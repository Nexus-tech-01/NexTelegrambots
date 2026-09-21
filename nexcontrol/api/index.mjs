const TARGET='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol';
const NEXMETA_PUBLIC='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexmeta-public';
const NEXMETA_ADMIN='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexmeta-admin-config';

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


function readCookie(req,name){
  const raw=String(req.headers.cookie||'');
  for(const part of raw.split(';')){
    const [key,...rest]=part.trim().split('=');
    if(key===name){
      try{return decodeURIComponent(rest.join('='))}catch{return rest.join('=')}
    }
  }
  return null;
}

function safeLocalPath(value){
  const p=String(value||'').trim();
  return p.startsWith('/')&&!p.startsWith('//')&&!p.includes('\\');
}

async function readJsonBody(req){
  if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;
  if(typeof req.body==='string'){
    try{return JSON.parse(req.body)}catch{return{}}
  }
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  if(!chunks.length)return{};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return{}}
}

function sendJson(res,status,value){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.end(JSON.stringify(value));
}

async function adminSessionOk(req){
  const headers=outboundHeaders(req,'/api/admin/bots');
  const r=await fetch(TARGET,{
    method:'GET',
    headers,
    redirect:'manual',
    signal:AbortSignal.timeout(10000)
  });
  await r.arrayBuffer().catch(()=>{});
  return r.status>=200&&r.status<300;
}

async function metaHealth(){
  const r=await fetch(NEXMETA_PUBLIC+'/health/meta',{
    headers:{accept:'application/json'},
    signal:AbortSignal.timeout(12000)
  });
  const text=await r.text();
  try{return JSON.parse(text)}catch{return {ok:false,error:'invalid_health_response'}}
}

function metaPage(health={}){
  const connected=Boolean(health?.account?.connected);
  const pages=Number(health?.pages?.connectedPages||0);
  const oauthReady=Boolean(health?.oauthConfigured);
  const metaReady=Boolean(health?.metaConfigured);
  const state=connected?'CONNECTED':oauthReady?'READY':'SETUP REQUIRED';

  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080808"><title>Facebook · NexControl</title><style>'+
  '*{box-sizing:border-box}body{margin:0;background:#080808;color:#f3f1ed;font-family:Inter,system-ui,-apple-system,sans-serif;min-height:100vh}.wrap{max-width:900px;margin:auto;padding:28px 18px 80px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:70px}.brand{font-weight:900;letter-spacing:.08em;text-decoration:none;color:inherit}.back{color:#aaa;text-decoration:none}.eyebrow{text-transform:uppercase;letter-spacing:.14em;color:#8f8d88;font-size:11px}.title{font-size:clamp(54px,11vw,110px);line-height:.82;letter-spacing:-.075em;margin:12px 0 22px;text-transform:uppercase}.lead{color:#aaa;line-height:1.55;font-size:17px;max-width:720px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:36px}.panel{border:1px solid #292929;border-radius:24px;padding:22px;background:#111}.metric{font-size:38px;font-weight:800;letter-spacing:-.05em;margin-top:10px}.pill{display:inline-block;border:1px solid #343434;border-radius:999px;padding:8px 11px;font-size:10px;letter-spacing:.1em}.ok{color:#aaf7c4;border-color:#315842}.bad{color:#ffb4b4;border-color:#5b3434}label{display:block;margin:18px 0 7px;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:.1em}input{width:100%;border:1px solid #343434;border-radius:13px;background:#0a0a0a;color:#fff;padding:14px;font-size:16px;outline:none}button{width:100%;border:0;border-radius:14px;padding:14px;margin-top:14px;font-weight:800;background:#d9d0ff;color:#111;cursor:pointer}.out{margin-top:16px;padding:13px;border-radius:13px;background:#0b0b0b;color:#aaa;white-space:pre-wrap;line-height:1.45}.hint{font-size:12px;color:#777;line-height:1.5;margin-top:12px}</style></head><body><main class="wrap"><div class="top"><a class="brand" href="/">NEXCONTROL / META</a><a class="back" href="/">Retour</a></div><div class="eyebrow">Facebook / Messenger</div><h1 class="title">Connect<br>Facebook.</h1><p class="lead">Configure l’App Meta sur le serveur puis lance l’autorisation Facebook officielle. Ton mot de passe Facebook n’est jamais envoyé à NexControl.</p>'+
  '<section class="grid"><article class="panel"><div class="eyebrow">Runtime</div><div class="metric">'+state+'</div><p class="lead" style="font-size:14px">Meta: '+(metaReady?'configuré':'incomplet')+' · OAuth: '+(oauthReady?'prêt':'incomplet')+' · Pages: '+pages+'</p><span class="pill '+(connected?'ok':'bad')+'">'+(connected?'Compte Facebook connecté':'Aucun compte connecté')+'</span></article>'+
  (oauthReady
    ? '<article class="panel"><div class="eyebrow">Connexion</div><h2>Autoriser Facebook</h2><p class="lead" style="font-size:14px">La clé propriétaire reste côté serveur et n’est jamais affichée.</p><button id="connect">Continuer avec Facebook</button><div class="out" id="out">Prêt.</div></article>'
    : '<article class="panel"><div class="eyebrow">Meta App</div><h2>Configurer l’application</h2><p class="lead" style="font-size:14px">Dans Meta for Developers → Settings → Basic, copie l’App ID et l’App Secret.</p><label>App ID</label><input id="appId" inputmode="numeric" autocomplete="off"><label>App Secret</label><input id="appSecret" type="password" autocomplete="off" spellcheck="false"><button id="save">Enregistrer sur le serveur</button><div class="out" id="out">Le secret part directement au serveur via HTTPS.</div><div class="hint">Le serveur redémarrera automatiquement, puis cette page affichera le bouton Facebook.</div></article>'
  )+
  '</section></main><script>const out=document.getElementById("out");async function post(path,body){const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({error:"invalid_response"}));if(!r.ok)throw new Error(j.detail||j.error||"request_failed");return j}const save=document.getElementById("save");if(save)save.onclick=async()=>{try{out.textContent="Enregistrement…";await post("/api/admin/meta/configure-app",{appId:appId.value,appSecret:appSecret.value});appSecret.value="";out.textContent="Enregistré. Redémarrage du serveur…";setTimeout(()=>location.reload(),7000)}catch(e){out.textContent=e.message}};const connect=document.getElementById("connect");if(connect)connect.onclick=async()=>{try{out.textContent="Ouverture de Facebook…";const j=await post("/api/admin/meta/start-oauth",{});if(j.authorizationUrl)location.href=j.authorizationUrl;else out.textContent="URL OAuth absente"}catch(e){out.textContent=e.message}};</script></body></html>';
}

