import {
  nexMetaStatus,
  nexMetaAction
} from '../lib/nexmeta-client.mjs';
import { renderMetaPage } from '../ui/meta-page.mjs';

const TARGET='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol';

function outboundHeaders(req,path){
  const h=new Headers();
  for(const [k,v] of Object.entries(req.headers||{})){
    const key=String(k).toLowerCase();
    if([
      'host',
      'content-length',
      'connection',
      'transfer-encoding',
      'keep-alive',
      'upgrade',
      'proxy-connection',
      'te',
      'trailer'
    ].includes(key))continue;
    if(v==null)continue;
    if(Array.isArray(v)){
      for(const x of v)h.append(key,String(x));
    }else{
      h.set(key,String(v));
    }
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
    return new URLSearchParams(
      Object.entries(b).map(([k,v])=>[k,String(v??'')])
    ).toString();
  }

  if(ct.includes('application/json')||typeof b==='object'){
    headers.set('content-type','application/json');
    return JSON.stringify(b);
  }

  return String(b);
}

async function readBodyObject(req){
  if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body)){
    return req.body;
  }

  if(typeof req.body==='string'){
    try{return JSON.parse(req.body)}catch{return{}}
  }

  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  if(!chunks.length)return{};

  const text=Buffer.concat(chunks).toString('utf8');
  try{return JSON.parse(text)}catch{return{}}
}

function injectMetaNavigation(upstream,buffer){
  const type=String(upstream.headers.get('content-type')||'').toLowerCase();
  if(!type.includes('text/html'))return buffer;

  let html=buffer.toString('utf8');
  if(html.includes('href="/meta"'))return buffer;

  if(html.includes('href="/server"')){
    html=html.replace(
      '<a href="/server"',
      '<a href="/meta">Meta</a><a href="/server"'
    );
  }else if(html.includes('</nav>')){
    html=html.replace('</nav>','<a href="/meta">Meta</a></nav>');
  }

  return Buffer.from(html,'utf8');
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
  const path=String(value||'').trim();
  return path.startsWith('/')&&!path.startsWith('//')&&!path.includes('\\');
}

function copyUpstreamResponse(upstream,res,buffer,{location,setCookieExtra}={}){
  buffer=injectMetaNavigation(upstream,buffer);
  res.statusCode=upstream.status;

  const skip=new Set([
    'content-length',
    'transfer-encoding',
    'connection',
    'content-encoding'
  ]);

  for(const [k,v] of upstream.headers){
    if(!skip.has(k.toLowerCase())){
      if(location&&k.toLowerCase()==='location')continue;
      res.setHeader(k,v);
    }
  }

  if(location)res.setHeader('location',location);

  let cookies=[];
  if(typeof upstream.headers.getSetCookie==='function'){
    cookies=upstream.headers.getSetCookie()||[];
  }else{
    const cookie=upstream.headers.get('set-cookie');
    if(cookie)cookies=[cookie];
  }

  if(setCookieExtra)cookies.push(setCookieExtra);
  if(cookies.length)res.setHeader('set-cookie',cookies);

  res.end(buffer);
}

async function proxyUpstream(req,res,path,search=''){
  const headers=outboundHeaders(req,path);
  const body=outboundBody(req,headers);

  const upstream=await fetch(TARGET+search,{
    method:req.method,
    headers,
    body,
    redirect:'manual',
    signal:AbortSignal.timeout(30000)
  });

  const buf=Buffer.from(await upstream.arrayBuffer());

  const returnTo=readCookie(req,'nexcontrol_return_to');
  const loginSucceeded=
    path==='/api/admin/login'&&
    req.method==='POST'&&
    upstream.status>=300&&
    upstream.status<400&&
    safeLocalPath(returnTo);

  copyUpstreamResponse(
    upstream,
    res,
    buf,
    loginSucceeded
      ? {
          location:returnTo,
          setCookieExtra:'nexcontrol_return_to=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
        }
      : {}
  );
}

