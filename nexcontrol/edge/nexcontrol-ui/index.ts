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
  const githubUi=JSON.stringify(github.map((g:any)=>({id:g.id,name:g.display_name||g.account_login,login:g.account_login,repos:g.repository_allowlist||[]}))).replace(/</g,"\\u003c");
  const nodesUi=JSON.stringify(nodes.map((n:any)=>({id:n.id,name:n.display_name||n.slug,slug:n.slug}))).replace(/</g,"\\u003c");
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
    const onboarding=String(prof?.config?.onboarding||"");
    const verifyNeeded=!prof?.rollback_supported;
    return '<div class="project-row"><div class="project-name"><span class="ico">'+infraIcon("project")+'</span><div><b>'+infraEsc(p.name)+'</b><small>'+infraEsc(p.repo_owner+"/"+p.repo_name)+' · '+infraEsc(branch)+'</small></div></div><div>'+infraPill(p.health_status||p.status)+'</div><code>'+infraEsc(service)+'</code><div>'+infraPill(plan?.status||"aucun")+(plan?.blocked_reason?'<small class="reason">'+infraEsc(infraReason(plan.blocked_reason))+'</small>':'')+'</div><div class="project-actions"><button data-manage="'+infraEsc(p.slug)+'" class="mini">'+infraIcon("server")+'<span>Manage</span></button><button data-deploy="'+infraEsc(p.slug)+'" class="mini primary" '+(!safe?"disabled":"")+'>'+infraIcon("deploy")+'<span>Deploy</span></button>'+(verifyNeeded?'<button data-verify="'+infraEsc(p.slug)+'" class="mini">'+infraIcon("server")+'<span>Verify</span></button>':'')+'<button data-auto="'+infraEsc(p.slug)+'" data-enabled="'+(p.auto_deploy?"1":"0")+'" class="toggle '+(p.auto_deploy?"on":"")+'" '+(!safe&&!p.auto_deploy?"disabled":"")+'><i></i>'+(p.auto_deploy?"AUTO ON":"AUTO OFF")+'</button><small class="reason '+(safe?"green":"")+'">'+infraEsc(safe?"Ready":(onboarding==="verification_failed"?"Runtime verification failed":infraReason(why)))+'</small></div></div>';
  }).join("");
  const ghCards=github.map((g:any)=>'<article class="card"><div class="between"><div class="avatar">'+(g.avatar_url?'<img src="'+infraEsc(g.avatar_url)+'" alt="">':infraIcon("git"))+'</div>'+infraPill(g.is_active?"active":"inactive")+'</div><h3>'+infraEsc(g.display_name||g.account_login)+'</h3><p>@'+infraEsc(g.account_login)+' · '+infraEsc(g.account_type)+'</p><div class="chips">'+(g.scopes||[]).map((x:any)=>'<span>'+infraEsc(x)+'</span>').join("")+'</div><small>'+infraEsc((g.repository_allowlist||[]).length)+' dépôt(s) autorisé(s)</small></article>').join("");
  const watchRows=watches.map((w:any)=>'<div class="watch-row"><div><b>'+infraEsc(w.repo_owner+"/"+w.repo_name)+'</b><small>'+infraEsc(w.branch)+' · '+infraEsc(String(w.last_sha||"").slice(0,12))+'</small></div><div>'+infraPill(w.blocked?"blocked":"ready")+(w.blocked?'<small class="reason">'+infraEsc(infraReason(w.blocked_reason))+'</small>':'')+'</div><div><span>COMMIT</span><b>'+infraEsc(infraAgo(w.last_commit_at))+'</b></div><div><span>POLL</span><b>'+infraEsc(infraAgo(w.last_polled_at))+'</b></div></div>').join("");
  const depRows=deployments.map((d:any)=>'<div class="deploy-row"><code>'+infraEsc(String(d.commit_sha||"").slice(0,12))+'</code><span>'+infraEsc(d.branch||"—")+'</span>'+infraPill(d.status)+'<span>'+infraEsc(infraAgo(d.created_at))+'</span></div>').join("")||'<div class="empty">Aucun déploiement exécuté — les garde-fous bloquent encore les sources non vérifiées.</div>';
  const alertRows=alerts.map((a:any)=>'<div class="alert-row"><span class="alert-ico">'+infraIcon("alert")+'</span><div><b>'+infraEsc(a.title)+'</b><p>'+infraEsc(a.message)+'</p></div><div><strong>'+infraEsc(a.severity)+'</strong><small>'+infraEsc(infraAgo(a.last_seen_at))+'</small></div></div>').join("")||'<div class="empty">Aucune alerte ouverte.</div>';
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070809"><title>Infrastructure · NexControl</title><style>'+
  '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#070809;color:#f4f2ed;font-family:Inter,system-ui,-apple-system,sans-serif}a{color:inherit;text-decoration:none}button{font:inherit}.side{position:fixed;inset:0 auto 0 0;width:232px;background:#090a0c;border-right:1px solid #202329;padding:20px 15px;z-index:10}.brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:.08em;margin:5px 7px 38px}.mark{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;border:1px solid #333641;background:#11131a;color:#a994ff;box-shadow:0 0 25px #8a70ff22}.nav{display:grid;gap:4px}.nav a{display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:11px;color:#898d96;font-size:12px;transition:.2s}.nav a:hover{background:#12151a;color:#fff}.nav svg,.ico svg,.avatar svg,.alert-ico svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.back{margin-top:12px;padding-top:18px!important;border-top:1px solid #202329}.main{margin-left:232px;padding:26px clamp(18px,4vw,54px) 90px;max-width:1650px}.top{display:flex;justify-content:space-between;color:#71757e;font-size:10px;letter-spacing:.12em;text-transform:uppercase}.live{display:flex;gap:7px;align-items:center}.live i{width:6px;height:6px;border-radius:50%;background:#54e5a2;box-shadow:0 0 12px #54e5a2}.hero{padding:70px 0 40px}.hero small,.section-head small,.card>div>div>small{font-size:9px;color:#6c7079;letter-spacing:.15em;text-transform:uppercase}.hero h1{font-size:clamp(46px,7vw,90px);letter-spacing:-.065em;line-height:.88;margin:10px 0 20px}.hero h1 em{font-style:normal;color:#8f7cff}.hero p{max-width:650px;color:#858a94;line-height:1.6}.metrics{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #22252b;border-radius:17px;overflow:hidden;background:#0b0d10;margin-bottom:66px}.metric{padding:18px 20px;border-right:1px solid #22252b}.metric:last-child{border:0}.metric span{font-size:9px;color:#686c74;letter-spacing:.1em;text-transform:uppercase}.metric b{display:block;font-size:29px;margin-top:10px;letter-spacing:-.05em}.section{margin:0 0 66px;scroll-margin-top:20px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:16px}.section-head h2{font-size:25px;margin:4px 0 0;letter-spacing:-.035em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px}.card{border:1px solid #23262c;background:#0b0d10;border-radius:17px;padding:19px}.between{display:flex;justify-content:space-between;align-items:center;gap:10px}.card h3{margin:5px 0;font-size:20px}.card p{font-size:10px;color:#747983}.triple{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:20px 0 14px}.triple div{border:1px solid #202329;border-radius:11px;padding:10px}.triple span,.watch-row span{display:block;font-size:8px;color:#656a73;letter-spacing:.1em}.triple b{display:block;margin-top:5px}.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid #30343b;border-radius:999px;font-size:8px;text-transform:uppercase;letter-spacing:.1em;color:#a4a8b0}.pill i{width:5px;height:5px;border-radius:50%;background:currentColor}.pill.ok{color:#60dca1;border-color:#28523e;background:#0c1914}.pill.bad{color:#ff848d;border-color:#583038;background:#1b0d10}.pill.warn{color:#dcc66e;border-color:#51472a;background:#17150d}.project-table,.watch-list,.deploy-list,.alert-list{border:1px solid #23262c;border-radius:17px;overflow:hidden;background:#0b0d10}.project-head,.project-row{display:grid;grid-template-columns:minmax(245px,1.5fr) .65fr minmax(170px,.9fr) .7fr 180px;gap:14px;align-items:center;padding:13px 17px}.project-head{color:#62666f;font-size:8px;letter-spacing:.12em;text-transform:uppercase;border-bottom:1px solid #22252b}.project-row{min-height:78px;border-bottom:1px solid #1d2025}.project-row:last-child{border:0}.project-name{display:flex;align-items:center;gap:11px}.ico{display:grid;place-items:center;width:37px;height:37px;border-radius:10px;border:1px solid #292d34;color:#9a89ff;background:#101219}.project-name b{display:block;font-size:13px}.project-name small,.reason{display:block;font-size:8px;color:#727680;margin-top:4px}.project-row code{font-size:9px;color:#a4a8b1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.reason.green{color:#54c996}.toggle{display:inline-flex;align-items:center;gap:7px;height:32px;border:1px solid #30343c;border-radius:9px;background:#111318;color:#858a93;font-size:8px;font-weight:800;letter-spacing:.08em;cursor:pointer}.toggle i{width:6px;height:6px;border-radius:50%;background:#666b74}.toggle.on{color:#5edda0;border-color:#28543f;background:#0c1913}.toggle.on i{background:#5be39f;box-shadow:0 0 9px #5be39f}.toggle:disabled,.mini:disabled{opacity:.35;cursor:not-allowed}.project-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.mini,.head-action,.modal button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #30343c;border-radius:9px;background:#111318;color:#b1b5be;min-height:32px;padding:0 10px;font-size:8px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;cursor:pointer}.mini svg,.head-action svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.8}.mini.primary,.head-action.primary,.modal button.primary{background:#8f7cff;color:#08080b;border-color:#8f7cff}.head-actions{display:flex;gap:7px;flex-wrap:wrap}.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:18px;background:#000a;backdrop-filter:blur(12px);z-index:100}.modal.open{display:flex}.modal-card{width:min(760px,100%);max-height:90vh;overflow:auto;border:1px solid #30343c;border-radius:20px;background:#0c0e12;box-shadow:0 32px 100px #000;padding:22px}.modal-card.wide{width:min(960px,100%)}.modal-head{display:flex;justify-content:space-between;gap:12px;align-items:start;margin-bottom:20px}.modal-head h3{font-size:25px;margin:4px 0;letter-spacing:-.04em}.modal-head p{font-size:10px;color:#7a7e88;margin:0;max-width:620px;line-height:1.5}.modal-close{width:34px!important;height:34px;min-height:34px!important;padding:0!important;border-radius:50%!important}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:8px;color:#737781;letter-spacing:.1em;text-transform:uppercase}.field input,.field select,.field textarea{width:100%;border:1px solid #282c33;background:#0a0c0f;color:#eee;border-radius:10px;padding:10px 11px;font:11px Inter,system-ui,sans-serif;outline:none}.field textarea{min-height:72px;resize:vertical}.field input:focus,.field select:focus,.field textarea:focus{border-color:#7465d9}.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}.copybox{display:none;margin-top:15px;border:1px solid #2b3038;border-radius:12px;background:#08090c;padding:13px}.copybox.show{display:block}.copybox code{display:block;word-break:break-all;white-space:pre-wrap;color:#c8c0ff;font-size:10px;line-height:1.6}.copybox small{display:block;color:#727680;font-size:9px;margin:0 0 8px}.service-actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 16px}.service-actions .danger{border-color:#573037;color:#ff969e;background:#1a0d10}.logs-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0}.logs-head small{font-size:9px;color:#747983}.logs{margin:0;min-height:260px;max-height:52vh;overflow:auto;border:1px solid #242830;border-radius:12px;background:#060709;color:#b8bec8;padding:14px;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.avatar{width:40px;height:40px;border:1px solid #292d34;border-radius:11px;overflow:hidden;display:grid;place-items:center}.avatar img{width:100%;height:100%;object-fit:cover}.chips{display:flex;flex-wrap:wrap;gap:5px;margin:14px 0}.chips span{font-size:8px;border:1px solid #292c33;border-radius:999px;padding:4px 7px;color:#92969f}.watch-row{display:grid;grid-template-columns:1.5fr .8fr .7fr .7fr;gap:14px;align-items:center;padding:14px 17px;border-bottom:1px solid #1d2025}.watch-row:last-child{border:0}.watch-row b{font-size:11px}.watch-row small{display:block;font-size:8px;color:#70747e;margin-top:4px}.deploy-row{display:grid;grid-template-columns:140px 1fr 120px 110px;gap:12px;align-items:center;padding:13px 17px;border-bottom:1px solid #1d2025;font-size:10px}.deploy-row:last-child{border:0}.deploy-row code{color:#9d8cff}.alert-row{display:grid;grid-template-columns:27px 1fr 90px;gap:11px;padding:14px 17px;border-bottom:1px solid #1d2025}.alert-row:last-child{border:0}.alert-ico{color:#ff858e}.alert-row b{font-size:11px}.alert-row p{font-size:10px;line-height:1.45;color:#7e838c;margin:4px 0 0}.alert-row>div:last-child{text-align:right}.alert-row strong{font-size:8px;color:#ff858e;text-transform:uppercase}.alert-row small{display:block;color:#666b74;font-size:8px;margin-top:4px}.empty{padding:25px;color:#686d76;font-size:11px;text-align:center}.toast{position:fixed;right:20px;bottom:20px;max-width:350px;background:#14171d;border:1px solid #373b45;border-radius:11px;padding:12px 15px;font-size:11px;opacity:0;transform:translateY(22px);transition:.25s;z-index:40}.toast.show{opacity:1;transform:none}.toast.bad{border-color:#5a3037;color:#ffabb0}.menu{display:none}@media(max-width:980px){.metrics{grid-template-columns:repeat(3,1fr)}.project-head{display:none}.project-row{grid-template-columns:1fr 1fr}.project-name{grid-column:1/-1}}@media(max-width:700px){.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.head-actions{width:100%;margin-top:8px}.section-head{align-items:flex-start;flex-direction:column;gap:10px}.side{width:min(82vw,270px);transform:translateX(-100%);transition:.25s}body.open .side{transform:none}.main{margin-left:0;padding:17px 14px 70px}.menu{display:block;border:1px solid #2d3038;border-radius:9px;background:#0f1115;color:#fff;padding:8px 11px}.hero{padding-top:45px}.metrics{grid-template-columns:1fr 1fr}.metric:last-child{grid-column:1/-1}.project-row{grid-template-columns:1fr}.project-name{grid-column:auto}.watch-row{grid-template-columns:1fr 1fr}.watch-row>div:first-child{grid-column:1/-1}.deploy-row{grid-template-columns:1fr 1fr}}'+
  '</style></head><body><aside class="side"><div class="brand"><span class="mark">N</span>NEXCONTROL</div><nav class="nav">'+nav("overview","Overview","grid")+nav("servers","Servers","server")+nav("projects","Projects","project")+nav("github","GitHub","git")+nav("deployments","Deployments","deploy")+nav("alerts","Alerts","alert")+'<a class="back" href="/">'+infraIcon("grid")+'<span>Control Center</span></a></nav></aside><main class="main"><div class="top"><button class="menu" id="menu">☰</button><span>NexControl / Infrastructure</span><span class="live"><i></i> live control plane</span></div><section class="hero" id="overview"><small>Nextech infrastructure orchestration</small><h1>One surface.<br><em>Every runtime.</em></h1><p>VPS, projets, GitHub, health gates et déploiements réunis dans NexControl. Les actions risquées restent verrouillées tant que les validations de source, le rollback et l’état runtime ne sont pas propres.</p></section><section class="metrics"><div class="metric"><span>Nodes</span><b>'+nodes.length+'</b></div><div class="metric"><span>Projects</span><b>'+projects.length+'</b></div><div class="metric"><span>Healthy</span><b>'+healthy+'/'+projects.length+'</b></div><div class="metric"><span>Auto Deploy</span><b>'+auto+'</b></div><div class="metric"><span>Blocked Repos</span><b>'+blocked+'</b></div></section><section class="section" id="servers"><div class="section-head"><div><small>Fleet</small><h2>Servers</h2></div><div class="head-actions"><button class="head-action primary" data-open="host">'+infraIcon("server")+'<span>Add VPS</span></button></div></div><div class="grid">'+nodeCards+'</div></section><section class="section" id="projects"><div class="section-head"><div><small>Runtime registry</small><h2>Projects</h2></div><div class="head-actions"><button class="head-action primary" data-open="project">'+infraIcon("project")+'<span>Add Project</span></button></div></div><div class="project-table"><div class="project-head"><span>Project</span><span>Health</span><span>Service</span><span>Plan</span><span>Auto-deploy</span></div>'+projectRows+'</div></section><section class="section" id="github"><div class="section-head"><div><small>Source control</small><h2>GitHub Accounts</h2></div></div><div class="grid">'+ghCards+'</div><div class="section-head" style="margin-top:30px"><div><small>Repository monitor</small><h2>Watches</h2></div><small>poll / 5 min</small></div><div class="watch-list">'+watchRows+'</div></section><section class="section" id="deployments"><div class="section-head"><div><small>Release history</small><h2>Deployments</h2></div></div><div class="deploy-list">'+depRows+'</div></section><section class="section" id="alerts"><div class="section-head"><div><small>Safety gates</small><h2>Open Alerts</h2></div></div><div class="alert-list">'+alertRows+'</div></section></main><div class="modal" id="hostModal"><div class="modal-card"><div class="modal-head"><div><small class="ey">Secure host onboarding</small><h3>Add VPS</h3><p>NexControl génère un token à usage unique et une commande d’installation. Aucun mot de passe SSH n’est conservé.</p></div><button class="modal-close" data-close>×</button></div><form id="hostForm" data-nxc-local><div class="field"><label>Server name</label><input name="name" value="NexControl Host" maxlength="80" required></div><div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Generate command</button></div></form><div class="copybox" id="hostCommand"><small>Exécute cette commande en root sur le nouveau VPS. Le token expire rapidement et ne peut servir qu’une fois.</small><code id="hostCommandText"></code><div class="form-actions"><button id="copyHostCommand" type="button">Copy command</button></div></div></div></div><div class="modal" id="projectModal"><div class="modal-card wide"><div class="modal-head"><div><small class="ey">Runtime onboarding</small><h3>Add Project</h3><p>Associe un dépôt GitHub autorisé à un nœud et à un service systemd existant. NexControl vérifiera le runtime avant d’autoriser le premier déploiement.</p></div><button class="modal-close" data-close>×</button></div><form id="projectForm" data-nxc-local><div class="form-grid"><div class="field"><label>Name</label><input name="name" placeholder="My Service" required></div><div class="field"><label>Slug</label><input name="slug" placeholder="my-service" pattern="[a-z0-9][a-z0-9._-]{1,62}" required></div><div class="field"><label>GitHub account</label><select name="githubConnectionId" id="githubConnection" required></select></div><div class="field"><label>Repository</label><select name="repository" id="repoSelect" required></select></div><div class="field"><label>Node / VPS</label><select name="nodeId" id="nodeSelect" required></select></div><div class="field"><label>Branch</label><input name="branch" value="main" required></div><div class="field"><label>Project type</label><select name="projectType"><option value="application">Application</option><option value="worker">Worker</option><option value="automation">Automation</option><option value="scheduled_job">Scheduled job</option></select></div><div class="field"><label>Runtime</label><input name="runtime" value="nodejs"></div><div class="field"><label>Current symlink</label><input name="currentPath" placeholder="/opt/nex/apps/public/my-service/current" required></div><div class="field"><label>Systemd service</label><input name="serviceName" placeholder="nex-my-service.service" required></div><div class="field"><label>Install command</label><input name="installCommand" value="npm ci"></div><div class="field"><label>Build command</label><input name="buildCommand" placeholder="npm run build"></div><div class="field full"><label>Pre-deploy checks</label><input name="predeployCommand" placeholder="npm test"></div><div class="field"><label>Start command (metadata)</label><input name="startCommand" placeholder="node index.js"></div><div class="field"><label>Local health URL (optional)</label><input name="healthUrl" placeholder="http://127.0.0.1:3000/health"></div><div class="field full"><label>Description</label><textarea name="description" placeholder="What this service does…"></textarea></div></div><div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Create project</button></div></form></div></div><div class="modal" id="manageModal"><div class="modal-card wide"><div class="modal-head"><div><small class="ey">Systemd runtime control</small><h3 id="manageTitle">Manage Project</h3><p>Actions limitées au service systemd enregistré pour ce projet. Les logs sont lus via journalctl sur le VPS associé.</p></div><button class="modal-close" data-close>×</button></div><div class="service-actions"><button type="button" data-service-action="start">Start</button><button type="button" class="primary" data-service-action="restart">Restart</button><button type="button" class="danger" data-service-action="stop">Stop</button></div><div class="logs-head"><small id="logsMeta">Latest service logs</small><button type="button" id="refreshLogs">Refresh logs</button></div><pre class="logs" id="projectLogs">Select a project.</pre></div></div><div class="toast" id="toast"></div><script>const GH='+githubUi+',NODES='+nodesUi+';const toast=document.getElementById("toast");function say(x,b){toast.textContent=x;toast.className="toast show"+(b?" bad":"");setTimeout(()=>toast.className="toast",3600)}const hostModal=document.getElementById("hostModal"),projectModal=document.getElementById("projectModal"),manageModal=document.getElementById("manageModal");let manageSlug="";function modal(name,on=true){const el=name==="host"?hostModal:projectModal;el.classList.toggle("open",on)}function option(value,label){const o=document.createElement("option");o.value=value;o.textContent=label;return o}function fillProjectSelectors(){const gc=document.getElementById("githubConnection"),rs=document.getElementById("repoSelect"),ns=document.getElementById("nodeSelect");gc.innerHTML="";ns.innerHTML="";GH.forEach(g=>gc.appendChild(option(g.id,g.name+" · @"+g.login)));NODES.forEach(n=>ns.appendChild(option(n.id,n.name)));const repos=GH.find(g=>g.id===gc.value)?.repos||[];rs.innerHTML="";repos.forEach(r=>rs.appendChild(option(r,r)))}fillProjectSelectors();document.getElementById("githubConnection").addEventListener("change",fillProjectSelectors);document.getElementById("menu").onclick=()=>document.body.classList.toggle("open");document.addEventListener("click",async e=>{const open=e.target.closest&&e.target.closest("[data-open]");if(open){modal(open.dataset.open,true);return}if(e.target.closest&&e.target.closest("[data-close]")){hostModal.classList.remove("open");projectModal.classList.remove("open");manageModal.classList.remove("open");return}if(e.target===hostModal)hostModal.classList.remove("open");if(e.target===projectModal)projectModal.classList.remove("open");if(e.target===manageModal)manageModal.classList.remove("open");const manage=e.target.closest&&e.target.closest("[data-manage]");if(manage){manageSlug=manage.dataset.manage;document.getElementById("manageTitle").textContent="Manage · "+manageSlug;manageModal.classList.add("open");loadProjectLogs();return}const action=e.target.closest&&e.target.closest("[data-service-action]");if(action&&manageSlug){const a=action.dataset.serviceAction;if((a==="stop"||a==="restart")&&!confirm(a.toUpperCase()+" "+manageSlug+"?"))return;action.disabled=true;try{const r=await fetch("/api/admin/infrastructure/projects/"+encodeURIComponent(manageSlug)+"/actions/"+encodeURIComponent(a),{method:"POST"});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Action refused");say(a+" queued · "+String(j.jobId||"").slice(0,8));setTimeout(loadProjectLogs,5500)}catch(err){say(err.message,true)}finally{action.disabled=false}return}const auto=e.target.closest&&e.target.closest("[data-auto]");if(auto&&!auto.disabled){const enabled=auto.dataset.enabled!=="1";auto.disabled=true;try{const r=await fetch("/api/admin/infrastructure/projects/"+encodeURIComponent(auto.dataset.auto)+"/autodeploy",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Action refusée");say(enabled?"Auto-deploy activé":"Auto-deploy désactivé");setTimeout(()=>location.reload(),600)}catch(err){say(err.message,true);auto.disabled=false}return}const verify=e.target.closest&&e.target.closest("[data-verify]");if(verify&&!verify.disabled){verify.disabled=true;try{const r=await fetch("/api/admin/infrastructure/projects/"+encodeURIComponent(verify.dataset.verify)+"/verify",{method:"POST"});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Verification failed");say("Runtime verification queued");setTimeout(()=>location.reload(),900)}catch(err){say(err.message,true);verify.disabled=false}return}const dep=e.target.closest&&e.target.closest("[data-deploy]");if(dep&&!dep.disabled){if(!confirm("Deploy the latest verified commit of "+dep.dataset.deploy+"?"))return;dep.disabled=true;try{const r=await fetch("/api/admin/infrastructure/projects/"+encodeURIComponent(dep.dataset.deploy)+"/deploy",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Deployment refused");say("Deployment queued · "+String(j.deploymentId||"").slice(0,8));setTimeout(()=>location.reload(),1000)}catch(err){say(err.message,true);dep.disabled=false}}});document.getElementById("hostForm").onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const body=Object.fromEntries(new FormData(e.currentTarget));const r=await fetch("/api/admin/infrastructure/hosts/setup-token",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Token generation failed");document.getElementById("hostCommandText").textContent=j.command;document.getElementById("hostCommand").classList.add("show");say("One-time VPS command generated")}catch(err){say(err.message,true)}finally{btn.disabled=false}};document.getElementById("copyHostCommand").onclick=async()=>{const t=document.getElementById("hostCommandText").textContent;try{await navigator.clipboard.writeText(t);say("Command copied")}catch{say("Copy unavailable — select the command manually",true)}};async function loadProjectLogs(){if(!manageSlug)return;const pre=document.getElementById("projectLogs"),meta=document.getElementById("logsMeta");pre.textContent="Loading logs…";try{const r=await fetch("/api/admin/infrastructure/projects/"+encodeURIComponent(manageSlug)+"/logs?lines=250");const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Logs unavailable");pre.textContent=j.logs||((j.pending?"Log job is still running. Press Refresh logs.":"No logs returned."));meta.textContent=(j.service||manageSlug)+" · "+(j.pending?"pending":"latest 250 lines")}catch(err){pre.textContent="Logs error: "+err.message}}document.getElementById("refreshLogs").onclick=loadProjectLogs;document.getElementById("projectForm").onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const body=Object.fromEntries(new FormData(e.currentTarget));const r=await fetch("/api/admin/infrastructure/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Project creation failed");say("Project created · runtime verification queued");setTimeout(()=>location.reload(),900)}catch(err){say(err.message,true)}finally{btn.disabled=false}};</script></body></html>';
}

