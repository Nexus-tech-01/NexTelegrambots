import { handleNexAiPublic } from '../nexai-public.mjs';
// NexControl proxy build 61.12.1-recovery + NexAccount control surface
const TARGET='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol';
const AGENT='nexus-main';

function outboundHeaders(req,path){
  const h=new Headers();
  for(const [k,v] of Object.entries(req.headers||{})){
    const key=String(k).toLowerCase();
    if(['host','content-length','connection','transfer-encoding','keep-alive','upgrade','proxy-connection','te','trailer'].includes(key))continue;
    if(v==null)continue;
    if(Array.isArray(v)){for(const x of v)h.append(key,String(x));}
    else h.set(key,String(v));
  }
  h.set('x-nexcontrol-path',path);
  h.set('accept-encoding','identity');
  return h;
}

function outboundBody(req,headers){
  if(req.method==='GET'||req.method==='HEAD')return undefined;
  const b=req.body;
  if(b==null)return undefined;
  if(Buffer.isBuffer(b)||typeof b==='string')return b;
  const ct=String(headers.get('content-type')||'').toLowerCase();
  if(ct.includes('application/x-www-form-urlencoded')){
    return new URLSearchParams(Object.entries(b).map(([k,v])=>[k,String(v??'')])).toString();
  }
  if(ct.includes('application/json')||typeof b==='object'){
    headers.set('content-type','application/json');
    return JSON.stringify(b);
  }
  return String(b);
}

async function localBody(req){
  if(req.body&&typeof req.body==='object')return req.body;
  const chunks=[];for await(const c of req)chunks.push(c);
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return {}}
}

async function upstreamJson(req,path,method='GET',data){
  const u=new URL(path,'https://nexcontrol.local');
  const headers=outboundHeaders(req,u.pathname);
  let body;
  if(data!==undefined){
    headers.set('content-type','application/json');
    body=JSON.stringify(data);
  }
  const response=await fetch(TARGET+u.search,{
    method,headers,body,redirect:'manual',signal:AbortSignal.timeout(30000)
  });
  const text=await response.text();
  let json;try{json=JSON.parse(text)}catch{json={error:text||('HTTP '+response.status)}}
  return {status:response.status,json,headers:response.headers};
}

async function runAgentCli(req,args,timeoutMs=45000){
  const create=await upstreamJson(req,'/api/admin/agent/jobs','POST',{
    agentSlug:AGENT,
    kind:'runtime.exec',
    payload:{command:'node',args:['bots/nexaccount/cli.mjs',...args],root:'nexus',timeoutMs}
  });
  if(create.status>=400)return create;
  const jobId=create.json.jobId;
  if(!jobId)return {status:502,json:{error:'agent_job_missing_id'}};
  const until=Date.now()+timeoutMs+15000;
  while(Date.now()<until){
    await new Promise(r=>setTimeout(r,700));
    const state=await upstreamJson(req,'/api/admin/agent/jobs?id='+encodeURIComponent(jobId));
    if(state.status>=400)return state;
    if(state.json.status==='failed')return {status:500,json:{error:state.json.error||'agent_job_failed'}};
    if(state.json.status==='succeeded'){
      const result=state.json.result||{};
      if(result.ok===false||Number(result.code||0)!==0){
        return {status:500,json:{error:result.stderr||result.stdout||'nexaccount_cli_failed'}};
      }
      const raw=String(result.stdout||'').trim();
      try{return {status:200,json:JSON.parse(raw)}}catch{return {status:200,json:{ok:true,raw}}}
    }
  }
  return {status:504,json:{error:'agent_job_timeout'}};
}

