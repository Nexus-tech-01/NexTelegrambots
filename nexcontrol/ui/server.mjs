import { db, X, fmtDate } from '../lib/core.mjs';
import { page } from './layout.mjs';

const ago = v => {
  if(!v)return 'jamais';
  const s=Math.floor((Date.now()-new Date(v).getTime())/1000);
  if(s<0)return 'à l’instant'; if(s<60)return `${s}s`; if(s<3600)return `${Math.floor(s/60)} min`; if(s<86400)return `${Math.floor(s/3600)} h`; return `${Math.floor(s/86400)} j`;
};
const safeJson = v => { try{return JSON.stringify(v,null,2)}catch{return String(v??'')} };

export async function serverPage(url){
  const d=await db();
  const agents=await d.collection('agents').find({}).sort({displayName:1}).toArray();
  const selected=String(url.searchParams.get('agent')||agents[0]?.slug||'');
  const jobs=await d.collection('agent_jobs').find(selected?{agentSlug:selected}:{}).sort({createdAt:-1}).limit(60).toArray();
  const opts=agents.map(a=>`<option value="${X(a.slug)}"${a.slug===selected?' selected':''}>${X(a.displayName||a.slug)} · ${X(a.slug)}</option>`).join('');
  const cards=agents.map(a=>{
    const online=a.lastHeartbeatAt&&(Date.now()-new Date(a.lastHeartbeatAt).getTime()<90000);
    const roots=(a.roots||[]).map(r=>X(r.key)).join(', ')||'—';
    return `<a class="panel" href="/server?agent=${encodeURIComponent(a.slug)}" style="display:block;padding:24px;border:${a.slug===selected?'1px solid var(--lav2)':'1px solid var(--line)'}"><div style="display:flex;justify-content:space-between;gap:20px;align-items:start"><div><div class="eyebrow">${online?'ONLINE':'OFFLINE'}</div><h3 style="font-size:26px;margin:8px 0 8px">${X(a.displayName||a.slug)}</h3><div class="muted">${X(a.hostname||'')} · ${X(a.platform||'')} · Node ${X(a.nodeVersion||'—')}</div></div><span class="pill">${X(a.version||'unknown')}</span></div><div class="muted" style="margin-top:18px">Heartbeat: ${X(ago(a.lastHeartbeatAt))} · Roots: ${roots}</div></a>`;
  }).join('');
  const rows=jobs.map(j=>{
    const result=j.status==='succeeded'?safeJson(j.result):j.status==='failed'?String(j.error||''):'En attente de l’agent';
    return `<tr><td><strong>${X(j.kind)}</strong><div class="dest-id">${X(String(j._id))}</div></td><td><span class="pill">${X(j.status)}</span><div class="dest-id">tentative ${Number(j.attempts||0)}</div></td><td>${X(fmtDate(j.createdAt))}</td><td><details><summary style="cursor:pointer">Payload / résultat</summary><pre style="white-space:pre-wrap;overflow:auto;max-width:760px;max-height:360px;background:#090909;border:1px solid var(--line);border-radius:16px;padding:14px;color:var(--muted)">${X(safeJson(j.payload))}\n\n--- RESULT ---\n${X(result)}</pre></details></td></tr>`;
  }).join('');
  const templates={
    'fs.list':{root:'nexgroup',path:'.'},
    'fs.read':{root:'nexgroup',path:'package.json',startLine:1,endLine:220},
    'fs.search':{root:'nexgroup',path:'.',query:'start',maxResults:80},
    'fs.write':{root:'nexgroup',path:'example.txt',content:'',expectedSha:''},
    'fs.mkdir':{root:'nexgroup',path:'tmp/example',recursive:true},
    'fs.move':{root:'nexgroup',path:'old.txt',toPath:'new.txt',overwrite:false},
    'fs.delete':{root:'nexgroup',path:'example.txt',allowDir:false},
    'fs.rollback':{backupId:'BACKUP_ID'},
    'check.run':{check:'node-check',root:'nexgroup',file:'src/index.js',timeoutMs:60000},
    'logs.tail':{log:'launcher',bytes:100000},
    'runtime.restart':{target:'all',reason:'NexControl'}
  };
  return page('Server',`<div class="page-head"><div><div class="eyebrow">Pterodactyl-independent control plane</div><h1 class="page-title">Server</h1></div><p class="page-sub">L’Agent ouvre uniquement des connexions sortantes vers NexControl. Les opérations fichiers, checks, logs et demandes de restart passent par une file de jobs MongoDB — aucune API Pterodactyl n’est nécessaire.</p></div>
  <section class="section fade-up"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">${cards||'<div class="empty">Aucun Agent n’a encore envoyé de heartbeat.</div>'}</div></section>
  <section class="section fade-up"><div class="panel" style="padding:26px"><div class="eyebrow">Create agent job</div><h2 style="font-size:32px;margin:8px 0 22px">Commande sécurisée</h2><form id="agentJob"><label>Agent</label><select name="agentSlug" required>${opts}</select><label>Action</label><select name="kind" id="jobKind" required>${Object.keys(templates).map(k=>`<option value="${k}">${k}</option>`).join('')}</select><label>Payload JSON</label><textarea name="payload" id="jobPayload" spellcheck="false" style="min-height:230px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace"></textarea><div style="display:flex;gap:10px;margin-top:20px"><button class="action primary" style="flex:1">Envoyer à l’Agent</button><button type="button" class="action" id="refreshJob">Actualiser</button></div><div class="result" id="jobOut"></div></form></div></section>
  <section class="section fade-up"><div class="panel"><div style="padding:24px 24px 4px"><div class="eyebrow">Job history</div><h2 style="font-size:32px;margin:8px 0">${selected?X(selected):'Tous les agents'}</h2></div><div style="overflow:auto"><table class="table"><thead><tr><th>Job</th><th>État</th><th>Créé</th><th>Détails</th></tr></thead><tbody>${rows||'<tr><td colspan="4" class="muted">Aucun job.</td></tr>'}</tbody></table></div></div></section>
  <script>const templates=${JSON.stringify(templates)};const kind=document.getElementById('jobKind'),payload=document.getElementById('jobPayload'),out=document.getElementById('jobOut');function sync(){payload.value=JSON.stringify(templates[kind.value]||{},null,2)}kind.onchange=sync;sync();document.getElementById('refreshJob').onclick=()=>location.reload();document.getElementById('agentJob').onsubmit=async e=>{e.preventDefault();out.textContent='Envoi…';let p;try{p=JSON.parse(payload.value)}catch{out.textContent='Payload JSON invalide';return}const r=await fetch('/api/admin/agent/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentSlug:e.target.agentSlug.value,kind:kind.value,payload:p})});const j=await r.json();out.textContent=r.ok?'Job créé : '+j.jobId:'Erreur : '+(j.error||'inconnue');if(r.ok)setTimeout(()=>location.href='/server?agent='+encodeURIComponent(e.target.agentSlug.value),700)}</script>`,'server');
}