async function probeAdminSession(req){
  const headers=outboundHeaders(req,'/api/admin/bots');

  const response=await fetch(TARGET,{
    method:'GET',
    headers,
    redirect:'manual',
    signal:AbortSignal.timeout(10000)
  });

  await response.arrayBuffer().catch(()=>{});

  return {
    authenticated:response.status>=200&&response.status<300,
    status:response.status
  };
}

function json(res,status,value){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.end(JSON.stringify(value));
}

function nexMetaBridgeConfigured(){
  return Boolean(
    String(process.env.NEXMETA_URL||'').trim()&&
    String(process.env.NEXMETA_CONTROL_KEY||'').trim()
  );
}

async function requireAdminApi(req,res){
  const auth=await probeAdminSession(req);

  if(!auth.authenticated){
    json(res,401,{error:'unauthorized'});
    return false;
  }

  return true;
}

async function metaPage(req,res,url){
  const auth=await probeAdminSession(req);

  if(!auth.authenticated){
    res.statusCode=303;
    res.setHeader(
      'set-cookie',
      'nexcontrol_return_to=%2Fmeta; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax'
    );
    res.setHeader('location','/');
    return res.end();
  }

  if(!nexMetaBridgeConfigured()){
    res.statusCode=503;
    res.setHeader('content-type','text/html; charset=utf-8');
    res.setHeader('cache-control','no-store');
    return res.end(
      '<!doctype html><html><body style="background:#080808;color:#eee;font-family:system-ui;padding:40px"><h1>NexMeta bridge not configured</h1><p>NEXMETA_URL and NEXMETA_CONTROL_KEY must be configured server-side in NexControl.</p><p><a style="color:#d9d0ff" href="/">Return to NexControl</a></p></body></html>'
    );
  }

  const [
    statusResponse,
    metricsResponse,
    pagesResponse,
    readinessResponse
  ]=await Promise.all([
    nexMetaStatus(),
    nexMetaAction('metrics'),
    nexMetaAction('list_connected_pages'),
    nexMetaAction('deployment_readiness')
  ]);

  const html=renderMetaPage({
    status:statusResponse||{},
    metrics:metricsResponse?.result||{},
    pages:Array.isArray(pagesResponse?.result)
      ? pagesResponse.result
      : [],
    readiness:readinessResponse?.result||{}
  });

  res.statusCode=200;
  res.setHeader('content-type','text/html; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data:; base-uri 'none'; frame-ancestors 'none'"
  );
  res.end(html);
}

async function metaApi(req,res,path){
  if(!await requireAdminApi(req,res))return;

  if(!nexMetaBridgeConfigured()){
    return json(res,503,{error:'nexmeta_bridge_not_configured'});
  }

  if(req.method==='GET'&&path==='/api/admin/meta/status'){
    const status=await nexMetaStatus();
    return json(res,200,status);
  }

  if(req.method==='POST'&&path==='/api/admin/meta/action'){
    const body=await readBodyObject(req);
    const action=String(body?.action||'').trim();

    if(!action){
      return json(res,400,{error:'action_required'});
    }

    const payload={...body};
    delete payload.action;

    const result=await nexMetaAction(action,payload);
    return json(res,200,result);
  }

  return json(res,404,{error:'not_found'});
}

export default async function handler(req,res){
  try{
    const u=new URL(req.url,'https://nexcontrol.local');

    if(req.method==='GET'&&u.pathname==='/meta'){
      return await metaPage(req,res,u);
    }

    if(u.pathname.startsWith('/api/admin/meta/')){
      return await metaApi(req,res,u.pathname);
    }

    return await proxyUpstream(req,res,u.pathname,u.search);
  }catch(error){
    console.error('[NexControl proxy]',error);

    if(!res.headersSent){
      res.statusCode=502;
      res.setHeader('content-type','application/json; charset=utf-8');
      res.setHeader('cache-control','no-store');
      return res.end(JSON.stringify({
        error:'upstream_unavailable'
      }));
    }

    res.end();
  }
}