function sendJson(res,status,data){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function nexaccountPage(){
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080808"><title>NexAccount · NexControl</title><style>'+
  'body{margin:0;background:#080808;color:#f5f3ef;font-family:Inter,system-ui,sans-serif}a{color:inherit}.wrap{max-width:920px;margin:auto;padding:28px 20px 80px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:70px}.brand{font-weight:900;letter-spacing:.08em;text-decoration:none}.back{opacity:.65}.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;opacity:.55}.title{font-size:clamp(44px,10vw,92px);line-height:.9;margin:10px 0 20px}.lead{max-width:650px;font-size:18px;line-height:1.5;opacity:.7}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:42px}.panel{border:1px solid #2b2b2b;border-radius:24px;padding:24px;background:#0d0d0d}.panel h2{margin:4px 0 20px;font-size:26px}label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.12em;opacity:.55;margin:16px 0 8px}input{box-sizing:border-box;width:100%;border:1px solid #333;background:#111;color:white;border-radius:14px;padding:14px;font-size:16px}button{width:100%;border:0;border-radius:14px;padding:14px 16px;margin-top:14px;font-weight:800;background:#6f5cff;color:white;cursor:pointer}.secondary{background:#1b1b1b}.status{white-space:pre-wrap;margin-top:16px;padding:14px;border-radius:14px;background:#111;min-height:28px;color:#c7c1ff}.account{padding:14px 0;border-top:1px solid #222}.premium{color:#c7c1ff}.hide{display:none}</style></head><body><div class="wrap"><div class="top"><a class="brand" href="/">NEXCONTROL / NEXACCOUNT</a><a class="back" href="/">Retour</a></div><div class="eyebrow">Telegram account pairing</div><h1 class="title">Pair.<br>Then forget it.</h1><p class="lead">Connecte un compte Telegram par numéro + code. La session reste chiffrée sur le serveur. NexAI fournit le menu inline, NexAccount agit avec le compte.</p><div class="grid"><section class="panel"><div class="eyebrow">01 — Pairing</div><h2>Connecter un compte</h2><label>Numéro Telegram</label><input id="phone" placeholder="+229..." autocomplete="tel"><button id="start">Envoyer le code</button><div id="codeBox" class="hide"><label>Code Telegram</label><input id="code" placeholder="12345" inputmode="numeric"><button id="sendCode">Valider le code</button></div><div id="passBox" class="hide"><label>Mot de passe 2FA</label><input id="password" type="password"><button id="sendPass">Valider la 2FA</button></div><div id="pairOut" class="status">Prêt.</div></section><section class="panel"><div class="eyebrow">02 — Runtime</div><h2>Comptes connectés</h2><button class="secondary" id="refresh">Actualiser</button><div id="health" class="status">Chargement…</div><div id="accounts"></div></section></div></div><script>'+
  'let pairId="",publicKey=null;const out=document.getElementById("pairOut"),codeBox=document.getElementById("codeBox"),passBox=document.getElementById("passBox");async function api(path,opt){const r=await fetch(path,opt);const j=await r.json().catch(()=>({error:"Réponse invalide"}));if(r.status===401){location.href="/";throw new Error("Connexion NexControl requise")}if(!r.ok)throw new Error(j.error||"Erreur");return j}function b64(bytes){let s="";for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s)}async function key(){if(publicKey)return publicKey;const j=await api("/api/nexaccount/key");const pem=j.publicKey.replace(/-----[^-]+-----/g,"").replace(/\\s/g,"");const raw=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));publicKey=await crypto.subtle.importKey("spki",raw,{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);return publicKey}async function seal(data){const encoded=new TextEncoder().encode(JSON.stringify(data));const encrypted=await crypto.subtle.encrypt({name:"RSA-OAEP"},await key(),encoded);return b64(encrypted)}async function secure(data){return api("/api/nexaccount/secure",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({envelope:await seal(data)})})}function stage(j){pairId=j.id||pairId;out.textContent=JSON.stringify(j,null,2);codeBox.classList.toggle("hide",j.stage!=="code");passBox.classList.toggle("hide",j.stage!=="password");if(j.stage==="connected"){code.value="";password.value="";load()}}start.onclick=async()=>{try{out.textContent="Demande du code…";stage(await secure({action:"pair-start",phone:phone.value}))}catch(e){out.textContent=e.message}};sendCode.onclick=async()=>{try{out.textContent="Vérification…";stage(await secure({action:"pair-code",id:pairId,code:code.value}))}catch(e){out.textContent=e.message}};sendPass.onclick=async()=>{try{out.textContent="Vérification 2FA…";stage(await secure({action:"pair-password",id:pairId,password:password.value}))}catch(e){out.textContent=e.message}};async function load(){try{const [h,a]=await Promise.all([api("/api/nexaccount/health"),api("/api/nexaccount/accounts")]);health.textContent="Service: "+(h.ok?"online":"offline")+"\\nNexAI inline: "+(h.botConfigured?"configuré":"token manquant")+"\\nSessions actives: "+(h.runtimes?.length||0);accounts.innerHTML=(a.accounts||[]).map(x=>"<div class=account><b>"+(x.username?"@"+x.username:(x.firstName||x.telegramUserId))+"</b><br><span class="+(x.premium?"premium":"")+">"+(x.premium?"Telegram Premium":"Standard")+"</span> · "+(x.phoneMasked||"")+"</div>").join("")||"<div class=account>Aucun compte.</div>"}catch(e){health.textContent=e.message}}refresh.onclick=load;load();</script></body></html>';
}


function pterodactylRecoveryPage(token='',message='',ok=false){
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>NexControl · Pterodactyl Recovery</title><style>'+
  '*{box-sizing:border-box}body{margin:0;background:#0b0b0d;color:#f7f3ec;font-family:Inter,system-ui,-apple-system,sans-serif;min-height:100vh;display:grid;place-items:center;padding:22px}.card{width:min(520px,100%);background:#131317;border:1px solid #2c2c33;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}h1{font-size:21px;margin:0 0 8px}.lead{color:#b9b5ad;line-height:1.5;margin:0}.field{margin-top:20px}.label{display:block;font-size:13px;margin-bottom:8px;color:#d8d3ca}.wrap{position:relative}.wrap input{width:100%;border:1px solid #383843;border-radius:12px;background:#0f0f12;color:#fff;padding:14px 48px 14px 14px;font-size:15px;outline:none}.wrap input:focus{border-color:#f2a23a;box-shadow:0 0 0 3px #f2a23a1d}.eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:#aaa;cursor:pointer;padding:8px;font-size:18px}.btn{width:100%;margin-top:16px;border:0;border-radius:12px;background:#f3a53b;color:#171109;padding:14px;font-weight:800;cursor:pointer}.msg{margin-top:16px;padding:12px;border-radius:11px;font-size:14px;line-height:1.4}.ok{background:#15351f;color:#baf5ca}.err{background:#3a1717;color:#ffc2c2}.small{font-size:12px;color:#8f8b85;margin-top:14px}</style></head><body><main class="card"><h1>NexControl · Recovery</h1><p class="lead">Colle ta clé API Client Pterodactyl. Elle sera enregistrée dans Supabase Vault puis NexControl demandera le redémarrage du serveur.</p>'+
  (message?'<div class="msg '+(ok?'ok':'err')+'">'+esc(message)+'</div>':'')+
  (ok?'':'<form method="post" action="/pterodactyl-recovery"><input type="hidden" name="token" value="'+esc(token)+'"><div class="field"><label class="label" for="key">Clé API Pterodactyl</label><div class="wrap"><input id="key" name="apiKey" type="password" autocomplete="off" required minlength="20"><button class="eye" type="button" aria-label="Afficher ou masquer">◉</button></div></div><button class="btn" type="submit">Enregistrer et redémarrer le serveur</button></form>')+
  '<div class="small">Lien à usage unique · expiration automatique.</div></main><script>const b=document.querySelector(".eye"),i=document.querySelector("#key");if(b&&i)b.onclick=()=>{i.type=i.type==="password"?"text":"password"};</script></body></html>';
}

async function handlePterodactylRecovery(req,res,u){
  if(u.pathname!=='/pterodactyl-recovery')return false;
  const endpoint='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nxc-pterodactyl-recovery';
  if(req.method==='GET'){
    const token=String(u.searchParams.get('token')||'');
    const check=await fetch(endpoint+'?token='+encodeURIComponent(token),{redirect:'manual',signal:AbortSignal.timeout(15000)});
    const loc=check.headers.get('location')||'';
    let message='',ok=false;
    if(check.status>=300&&check.status<400&&loc){
      try{
        const ru=new URL(loc);
        const status=ru.searchParams.get('status')||'';
        message=ru.searchParams.get('message')||'';
        ok=status==='ok';
      }catch{}
    }else if(check.status>=400){
      message='Lien invalide ou expiré.';
    }
    res.statusCode=200;
    res.setHeader('content-type','text/html; charset=utf-8');
    res.setHeader('cache-control','no-store, max-age=0');
    res.setHeader('x-content-type-options','nosniff');
    res.end(pterodactylRecoveryPage(token,message,ok));
    return true;
  }
  if(req.method==='POST'){
    const body=req.body&&typeof req.body==='object'?req.body:Object.fromEntries(new URLSearchParams(typeof req.body==='string'?req.body:''));
    const token=String(body.token||'');
    const apiKey=String(body.apiKey||'').trim();
    const upstream=await fetch(endpoint,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({token,apiKey}),
      redirect:'manual',
      signal:AbortSignal.timeout(20000)
    });
    const loc=upstream.headers.get('location')||'';
    let message=upstream.ok?'Clé enregistrée.':'Réponse inattendue du service de récupération.',ok=false;
    if(loc){
      try{
        const ru=new URL(loc);
        const status=ru.searchParams.get('status')||'';
        message=ru.searchParams.get('message')||message;
        ok=status==='ok';
      }catch{}
    }
    res.statusCode=200;
    res.setHeader('content-type','text/html; charset=utf-8');
    res.setHeader('cache-control','no-store, max-age=0');
    res.setHeader('x-content-type-options','nosniff');
    res.end(pterodactylRecoveryPage(token,message,ok));
    return true;
  }
  res.statusCode=405;
  res.end('method_not_allowed');
  return true;
}