async function infraRpc(name:string,payload:any={}){
  return infraDb("rpc/"+name,{method:"POST",headers:{"prefer":"return=representation"},body:JSON.stringify(payload)});
}
async function infraHostSetup(q:any){
  const name=String(q?.name||"NexControl Host").trim().slice(0,80)||"NexControl Host";
  if(!/^[A-Za-z0-9 _.-]{1,80}$/.test(name))throw new Error("invalid_host_name");
  const x=await infraRpc("nxc_admin_create_host_setup_token",{p_ttl_minutes:15});
  if(!x?.token||!/^[A-Za-z0-9_]+$/.test(String(x.token)))throw new Error("setup_token_generation_failed");
  const installer="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/ce2fdff3d76f2277f88c1e80f73ea133bb4ac515/ops/install-nexforge-host-agent.sh";
  const command="curl -fsSL '"+installer+"' | sudo bash -s -- '"+x.token+"' '"+name+"'";
  return {ok:true,command,expiresAt:x.expiresAt};
}
async function infraCreateProject(q:any){
  const repo=String(q?.repository||"").trim();
  const m=repo.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  if(!m)throw new Error("invalid_repository");
  const branch=String(q?.branch||"main").trim();
  const gh=await fetch("https://api.github.com/repos/"+encodeURIComponent(m[1])+"/"+encodeURIComponent(m[2])+"/branches/"+encodeURIComponent(branch),{headers:{"user-agent":"NexControl/2.0","accept":"application/vnd.github+json"},signal:AbortSignal.timeout(12000)});
  if(!gh.ok)throw new Error("repository_or_branch_unreachable_"+gh.status);
  const branchData=await gh.json();
  const headSha=String(branchData?.commit?.sha||"");
  if(!/^[0-9a-f]{40}$/i.test(headSha))throw new Error("github_missing_commit_sha");
  const data={name:String(q?.name||"").trim(),slug:String(q?.slug||"").trim().toLowerCase(),description:String(q?.description||"").trim(),githubConnectionId:String(q?.githubConnectionId||""),nodeId:String(q?.nodeId||""),repoOwner:m[1],repoName:m[2],branch,headSha,sourceVerified:true,projectType:String(q?.projectType||"application"),runtime:String(q?.runtime||"nodejs"),currentPath:String(q?.currentPath||"").trim(),serviceName:String(q?.serviceName||"").trim(),installCommand:String(q?.installCommand||"").trim(),buildCommand:String(q?.buildCommand||"").trim(),predeployCommand:String(q?.predeployCommand||"").trim(),startCommand:String(q?.startCommand||"").trim(),healthUrl:String(q?.healthUrl||"").trim()};
  const made=await infraRpc("nxc_admin_create_project",{p_data:data});
  try{await infraRpc("nxc_admin_retry_project_verification",{p_project_slug:data.slug})}catch{}
  return {...made,headSha};
}
async function infraVerifyProject(slug:string){return infraRpc("nxc_admin_retry_project_verification",{p_project_slug:slug})}
async function infraDeployProject(slug:string,q:any={}){
  const queued=await infraRpc("nxc_admin_queue_deployment",{p_project_slug:slug,p_commit_sha:q?.commitSha?String(q.commitSha):null,p_trigger_type:"manual"});
  try{await infraRpc("nxc_admin_deployment_tick",{})}catch{}
  return queued;
}