async function handleMeta(req,res,u){
  const page=req.method==='GET'&&u.pathname==='/meta';
  const configure=req.method==='POST'&&u.pathname==='/api/admin/meta/configure-app';
  const start=req.method==='POST'&&u.pathname==='/api/admin/meta/start-oauth';
  if(!page&&!configure&&!start)return false;

  if(!await adminSessionOk(req)){
    if(page){
      res.statusCode=303;
      res.setHeader('set-cookie','nexcontrol_return_to=%2Fmeta; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax');
      res.setHeader('location','/');
      res.end();
    }else sendJson(res,401,{error:'unauthorized'});
    return true;
  }

  if(page){
    const health=await metaHealth().catch(()=>({ok:false,error:'nexmeta_unreachable'}));
    res.statusCode=200;
    res.setHeader('content-type','text/html; charset=utf-8');
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.end(metaPage(health));
    return true;
  }

  const body=await readJsonBody(req);
  const payload=configure
    ? {action:'configure_app',appId:String(body.appId||''),appSecret:String(body.appSecret||'')}
    : {action:'start_oauth'};

  const r=await fetch(NEXMETA_ADMIN,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'cookie':String(req.headers.cookie||'')
    },
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(30000)
  });
  const text=await r.text();
  let data={};
  try{data=JSON.parse(text)}catch{data={error:'invalid_admin_response'}}
  sendJson(res,r.status,data);
  return true;
}

export default async function handler(req,res){
  try{
    const u=new URL(req.url,'https://nexcontrol.local');
    if(await handleMeta(req,res,u))return;
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
    const isUi=(req.method==='GET'||req.method==='HEAD')&&!u.pathname.startsWith('/api/');
    const returnTo=readCookie(req,'nexcontrol_return_to');
    const loginSucceeded=u.pathname==='/api/admin/login'&&req.method==='POST'&&upstream.status>=300&&upstream.status<400&&safeLocalPath(returnTo);
    const skip=new Set(['content-length','transfer-encoding','connection','content-encoding']);
    for(const [k,v] of upstream.headers){
      const key=k.toLowerCase();
      if(skip.has(key))continue;
      if(loginSucceeded&&key==='location')continue;
      if(isUi&&(key==='content-type'||key==='content-security-policy'||key==='x-content-type-options'))continue;
      res.setHeader(k,v);
    }
    if(typeof upstream.headers.getSetCookie==='function'){
      const cookies=upstream.headers.getSetCookie();
      if(cookies?.length)res.setHeader('set-cookie',cookies);
    }else{
      const cookie=upstream.headers.get('set-cookie');
      if(cookie)res.setHeader('set-cookie',cookie);
    }
    if(loginSucceeded){
      res.setHeader('location',returnTo);
      const current=res.getHeader('set-cookie');
      const clear='nexcontrol_return_to=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
      if(Array.isArray(current))res.setHeader('set-cookie',[...current,clear]);
      else if(current)res.setHeader('set-cookie',[String(current),clear]);
      else res.setHeader('set-cookie',clear);
    }
    if(isUi){
      res.setHeader('content-type','text/html; charset=utf-8');
      res.setHeader('cache-control','no-store');
      res.setHeader('x-content-type-options','nosniff');
      res.setHeader('content-security-policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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