async function handleNexAccount(req,res,u){
  if(req.method==='GET'&&u.pathname==='/nexaccount'){
    res.statusCode=200;res.setHeader('content-type','text/html; charset=utf-8');res.end(nexaccountPage());return true;
  }
  if(!u.pathname.startsWith('/api/nexaccount/'))return false;
  const q=await localBody(req);
  let result;
  if(req.method==='GET'&&u.pathname==='/api/nexaccount/health')result=await runAgentCli(req,['health'],20000);
  else if(req.method==='GET'&&u.pathname==='/api/nexaccount/accounts')result=await runAgentCli(req,['accounts'],20000);
  else if(req.method==='GET'&&u.pathname==='/api/nexaccount/anime/status')result=await runAgentCli(req,['anime-status'],30000);
  else if(req.method==='POST'&&u.pathname==='/api/nexaccount/anime/discover'){
    const target=String(q.username||q.telegramUserId||'').replace(/[^A-Za-z0-9_@-]/g,'').slice(0,80);
    result=await runAgentCli(req,['anime-discover',target],90000);
  }
  else if(req.method==='POST'&&u.pathname==='/api/nexaccount/anime/retry')result=await runAgentCli(req,['anime-retry'],30000);
  else if(req.method==='GET'&&u.pathname==='/api/nexaccount/key')result=await runAgentCli(req,['public-key'],20000);
  else if(req.method==='POST'&&u.pathname==='/api/nexaccount/secure'){
    const envelope=String(q.envelope||'');
    if(!/^[A-Za-z0-9+/=]{100,2000}$/.test(envelope))result={status:400,json:{error:'invalid_envelope'}};
    else result=await runAgentCli(req,['secure',envelope],45000);
  }else result={status:404,json:{error:'not_found'}};
  sendJson(res,result.status,result.json);
  return true;
}

