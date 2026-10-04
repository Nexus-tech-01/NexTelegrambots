const BACKEND = "https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TABLE = "nxc_web_proxy_sessions";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const ALLOWED_ORIGINS = new Set([
  "https://tresor562.github.io",
  "https://tresor-hontonnou.zone.id",
  "https://www.tresor-hontonnou.zone.id",
]);

function b64u(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64u(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function sha256(value: string) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
const aesKeyPromise = (async () => {
  const material = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    enc.encode(SERVICE_ROLE + "|nexcontrol-web-proxy-v1"),
  ));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
})();
async function seal(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKeyPromise;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return b64u(out);
}
async function unseal(value: string) {
  const all = fromB64u(value);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  const key = await aesKeyPromise;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(pt);
}

function cors(origin: string | null) {
  const h = new Headers({
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-nxc-session,x-requested-with",
    "access-control-expose-headers": "x-nxc-location,x-nxc-session,x-nxc-route,content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) h.set("access-control-allow-origin", origin);
  return h;
}
function addCors(target: Headers, origin: string | null) {
  const h = cors(origin);
  for (const [k, v] of h) target.set(k, v);
}

async function rest(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers || {});
  h.set("apikey", SERVICE_ROLE);
  h.set("authorization", "Bearer " + SERVICE_ROLE);
  if (!h.has("content-type") && init.body) h.set("content-type", "application/json");
  return fetch(SUPABASE_URL + "/rest/v1/" + path, { ...init, headers: h });
}
async function loadSession(rawToken: string, ua: string) {
  if (!rawToken || rawToken.length > 256) return null;
  const tokenHash = await sha256(rawToken);
  const r = await rest(TABLE + "?token_hash=eq." + encodeURIComponent(tokenHash) +
    "&select=token_hash,cookie_ciphertext,user_agent_hash,expires_at&limit=1");
  if (!r.ok) return null;
  const rows = await r.json();
  const row = rows?.[0];
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  const uaHash = await sha256(ua || "");
  if (row.user_agent_hash !== uaHash) return null;
  try {
    return { tokenHash, cookie: await unseal(row.cookie_ciphertext) };
  } catch {
    return null;
  }
}
async function saveSession(rawToken: string, cookie: string, ua: string) {
  const tokenHash = await sha256(rawToken);
  const body = {
    token_hash: tokenHash,
    cookie_ciphertext: await seal(cookie),
    user_agent_hash: await sha256(ua || ""),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const r = await rest(TABLE + "?on_conflict=token_hash", {
    method: "POST",
    headers: { "prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("proxy session save failed: " + r.status);
  return tokenHash;
}
async function deleteSessionByRaw(rawToken: string) {
  if (!rawToken) return;
  const tokenHash = await sha256(rawToken);
  await rest(TABLE + "?token_hash=eq." + encodeURIComponent(tokenHash), { method: "DELETE" });
}
async function cleanupExpired() {
  await rest(TABLE + "?expires_at=lt." + encodeURIComponent(new Date().toISOString()), { method: "DELETE" });
}

function randomToken() {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}
function cookieMap(cookieHeader: string) {
  const map = new Map<string, string>();
  for (const part of (cookieHeader || "").split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i > 0) map.set(p.slice(0, i), p.slice(i + 1));
  }
  return map;
}
function setCookies(headers: Headers): string[] {
  const fn = (headers as any).getSetCookie;
  if (typeof fn === "function") {
    try { return fn.call(headers) || []; } catch {}
  }
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}
function mergeCookies(current: string, incoming: string[]) {
  const map = cookieMap(current);
  for (const sc of incoming) {
    const first = sc.split(";", 1)[0]?.trim() || "";
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1);
    if (!name || name.startsWith("__cf") || name.startsWith("cf_")) continue;
    const low = sc.toLowerCase();
    const remove = value === "" || /max-age\s*=\s*0/.test(low) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/.test(low);
    if (remove) map.delete(name); else map.set(name, value);
  }
  return [...map.entries()].map(([k, v]) => k + "=" + v).join("; ");
}
function safeRoute(raw: string | null) {
  const v = raw || "/";
  if (!v.startsWith("/") || v.startsWith("//") || v.length > 4096 || /[\u0000-\u001f]/.test(v)) return null;
  try {
    const u = new URL(v, "https://nexcontrol.local");
    if (u.origin !== "https://nexcontrol.local") return null;
    if (u.pathname.split("/").some(x => x === "..")) return null;
    return u;
  } catch {
    return null;
  }
}
function upstreamHeaders(req: Request, path: string, cookie: string) {
  const h = new Headers(req.headers);
  for (const k of [
    "host","content-length","connection","transfer-encoding","keep-alive","upgrade",
    "proxy-connection","te","trailer","accept-encoding","origin","referer",
    "authorization","apikey","cookie","x-nxc-session"
  ]) h.delete(k);
  h.set("x-nexcontrol-path", path);
  h.set("accept-encoding", "identity");
  if (cookie) h.set("cookie", cookie);
  return h;
}


function infraJson(data: any,status=200,origin: string|null=null){
  const headers=cors(origin);
  headers.set("content-type","application/json; charset=utf-8");
  return new Response(JSON.stringify(data),{status,headers});
}
async function infraDb(path: string,init: RequestInit={}){
  const r=await rest(path,init);
  const text=await r.text();
  let data:any=null;try{data=text?JSON.parse(text):null}catch{data=text}
  if(!r.ok)throw new Error("db_"+r.status+":"+String(text).slice(0,300));
  return data;
}
function infraEsc(x:any){
  return String(x??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"} as any)[c]);
}
function infraAgo(v:any){
  if(!v)return "jamais";
  const m=Math.floor(Math.max(0,Date.now()-new Date(v).getTime())/60000);
  if(m<1)return "maintenant"; if(m<60)return m+" min"; if(m<1440)return Math.floor(m/60)+" h"; return Math.floor(m/1440)+" j";
}
function infraReason(v:any){
  const map:any={
    source_bundle_invalid:"Bundle source invalide",
    runtime_drift:"Dérive runtime détectée",
    source_mapping_unverified:"Mapping source non vérifié",
    source_mapping_missing:"Mapping source absent",
    repository_not_mapped:"Dépôt non associé",
    immutable_commit_required:"Commit immuable requis",
    non_atomic_strategy:"Stratégie non atomique",
    rollback_not_ready:"Rollback non prêt",
    watch_not_ready:"Watcher non prêt"
  };
  return map[String(v||"")]||String(v||"Prêt");
}
function infraIcon(name:string){
  const p:any={
    grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    server:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    project:'<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>',
    git:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h5a5 5 0 0 1 5 5v5M6 8v10"/>',
    deploy:'<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    alert:'<path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">'+(p[name]||"")+'</svg>';
}
function infraPill(value:any){
  const v=String(value||"unknown");
  const good=/healthy|running|ready|active|valid|online/i.test(v),bad=/critical|failed|blocked|invalid|offline|error/i.test(v);
  return '<span class="pill '+(good?"ok":bad?"bad":"warn")+'"><i></i>'+infraEsc(v)+'</span>';
}
async function infraState(){
  const [nodes,agents,projects,github,watches,deployments,plans,alerts,samples,sources,profiles]=await Promise.all([
    infraDb("nxc_nodes?select=*&order=created_at.asc"),
    infraDb("nxc_host_agents?select=id,name,hostname,os,kernel,arch,version,enabled,last_seen_at&order=created_at.asc"),
    infraDb("nxc_projects?select=*&archived_at=is.null&order=name.asc"),
    infraDb("nxc_github_connections?select=id,connection_key,account_login,account_type,display_name,avatar_url,repository_allowlist,scopes,is_active,connected_at&order=connected_at.asc"),
    infraDb("nxc_repo_watches?select=*&order=repo_owner.asc,repo_name.asc"),
    infraDb("nxc_deployments?select=*&order=created_at.desc&limit=24"),
    infraDb("nxc_deploy_plans?select=id,project_id,requested_sha,status,blocked_reason,created_at,executed_deployment_id&order=created_at.desc&limit=40"),
    infraDb("nxc_alerts?select=*&status=eq.open&order=last_seen_at.desc&limit=24"),
    infraDb("nxc_node_samples?select=*&order=sampled_at.desc&limit=80"),
    infraDb("nxc_project_sources?select=*&order=updated_at.desc"),
    infraDb("nxc_deploy_profiles?select=*&order=updated_at.desc")
  ]);
  const agentById:any={};for(const x of agents||[])agentById[x.id]=x;
  const sampleByNode:any={};for(const x of samples||[])if(!sampleByNode[x.node_id])sampleByNode[x.node_id]=x;
  const watchByRepo:any={};for(const x of watches||[])watchByRepo[x.repo_owner+"/"+x.repo_name+"#"+x.branch]=x;
  const sourceByProject:any={};for(const x of sources||[])sourceByProject[x.project_id]=x;
  const profileByProject:any={};for(const x of profiles||[])profileByProject[x.project_id]=x;
  const planByProject:any={};for(const x of plans||[])if(!planByProject[x.project_id])planByProject[x.project_id]=x;
  return {nodes,agents,projects,github,watches,deployments,plans,alerts,samples,sources,profiles,agentById,sampleByNode,watchByRepo,sourceByProject,profileByProject,planByProject,generatedAt:new Date().toISOString()};
}
function infraHtml(s:any){
  const nodes=s.nodes||[],projects=s.projects||[],github=s.github||[],watches=s.watches||[],deployments=s.deployments||[],alerts=s.alerts||[];
  const healthy=projects.filter((x:any)=>x.health_status==="healthy").length;
  const auto=projects.filter((x:any)=>x.auto_deploy).length;
  const blocked=watches.filter((x:any)=>x.blocked).length;
  const nav=(id:string,label:string,ic:string)=>'<a href="#'+id+'">'+infraIcon(ic)+'<span>'+label+'</span></a>';
  const nodeCards=nodes.map((n:any)=>{
    const a=s.agentById[n.host_agent_id]||{},m=s.sampleByNode[n.id]||{};
    const online=!!(a.enabled&&a.last_seen_at&&Date.now()-new Date(a.last_seen_at).getTime()<180000);
    const ram=m.memory_total_bytes?Math.round(Number(m.memory_used_bytes||0)*100/Number(m.memory_total_bytes)):null;
    return '<article class="card node"><div class="between"><div><small>'+infraEsc(n.provider||"VPS")+' · '+infraEsc(n.environment||"production")+'</small><h3>'+infraEsc(n.display_name||n.slug)+'</h3></div>'+infraPill(online?"online":"offline")+'</div><div class="triple"><div><span>CPU</span><b>'+(m.cpu_percent==null?"—":Number(m.cpu_percent).toFixed(1)+"%")+'</b></div><div><span>RAM</span><b>'+(ram==null?"—":ram+"%")+'</b></div><div><span>DISK</span><b>'+(m.disk_percent==null?"—":Number(m.disk_percent).toFixed(1)+"%")+'</b></div></div><p>'+infraEsc(a.hostname||n.slug)+' · '+infraEsc(a.arch||n.resource_profile?.arch||"—")+' · agent '+infraEsc(a.version||n.resource_profile?.agentVersion||"—")+' · vu '+infraEsc(infraAgo(a.last_seen_at))+'</p></article>';
  }).join("")||'<div class="empty">Aucun serveur.</div>';
  const projectRows=projects.map((p:any)=>{
    const branch=p.auto_deploy_branch||p.repo_default_branch||"main";
    const w=s.watchByRepo[p.repo_owner+"/"+p.repo_name+"#"+branch],src=s.sourceByProject[p.id],prof=s.profileByProject[p.id],plan=s.planByProject[p.id];
    const safe=!!(w&&w.active&&!w.blocked&&src?.verified&&prof?.strategy==="atomic_symlink"&&prof?.rollback_supported);
    const why=w?.blocked_reason||(!src?.verified?"source_mapping_unverified":prof?.strategy!=="atomic_symlink"?"non_atomic_strategy":!prof?.rollback_supported?"rollback_not_ready":"watch_not_ready");
    const service=p.runtime_config?.systemdService||prof?.service_name||"—";
    return '<div class="project-row"><div class="project-name"><span class="ico">'+infraIcon("project")+'</span><div><b>'+infraEsc(p.name)+'</b><small>'+infraEsc(p.repo_owner+"/"+p.repo_name)+' · '+infraEsc(branch)+'</small></div></div><div>'+infraPill(p.health_status||p.status)+'</div><code>'+infraEsc(service)+'</code><div>'+infraPill(plan?.status||"aucun")+(plan?.blocked_reason?'<small class="reason">'+infraEsc(infraReason(plan.blocked_reason))+'</small>':'')+'</div><div><button data-auto="'+infraEsc(p.slug)+'" data-enabled="'+(p.auto_deploy?"1":"0")+'" class="toggle '+(p.auto_deploy?"on":"")+'" '+(!safe&&!p.auto_deploy?"disabled":"")+'><i></i>'+(p.auto_deploy?"AUTO ON":"AUTO OFF")+'</button><small class="reason '+(safe?"green":"")+'">'+infraEsc(safe?"Prêt":infraReason(why))+'</small></div></div>';
  }).join("");
  const ghCards=github.map((g:any)=>'<article class="card"><div class="between"><div class="avatar">'+(g.avatar_url?'<img src="'+infraEsc(g.avatar_url)+'" alt="">':infraIcon("git"))+'</div>'+infraPill(g.is_active?"active":"inactive")+'</div><h3>'+infraEsc(g.display_name||g.account_login)+'</h3><p>@'+infraEsc(g.account_login)+' · '+infraEsc(g.account_type)+'</p><div class="chips">'+(g.scopes||[]).map((x:any)=>'<span>'+infraEsc(x)+'</span>').join("")+'</div><small>'+infraEsc((g.repository_allowlist||[]).length)+' dépôt(s) autorisé(s)</small></article>').join("");
  const watchRows=watches.map((w:any)=>'<div class="watch-row"><div><b>'+infraEsc(w.repo_owner+"/"+w.repo_name)+'</b><small>'+infraEsc(w.branch)+' · '+infraEsc(String(w.last_sha||"").slice(0,12))+'</small></div><div>'+infraPill(w.blocked?"blocked":"ready")+(w.blocked?'<small class="reason">'+infraEsc(infraReason(w.blocked_reason))+'</small>':'')+'</div><div><span>COMMIT</span><b>'+infraEsc(infraAgo(w.last_commit_at))+'</b></div><div><span>POLL</span><b>'+infraEsc(infraAgo(w.last_polled_at))+'</b></div></div>').join("");
  const depRows=deployments.map((d:any)=>'<div class="deploy-row"><code>'+infraEsc(String(d.commit_sha||"").slice(0,12))+'</code><span>'+infraEsc(d.branch||"—")+'</span>'+infraPill(d.status)+'<span>'+infraEsc(infraAgo(d.created_at))+'</span></div>').join("")||'<div class="empty">Aucun déploiement exécuté — les garde-fous bloquent encore les sources non vérifiées.</div>';
  const alertRows=alerts.map((a:any)=>'<div class="alert-row"><span class="alert-ico">'+infraIcon("alert")+'</span><div><b>'+infraEsc(a.title)+'</b><p>'+infraEsc(a.message)+'</p></div><div><strong>'+infraEsc(a.severity)+'</strong><small>'+infraEsc(infraAgo(a.last_seen_at))+'</small></div></div>').join("")||'<div class="empty">Aucune alerte ouverte.</div>';
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070809"><title>Infrastructure · NexControl</title><style>'+
  '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#070809;color:#f4f2ed;font-family:Inter,system-ui,-apple-system,sans-serif}a{color:inherit;text-decoration:none}button{font:inherit}.side{position:fixed;inset:0 auto 0 0;width:232px;background:#090a0c;border-right:1px solid #202329;padding:20px 15px;z-index:10}.brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:.08em;margin:5px 7px 38px}.mark{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;border:1px solid #333641;background:#11131a;color:#a994ff;box-shadow:0 0 25px #8a70ff22}.nav{display:grid;gap:4px}.nav a{display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:11px;color:#898d96;font-size:12px;transition:.2s}.nav a:hover{background:#12151a;color:#fff}.nav svg,.ico svg,.avatar svg,.alert-ico svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.back{margin-top:12px;padding-top:18px!important;border-top:1px solid #202329}.main{margin-left:232px;padding:26px clamp(18px,4vw,54px) 90px;max-width:1650px}.top{display:flex;justify-content:space-between;color:#71757e;font-size:10px;letter-spacing:.12em;text-transform:uppercase}.live{display:flex;gap:7px;align-items:center}.live i{width:6px;height:6px;border-radius:50%;background:#54e5a2;box-shadow:0 0 12px #54e5a2}.hero{padding:70px 0 40px}.hero small,.section-head small,.card>div>div>small{font-size:9px;color:#6c7079;letter-spacing:.15em;text-transform:uppercase}.hero h1{font-size:clamp(46px,7vw,90px);letter-spacing:-.065em;line-height:.88;margin:10px 0 20px}.hero h1 em{font-style:normal;color:#8f7cff}.hero p{max-width:650px;color:#858a94;line-height:1.6}.metrics{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #22252b;border-radius:17px;overflow:hidden;background:#0b0d10;margin-bottom:66px}.metric{padding:18px 20px;border-right:1px solid #22252b}.metric:last-child{border:0}.metric span{font-size:9px;color:#686c74;letter-spacing:.1em;text-transform:uppercase}.metric b{display:block;font-size:29px;margin-top:10px;letter-spacing:-.05em}.section{margin:0 0 66px;scroll-margin-top:20px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:16px}.section-head h2{font-size:25px;margin:4px 0 0;letter-spacing:-.035em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px}.card{border:1px solid #23262c;background:#0b0d10;border-radius:17px;padding:19px}.between{display:flex;justify-content:space-between;align-items:center;gap:10px}.card h3{margin:5px 0;font-size:20px}.card p{font-size:10px;color:#747983}.triple{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:20px 0 14px}.triple div{border:1px solid #202329;border-radius:11px;padding:10px}.triple span,.watch-row span{display:block;font-size:8px;color:#656a73;letter-spacing:.1em}.triple b{display:block;margin-top:5px}.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid #30343b;border-radius:999px;font-size:8px;text-transform:uppercase;letter-spacing:.1em;color:#a4a8b0}.pill i{width:5px;height:5px;border-radius:50%;background:currentColor}.pill.ok{color:#60dca1;border-color:#28523e;background:#0c1914}.pill.bad{color:#ff848d;border-color:#583038;background:#1b0d10}.pill.warn{color:#dcc66e;border-color:#51472a;background:#17150d}.project-table,.watch-list,.deploy-list,.alert-list{border:1px solid #23262c;border-radius:17px;overflow:hidden;background:#0b0d10}.project-head,.project-row{display:grid;grid-template-columns:minmax(245px,1.5fr) .65fr minmax(170px,.9fr) .7fr 180px;gap:14px;align-items:center;padding:13px 17px}.project-head{color:#62666f;font-size:8px;letter-spacing:.12em;text-transform:uppercase;border-bottom:1px solid #22252b}.project-row{min-height:78px;border-bottom:1px solid #1d2025}.project-row:last-child{border:0}.project-name{display:flex;align-items:center;gap:11px}.ico{display:grid;place-items:center;width:37px;height:37px;border-radius:10px;border:1px solid #292d34;color:#9a89ff;background:#101219}.project-name b{display:block;font-size:13px}.project-name small,.reason{display:block;font-size:8px;color:#727680;margin-top:4px}.project-row code{font-size:9px;color:#a4a8b1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.reason.green{color:#54c996}.toggle{display:inline-flex;align-items:center;gap:7px;height:32px;border:1px solid #30343c;border-radius:9px;background:#111318;color:#858a93;font-size:8px;font-weight:800;letter-spacing:.08em;cursor:pointer}.toggle i{width:6px;height:6px;border-radius:50%;background:#666b74}.toggle.on{color:#5edda0;border-color:#28543f;background:#0c1913}.toggle.on i{background:#5be39f;box-shadow:0 0 9px #5be39f}.toggle:disabled{opacity:.35;cursor:not-allowed}.avatar{width:40px;height:40px;border:1px solid #292d34;border-radius:11px;overflow:hidden;display:grid;place-items:center}.avatar img{width:100%;height:100%;object-fit:cover}.chips{display:flex;flex-wrap:wrap;gap:5px;margin:14px 0}.chips span{font-size:8px;border:1px solid #292c33;border-radius:999px;padding:4px 7px;color:#92969f}.watch-row{display:grid;grid-template-columns:1.5fr .8fr .7fr .7fr;gap:14px;align-items:center;padding:14px 17px;border-bottom:1px solid #1d2025}.watch-row:last-child{border:0}.watch-row b{font-size:11px}.watch-row small{display:block;font-size:8px;color:#70747e;margin-top:4px}.deploy-row{display:grid;grid-template-columns:140px 1fr 120px 110px;gap:12px;align-items:center;padding:13px 17px;border-bottom:1px solid #1d2025;font-size:10px}.deploy-row:last-child{border:0}.deploy-row code{color:#9d8cff}.alert-row{display:grid;grid-template-columns:27px 1fr 90px;gap:11px;padding:14px 17px;border-bottom:1px solid #1d2025}.alert-row:last-child{border:0}.alert-ico{color:#ff858e}.alert-row b{font-size:11px}.alert-row p{font-size:10px;line-height:1.45;color:#7e838c;margin:4px 0 0}.alert-row>div:last-child{text-align:right}.alert-row strong{font-size:8px;color:#ff858e;text-transform:uppercase}.alert-row small{display:block;color:#666b74;font-size:8px;margin-top:4px}.empty{padding:25px;color:#686d76;font-size:11px;text-align:center}.toast{position:fixed;right:20px;bottom:20px;max-width:350px;background:#14171d;border:1px solid #373b45;border-radius:11px;padding:12px 15px;font-size:11px;opacity:0;transform:translateY(22px);transition:.25s;z-index:40}.toast.show{opacity:1;transform:none}.toast.bad{border-color:#5a3037;color:#ffabb0}.menu{display:none}@media(max-width:980px){.metrics{grid-template-columns:repeat(3,1fr)}.project-head{display:none}.project-row{grid-template-columns:1fr 1fr}.project-name{grid-column:1/-1}}@media(max-width:700px){.side{width:min(82vw,270px);transform:translateX(-100%);transition:.25s}body.open .side{transform:none}.main{margin-left:0;padding:17px 14px 70px}.menu{display:block;border:1px solid #2d3038;border-radius:9px;background:#0f1115;color:#fff;padding:8px 11px}.hero{padding-top:45px}.metrics{grid-template-columns:1fr 1fr}.metric:last-child{grid-column:1/-1}.project-row{grid-template-columns:1fr}.project-name{grid-column:auto}.watch-row{grid-template-columns:1fr 1fr}.watch-row>div:first-child{grid-column:1/-1}.deploy-row{grid-template-columns:1fr 1fr}}'+
  '</style></head><body><aside class="side"><div class="brand"><span class="mark">N</span>NEXCONTROL</div><nav class="nav">'+nav("overview","Overview","grid")+nav("servers","Servers","server")+nav("projects","Projects","project")+nav("github","GitHub","git")+nav("deployments","Deployments","deploy")+nav("alerts","Alerts","alert")+'<a class="back" href="/">'+infraIcon("grid")+'<span>Control Center</span></a></nav></aside><main class="main"><div class="top"><button class="menu" id="menu">☰</button><span>NexControl / Infrastructure</span><span class="live"><i></i> live control plane</span></div><section class="hero" id="overview"><small>Nextech infrastructure orchestration</small><h1>One surface.<br><em>Every runtime.</em></h1><p>VPS, projets, GitHub, health gates et déploiements réunis dans NexControl. Les actions risquées restent verrouillées tant que les validations de source, le rollback et l’état runtime ne sont pas propres.</p></section><section class="metrics"><div class="metric"><span>Nodes</span><b>'+nodes.length+'</b></div><div class="metric"><span>Projects</span><b>'+projects.length+'</b></div><div class="metric"><span>Healthy</span><b>'+healthy+'/'+projects.length+'</b></div><div class="metric"><span>Auto Deploy</span><b>'+auto+'</b></div><div class="metric"><span>Blocked Repos</span><b>'+blocked+'</b></div></section><section class="section" id="servers"><div class="section-head"><div><small>Fleet</small><h2>Servers</h2></div></div><div class="grid">'+nodeCards+'</div></section><section class="section" id="projects"><div class="section-head"><div><small>Runtime registry</small><h2>Projects</h2></div></div><div class="project-table"><div class="project-head"><span>Project</span><span>Health</span><span>Service</span><span>Plan</span><span>Auto-deploy</span></div>'+projectRows+'</div></section><section class="section" id="github"><div class="section-head"><div><small>Source control</small><h2>GitHub Accounts</h2></div></div><div class="grid">'+ghCards+'</div><div class="section-head" style="margin-top:30px"><div><small>Repository monitor</small><h2>Watches</h2></div><small>poll / 5 min</small></div><div class="watch-list">'+watchRows+'</div></section><section class="section" id="deployments"><div class="section-head"><div><small>Release history</small><h2>Deployments</h2></div></div><div class="deploy-list">'+depRows+'</div></section><section class="section" id="alerts"><div class="section-head"><div><small>Safety gates</small><h2>Open Alerts</h2></div></div><div class="alert-list">'+alertRows+'</div></section></main><div class="toast" id="toast"></div><script>const toast=document.getElementById("toast");function say(x,b){toast.textContent=x;toast.className="toast show"+(b?" bad":"");setTimeout(()=>toast.className="toast",3000)}document.getElementById("menu").onclick=()=>document.body.classList.toggle("open");document.addEventListener("click",async e=>{const b=e.target.closest&&e.target.closest("[data-auto]");if(!b||b.disabled)return;const enabled=b.dataset.enabled!=="1";b.disabled=true;try{const r=await fetch("/api/admin/infrastructure/projects/"+encodeURIComponent(b.dataset.auto)+"/autodeploy",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Action refusée");say(enabled?"Auto-deploy activé":"Auto-deploy désactivé");setTimeout(()=>location.reload(),500)}catch(err){say(err.message,true);b.disabled=false}});</script></body></html>';
}
async function infraSetAuto(slug:string,enabled:boolean){
  const ps=await infraDb("nxc_projects?slug=eq."+encodeURIComponent(slug)+"&archived_at=is.null&select=*&limit=1");
  const p=ps?.[0];if(!p)return {status:404,body:{error:"project_not_found"}};
  const branch=p.auto_deploy_branch||p.repo_default_branch||"main";
  const ws=await infraDb("nxc_repo_watches?repo_owner=eq."+encodeURIComponent(p.repo_owner)+"&repo_name=eq."+encodeURIComponent(p.repo_name)+"&branch=eq."+encodeURIComponent(branch)+"&select=*&limit=1");
  const w=ws?.[0];
  if(enabled){
    if(!w||!w.active)return {status:409,body:{error:"watch_not_ready",message:"Watcher GitHub non prêt."}};
    if(w.blocked)return {status:409,body:{error:w.blocked_reason||"watch_blocked",message:"Auto-deploy bloqué : "+infraReason(w.blocked_reason)}};
    const [ss,pp]=await Promise.all([
      infraDb("nxc_project_sources?project_id=eq."+p.id+"&select=*&limit=1"),
      infraDb("nxc_deploy_profiles?project_id=eq."+p.id+"&select=*&limit=1")
    ]);
    const source=ss?.[0],profile=pp?.[0];
    if(!source?.verified)return {status:409,body:{error:"source_mapping_unverified",message:"Auto-deploy bloqué : source non vérifiée."}};
    if(profile?.strategy!=="atomic_symlink")return {status:409,body:{error:"non_atomic_strategy",message:"Auto-deploy bloqué : stratégie non atomique."}};
    if(!profile?.rollback_supported)return {status:409,body:{error:"rollback_not_ready",message:"Auto-deploy bloqué : rollback non prêt."}};
  }
  const now=new Date().toISOString();
  await infraDb("nxc_projects?id=eq."+p.id,{method:"PATCH",headers:{"prefer":"return=minimal"},body:JSON.stringify({auto_deploy:enabled,updated_at:now})});
  await infraDb("nxc_project_environments?project_id=eq."+p.id+"&slug=eq.production",{method:"PATCH",headers:{"prefer":"return=minimal"},body:JSON.stringify({auto_deploy:enabled,updated_at:now})});
  if(w){
    const ep=await infraDb("nxc_projects?repo_owner=eq."+encodeURIComponent(p.repo_owner)+"&repo_name=eq."+encodeURIComponent(p.repo_name)+"&auto_deploy=eq.true&archived_at=is.null&select=id");
    await infraDb("nxc_repo_watches?id=eq."+w.id,{method:"PATCH",headers:{"prefer":"return=minimal"},body:JSON.stringify({auto_enqueue:!!(ep?.length&&w.active&&!w.blocked),updated_at:now})});
  }
  return {status:200,body:{ok:true,slug,auto_deploy:enabled}};
}
async function handleInfrastructure(req:Request,route:URL,origin:string|null){
  if(req.method==="GET"&&route.pathname==="/infrastructure"){
    const html=infraHtml(await infraState());
    const headers=cors(origin);
    headers.set("content-type","text/html; charset=utf-8");
    headers.set("content-security-policy","default-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'");
    return new Response(html,{status:200,headers});
  }
  if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/state")return infraJson(await infraState(),200,origin);
  const m=route.pathname.match(/^\/api\/admin\/infrastructure\/projects\/([A-Za-z0-9._-]+)\/autodeploy$/);
  if(req.method==="POST"&&m){
    const q=await req.json().catch(()=>({}));
    const out=await infraSetAuto(m[1],q.enabled===true);
    return infraJson(out.body,out.status,origin);
  }
  return infraJson({error:"not_found"},404,origin);
}

Deno.serve(async (req: Request) => {
  const requestUrl = new URL(req.url);
  const origin = req.headers.get("origin");

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ ok: false, error: "origin_not_allowed" }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  const route = safeRoute(requestUrl.searchParams.get("route"));
  if (!route) {
    const h = cors(origin); h.set("content-type", "application/json");
    return new Response(JSON.stringify({ ok: false, error: "invalid_route" }), { status: 400, headers: h });
  }

  const ua = req.headers.get("user-agent") || "";
  const rawProxyToken = (req.headers.get("x-nxc-session") || "").trim();
  const existing = await loadSession(rawProxyToken, ua);
  let upstreamCookie = existing?.cookie || "";

  const infraRoute = route.pathname === "/infrastructure" || route.pathname.startsWith("/api/admin/infrastructure/");
  if (infraRoute) {
    if (!existing) {
      const h = cors(origin);
      h.set("x-nxc-location", "/login");
      h.set("content-type", "text/plain; charset=utf-8");
      return new Response(null, { status: 200, headers: h });
    }
    return handleInfrastructure(req, route, origin);
  }

  const body = (req.method === "GET" || req.method === "HEAD") ? undefined : await req.arrayBuffer();
  const upstream = await fetch(BACKEND + route.search, {
    method: req.method,
    headers: upstreamHeaders(req, route.pathname, upstreamCookie),
    body,
    redirect: "manual",
  });

  const incomingCookies = setCookies(upstream.headers);
  const mergedCookie = mergeCookies(upstreamCookie, incomingCookies);
  let newProxyToken = "";
  const isLogin = route.pathname === "/api/admin/login" && req.method === "POST";
  const location = upstream.headers.get("location") || "";

  if (isLogin && mergedCookie && mergedCookie !== upstreamCookie) {
    newProxyToken = randomToken();
    await saveSession(newProxyToken, mergedCookie, ua);
    cleanupExpired().catch(() => {});
  } else if (existing && mergedCookie && mergedCookie !== upstreamCookie) {
    await saveSession(rawProxyToken, mergedCookie, ua);
  }

  const isLogout = route.pathname === "/api/admin/logout";
  const redirectedToLogin = location === "/login" && !!existing;
  if ((isLogout || redirectedToLogin || upstream.status === 401) && rawProxyToken) {
    await deleteSessionByRaw(rawProxyToken);
  }

  const out = new Headers(upstream.headers);
  for (const k of [
    "set-cookie","content-length","content-encoding","transfer-encoding","connection",
    "location","content-security-policy","x-frame-options"
  ]) out.delete(k);
  addCors(out, origin);
  out.set("x-nxc-route", route.pathname + route.search);
  if (location) out.set("x-nxc-location", location);
  if (newProxyToken) out.set("x-nxc-session", newProxyToken);

  const bytes = new Uint8Array(await upstream.arrayBuffer());

  if (location && upstream.status >= 300 && upstream.status < 400) {
    out.set("content-type", "text/plain; charset=utf-8");
    return new Response(bytes.length ? bytes : null, { status: 200, headers: out });
  }

  return new Response(bytes, { status: upstream.status, headers: out });
});