async function infraWaitHostJob(jobId:string,timeoutMs=9000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const rows=await infraDb("nxc_host_jobs?id=eq."+encodeURIComponent(jobId)+"&select=id,status,result,error,completed_at&limit=1");
    const job=rows?.[0];
    if(job&&["done","failed"].includes(job.status))return job;
    await new Promise(r=>setTimeout(r,450));
  }
  return null;
}
async function infraProjectAction(slug:string,action:string){
  return infraRpc("nxc_admin_project_action",{p_project_slug:slug,p_action:action});
}
async function infraProjectLogs(slug:string,lines:number){
  const queued=await infraRpc("nxc_admin_project_logs",{p_project_slug:slug,p_lines:lines});
  const job=await infraWaitHostJob(String(queued?.jobId||""),9000);
  if(!job)return {ok:true,pending:true,jobId:queued?.jobId,service:queued?.service};
  if(job.status==="failed")throw new Error(job.error||"log_job_failed");
  return {ok:true,pending:false,jobId:queued?.jobId,service:queued?.service,logs:String(job.result?.stdout||""),stderr:String(job.result?.stderr||"")};
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
async function infraSessionValid(cookie:string){
  if(!cookie)return false;
  try{
    const headers=new Headers({"x-nexcontrol-path":"/","accept":"text/html","cookie":cookie});
    const r=await fetch(BACKEND,{method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(8000)});
    return r.status===200&&!r.headers.get("location");
  }catch{return false}
}


// NEXCONTROL_PAGES_V4
async function ncState(){
  const base=await infraState();
  const [bots,dests,botJobs,botEvents,deliveries,agents,agentJobs,audit,watchdog,processSnapshots]=await Promise.all([
    infraDb("nxc_bots?select=id,slug,display_name,username,enabled,last_heartbeat_at,version,capabilities&order=display_name.asc"),
    infraDb("nxc_destinations?select=id,bot_id,chat_id,type,title,username,bot_status,can_publish,publish_block_reason,active,last_seen_at,last_verified_at&order=updated_at.desc&limit=180"),
    infraDb("nxc_bot_jobs?select=id,bot_id,kind,status,payload,result,error,created_at,completed_at&order=created_at.desc&limit=160"),
    infraDb("nxc_bot_events?select=id,bot_id,direction,event_type,chat_id,chat_type,chat_title,user_id,username,message_id,reply_to_message_id,text,payload,created_at&order=created_at.desc&limit=240"),
    infraDb("nxc_deliveries?select=id,bot_id,chat_id,destination_title,status,attempts,error,sent_at,created_at&order=created_at.desc&limit=160"),
    infraDb("nxc_agents?select=id,slug,display_name,enabled,version,hostname,platform,node_version,roots,last_heartbeat_at&order=display_name.asc"),
    infraDb("nxc_agent_jobs?select=id,agent_id,kind,status,payload,result,error,created_at,completed_at&order=created_at.desc&limit=120"),
    infraDb("nxc_operator_audit?select=id,origin,target_type,target_slug,action,job_id,created_at&order=created_at.desc&limit=140"),
    infraDb("nxc_external_watchdog_events?select=id,event_type,detail,created_at&order=created_at.desc&limit=80"),
    infraDb("nxc_agent_jobs?kind=eq.process.list&status=eq.done&select=result,created_at&order=created_at.desc&limit=1")
  ]);
  const by=(rows:any[],key:string)=>{const o:any={};for(const r of rows||[]){(o[r[key]]||=[]).push(r)}return o};
  return {...base,bots,dests,botJobs,botEvents,deliveries,agents,agentJobs,audit,watchdog,processes:processSnapshots?.[0]?.result?.items||[],processSnapshotAt:processSnapshots?.[0]?.created_at||null,
    destByBot:by(dests,"bot_id"),jobsByBot:by(botJobs,"bot_id"),eventsByBot:by(botEvents,"bot_id"),
    deliveriesByBot:by(deliveries,"bot_id"),jobsByAgent:by(agentJobs,"agent_id")};
}
function ncBotProject(slug:string){return slug==="nexgame"?"nexgames":slug}
function ncJson(v:any,max=2200){try{let x=JSON.stringify(v,null,2);if(x.length>max)x=x.slice(0,max)+"\n…";return infraEsc(x)}catch{return infraEsc(String(v??""))}}
function ncIcon(n:string){
  const p:any={
    home:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    server:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    project:'<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/>',
    bot:'<rect x="4" y="7" width="16" height="12" rx="4"/><path d="M9 3h6M12 3v4M8 12h.01M16 12h.01M9 16h6"/>',
    eye:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    deploy:'<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    git:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h5a5 5 0 0 1 5 5v5M6 8v10"/>',
    log:'<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    back:'<path d="m15 18-6-6 6-6"/>',
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>'
  };
  return '<svg viewBox="0 0 24 24">'+(p[n]||p.home)+'</svg>';
}
function ncPage(s:any,route:URL){
  const page=route.pathname.split("/")[2]||"overview";
  const defs:any={
    overview:["Discussions","Bots, automatisations et activités dans une vue façon Telegram."],
    servers:["Serveurs","VPS, agents, jobs, ressources et opérations système."],
    projects:["Projets","Services, GitHub, auto-deploy, santé, logs et contrôles."],
    automations:["Automatisations","Workers, watchers, schedulers et tâches qui tournent en continu."],
    bots:["Bots","Tous les bots. Chaque profil regroupe discussions, publications, fichiers, logs et sessions."],
    files:["Fichiers","Explorateur des fichiers runtime, projet par projet."],
    publications:["Publications","Ce que chaque bot publie, où il le publie et le statut de livraison."],
    profile:["Profil","Résumé administrateur NexControl et accès rapide."],
    "bot-view":["Bot View","Flux, destinations, jobs et logs live du bot."],
    deployments:["Déploiements","Pipelines, commits, plans et blocages."],
    github:["GitHub","Comptes connectés et watchers de dépôts."],
    activity:["Activité","Audit opérateur, agents et watchdog."]
  };
  const meta=defs[page]||defs.overview;
  const items=[
    ["overview","/infrastructure","home","Discussions"],
    ["conversations","/infrastructure/conversations","eye","Messages"],
    ["automations","/infrastructure/automations","deploy","Automatisations"],
    ["bots","/infrastructure/bots","bot","Bots"],
    ["projects","/infrastructure/projects","project","Projets"],
    ["servers","/infrastructure/servers","server","Serveurs"],
    ["files","/infrastructure/files","project","Fichiers"],
    ["publications","/infrastructure/publications","deploy","Publications"],
    ["deployments","/infrastructure/deployments","deploy","Déploiements"],
    ["github","/infrastructure/github","git","GitHub"],
    ["activity","/infrastructure/activity","log","Activité"],
    ["profile","/infrastructure/profile","eye","Profil"]
  ];
  const nav=items.map((x:any)=>'<a class="'+(page===x[0]?"on":"")+'" href="'+x[1]+'">'+ncIcon(x[2])+'<span>'+x[3]+'</span></a>').join("");
  const onlineBots=(s.bots||[]).filter((b:any)=>b.enabled&&b.last_heartbeat_at&&Date.now()-new Date(b.last_heartbeat_at).getTime()<180000).length;
  const onlineAgents=(s.agents||[]).filter((a:any)=>a.enabled&&a.last_heartbeat_at&&Date.now()-new Date(a.last_heartbeat_at).getTime()<180000).length;
  const healthy=(s.projects||[]).filter((p:any)=>p.health_status==="healthy").length;
  const pill=(v:any)=>infraPill(v);
  const section=(title:string,note:string,html:string)=>'<section><div class="sh"><div><small>NEXCONTROL</small><h2>'+infraEsc(title)+'</h2></div><p>'+infraEsc(note)+'</p></div>'+html+'</section>';
  let body="";
  let extra="";
  if(page==="overview"){
    const botRows=(s.bots||[]).map((b:any)=>{
      const on=b.enabled&&b.last_heartbeat_at&&Date.now()-new Date(b.last_heartbeat_at).getTime()<180000;
      const ev=s.eventsByBot[b.id]||[],last=ev[0],ds=s.destByBot[b.id]||[];
      const text=last?.text||((last?.payload?.mediaType||last?.payload?.hasMedia)?"["+(last?.payload?.mediaType||"média")+"]":"Aucune activité récente");
      const unread=ev.filter((e:any)=>!(e.direction==="out"||e.direction==="outgoing")&&Date.now()-new Date(e.created_at).getTime()<3600000).length;
      const initials=String(b.display_name||b.slug||"B").replace(/[^A-Za-z0-9 ]/g," ").trim().split(/\s+/).slice(0,2).map((x:string)=>x[0]||"").join("").toUpperCase()||"B";
      return '<a class="home-chat-row '+(b.slug==="nexai"?"featured":"")+'" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab=overview"><span class="home-avatar">'+infraEsc(initials)+'<i class="'+(on?"on":"")+'"></i></span><span class="home-chat-main"><span class="home-title"><b>'+infraEsc(b.display_name||b.slug)+'</b>'+(b.slug==="nexai"?'<em>◆</em>':'')+'</span><span class="home-preview">'+infraEsc(text)+'</span><span class="home-meta">'+(on?'<strong>● Live</strong>':'<strong class="off">○ Offline</strong>')+(b.slug==="nexai"?'<strong class="purple">Multi-session</strong>':'')+'<small>'+ds.length+' destination(s)</small></span></span><span class="home-side"><time>'+infraEsc(last?new Date(last.created_at).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):"—")+'</time>'+(unread?'<i>'+unread+'</i>':'<b>›</b>')+'</span></a>';
    }).join("");
    const autos=(s.processes||[]).filter((p:any)=>/(publisher|automation|orchestrator|worker|watcher|scanner|relay|anime|apk)/i.test(String(p.cmdline||""))).slice(0,5).map((p:any)=>{
      const label=String(p.name||"Automation"),initials=label.slice(0,2).toUpperCase();
      return '<a class="home-chat-row" href="/infrastructure/automations"><span class="home-avatar auto">'+infraEsc(initials)+'</span><span class="home-chat-main"><span class="home-title"><b>'+infraEsc(label)+'</b></span><span class="home-preview">'+infraEsc(String(p.cmdline||"").split(/\s+/).slice(0,9).join(" "))+'</span><span class="home-meta"><strong class="purple">ϟ Automation</strong><small>PID '+infraEsc(p.pid||"—")+'</small></span></span><span class="home-side"><time>'+infraEsc(infraAgo(s.processSnapshotAt))+'</time><b>›</b></span></a>';
    }).join("");
    body='<div class="home-titlebar"><div><b>Chats</b><span>'+((s.bots||[]).length+Math.min(5,autos.length))+'</span></div><input id="homeSearch" placeholder="Rechercher"></div><div class="home-chat-list" id="homeList">'+botRows+autos+'</div>';
    extra+='const hs=document.getElementById("homeSearch");if(hs)hs.oninput=()=>{const v=hs.value.toLowerCase();document.querySelectorAll("#homeList .home-chat-row").forEach(x=>x.style.display=x.textContent.toLowerCase().includes(v)?"grid":"none")};';
  }else if(page==="servers"){
    const cards=(s.agents||[]).map((a:any)=>{
      const on=a.enabled&&a.last_heartbeat_at&&Date.now()-new Date(a.last_heartbeat_at).getTime()<180000;
      const jobs=s.jobsByAgent[a.id]||[];
      const roots=(a.roots||[]).map((r:any)=>r.key).join(", ");
      return '<article class="card"><div class="between"><div><small>'+infraEsc(a.slug)+'</small><h3>'+infraEsc(a.display_name||a.slug)+'</h3></div>'+pill(on?"online":"offline")+'</div><div class="nums"><div><span>Version</span><b>'+infraEsc(a.version||"—")+'</b></div><div><span>Jobs</span><b>'+jobs.length+'</b></div><div><span>Heartbeat</span><b>'+infraEsc(infraAgo(a.last_heartbeat_at))+'</b></div></div><p class="muted">'+infraEsc(a.hostname||"")+' · '+infraEsc(a.platform||"")+' · Node '+infraEsc(a.node_version||"—")+'</p><p class="tiny">Roots: '+infraEsc(roots||"—")+'</p></article>';
    }).join("");
    const jobs=(s.agentJobs||[]).slice(0,80).map((j:any)=>'<div class="row"><div>'+pill(j.status)+'</div><div><b>'+infraEsc(j.kind)+'</b><p>'+infraEsc(j.error||"")+'</p><details><summary>Détails</summary><pre>'+ncJson({payload:j.payload,result:j.result})+'</pre></details></div><time>'+infraEsc(infraAgo(j.created_at))+'</time></div>').join("");
    body=section("Flotte","Tous les agents connectés.",'<div class="grid">'+cards+'</div>')+section("Jobs système","Historique récent.",'<div class="stream">'+jobs+'</div>');
  }else if(page==="projects"){
    const rows=(s.projects||[]).map((p:any)=>{
      const prof=s.profileByProject[p.id],plan=s.planByProject[p.id];
      const service=p.runtime_config?.systemdService||prof?.service_name||"—";
      return '<tr><td><b>'+infraEsc(p.name)+'</b><div class="tiny">'+infraEsc(p.repo_owner+"/"+p.repo_name)+'</div></td><td>'+pill(p.health_status||p.status)+'</td><td><code>'+infraEsc(service)+'</code></td><td>'+pill(plan?.status||"none")+'</td><td><div class="actions"><button class="btn" data-logs="'+infraEsc(p.slug)+'">Logs</button><button class="btn" data-action="project:'+infraEsc(p.slug)+':restart">Restart</button><button class="btn primary" data-deploy="'+infraEsc(p.slug)+'">Deploy</button><button class="btn" data-verify="'+infraEsc(p.slug)+'">Verify</button><button class="btn" data-auto="'+infraEsc(p.slug)+'" data-enabled="'+(p.auto_deploy?"1":"0")+'">'+(p.auto_deploy?"Auto ON":"Auto OFF")+'</button></div></td></tr>';
    }).join("");
    body=section("Tous les projets","Contrôle service, logs, validation et déploiement.",'<div class="tablebox"><table><thead><tr><th>Projet</th><th>Santé</th><th>Service</th><th>Plan</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
  }else if(page==="automations"){
    const rows=(s.processes||[]).filter((p:any)=>{const c=String(p.cmdline||"").toLowerCase();return /(worker|watcher|scheduler|automation|orchestrator|publisher|scanner|relay|supervise|tunnel|daemon|nexanime)/.test(c)});
    const classify=(cmd:string)=>{const c=String(cmd||"").toLowerCase();if(c.includes("anime"))return "Anime";if(c.includes("apk")||c.includes("liteapk"))return "APK";if(c.includes("otaku")||c.includes("dark-universe"))return "Otaku";if(c.includes("watcher"))return "Watcher";if(c.includes("publisher"))return "Publisher";if(c.includes("tunnel"))return "Tunnel";if(c.includes("worker"))return "Worker";return "Automation"};
    const cards=rows.map((p:any)=>{const cmd=String(p.cmdline||"");const short=cmd.split(/\\s+/).slice(0,7).join(" ");return '<article class="card"><div class="between"><div><small>'+infraEsc(classify(cmd))+'</small><h3>'+infraEsc(p.name||("PID "+p.pid))+'</h3></div>'+pill("running")+'</div><p class="muted">'+infraEsc(short)+'</p><div class="nums"><div><span>PID</span><b>'+infraEsc(p.pid||"—")+'</b></div><div><span>Snapshot</span><b>'+infraEsc(infraAgo(s.processSnapshotAt))+'</b></div></div><details><summary>Commande complète</summary><pre>'+infraEsc(cmd)+'</pre></details></article>'}).join("");
    const recurring=(s.botJobs||[]).filter((j:any)=>/auto|watch|publish|scan|sync|relay|schedule/i.test(String(j.kind||"")+" "+JSON.stringify(j.payload||{}))).slice(0,80).map((j:any)=>{const b=(s.bots||[]).find((x:any)=>x.id===j.bot_id);return '<div class="row"><div>'+pill(j.status)+'</div><div><b>'+infraEsc((b?.display_name||b?.slug||"Bot")+" · "+j.kind)+'</b><details><summary>Détails</summary><pre>'+ncJson(j.payload,2200)+'</pre></details></div><time>'+infraEsc(infraAgo(j.created_at))+'</time></div>'}).join("");
    body=section("Automatisations actives","Processus continus détectés sur le VPS principal.",'<div class="grid">'+(cards||'<div class="empty">Aucun worker continu détecté dans le dernier snapshot.</div>')+'</div>')+section("Tâches automatisées","Jobs et déclencheurs récents liés aux bots.",'<div class="stream">'+(recurring||'<div class="empty">Aucun job automatisé récent.</div>')+'</div>');
  }else if(page==="bots"){
    const cards=(s.bots||[]).map((b:any)=>{
      const ds=s.destByBot[b.id]||[],jobs=s.jobsByBot[b.id]||[],events=s.eventsByBot[b.id]||[];
      const chats=new Set(events.map((e:any)=>String(e.chat_id||"")).filter(Boolean));
      const on=b.enabled&&b.last_heartbeat_at&&Date.now()-new Date(b.last_heartbeat_at).getTime()<180000;
      const sessionButton=b.slug==="nexai"?'<a class="btn" href="/infrastructure/bot-view?bot=nexai&tab=sessions">Sessions</a>':"";
      return '<article class="card bot-card"><div class="between"><div><small>@'+infraEsc(b.username||"—")+'</small><h3>'+infraEsc(b.display_name||b.slug)+'</h3><span class="tiny">'+infraEsc(b.slug)+'</span></div>'+pill(on?"online":"offline")+'</div><div class="nums"><div><span>Conversations</span><b>'+chats.size+'</b></div><div><span>Messages</span><b>'+events.length+'</b></div><div><span>Destinations</span><b>'+ds.length+'</b></div><div><span>Jobs</span><b>'+jobs.length+'</b></div></div><div class="actions"><a class="btn primary" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab=overview">Ouvrir</a><a class="btn" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab=conversations">Conversations</a>'+sessionButton+'</div></article>';
    }).join("");
    body=section("Tous les bots","Chaque bot possède maintenant sa propre console : conversations, automatisations, fichiers, logs et sessions lorsqu’elles existent.",'<div class="grid">'+cards+'</div>');
  }else if(page==="bot-view"){
    const slug=String(route.searchParams.get("bot")||(s.bots||[])[0]?.slug||"");
    const tab=String(route.searchParams.get("tab")||"overview");
    const selectedChat=String(route.searchParams.get("chat")||"");
    const selectedSession=String(route.searchParams.get("session")||"");
    const b=(s.bots||[]).find((x:any)=>x.slug===slug)||(s.bots||[])[0];
    if(!b){body='<div class="empty">Aucun bot.</div>'}else{
      const events=s.eventsByBot[b.id]||[],jobs=s.jobsByBot[b.id]||[],ds=s.destByBot[b.id]||[];
      const chats:any={};
      for(const e of events){const id=String(e.chat_id||"");if(!id)continue;if(!chats[id])chats[id]={id,title:e.chat_title||e.username||id,type:e.chat_type||"chat",last:e.created_at,count:0};chats[id].count++;if(new Date(e.created_at)>new Date(chats[id].last))chats[id].last=e.created_at}
      for(const d of ds){const id=String(d.chat_id||"");if(id&&!chats[id])chats[id]={id,title:d.title||d.username||id,type:d.type||"destination",last:d.last_seen_at||d.last_verified_at,count:0}}
      const ordered=Object.values(chats).sort((a:any,b:any)=>new Date(b.last||0).getTime()-new Date(a.last||0).getTime());
      const activeChat=selectedChat||String((ordered[0] as any)?.id||"");
      const thread=events.filter((e:any)=>String(e.chat_id||"")===activeChat).slice().reverse();
      const tabs:any[]=[["overview","Profil"],["conversations","Discussions"],["publications","Publications"],["automations","Automatisations"]];
      if(b.slug==="nexai")tabs.push(["sessions","Sessions Telegram"]);
      tabs.push(["files","Fichiers"],["logs","Logs"]);
      const tabbar='<div style="display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 8px">'+tabs.map((t:any)=>'<a class="btn '+(tab===t[0]?"primary":"")+'" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab='+t[0]+'">'+infraEsc(t[1])+'</a>').join("")+'</div>';
      const initials=String(b.display_name||b.slug||"B").replace(/[^A-Za-z0-9 ]/g," ").trim().split(/\s+/).slice(0,2).map((x:string)=>x[0]||"").join("").toUpperCase()||"B";
      const head='<section class="tg-profile-head"><a class="tg-profile-back" href="/infrastructure/bots">‹</a><span class="tg-profile-avatar">'+infraEsc(initials)+'</span><div class="tg-profile-title"><h2>'+infraEsc(b.display_name||b.slug)+'</h2><p>@'+infraEsc(b.username||"—")+' · '+(b.enabled?"online":"offline")+'</p></div><button class="tg-profile-action" data-logs="'+infraEsc(b.slug)+'" data-kind="bot">≋</button><button class="tg-profile-action" data-action="bot:'+infraEsc(b.slug)+':restart">↻</button><span class="tg-profile-action">⋮</span></section>'+tabbar;
      if(tab==="conversations"){
        const list=ordered.map((c:any)=>'<a style="display:flex;justify-content:space-between;gap:12px;padding:13px;border-bottom:1px solid var(--line)" class="chatItem" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab=conversations&chat='+encodeURIComponent(c.id)+'"><div><b>'+infraEsc(c.title||c.id)+'</b><div class="tiny">'+infraEsc(c.type)+' · '+c.count+' message(s)</div></div><time class="tiny">'+infraEsc(infraAgo(c.last))+'</time></a>').join("");
        const messages=thread.map((e:any)=>{const mine=e.direction==="out"||e.direction==="outgoing";return '<div style="max-width:78%;align-self:'+(mine?"flex-end":"flex-start")+';background:'+(mine?"#19152a":"#11151b")+';border:1px solid var(--line);border-radius:18px;padding:11px 13px"><div class="tiny">'+infraEsc(mine?(b.display_name||b.slug):(e.username?"@"+e.username:(e.user_id||e.chat_title||"Utilisateur")))+'</div><div style="white-space:pre-wrap;margin-top:5px">'+infraEsc(e.text||((e.payload?.mediaType||e.payload?.hasMedia)?"["+(e.payload?.mediaType||"média")+"]":"(événement)"))+'</div><time class="tiny">'+infraEsc(new Date(e.created_at).toLocaleString("fr-FR"))+'</time></div>'}).join("");
        const sessionSel=b.slug==="nexai"?'<select id="composeSession"><option value="">Session NexAi automatique</option></select>':"";
        const composer=(activeChat||b.slug==="nexai")?'<div style="border-top:1px solid var(--line);padding:14px;display:grid;gap:8px">'+sessionSel+'<textarea id="composeText" placeholder="Écrire un message…" style="width:100%;min-height:72px;background:#0c0e13;color:#fff;border:1px solid var(--line);border-radius:14px;padding:12px"></textarea><div class="actions"><label class="btn">Média<input id="composeFile" type="file" accept="image/*,video/*,audio/*,.pdf,.zip" hidden></label><button class="btn" id="recordVoice">Vocal</button><button class="btn primary" id="sendCompose">Envoyer</button></div><div class="tiny" id="composeState">Envoi via '+infraEsc(b.display_name||b.slug)+'</div></div>':'<div class="empty">Choisis une conversation.</div>';
        body=head+'<section><div class="botChatLayout" style="display:grid;grid-template-columns:minmax(240px,32%) 1fr;min-height:68vh;border:1px solid var(--line);border-radius:20px;overflow:hidden"><aside id="chatSidebar" style="border-right:1px solid var(--line);overflow:auto"><div style="padding:10px;display:grid;gap:8px">'+(b.slug==="nexai"?'<select id="liveSession" style="width:100%"><option value="">Choisir une session Telegram…</option></select><div class="tiny" id="liveSessionState">Chargement des sessions…</div>':"")+'<input id="chatSearch" placeholder="Rechercher une conversation" style="width:100%;background:#0c0e13;color:#fff;border:1px solid var(--line);border-radius:12px;padding:10px"></div><div id="chatList">'+(list||'<div class="empty">Aucune conversation capturée pour ce bot.</div>')+'</div></aside><main style="display:flex;flex-direction:column;min-width:0"><div style="padding:14px;border-bottom:1px solid var(--line)"><b id="activeChatTitle">'+infraEsc((chats[activeChat] as any)?.title||activeChat||"Conversation")+'</b><div class="tiny" id="activeChatId">'+infraEsc(activeChat)+'</div></div><div id="messageList" style="display:flex;flex-direction:column;gap:8px;padding:14px;overflow:auto;flex:1;max-height:58vh">'+(messages||'<div class="empty">Aucun message enregistré.</div>')+'</div>'+composer+'</main></div></section>';
        extra+='const qs=document.getElementById("chatSearch");if(qs)qs.oninput=()=>{const v=qs.value.toLowerCase();document.querySelectorAll(".chatItem").forEach(x=>x.style.display=x.textContent.toLowerCase().includes(v)?"flex":"none")};';
        if(activeChat||b.slug==="nexai"){
          extra+='let recordedBlob=null,recorder=null,chunks=[];const rb=document.getElementById("recordVoice");if(rb)rb.onclick=async()=>{if(recorder&&recorder.state==="recording"){recorder.stop();rb.textContent="Vocal";return}try{const st=await navigator.mediaDevices.getUserMedia({audio:true});chunks=[];recorder=new MediaRecorder(st);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=()=>{recordedBlob=new Blob(chunks,{type:recorder.mimeType||"audio/webm"});st.getTracks().forEach(t=>t.stop());document.getElementById("composeState").textContent="Vocal prêt"};recorder.start();rb.textContent="Stop"}catch(e){document.getElementById("composeState").textContent="Micro inaccessible"}};';
          extra+='function to64(blob){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(",")[1]||"");r.onerror=no;r.readAsDataURL(blob)})}';
          extra+='const sb=document.getElementById("sendCompose");if(sb)sb.onclick=async()=>{const state=document.getElementById("composeState"),text=document.getElementById("composeText").value,file=document.getElementById("composeFile").files[0],media=recordedBlob||file;try{sb.disabled=true;state.textContent="Envoi…";const payload={chatId:(window.nxcActiveChat||'+JSON.stringify(activeChat)+'),text,sessionId:document.getElementById("composeSession")?.value||document.getElementById("liveSession")?.value||""};if(media){if(media.size>6000000)throw new Error("Média trop lourd pour ce composeur (6 Mo max)");payload.fileBase64=await to64(media);payload.fileName=file?.name||(recordedBlob?"voice.webm":"media");payload.mimeType=media.type||"application/octet-stream";payload.mode=recordedBlob?"voice":(media.type.startsWith("image/")?"photo":media.type.startsWith("video/")?"video":media.type.startsWith("audio/")?"audio":"document")}const r=await fetch("/api/admin/infrastructure/bots/'+encodeURIComponent(b.slug)+'/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}),j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"Envoi échoué");state.textContent="Envoyé";setTimeout(()=>location.reload(),650)}catch(e){state.textContent=e.message}finally{sb.disabled=false}};';
          if(b.slug==="nexai")extra+=`
(function(){
  const esc=v=>String(v==null?"":v).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;"}[c]));
  const live=document.getElementById("liveSession"),compose=document.getElementById("composeSession"),state=document.getElementById("liveSessionState"),list=document.getElementById("chatList"),messages=document.getElementById("messageList"),title=document.getElementById("activeChatTitle"),chatIdEl=document.getElementById("activeChatId");
  let dialogs=[];
  function time(v){try{return v?new Date(v).toLocaleString("fr-FR"):""}catch{return ""}}
  function mediaLabel(m){if(!m||!m.hasMedia)return "";return "["+String(m.mediaType||"média")+"]"}
  function renderDialogs(rows){
    dialogs=Array.isArray(rows)?rows:[];
    if(!list)return;
    if(!dialogs.length){list.innerHTML='<div class="empty">Aucune conversation disponible pour cette session.</div>';return}
    list.innerHTML=dialogs.map(d=>'<button class="liveChatItem" data-chat="'+esc(d.chatId)+'" style="width:100%;text-align:left;display:flex;justify-content:space-between;gap:12px;padding:13px;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;cursor:pointer"><div style="min-width:0"><b>'+esc(d.title||d.chatId)+'</b><div class="tiny">'+esc(d.type||"chat")+(d.unreadCount?' · '+esc(d.unreadCount)+' non lu(s)':'')+'</div><div class="tiny" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px">'+esc(d.lastMessage||mediaLabel(d.media)||"")+'</div></div><time class="tiny">'+esc(time(d.lastMessageAt))+'</time></button>').join("");
    list.querySelectorAll(".liveChatItem").forEach(btn=>btn.onclick=()=>loadHistory(btn.dataset.chat));
  }
  function renderMessages(rows){
    if(!messages)return;
    const m=Array.isArray(rows)?rows:[];
    messages.innerHTML=m.length?m.map(x=>'<div style="max-width:78%;align-self:'+(x.out?"flex-end":"flex-start")+';background:'+(x.out?"#19152a":"#11151b")+';border:1px solid var(--line);border-radius:18px;padding:11px 13px"><div style="white-space:pre-wrap">'+esc(x.text||mediaLabel(x)||"(événement)")+'</div><time class="tiny">'+esc(time(x.date))+'</time></div>').join(""):'<div class="empty">Aucun message dans cette conversation.</div>';
    messages.scrollTop=messages.scrollHeight;
  }
  async function loadHistory(chat){
    if(!live?.value||!chat)return;
    window.nxcActiveChat=String(chat);
    const d=dialogs.find(x=>String(x.chatId)===String(chat));
    if(title)title.textContent=d?.title||chat;if(chatIdEl)chatIdEl.textContent=chat;
    if(messages)messages.innerHTML='<div class="empty">Chargement des messages…</div>';
    try{
      const r=await fetch("/api/admin/infrastructure/bots/nexai/history?sessionId="+encodeURIComponent(live.value)+"&chatId="+encodeURIComponent(chat)+"&limit=120"),j=await r.json();
      if(!r.ok)throw new Error(j.message||j.error||"history_failed");
      renderMessages(j.messages||[]);
    }catch(e){if(messages)messages.innerHTML='<div class="empty">Erreur: '+esc(e.message)+'</div>'}
  }
  async function loadDialogs(){
    if(!live?.value)return;
    if(state)state.textContent="Synchronisation Telegram…";
    if(compose)compose.value=live.value;
    try{
      const r=await fetch("/api/admin/infrastructure/bots/nexai/conversations?sessionId="+encodeURIComponent(live.value)+"&limit=180"),j=await r.json();
      if(!r.ok)throw new Error(j.message||j.error||"conversation_load_failed");
      renderDialogs(j.dialogs||[]);
      if(state)state.textContent=(j.dialogs||[]).length+" conversation(s) · @"+(j.username||"session");
      const preferred=(j.dialogs||[]).find(d=>String(d.chatId)===String(window.nxcActiveChat||""))||(j.dialogs||[])[0];
      if(preferred)loadHistory(preferred.chatId);
    }catch(e){if(state)state.textContent="Erreur: "+e.message}
  }
  fetch("/api/admin/infrastructure/bots/nexai/sessions").then(r=>r.json()).then(j=>{
    const active=(j.runtimes||[]).filter(x=>x.connected);
    const preferred=active.find(x=>String(x.telegramUserId)===String(new URLSearchParams(location.search).get("session")||""))||active.find(x=>x.premium)||active.find(x=>String(x.username||"").toLowerCase()==="tresor20001")||active[0];
    for(const x of active){
      const label=(x.username?"@"+x.username:(x.firstName||x.telegramUserId))+" · "+x.telegramUserId+(x.premium?" · Premium":"");
      for(const sel of [live,compose])if(sel){const o=document.createElement("option");o.value=x.telegramUserId;o.textContent=label;sel.appendChild(o)}
    }
    if(preferred&&live){live.value=String(preferred.telegramUserId);if(compose)compose.value=live.value;loadDialogs()}
    else if(state)state.textContent="Aucune session Telegram active.";
  }).catch(e=>{if(state)state.textContent="Erreur sessions: "+e.message});
  if(live)live.onchange=()=>{window.nxcActiveChat="";loadDialogs()};
  const search=document.getElementById("chatSearch");
  if(search)search.oninput=()=>{const v=search.value.toLowerCase();document.querySelectorAll(".liveChatItem").forEach(x=>x.style.display=x.textContent.toLowerCase().includes(v)?"flex":"none")};
})();
`;
        }
      }else if(tab==="sessions"&&b.slug==="nexai"){
        body=head+section("Sessions Telegram connectées","Comptes stockés, runtimes actifs, worker, synchronisation, réparation et automatisations. Les numéros restent masqués.",'<div id="sessionGrid" class="grid"><div class="empty">Chargement des sessions live…</div></div>');
        extra+='fetch("/api/admin/infrastructure/bots/nexai/sessions").then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||"session_load_failed");const by={};for(const a of j.accounts||[])by[String(a.telegramUserId)]=a;const cards=(j.runtimes||[]).map(x=>{const a=by[String(x.telegramUserId)]||{};const ident=x.username?"@"+x.username:(x.firstName||x.telegramUserId);const detail={telegramUserId:x.telegramUserId,phone:a.phoneMasked||null,premium:Boolean(a.premium||x.premium),connected:x.connected,workerId:x.workerId,startedAt:x.startedAt,lastUpdateAt:x.lastUpdateAt,lastCatchUpAt:x.lastCatchUpAt,updateCount:x.updateCount,catchUpFailures:x.catchUpFailures,lastCommandPollAt:x.lastCommandPollAt,commandPollFailures:x.commandPollFailures,sessionRepairRequired:a.sessionRepairRequired,sessionRepairReason:a.sessionRepairReason,lastRuntimeSeenAt:a.lastRuntimeSeenAt,automations:x.automations,anime:x.anime,liteApks:x.liteApks};return "<article class=card><div class=between><div><small>SESSION TELEGRAM</small><h3>"+ident+"</h3><span class=tiny>"+x.telegramUserId+"</span></div><span class=pill>"+(x.connected?"connected":"offline")+"</span></div><div class=nums><div><span>Premium</span><b>"+(detail.premium?"Oui":"Non")+"</b></div><div><span>Updates</span><b>"+(x.updateCount||0)+"</b></div><div><span>Poll errors</span><b>"+(x.commandPollFailures||0)+"</b></div></div><details open><summary>Détails complets</summary><pre>"+JSON.stringify(detail,null,2)+"</pre></details><div class=actions><a class="btn primary" href="/infrastructure/bot-view?bot=nexai&tab=conversations&session="+encodeURIComponent(x.telegramUserId)>Conversations</a></div></article>"}).join("");const offline=(j.accounts||[]).filter(a=>!(j.runtimes||[]).some(x=>String(x.telegramUserId)===String(a.telegramUserId))).map(a=>"<article class=card><small>SESSION STOCKÉE</small><h3>"+(a.username?"@"+a.username:(a.firstName||a.telegramUserId))+"</h3><span class=pill>offline</span><pre>"+JSON.stringify({telegramUserId:a.telegramUserId,phone:a.phoneMasked,premium:a.premium,enabled:a.enabled,connectedAt:a.connectedAt,lastActivityAt:a.lastActivityAt,lastRuntimeSeenAt:a.lastRuntimeSeenAt,sessionRepairRequired:a.sessionRepairRequired,sessionRepairReason:a.sessionRepairReason},null,2)+"</pre><div class=actions><a class="btn" href="/infrastructure/bot-view?bot=nexai&tab=conversations&session="+encodeURIComponent(a.telegramUserId)>Conversations</a></div></article>").join("");document.getElementById("sessionGrid").innerHTML=cards+offline||"<div class=empty>Aucune session.</div>"}).catch(e=>document.getElementById("sessionGrid").innerHTML="<div class=empty>Erreur: "+e.message+"</div>");';
      }else if(tab==="publications"){
        const pubs=(s.deliveriesByBot?.[b.id]||[]).slice(0,120).map((d:any)=>{
          const out=events.find((e:any)=>String(e.message_id||"")===String(d.telegram_message_id||"")&&String(e.chat_id||"")===String(d.chat_id||""));
          return '<div class="publication-item"><div class="pub-icon">↗</div><div><b>'+infraEsc(d.destination_title||d.chat_id||"Destination")+'</b><p>'+infraEsc(out?.text||("Publication #"+(d.telegram_message_id||"—")))+'</p><small>'+infraEsc(d.chat_id||"")+' · '+infraEsc(d.sent_at?new Date(d.sent_at).toLocaleString("fr-FR"):infraAgo(d.created_at))+'</small></div>'+pill(d.status)+'</div>';
        }).join("");
        const dests=ds.slice(0,100).map((d:any)=>'<div class="destination-item"><div><b>'+infraEsc(d.title||d.username||d.chat_id)+'</b><small>'+infraEsc(d.type||"chat")+' · '+infraEsc(d.chat_id)+'</small></div>'+pill(d.can_publish?"publish":"blocked")+'</div>').join("");
        body=head+section("Publications","Ce que ce bot a publié.",'<div class="publication-list">'+(pubs||'<div class="empty">Aucune publication enregistrée.</div>')+'</div>')+section("Destinations","Où ce bot peut publier.",'<div class="destination-list">'+(dests||'<div class="empty">Aucune destination enregistrée.</div>')+'</div>');
      }else if(tab==="automations"){
        const jb=jobs.slice(0,100).map((j:any)=>'<div class="row"><div>'+pill(j.status)+'</div><div><b>'+infraEsc(j.kind)+'</b><p>'+infraEsc(j.error||"")+'</p><details><summary>Payload / résultat</summary><pre>'+ncJson({payload:j.payload,result:j.result},3200)+'</pre></details></div><time>'+infraEsc(infraAgo(j.created_at))+'</time></div>').join("");
        const proc=(s.processes||[]).filter((p:any)=>String(p.cmdline||"").toLowerCase().includes(b.slug==="nexai"?"nexai":b.slug)).map((p:any)=>'<div class="row"><div>'+pill("running")+'</div><div><b>PID '+infraEsc(p.pid)+'</b><p>'+infraEsc(String(p.cmdline||"").slice(0,300))+'</p></div></div>').join("");
        body=head+section("Processus et automatisations","Workers et jobs rattachés à ce bot.",'<div class="stream">'+(proc+jb||'<div class="empty">Aucune automatisation enregistrée.</div>')+'</div>');
      }else if(tab==="files"){
        body=head+section("Fichiers du bot","L’explorateur s’ouvre directement sur le runtime du bot.",'<div class="card"><h3>'+infraEsc(b.display_name||b.slug)+'</h3><a class="btn primary" href="/infrastructure/files?root='+encodeURIComponent(b.slug)+'&path=.">Ouvrir les fichiers</a></div>');
      }else if(tab==="logs"){
        body=head+section("Logs runtime","Journal du service correspondant à ce bot.",'<div class="card"><h3>Logs live</h3><button class="btn primary" data-logs="'+infraEsc(b.slug)+'" data-kind="bot">Ouvrir les logs</button></div>');
      }else{
        const on=b.enabled&&b.last_heartbeat_at&&Date.now()-new Date(b.last_heartbeat_at).getTime()<180000;
        const dr=ds.slice(0,40).map((d:any)=>'<tr><td><b>'+infraEsc(d.title||d.username||d.chat_id)+'</b><div class="tiny">'+infraEsc(d.chat_id)+'</div></td><td>'+infraEsc(d.type||"—")+'</td><td>'+pill(d.can_publish?"publish":"known")+'</td><td>'+infraEsc(infraAgo(d.last_seen_at||d.last_verified_at))+'</td></tr>').join("");
        body=head+'<section><div class="grid"><article class="card"><div class="between"><div><small>État</small><h3>'+infraEsc(b.slug)+'</h3></div>'+pill(on?"online":"offline")+'</div><div class="nums"><div><span>Conversations</span><b>'+ordered.length+'</b></div><div><span>Messages</span><b>'+events.length+'</b></div><div><span>Destinations</span><b>'+ds.length+'</b></div><div><span>Heartbeat</span><b>'+infraEsc(infraAgo(b.last_heartbeat_at))+'</b></div></div></article><article class="card"><small>Accès rapide</small><h3>Console du bot</h3><div class="actions"><a class="btn primary" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab=conversations">Conversations</a><a class="btn" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug)+'&tab=automations">Automatisations</a>'+(b.slug==="nexai"?'<a class="btn" href="/infrastructure/bot-view?bot=nexai&tab=sessions">Sessions Telegram</a>':"")+'</div></article></div></section>'+section("Destinations connues","Groupes, canaux et chats détectés.",'<div class="tablebox"><table><thead><tr><th>Destination</th><th>Type</th><th>État</th><th>Vu</th></tr></thead><tbody>'+dr+'</tbody></table></div>');
      }
    }
  }else if(page==="conversations"){
    const ev=(s.botEvents||[]).filter((e:any)=>e.chat_type==="group"||e.chat_type==="supergroup").slice().reverse();
    const groups:any={};for(const e of ev){const k=String(e.chat_id||"");if(k&&!groups[k])groups[k]={id:k,title:e.chat_title||k}}
    const options='<option value="">Tous les groupes</option>'+Object.values(groups).map((g:any)=>'<option value="'+infraEsc(g.id)+'">'+infraEsc(g.title||g.id)+'</option>').join("");
    const initial=ev.map((e:any)=>'<div class="row conversation" data-chat="'+infraEsc(e.chat_id||"")+'"><div>'+pill(e.direction||"incoming")+'</div><div><b>'+infraEsc(e.chat_title||e.chat_id||"Groupe")+'</b><p>'+infraEsc(e.text||"(média / événement sans texte)")+'</p><span class="tiny">'+infraEsc(e.username?"@"+e.username:(e.user_id||""))+' · vu par '+infraEsc(e.payload?.accountUsername?"@"+e.payload.accountUsername:(e.payload?.accountTelegramUserId||"NexAi"))+'</span></div><time>'+infraEsc(infraAgo(e.created_at))+'</time></div>').join("");
    body='<section><div class="sh"><div><small>LIVE GROUP STREAM</small><h2>Conversations</h2></div><select id="groupPick">'+options+'</select></div><article class="card"><div class="between"><div><small>État</small><h3>Flux NexAi</h3></div>'+pill("live")+'</div><p class="muted">Uniquement les groupes et supergroupes vus par les comptes NexAi connectés. Les messages privés ne sont pas collectés dans cette vue.</p></article></section>'+
      section("Messages en temps réel","Actualisation automatique environ chaque seconde.",'<div class="stream" id="conversationStream">'+(initial||'<div class="empty" id="conversationEmpty">En attente du premier message de groupe…</div>')+'</div>');
    extra='let convAfter='+JSON.stringify(ev.length?ev[ev.length-1].created_at:"")+',groupFilter="";var stream=document.getElementById("conversationStream"),pick=document.getElementById("groupPick");function ce(x){return String(x==null?"":x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}function addConv(e){var d=document.createElement("div");d.className="row conversation";d.dataset.chat=String(e.chat_id||"");var seen=e.payload&&e.payload.accountUsername?"@"+e.payload.accountUsername:(e.payload&&e.payload.accountTelegramUserId||"NexAi");var who=e.username?"@"+e.username:(e.user_id||"");d.innerHTML="<div><span class=\"pill\">"+ce(e.direction||"incoming")+"</span></div><div><b>"+ce(e.chat_title||e.chat_id||"Groupe")+"</b><p>"+ce(e.text||"(média / événement sans texte)")+"</p><span class=\"tiny\">"+ce(who)+" · vu par "+ce(seen)+"</span></div><time>maintenant</time>";stream.appendChild(d)}function applyGroup(){document.querySelectorAll(".conversation").forEach(function(x){x.style.display=!groupFilter||x.dataset.chat===groupFilter?"grid":"none"})}pick.onchange=function(){groupFilter=pick.value;applyGroup()};async function pollConv(){try{var u="/api/admin/infrastructure/conversations"+(convAfter?"?after="+encodeURIComponent(convAfter):"");var r=await fetch(u),j=await r.json();if(r.ok&&Array.isArray(j.events)&&j.events.length){var empty=document.getElementById("conversationEmpty");if(empty)empty.remove();j.events.forEach(function(e){addConv(e);convAfter=e.created_at||convAfter;var exists=false;for(var i=0;i<pick.options.length;i++)if(pick.options[i].value===String(e.chat_id||""))exists=true;if(e.chat_id&&!exists){var o=document.createElement("option");o.value=e.chat_id;o.textContent=e.chat_title||e.chat_id;pick.appendChild(o)}});while(stream.children.length>350)stream.removeChild(stream.firstElementChild);applyGroup()}}catch(e){}setTimeout(pollConv,1200)}setTimeout(pollConv,700);';

  }else if(page==="publications"){
    const pubs=(s.deliveries||[]).slice(0,200).map((d:any)=>{
      const b=(s.bots||[]).find((x:any)=>x.id===d.bot_id)||{};
      const out=(s.eventsByBot?.[d.bot_id]||[]).find((e:any)=>String(e.message_id||"")===String(d.telegram_message_id||"")&&String(e.chat_id||"")===String(d.chat_id||""));
      return '<a class="publication-item" href="/infrastructure/bot-view?bot='+encodeURIComponent(b.slug||"")+'&tab=publications"><div class="pub-avatar">'+infraEsc(String(b.display_name||b.slug||"B").slice(0,2).toUpperCase())+'</div><div><b>'+infraEsc(b.display_name||b.slug||"Bot")+' → '+infraEsc(d.destination_title||d.chat_id||"Destination")+'</b><p>'+infraEsc(out?.text||("Publication #"+(d.telegram_message_id||"—")))+'</p><small>'+infraEsc(d.chat_id||"")+' · '+infraEsc(d.sent_at?new Date(d.sent_at).toLocaleString("fr-FR"):infraAgo(d.created_at))+'</small></div>'+pill(d.status)+'</a>';
    }).join("");
    body=section("Publications","Ce que les bots publient, où et avec quel résultat.",'<div class="publication-list">'+(pubs||'<div class="empty">Aucune publication enregistrée.</div>')+'</div>');
  }else if(page==="profile"){
    body='<section class="profile-summary"><div class="profile-orb">NC</div><h2>NexControl</h2><p>Private operations console · Nextech</p><div class="profile-counters"><a href="/infrastructure/bots"><b>'+String((s.bots||[]).length)+'</b><span>Bots</span></a><a href="/infrastructure/automations"><b>'+String((s.processes||[]).length)+'</b><span>Processus</span></a><a href="/infrastructure/servers"><b>'+String((s.nodes||[]).length)+'</b><span>VPS</span></a></div></section>'+section("Accès rapide","Toutes les zones de contrôle.",'<div class="quick-links"><a href="/infrastructure/conversations">Messages</a><a href="/infrastructure/publications">Publications</a><a href="/infrastructure/files">Fichiers</a><a href="/infrastructure/projects">Projets</a><a href="/infrastructure/activity">Activité</a><a href="/infrastructure/github">GitHub</a></div>');
  }else if(page==="files"){
    const agent=(s.agents||[]).find((a:any)=>a.slug==="nexus-main");
    const roots=agent?.roots||[];
    const requestedRoot=String(route.searchParams.get("root")||(roots.some((r:any)=>r.key==="nexai")?"nexai":(roots[0]?.key||"nexus")));
    const requestedPath=String(route.searchParams.get("path")||".");
    const rootOpts=roots.map((r:any)=>'<option value="'+infraEsc(r.key)+'" '+(r.key===requestedRoot?"selected":"")+'>'+infraEsc(r.key)+' · '+infraEsc(r.path)+'</option>').join("");
    body='<section><div class="sh"><div><small>RUNTIME FILESYSTEM</small><h2>Explorateur de fichiers</h2></div><div class="actions"><select id="rootPick">'+rootOpts+'</select><button class="btn" id="fileUp">↑ Parent</button></div></div><article class="card"><small>Chemin actuel</small><h3 id="filePath">'+infraEsc(requestedPath)+'</h3><p class="muted">Navigation en lecture seule. Les secrets et fichiers hors des roots autorisés restent inaccessibles.</p></article></section>'+
      section("Fichiers","Dossiers et fichiers du projet sélectionné.",'<div class="tablebox"><table><thead><tr><th>Nom</th><th>Type</th><th>Taille</th><th>Modifié</th></tr></thead><tbody id="fileRows"><tr><td colspan="4">Chargement…</td></tr></tbody></table></div>')+
      section("Aperçu","Contenu du fichier sélectionné.",'<div class="card"><b id="previewName">Aucun fichier sélectionné</b><pre id="filePreview" style="max-height:65vh;overflow:auto;margin-top:12px">Sélectionne un fichier.</pre></div>');
    extra='var fileRoot='+JSON.stringify(requestedRoot)+',filePath='+JSON.stringify(requestedPath)+';var rows=document.getElementById("fileRows"),pathEl=document.getElementById("filePath"),preview=document.getElementById("filePreview"),previewName=document.getElementById("previewName");function fp(a,b){return !a||a==="."?b:a.replace(/\\\/$/,"")+"/"+b}function parentPath(p){if(!p||p===".")return ".";var a=p.split("/").filter(Boolean);a.pop();return a.length?a.join("/"):"."}function cell(tr,v){var d=document.createElement("td");d.textContent=v==null?"—":String(v);tr.appendChild(d)}async function loadFiles(){rows.innerHTML="<tr><td colspan=\"4\">Chargement…</td></tr>";pathEl.textContent=filePath;var r=await fetch("/api/admin/infrastructure/files/list?root="+encodeURIComponent(fileRoot)+"&path="+encodeURIComponent(filePath)),j=await r.json();if(!r.ok){rows.innerHTML="<tr><td colspan=\"4\">Erreur: "+String(j.message||j.error||r.status)+"</td></tr>";return}var items=(j.result&&((j.result.items)||(j.result.entries)))||j.items||[];rows.innerHTML="";items.forEach(function(x){var tr=document.createElement("tr");tr.style.cursor="pointer";var name=x.name||x.path||"",type=x.type||(x.isDirectory?"directory":"file");tr.dataset.name=name;tr.dataset.type=type;cell(tr,(type==="directory"?"📁 ":"📄 ")+name);cell(tr,type);cell(tr,x.size!=null?x.size:(x.bytes!=null?x.bytes:"—"));cell(tr,x.mtime||x.modifiedAt||"—");rows.appendChild(tr)});if(!items.length)rows.innerHTML="<tr><td colspan=\"4\">Dossier vide.</td></tr>"}rows.onclick=async function(e){var tr=e.target.closest("tr[data-name]");if(!tr)return;var next=fp(filePath,tr.dataset.name);if(tr.dataset.type==="directory"||tr.dataset.type==="dir"){filePath=next;loadFiles();return}previewName.textContent=next;preview.textContent="Chargement…";var r=await fetch("/api/admin/infrastructure/files/read?root="+encodeURIComponent(fileRoot)+"&path="+encodeURIComponent(next)),j=await r.json();preview.textContent=r.ok?((j.result&&j.result.content)||j.content||JSON.stringify(j.result||j,null,2)):"Erreur: "+String(j.message||j.error||r.status)};document.getElementById("rootPick").onchange=function(e){fileRoot=e.target.value;filePath=".";loadFiles()};document.getElementById("fileUp").onclick=function(){filePath=parentPath(filePath);loadFiles()};loadFiles();';
  }else if(page==="deployments"){
    const rows=(s.deployments||[]).map((d:any)=>'<tr><td><code>'+infraEsc(String(d.commit_sha||"").slice(0,12))+'</code><div class="tiny">'+infraEsc(d.branch||"—")+'</div></td><td>'+pill(d.status)+'</td><td>'+infraEsc(d.trigger_type||d.source_provider||"—")+'</td><td>'+infraEsc(infraAgo(d.created_at))+'</td><td><details><summary>Détails</summary><pre>'+ncJson(d.metadata)+'</pre></details></td></tr>').join("");
    body=section("Déploiements","Historique et détails des mutations production.",'<div class="tablebox"><table><thead><tr><th>Commit</th><th>État</th><th>Source</th><th>Créé</th><th>Détails</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
  }else if(page==="github"){
    const cards=(s.github||[]).map((g:any)=>'<article class="card"><div class="between"><div><small>'+infraEsc(g.account_type||"account")+'</small><h3>'+infraEsc(g.display_name||g.account_login)+'</h3></div>'+pill(g.is_active?"active":"inactive")+'</div><p class="muted">@'+infraEsc(g.account_login)+'</p><pre>'+infraEsc((g.repository_allowlist||[]).join("\n")||"Aucun dépôt allowlisté")+'</pre></article>').join("");
    const ws=(s.watches||[]).map((w:any)=>'<div class="row"><div>'+pill(w.blocked?"blocked":"ready")+'</div><div><b>'+infraEsc(w.repo_owner+"/"+w.repo_name+" · "+w.branch)+'</b><p>'+infraEsc(w.blocked_reason||String(w.last_sha||"").slice(0,12))+'</p></div><time>'+infraEsc(infraAgo(w.last_polled_at))+'</time></div>').join("");
    body=section("Comptes GitHub","Connexions et dépôts autorisés.",'<div class="grid">'+cards+'</div>')+section("Watchers","Surveillance des branches.",'<div class="stream">'+ws+'</div>');
  }else if(page==="activity"){
    const aud=(s.audit||[]).map((a:any)=>'<div class="row"><div>'+pill(a.origin||"audit")+'</div><div><b>'+infraEsc((a.target_slug||a.target_type||"system")+" · "+a.action)+'</b><p>'+infraEsc(a.job_id?"job "+a.job_id:"")+'</p></div><time>'+infraEsc(infraAgo(a.created_at))+'</time></div>').join("");
    const wd=(s.watchdog||[]).map((e:any)=>'<div class="row"><div>'+pill(e.event_type||"watchdog")+'</div><div><b>'+infraEsc(e.event_type||"event")+'</b><details><summary>Détails</summary><pre>'+ncJson(e.detail)+'</pre></details></div><time>'+infraEsc(infraAgo(e.created_at))+'</time></div>').join("");
    body=section("Audit opérateur","Actions déclenchées depuis NexControl.",'<div class="stream">'+aud+'</div>')+section("Watchdog","Supervision et remédiation.",'<div class="stream">'+wd+'</div>');
  }else{body='<div class="empty">Page inconnue.</div>'}

  const css="\n:root{--bg:#050817;--panel:#0a1022;--panel2:#0e1530;--line:#20294d;--line2:#334071;--ink:#f7f8ff;--muted:#8d98b7;--blue:#7789ff;--purple:#9b67ff;--green:#4ce9a8;--yellow:#ffbf54;--red:#ff7890;--nav:76px}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% -10%,#4938a735,transparent 34%),radial-gradient(circle at 90% 12%,#4f2a9126,transparent 30%),linear-gradient(180deg,#050817,#040713 75%);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}.app-wrap{width:min(1180px,100%);margin:auto;padding:12px 14px calc(var(--nav) + 34px)}.side{display:none}.main{margin:0;padding:0;max-width:none}.appbar{position:sticky;top:0;z-index:45;display:flex;align-items:center;gap:13px;padding:10px 0 13px;background:linear-gradient(180deg,#050817 72%,transparent);backdrop-filter:blur(16px)}.avatar-stack{display:flex;align-items:center}.avatar-stack i{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;margin-left:-11px;border:2px solid #050817;background:linear-gradient(135deg,#566cff,#9a56ff);font-size:11px;font-weight:900;box-shadow:0 0 20px #755dff2f}.avatar-stack i:first-child{margin-left:0}.app-brand{min-width:0}.app-brand b{display:block;font-size:26px;letter-spacing:-.055em}.app-brand span{display:block;color:#7e89a8;font-size:8px;letter-spacing:.24em;margin-top:1px}.app-actions{margin-left:auto;display:flex;gap:7px}.ico{width:42px;height:42px;border:1px solid #28335e;background:#0c1229;color:#dce1ff;border-radius:14px;display:grid;place-items:center;cursor:pointer}.ico svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7}.filter-nav{display:flex;gap:8px;overflow-x:auto;padding:4px 0 16px;scrollbar-width:none}.filter-nav::-webkit-scrollbar{display:none}.filter-nav a{display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid #27315a;background:#0b1126;color:#a6afc9;border-radius:19px;padding:10px 13px;font-size:11px}.filter-nav a.active{background:linear-gradient(135deg,#342c7b,#151c42);border-color:#786dff;color:#fff;box-shadow:0 0 22px #6d5cff37}.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 0 4px}.top>div{display:flex;align-items:center;gap:8px}.top b{font-size:12px}.top .tiny{font-size:8px;color:#737e9c}.hero{padding:14px 2px 18px}.hero small,.card small,.sh small{font-size:8px;letter-spacing:.14em;color:#6f7a99;text-transform:uppercase}.hero h1{font-size:clamp(34px,8vw,58px);line-height:.94;letter-spacing:-.06em;margin:7px 0 8px}.hero p,.muted{color:#8792b0;line-height:1.45;margin:0}.kpis{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:17px;overflow:hidden;background:#080d1e;margin:0 0 18px}.kpi{padding:12px 14px;border-right:1px solid var(--line)}.kpi:last-child{border:0}.kpi span,.nums span{font-size:8px;color:#6e7897;text-transform:uppercase;letter-spacing:.08em}.kpi b{display:block;font-size:22px;margin-top:4px}.section{margin:24px 0 38px}.sh{display:flex;justify-content:space-between;align-items:end;gap:14px;margin-bottom:10px}.sh h2{font-size:22px;letter-spacing:-.04em;margin:4px 0}.sh p{max-width:520px;color:#74809f;font-size:10px;margin:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}.card,.stream,.tablebox,.publication-list,.destination-list{border:1px solid var(--line);border-radius:19px;background:linear-gradient(180deg,#0b1126,#080d1d);overflow:hidden}.card{padding:16px}.between{display:flex;justify-content:space-between;gap:11px;align-items:start}.card h3{font-size:18px;margin:4px 0}.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px;margin:13px 0}.nums div{border:1px solid #20294c;border-radius:12px;padding:9px}.nums b{display:block;margin-top:3px;font-size:12px}.pill{display:inline-flex;align-items:center;gap:5px;border:1px solid #303a62;border-radius:999px;padding:5px 8px;font-size:8px;text-transform:uppercase;letter-spacing:.06em}.pill i{width:5px;height:5px;border-radius:50%;background:currentColor}.pill.ok{color:#58e9ae;border-color:#286d58;background:#08231b}.pill.bad{color:#ff8ba0;border-color:#6c3142;background:#250e18}.pill.warn{color:#ffca69;border-color:#675124;background:#241c0d}.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 11px;border:1px solid #2a345f;background:#10162e;color:#bec7e0;border-radius:11px;font-size:9px;font-weight:800;cursor:pointer}.btn.primary{background:linear-gradient(135deg,#6b73ff,#905fff);border-color:#7a72ff;color:#fff}.btn.danger{color:#ff9cad;border-color:#603044;background:#241019}.tiny{font-size:8px;color:#727d9c}.tablebox{overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:12px 13px;border-bottom:1px solid #19213f;font-size:10px;vertical-align:top}th{font-size:8px;color:#687391;text-transform:uppercase;letter-spacing:.1em}tr:last-child td{border:0}code{color:#b8afff}.stream{overflow:hidden}.row{display:grid;grid-template-columns:100px 1fr 90px;gap:11px;padding:12px 13px;border-bottom:1px solid #19213f}.row:last-child{border:0}.row b{font-size:10px}.row p{font-size:10px;color:#8b96b4;margin:4px 0;white-space:pre-wrap}.row time{font-size:8px;color:#6d7898;text-align:right}.row summary,details summary{font-size:8px;color:#8b96b4;cursor:pointer;margin-top:5px}.row pre,.card pre{max-height:300px;overflow:auto;background:#050918;border:1px solid #20294b;border-radius:10px;padding:10px;color:#adb6ce;font:9px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}.bot-card{position:relative;overflow:hidden}.bot-card:before{content:\"\";position:absolute;inset:-40% auto auto 60%;width:180px;height:180px;border-radius:50%;background:#765dff18;filter:blur(20px)}.bot-card .between,.bot-card .nums,.bot-card .actions{position:relative}.chatItem{background:#080d1d;color:#dfe3f4}.chatItem:hover{background:#0d1530}.botChatLayout{background:#060a16!important;border-color:#29335d!important}.botChatLayout aside{background:#080d1d}.botChatLayout main{background:radial-gradient(circle at 50% 15%,#26205f1c,transparent 38%),#060a16}.botChatLayout #messageList>div{box-shadow:0 6px 24px #0002}.publication-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:11px;align-items:center;padding:13px;border-bottom:1px solid #19213f}.publication-item:last-child{border:0}.publication-item p{margin:4px 0;color:#9aa4bf;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.publication-item small,.destination-item small{display:block;color:#6f7a98;font-size:9px}.pub-icon,.pub-avatar{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#5f5fff,#9b5cff);display:grid;place-items:center;color:#fff;font-weight:900}.destination-item{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:13px;border-bottom:1px solid #19213f}.destination-item:last-child{border:0}.profile-summary{text-align:center;border:1px solid var(--line);border-radius:22px;background:#080d1d;padding:28px 18px}.profile-orb{width:96px;height:96px;border-radius:30px;background:linear-gradient(135deg,#566bff,#b15dff);display:grid;place-items:center;margin:auto;font-size:28px;font-weight:900;box-shadow:0 0 35px #745cff45}.profile-summary h2{font-size:28px;margin:12px 0 3px}.profile-summary p{color:#7f8aa7;margin:0}.profile-counters{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:18px}.profile-counters a{min-width:95px;border:1px solid #29335b;border-radius:15px;padding:10px;background:#0d142b}.profile-counters b{display:block;font-size:19px}.profile-counters span{font-size:8px;color:#7782a1;text-transform:uppercase}.quick-links{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.quick-links a{border:1px solid var(--line);border-radius:14px;padding:12px;background:#080d1d;color:#bcc5df}.empty{padding:28px;color:#75809e;font-size:11px}.drawer{position:fixed;z-index:80;inset:0;background:#02040ddd;display:none;padding:70px 14px 14px;backdrop-filter:blur(12px)}.drawer.open{display:block}.drawerbox{max-width:540px;margin:auto;border:1px solid #303a66;border-radius:24px;background:#0a1022;padding:13px;max-height:80vh;overflow:auto}.drawerhead{display:flex;justify-content:space-between;align-items:center;padding:6px 7px 12px}.drawer .nav{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.drawer .nav a{display:flex;align-items:center;gap:9px;padding:12px;border:1px solid #20294c;border-radius:14px;color:#9ca6c3}.drawer .nav a.on{background:#171d43;color:#fff;border-color:#6d67ff}.nav svg{width:18px;height:18px;fill:none;stroke:currentColor}.modal{position:fixed;z-index:90;inset:0;display:none;align-items:center;justify-content:center;padding:15px;background:#000c;backdrop-filter:blur(12px)}.modal.open{display:flex}.modalbox{width:min(980px,100%);max-height:90vh;overflow:auto;background:#080d1d;border:1px solid #303a66;border-radius:22px;padding:15px}.modalbox pre{min-height:300px;max-height:65vh;overflow:auto;background:#050918;border:1px solid #20294c;border-radius:12px;padding:12px;color:#acb5cd;font:10px/1.5 ui-monospace,monospace;white-space:pre-wrap}.toast{position:fixed;right:16px;bottom:92px;z-index:110;background:#0e1530;border:1px solid #303b6b;border-radius:12px;padding:10px 12px;color:#dfe3f2;font-size:10px;opacity:0;transform:translateY(8px);transition:.2s}.toast.show{opacity:1;transform:none}.bottom-nav{position:fixed;z-index:70;left:50%;bottom:10px;transform:translateX(-50%);width:min(720px,calc(100% - 22px));height:68px;display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #354170;border-radius:27px;background:#0b1024e8;backdrop-filter:blur(18px);padding:6px;box-shadow:0 20px 60px #0008,0 0 30px #5639a72a}.bottom-nav a{display:grid;place-items:center;align-content:center;gap:2px;border-radius:21px;color:#95a0bf;font-size:9px}.bottom-nav a b{font-size:21px}.bottom-nav a.active{color:#fff;background:radial-gradient(circle at 50% 100%,#594ebd99,transparent 70%),#151b3f;box-shadow:inset 0 0 0 1px #6063d5}@media(max-width:850px){.app-wrap{padding:9px 10px calc(var(--nav) + 26px)}.app-brand b{font-size:22px}.app-brand span{display:none}.app-actions .optional{display:none}.filter-nav{padding-bottom:12px}.kpis{grid-template-columns:1fr 1fr}.kpi:nth-child(2){border-right:0}.kpi:nth-child(-n+2){border-bottom:1px solid var(--line)}.sh{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.botChatLayout{grid-template-columns:1fr!important}.botChatLayout aside{border-right:0!important;max-height:54vh}.botChatLayout main{min-height:64vh;border-top:1px solid var(--line)}.row{grid-template-columns:88px 1fr}.row time{display:none}.drawer .nav{grid-template-columns:1fr}.profile-counters{gap:6px}}
.home-titlebar{display:flex;align-items:center;gap:12px;margin:6px 0 12px}.home-titlebar>div{display:flex;align-items:center;gap:8px}.home-titlebar b{font-size:26px;letter-spacing:-.05em}.home-titlebar span{background:#7789ff;border-radius:11px;padding:3px 8px;font-size:11px}.home-titlebar input{margin-left:auto;width:min(260px,45vw);background:#0b1126;border:1px solid #27315a;color:#fff;border-radius:15px;padding:10px 12px}.home-chat-list{border:1px solid #20294d;border-radius:23px;overflow:hidden;background:#080d1d}.home-chat-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:13px;align-items:center;padding:14px;border-bottom:1px solid #19213f;position:relative}.home-chat-row:last-child{border:0}.home-chat-row:hover{background:#0d1530}.home-chat-row.featured{background:linear-gradient(105deg,#171443,#0c1530 70%);box-shadow:inset 0 0 0 1px #6f62ff}.home-avatar{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;position:relative;background:radial-gradient(circle at 30% 25%,#a785ff,#4c55bf 55%,#111830 56%);box-shadow:0 0 0 2px #735fff,0 0 24px #785fff30;font-size:14px;font-weight:900}.home-avatar.auto{border-radius:18px;background:linear-gradient(135deg,#5d5aff,#b855ff)}.home-avatar i{position:absolute;width:12px;height:12px;border-radius:50%;right:1px;bottom:1px;background:#5f6884;border:2px solid #080d1d}.home-avatar i.on{background:#4ce9a8;box-shadow:0 0 8px #4ce9a8}.home-chat-main{min-width:0}.home-title{display:flex;align-items:center;gap:7px}.home-title b{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.home-title em{font-style:normal;color:#aa7fff}.home-preview{display:block;color:#98a3bf;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:3px 0 7px}.home-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.home-meta strong{font-size:9px;color:#57e7aa;border:1px solid #276b57;background:#08221a;border-radius:999px;padding:3px 7px}.home-meta strong.off{color:#8994b1;border-color:#333c60;background:#10162a}.home-meta strong.purple{color:#c1a6ff;border-color:#5c4495;background:#19102e}.home-meta small{color:#697493;font-size:9px}.home-side{display:grid;justify-items:end;gap:8px}.home-side time{font-size:10px;color:#808ba9}.home-side i{font-style:normal;min-width:27px;height:27px;border-radius:11px;background:#7789ff;display:grid;place-items:center;font-size:10px}.home-side b{font-size:25px;color:#667190}.tg-profile-head{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto auto auto;gap:8px;align-items:center;padding:8px 0 12px;border-bottom:1px solid #19213f}.tg-profile-back,.tg-profile-action{width:42px;height:42px;border:1px solid #28335e;background:#0c1229;color:#e5e8ff;border-radius:14px;display:grid;place-items:center;font-size:23px;cursor:pointer}.tg-profile-avatar{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 30% 25%,#a785ff,#4c55bf 55%,#111830 56%);box-shadow:0 0 0 2px #735fff,0 0 22px #785fff35;font-weight:900}.tg-profile-title{min-width:0}.tg-profile-title h2{margin:0;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tg-profile-title p{margin:3px 0 0;color:#8390ad;font-size:10px}
@media(max-width:520px){.home-titlebar input{width:42vw}.home-chat-row{padding:12px}.home-avatar{width:52px;height:52px}.home-meta small{display:none}.tg-profile-head{grid-template-columns:auto auto minmax(0,1fr) auto auto}.tg-profile-head>.tg-profile-action:last-child{display:none}.avatar-stack i:nth-child(3){display:none}.hero h1{font-size:38px}.filter-nav a{padding:9px 11px}.kpis{margin-bottom:14px}.bottom-nav{height:64px}.bottom-nav a b{font-size:19px}.publication-item{grid-template-columns:auto minmax(0,1fr)}.publication-item>.pill{display:none}}\n";
  const kpis='<div class="kpis"><div class="kpi"><span>Bots online</span><b>'+onlineBots+'/'+(s.bots||[]).length+'</b></div><div class="kpi"><span>Projets sains</span><b>'+healthy+'/'+(s.projects||[]).length+'</b></div><div class="kpi"><span>Agents online</span><b>'+onlineAgents+'/'+(s.agents||[]).length+'</b></div><div class="kpi"><span>Alertes</span><b>'+(s.alerts||[]).length+'</b></div></div>';
  const js='const drawer=document.getElementById("drawer"),modal=document.getElementById("modal"),logBody=document.getElementById("logBody"),toast=document.getElementById("toast");function say(x){toast.textContent=x;toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),2400)}document.getElementById("menu").onclick=()=>drawer.classList.add("open");document.getElementById("closeMenu").onclick=()=>drawer.classList.remove("open");drawer.onclick=e=>{if(e.target===drawer)drawer.classList.remove("open")};document.getElementById("back").onclick=()=>history.length>1?history.back():location.href="/infrastructure";document.getElementById("refresh").onclick=()=>location.reload();document.getElementById("closeModal").onclick=()=>modal.classList.remove("open");modal.onclick=e=>{if(e.target===modal)modal.classList.remove("open")};document.addEventListener("keydown",e=>{if(e.key==="Escape"){drawer.classList.remove("open");modal.classList.remove("open")}});async function post(url,body){const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error||"Action refusée");return j}async function logs(slug,kind){modal.classList.add("open");logBody.textContent="Chargement…";const base=kind==="bot"?"/api/admin/infrastructure/bots/":"/api/admin/infrastructure/projects/";const r=await fetch(base+encodeURIComponent(slug)+"/logs?lines=260");const j=await r.json().catch(()=>({}));logBody.textContent=r.ok?(j.logs||j.stderr||"Aucun log."):"Erreur: "+(j.message||j.error||r.status)}document.addEventListener("click",async e=>{const t=e.target.closest&&e.target.closest("[data-logs],[data-action],[data-deploy],[data-verify],[data-auto]");if(!t)return;try{if(t.dataset.logs){logs(t.dataset.logs,t.dataset.kind||"project");return}t.disabled=true;if(t.dataset.action){const a=t.dataset.action.split(":");await post("/api/admin/infrastructure/"+(a[0]==="bot"?"bots/":"projects/")+encodeURIComponent(a[1])+"/actions/"+a[2]);say(a[2]+" envoyé");setTimeout(()=>location.reload(),800)}else if(t.dataset.deploy){await post("/api/admin/infrastructure/projects/"+encodeURIComponent(t.dataset.deploy)+"/deploy",{});say("Déploiement lancé");setTimeout(()=>location.reload(),800)}else if(t.dataset.verify){await post("/api/admin/infrastructure/projects/"+encodeURIComponent(t.dataset.verify)+"/verify");say("Vérification lancée");setTimeout(()=>location.reload(),800)}else if(t.dataset.auto){const enabled=t.dataset.enabled!=="1";await post("/api/admin/infrastructure/projects/"+encodeURIComponent(t.dataset.auto)+"/autodeploy",{enabled});say(enabled?"Auto-deploy activé":"Auto-deploy désactivé");setTimeout(()=>location.reload(),700)}}catch(err){say(err.message||String(err));t.disabled=false}});'+extra;
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#050817"><title>'+infraEsc(meta[0])+' · NexControl</title><style>'+css+'</style></head><body><div class="app-wrap"><header class="appbar"><div class="avatar-stack"><i>NA</i><i>ST</i><i>NS</i></div><div class="app-brand"><b>NexControl</b><span>BOTS · AUTOMATIONS · BEYOND</span></div><div class="app-actions"><a class="ico optional" href="/infrastructure/conversations">⌕</a><a class="ico optional" href="/infrastructure/profile">⌾</a><button id="menu" class="ico">⋮</button></div></header><nav class="filter-nav"><a class="'+(page==="overview"?"active":"")+'" href="/infrastructure"><b>◫</b>Tout</a><a class="'+(page==="conversations"?"active":"")+'" href="/infrastructure/conversations"><b>◌</b>Messages</a><a class="'+(page==="bots"||page==="bot-view"?"active":"")+'" href="/infrastructure/bots"><b>◉</b>Bots</a><a class="'+(page==="automations"?"active":"")+'" href="/infrastructure/automations"><b>ϟ</b>Automations</a><a class="'+(page==="servers"?"active":"")+'" href="/infrastructure/servers"><b>▤</b>VPS</a><a class="'+(page==="files"?"active":"")+'" href="/infrastructure/files"><b>□</b>Fichiers</a><a class="'+(page==="publications"?"active":"")+'" href="/infrastructure/publications"><b>↗</b>Publications</a></nav><main class="main"><header class="top"><div><button id="back" class="ico">'+ncIcon("back")+'</button><b>'+infraEsc(meta[0])+'</b></div><div><span class="tiny">LIVE</span><button id="refresh" class="ico">↻</button></div></header><div class="hero"><small>CONTROL PLANE PRIVÉ</small><h1>'+infraEsc(meta[0])+'</h1><p>'+infraEsc(meta[1])+'</p></div>'+kpis+body+'</main></div><nav class="bottom-nav"><a class="'+(["overview","conversations","bots","bot-view"].includes(page)?"active":"")+'" href="/infrastructure"><b>◌</b><span>Chats</span></a><a class="'+(["servers","files","projects","deployments","github","publications"].includes(page)?"active":"")+'" href="/infrastructure/servers"><b>▤</b><span>Infrastructure</span></a><a class="'+(page==="automations"?"active":"")+'" href="/infrastructure/automations"><b>ϟ</b><span>Automations</span></a><a class="'+(page==="profile"?"active":"")+'" href="/infrastructure/profile"><b>○</b><span>Profil</span></a></nav><div id="drawer" class="drawer"><div class="drawerbox"><div class="drawerhead"><b>NEXCONTROL</b><button id="closeMenu" class="ico">'+ncIcon("close")+'</button></div><nav class="nav">'+nav+'</nav></div></div><div id="modal" class="modal"><div class="modalbox"><div class="between"><b>Runtime logs</b><button id="closeModal" class="ico">'+ncIcon("close")+'</button></div><pre id="logBody">Chargement…</pre></div></div><div id="toast" class="toast"></div><script>'+js+'</script></body></html>';
}


 // NEXCONTROL_FILES_CONVERSATIONS_HELPERS_V1
 async function ncPrimaryAgent(){
   const rows=await infraDb("nxc_agents?slug=eq.nexus-main&select=id,slug,roots,last_heartbeat_at&limit=1");
   const a=rows?.[0]; if(!a)throw new Error("nexus_main_agent_not_found"); return a;
 }
 async function ncQueueAgentJob(kind:string,payload:any){
   const a=await ncPrimaryAgent();
   const rows=await infraDb("nxc_agent_jobs",{
     method:"POST",
     headers:{"prefer":"return=representation"},
     body:JSON.stringify({agent_id:a.id,kind,payload,status:"pending",available_at:new Date().toISOString(),created_by:"nexcontrol-files-v1"})
   });
   const j=rows?.[0]; if(!j?.id)throw new Error("agent_job_create_failed"); return j.id;
 }
 async function ncWaitAgentJob(id:string,timeoutMs=12000){
   const until=Date.now()+timeoutMs;
   while(Date.now()<until){
     const rows=await infraDb("nxc_agent_jobs?id=eq."+encodeURIComponent(id)+"&select=id,status,result,error,completed_at&limit=1");
     const j=rows?.[0];
     if(j?.status==="done")return j.result||{};
     if(j?.status==="failed")throw new Error(j.error||"agent_job_failed");
     await new Promise(r=>setTimeout(r,450));
   }
   return {pending:true,jobId:id};
 }
 function ncSafeRoot(v:any){
   const x=String(v||"").trim();
   if(!/^[A-Za-z0-9._-]{1,80}$/.test(x))throw new Error("invalid_root");
   return x;
 }
 function ncSafePath(v:any){
   const x=String(v||".").trim()||".";
   if(x.length>1600||/[\u0000-\u001f]/.test(x)||x.startsWith("/")||x.split("/").some(p=>p===".."))throw new Error("invalid_path");
   return x;
 }
 async function ncFilesList(root:any,path:any){
   const id=await ncQueueAgentJob("fs.list",{root:ncSafeRoot(root),path:ncSafePath(path)});
   return ncWaitAgentJob(id,12000);
 }
 async function ncFilesRead(root:any,path:any,start:any=1,end:any=1400){
   const id=await ncQueueAgentJob("fs.read",{root:ncSafeRoot(root),path:ncSafePath(path),startLine:Math.max(1,Number(start)||1),endLine:Math.min(5000,Math.max(1,Number(end)||1400))});
   return ncWaitAgentJob(id,12000);
 }
 async function ncFilesSearch(root:any,path:any,query:any){
   const q=String(query||"").trim(); if(!q||q.length>200)throw new Error("invalid_search");
   const id=await ncQueueAgentJob("fs.search",{root:ncSafeRoot(root),path:ncSafePath(path),query:q,maxResults:120});
   return ncWaitAgentJob(id,15000);
 }
 async function ncConversationEvents(after:string|null=null,limit=250){
   let p="nxc_bot_events?select=id,bot_id,direction,event_type,chat_id,chat_type,chat_title,user_id,username,message_id,reply_to_message_id,text,payload,created_at&chat_type=in.(group,supergroup)&order=created_at.asc&limit="+Math.min(500,Math.max(1,limit));
   if(after){const d=new Date(after);if(!Number.isNaN(d.getTime()))p+="&created_at=gt."+encodeURIComponent(d.toISOString())}
   return infraDb(p);
 }
 async function ncTelemetryBotEvent(req:Request,origin:string|null){
   const expected=String(Deno.env.get("NEXCONTROL_FLEET_KEY")||"").trim();
   const supplied=String(req.headers.get("x-nexcontrol-agent-key")||"").trim();
   if(!expected||!supplied||supplied!==expected)return infraJson({ok:false,error:"unauthorized"},401,origin);
   const q=await req.json().catch(()=>null);
   if(!q||typeof q!=="object")return infraJson({ok:false,error:"invalid_payload"},400,origin);
   const slug=String(q.slug||"").trim().toLowerCase().replace(/[^a-z0-9._-]/g,"");
   if(!slug)return infraJson({ok:false,error:"bot_slug_required"},400,origin);
   const chatType=String(q.chatType||"private").toLowerCase();
   if(!["private","group","supergroup","channel"].includes(chatType))return infraJson({ok:false,error:"invalid_chat_type"},400,origin);
   const chatId=String(q.chatId||"").slice(0,120);
   const messageId=String(q.messageId||q.updateId||"").slice(0,120);
   if(!chatId||!messageId)return infraJson({ok:false,error:"chat_or_message_missing"},400,origin);
   const bots=await infraDb("nxc_bots?slug=eq."+encodeURIComponent(slug)+"&select=id&limit=1");
   const botId=bots?.[0]?.id;if(!botId)return infraJson({ok:false,error:"bot_not_registered"},409,origin);
   const direction=["out","outgoing"].includes(String(q.direction||"").toLowerCase())?"out":"in";
   const existing=await infraDb("nxc_bot_events?bot_id=eq."+botId+"&chat_id=eq."+encodeURIComponent(chatId)+"&message_id=eq."+encodeURIComponent(messageId)+"&direction=eq."+direction+"&select=id&limit=1");
   if(!existing?.length){
     const row={
       bot_id:botId,direction,event_type:String(q.eventType||"message").slice(0,80),
       chat_id:chatId,chat_type:chatType,chat_title:String(q.chatTitle||"").slice(0,300)||null,
       user_id:String(q.userId||"").slice(0,120)||null,username:String(q.username||"").slice(0,200)||null,
       message_id:messageId,reply_to_message_id:String(q.replyToMessageId||"").slice(0,120)||null,
       text:String(q.text||"").slice(0,12000)||null,
       payload:q.payload&&typeof q.payload==="object"?q.payload:{},
       created_at:q.createdAt&&!Number.isNaN(new Date(q.createdAt).getTime())?new Date(q.createdAt).toISOString():new Date().toISOString()
     };
     try{await infraDb("nxc_bot_events",{method:"POST",headers:{"prefer":"return=minimal"},body:JSON.stringify(row)})}catch(error){
       if(!/duplicate|unique/i.test(String(error?.message||error)))throw error;
     }
   }
   await infraDb("nxc_bots?id=eq."+botId,{method:"PATCH",headers:{"prefer":"return=minimal"},body:JSON.stringify({last_heartbeat_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
   return infraJson({ok:true},202,origin);
 }

async function ncTelemetryGroupEvent(req:Request,origin:string|null){
   const expected=String(Deno.env.get("NEXCONTROL_FLEET_KEY")||"").trim();
   const supplied=String(req.headers.get("x-nexcontrol-agent-key")||"").trim();
   if(!expected||!supplied||supplied!==expected)return infraJson({ok:false,error:"unauthorized"},401,origin);
   const q=await req.json().catch(()=>null);
   if(!q||typeof q!=="object")return infraJson({ok:false,error:"invalid_payload"},400,origin);
   const chatType=String(q.chatType||"group").toLowerCase();
   if(!["group","supergroup"].includes(chatType))return infraJson({ok:false,error:"group_only"},400,origin);
   const chatId=String(q.chatId||"").slice(0,120),messageId=String(q.messageId||"").slice(0,120);
   if(!chatId||!messageId)return infraJson({ok:false,error:"chat_or_message_missing"},400,origin);
   const bots=await infraDb("nxc_bots?slug=eq.nexai&select=id&limit=1");
   const botId=bots?.[0]?.id;if(!botId)return infraJson({ok:false,error:"nexai_bot_not_registered"},409,origin);
   const direction=String(q.direction||"incoming")==="outgoing"?"outgoing":"incoming";
   const existing=await infraDb("nxc_bot_events?bot_id=eq."+botId+"&chat_id=eq."+encodeURIComponent(chatId)+"&message_id=eq."+encodeURIComponent(messageId)+"&direction=eq."+direction+"&select=id&limit=1");
   if(!existing?.length){
     const row={
       bot_id:botId,direction,event_type:String(q.eventType||"message").slice(0,80),
       chat_id:chatId,chat_type:chatType,chat_title:String(q.chatTitle||"").slice(0,300)||null,
       user_id:String(q.userId||"").slice(0,120)||null,username:String(q.username||"").slice(0,200)||null,
       message_id:messageId,reply_to_message_id:String(q.replyToMessageId||"").slice(0,120)||null,
       text:String(q.text||"").slice(0,12000)||null,payload:q.payload&&typeof q.payload==="object"?q.payload:{},
       created_at:q.createdAt&&!Number.isNaN(new Date(q.createdAt).getTime())?new Date(q.createdAt).toISOString():new Date().toISOString()
     };
     try{await infraDb("nxc_bot_events",{method:"POST",headers:{"prefer":"return=minimal"},body:JSON.stringify(row)})}catch(error){
       if(!/duplicate|unique/i.test(String(error?.message||error)))throw error;
     }
   }
   await infraDb("nxc_bots?id=eq."+botId,{method:"PATCH",headers:{"prefer":"return=minimal"},body:JSON.stringify({last_heartbeat_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
   return infraJson({ok:true},202,origin);
 }

async function ncHostJob(kind:string,payload:any,timeoutMs=45000){
  const agents=await infraDb("nxc_host_agents?enabled=eq.true&select=id,last_seen_at&order=last_seen_at.desc&limit=1");
  const a=agents?.[0];if(!a?.id)throw new Error("host_agent_not_found");
  const now=new Date().toISOString();
  const rows=await infraDb("nxc_host_jobs",{method:"POST",headers:{"prefer":"return=representation"},body:JSON.stringify({agent_id:a.id,kind,payload,status:"pending",created_at:now,updated_at:now})});
  const id=rows?.[0]?.id;if(!id)throw new Error("host_job_create_failed");
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    await new Promise(r=>setTimeout(r,450));
    const state=(await infraDb("nxc_host_jobs?id=eq."+id+"&select=id,status,result,error,completed_at&limit=1"))?.[0];
    if(state?.status==="done")return state.result||{};
    if(state?.status==="failed")throw new Error(state.error||"host_job_failed");
  }
  throw new Error("host_job_timeout");
}
function ncLastJson(stdout:any){
  const lines=String(stdout||"").split(/\r?\n/).map((x:string)=>x.trim()).filter(Boolean).reverse();
  for(const line of lines){if(line.startsWith("{")||line.startsWith("[")){try{return JSON.parse(line)}catch{}}}
  throw new Error("runtime_json_missing");
}
async function ncNexAiSessions(){
  const id=await ncQueueAgentJob("runtime.exec",{root:"nexai",command:"node",args:["cli.mjs","accounts"],timeoutMs:25000});
  const result=await ncWaitAgentJob(id,35000);
  if(result?.pending)throw new Error("session_inventory_timeout");
  if(result?.ok===false||Number(result?.code||0)!==0)throw new Error(result?.stderr||"session_inventory_failed");
  return ncLastJson(result?.stdout);
}
async function ncNexAiConversations(sessionId:any,limit:any=120){
  const sid=String(sessionId||"").trim();
  if(!sid)throw new Error("session_id_required");
  const lim=Math.max(1,Math.min(250,Number(limit)||120));
  const id=await ncQueueAgentJob("runtime.exec",{root:"nexai",command:"node",args:["cli.mjs","conversation-list",sid,String(lim)],timeoutMs:45000});
  const result=await ncWaitAgentJob(id,55000);
  if(result?.pending)throw new Error("conversation_list_timeout");
  if(result?.ok===false||Number(result?.code||0)!==0)throw new Error(result?.stderr||result?.stdout||"conversation_list_failed");
  return ncLastJson(result?.stdout);
}
async function ncNexAiHistory(sessionId:any,chatId:any,limit:any=100){
  const sid=String(sessionId||"").trim(),chat=String(chatId||"").trim();
  if(!sid)throw new Error("session_id_required");
  if(!chat)throw new Error("chat_id_required");
  const lim=Math.max(1,Math.min(200,Number(limit)||100));
  const id=await ncQueueAgentJob("runtime.exec",{root:"nexai",command:"node",args:["cli.mjs","conversation-history",sid,chat,String(lim)],timeoutMs:45000});
  const result=await ncWaitAgentJob(id,55000);
  if(result?.pending)throw new Error("conversation_history_timeout");
  if(result?.ok===false||Number(result?.code||0)!==0)throw new Error(result?.stderr||result?.stdout||"conversation_history_failed");
  return ncLastJson(result?.stdout);
}
async function ncSendNexAiMessage(q:any){
  const payload={chatId:String(q.chatId||""),telegramUserId:String(q.sessionId||q.telegramUserId||""),text:String(q.text||"").slice(0,12000),fileBase64:String(q.fileBase64||""),fileName:String(q.fileName||"media").slice(0,180),mimeType:String(q.mimeType||"").slice(0,120),mode:String(q.mode||"auto").slice(0,40),replyToMessageId:Number(q.replyToMessageId||0)||0};
  if(!payload.chatId)throw new Error("chat_id_required");
  if(payload.fileBase64.length>8000000)throw new Error("media_too_large");
  const path=".runtime/nexcontrol-compose-"+crypto.randomUUID()+".json";
  let id=await ncQueueAgentJob("fs.write",{root:"nexai",path,content:JSON.stringify(payload)});
  const written=await ncWaitAgentJob(id,15000);if(written?.pending)throw new Error("compose_write_timeout");
  id=await ncQueueAgentJob("runtime.exec",{root:"nexai",command:"node",args:["cli.mjs","conversation-send-file",path],timeoutMs:180000});
  const result=await ncWaitAgentJob(id,190000);
  if(result?.pending)throw new Error("compose_send_timeout");
  if(result?.ok===false||Number(result?.code||0)!==0)throw new Error(result?.stderr||result?.stdout||"compose_send_failed");
  return ncLastJson(result?.stdout);
}
async function ncSendBotMessage(slug:string,q:any){
  const botSlug=String(slug||"").toLowerCase();
  if(botSlug==="nexai")return ncSendNexAiMessage(q);
  const payload={chatId:String(q.chatId||""),text:String(q.text||"").slice(0,12000),fileBase64:String(q.fileBase64||""),fileName:String(q.fileName||"media").slice(0,180),mimeType:String(q.mimeType||"application/octet-stream").slice(0,120),mode:String(q.mode||"auto").slice(0,40),replyToMessageId:Number(q.replyToMessageId||0)||0};
  if(!payload.chatId)throw new Error("chat_id_required");
  if(!payload.text&&!payload.fileBase64)throw new Error("message_empty");
  if(payload.fileBase64.length>8000000)throw new Error("media_too_large");
  const composePath=".runtime/nexcontrol-bot-compose-"+crypto.randomUUID()+".json";
  let id=await ncQueueAgentJob("fs.write",{root:"nexus",path:composePath,content:JSON.stringify(payload)});
  const written=await ncWaitAgentJob(id,15000);if(written?.pending)throw new Error("compose_write_timeout");
  const script=`const fs=require("fs");const map={nexcanal:"NEXCANAL__BOT_TOKEN",nexdownloader:"NEXDOWNLOADER__BOT_TOKEN",nexgame:"NEXGAME__BOT_TOKEN",nexgroup:"NEXGROUP__TELEGRAM_BOT_TOKEN",nexstick:"NEXSTICK__BOT_TOKEN",nexwhisper:"NEXWHISPER__BOT_TOKEN",stacy:"STACY__BOT_TOKEN"};const slug=process.argv[1],file=process.argv[2],q=JSON.parse(fs.readFileSync(file,"utf8")),token=process.env[map[slug]];if(!token)throw new Error("bot_token_unavailable");let method="sendMessage",field="";if(q.fileBase64){if(q.mode==="photo"){method="sendPhoto";field="photo"}else if(q.mode==="voice"){method="sendVoice";field="voice"}else if(q.mode==="audio"){method="sendAudio";field="audio"}else if(q.mode==="video"){method="sendVideo";field="video"}else{method="sendDocument";field="document"}}const url="https://api.telegram.org/bot"+token+"/"+method;let opt;if(field){const fd=new FormData();fd.append("chat_id",q.chatId);fd.append(field,new Blob([Buffer.from(q.fileBase64,"base64")],{type:q.mimeType||"application/octet-stream"}),q.fileName||"media");if(q.text)fd.append("caption",q.text);if(q.replyToMessageId)fd.append("reply_parameters",JSON.stringify({message_id:q.replyToMessageId}));opt={method:"POST",body:fd}}else{const body={chat_id:q.chatId,text:q.text};if(q.replyToMessageId)body.reply_parameters={message_id:q.replyToMessageId};opt={method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}}fetch(url,opt).then(async r=>{const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.description||("HTTP "+r.status));console.log(JSON.stringify(j))}).finally(()=>{try{fs.unlinkSync(file)}catch{}}).catch(e=>{console.error(e.message||e);process.exit(1)})`;
  id=await ncQueueAgentJob("runtime.exec",{root:"nexus",command:"node",args:["-e",script,botSlug,composePath],timeoutMs:120000});
  const result=await ncWaitAgentJob(id,130000);
  if(result?.pending)throw new Error("bot_send_timeout");
  if(result?.ok===false||Number(result?.code||0)!==0)throw new Error(result?.stderr||result?.stdout||"bot_send_failed");
  const out=ncLastJson(result?.stdout);
  const message=out?.result||{};
  const bots=await infraDb("nxc_bots?slug=eq."+encodeURIComponent(botSlug)+"&select=id&limit=1");
  const botId=bots?.[0]?.id;
  if(botId&&message?.message_id){
    const chat=message.chat||{};
    const row={bot_id:botId,direction:"out",event_type:payload.fileBase64?(payload.mode||"media"):"message",chat_id:String(chat.id||payload.chatId),chat_type:String(chat.type||"private"),chat_title:String(chat.title||chat.username||chat.first_name||payload.chatId).slice(0,300),message_id:String(message.message_id),text:String(message.text||message.caption||payload.text||"").slice(0,12000),payload:{hasMedia:Boolean(payload.fileBase64),mediaType:payload.mode||"",source:"nexcontrol-compose"},created_at:message.date?new Date(Number(message.date)*1000).toISOString():new Date().toISOString()};
    await infraDb("nxc_bot_events",{method:"POST",headers:{"prefer":"return=minimal"},body:JSON.stringify(row)}).catch(()=>{});
  }
  return out;
}
async function handleInfrastructure(req:Request,route:URL,origin:string|null){
  try{
    if(req.method==="GET"&&(route.pathname==="/infrastructure"||route.pathname.startsWith("/infrastructure/"))){const html=ncPage(await ncState(),route);const headers=cors(origin);headers.set("content-type","text/html; charset=utf-8");headers.set("content-security-policy","default-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'");return new Response(html,{status:200,headers})}
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/state")return infraJson(await infraState(),200,origin);
    if(req.method==="POST"&&route.pathname==="/api/admin/infrastructure/hosts/setup-token"){const q=await req.json().catch(()=>({}));return infraJson(await infraHostSetup(q),200,origin)}
    if(req.method==="POST"&&route.pathname==="/api/admin/infrastructure/projects"){const q=await req.json().catch(()=>({}));return infraJson(await infraCreateProject(q),201,origin)}
    let m=route.pathname.match(/^\/api\/admin\/infrastructure\/projects\/([A-Za-z0-9._-]+)\/autodeploy$/);
    if(req.method==="POST"&&m){const q=await req.json().catch(()=>({}));const out=await infraSetAuto(m[1],q.enabled===true);return infraJson(out.body,out.status,origin)}
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/projects\/([A-Za-z0-9._-]+)\/verify$/);
    if(req.method==="POST"&&m)return infraJson(await infraVerifyProject(m[1]),202,origin);
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/projects\/([A-Za-z0-9._-]+)\/deploy$/);
    if(req.method==="POST"&&m){const q=await req.json().catch(()=>({}));return infraJson(await infraDeployProject(m[1],q),202,origin)}
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/projects\/([A-Za-z0-9._-]+)\/actions\/(start|stop|restart)$/);
    if(req.method==="POST"&&m)return infraJson(await infraProjectAction(m[1],m[2]),202,origin);
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/projects\/([A-Za-z0-9._-]+)\/logs$/);
    if(req.method==="GET"&&m){const lines=Math.max(20,Math.min(1000,Number(route.searchParams.get("lines")||250)));return infraJson(await infraProjectLogs(m[1],lines),200,origin)}


    // FILES_CONVERSATIONS_API_V1
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/conversations"){
      const after=route.searchParams.get("after");return infraJson({events:await ncConversationEvents(after,300)},200,origin)
    }
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/files/list"){
      return infraJson({result:await ncFilesList(route.searchParams.get("root"),route.searchParams.get("path"))},200,origin)
    }
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/files/read"){
      return infraJson({result:await ncFilesRead(route.searchParams.get("root"),route.searchParams.get("path"),route.searchParams.get("start")||1,route.searchParams.get("end")||1400)},200,origin)
    }
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/files/search"){
      return infraJson({result:await ncFilesSearch(route.searchParams.get("root"),route.searchParams.get("path"),route.searchParams.get("q"))},200,origin)
    }

    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/bots/nexai/sessions"){
      return infraJson(await ncNexAiSessions(),200,origin)
    }
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/bots/nexai/conversations"){
      return infraJson(await ncNexAiConversations(route.searchParams.get("sessionId"),route.searchParams.get("limit")||120),200,origin)
    }
    if(req.method==="GET"&&route.pathname==="/api/admin/infrastructure/bots/nexai/history"){
      return infraJson(await ncNexAiHistory(route.searchParams.get("sessionId"),route.searchParams.get("chatId"),route.searchParams.get("limit")||100),200,origin)
    }
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/bots\/([A-Za-z0-9._-]+)\/send$/);
    if(req.method==="POST"&&m){const q=await req.json().catch(()=>({}));return infraJson(await ncSendBotMessage(m[1],q),200,origin)}
    // BOT_CONTROL_ROUTES_V4
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/bots\/([A-Za-z0-9._-]+)\/actions\/(start|stop|restart)$/);
    if(req.method==="POST"&&m)return infraJson(await infraProjectAction(ncBotProject(m[1]),m[2]),202,origin);
    m=route.pathname.match(/^\/api\/admin\/infrastructure\/bots\/([A-Za-z0-9._-]+)\/logs$/);
    if(req.method==="GET"&&m){const lines=Math.max(20,Math.min(1000,Number(route.searchParams.get("lines")||260)));return infraJson(await infraProjectLogs(ncBotProject(m[1]),lines),200,origin)}
    return infraJson({error:"not_found"},404,origin);
  }catch(error){
    const message=String(error?.message||error).slice(0,500);
    const conflict=/not_found|invalid_|not_allowed|blocked|unverified|unreachable|exists|required|not_ready/i.test(message);
    return infraJson({error:"infrastructure_error",message},conflict?409:500,origin);
  }
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


  if(route.pathname==="/api/telemetry/bot-event"&&req.method==="POST"){
    return ncTelemetryBotEvent(req,origin);
  }

  // TELEMETRY_GROUP_EVENT_ROUTE_V1
  if(route.pathname==="/api/telemetry/group-event"&&req.method==="POST"){
    return ncTelemetryGroupEvent(req,origin);
  }

  const ua = req.headers.get("user-agent") || "";
  const rawProxyToken = (req.headers.get("x-nxc-session") || "").trim();
  const existing = await loadSession(rawProxyToken, ua);
  let upstreamCookie = existing?.cookie || "";

  const infraRoute = route.pathname === "/infrastructure" || route.pathname.startsWith("/infrastructure/") || route.pathname.startsWith("/api/admin/infrastructure/");
  if (infraRoute) {
    const valid = !!existing && await infraSessionValid(existing.cookie);
    if (!valid) {
      if(rawProxyToken)await deleteSessionByRaw(rawProxyToken).catch(()=>{});
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