export default async function handler(req,res){
  try{
    const u=new URL(req.url,'https://nexcontrol.local');
    if(await handleNexAiPublic(req,res,u))return;
    if(await handlePterodactylRecovery(req,res,u))return;
  if(await handleNexAccount(req,res,u))return;
    const headers=outboundHeaders(req,u.pathname);
    const body=outboundBody(req,headers);
    const upstream=await fetch(TARGET+u.search,{
      method:req.method,
      headers,
      body,
      redirect:'manual',
      signal:AbortSignal.timeout(30000)
    });

    res.statusCode=upstream.status;
    const skip=new Set(['content-length','transfer-encoding','connection','content-encoding']);
    for(const [k,v] of upstream.headers){
      if(!skip.has(k.toLowerCase()))res.setHeader(k,v);
    }
    if(typeof upstream.headers.getSetCookie==='function'){
      const cookies=upstream.headers.getSetCookie();
      if(cookies?.length)res.setHeader('set-cookie',cookies);
    }else{
      const cookie=upstream.headers.get('set-cookie');
      if(cookie)res.setHeader('set-cookie',cookie);
    }

    // Supabase Edge may label rendered pages as text/plain. Force browser-renderable
    // HTML for UI routes while preserving API content types exactly as returned.
    if((req.method==='GET'||req.method==='HEAD')&&!u.pathname.startsWith('/api/')){
      res.setHeader('content-type','text/html; charset=utf-8');
      res.setHeader('x-content-type-options','nosniff');
    }

    const buf=Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  }catch(error){
    console.error('[NexControl proxy]',error);
    res.statusCode=502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:'upstream_unavailable'}));
  }
}
