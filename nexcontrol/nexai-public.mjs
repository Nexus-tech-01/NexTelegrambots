import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nexAiConnectPage } from './nexai-connect-page.mjs';

const TARGET='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol';
const AGENT='nexus-main';
const root=path.dirname(fileURLToPath(import.meta.url));
const assetCache=new Map();

function b64url(input){
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function serviceCookie(){
  const secret=String(process.env.NEXCONTROL_SESSION_SECRET||process.env.SESSION_SECRET||'').trim();
  if(!secret)throw new Error('service_auth_unavailable');
  const payload=b64url(JSON.stringify({exp:Date.now()+5*60*1000}));
  const sig=b64url(crypto.createHmac('sha256',secret).update(payload).digest());
  return payload+'.'+sig;
}
function safeHeaders(req){
  const h=new Headers();
  for(const [k,v] of Object.entries(req.headers||{})){
    const key=String(k).toLowerCase();
    if(['host','content-length','connection','transfer-encoding','keep-alive','upgrade','proxy-connection','te','trailer','cookie','authorization'].includes(key))continue;
    if(v==null)continue;
    if(Array.isArray(v)){for(const x of v)h.append(key,String(x));}
    else h.set(key,String(v));
  }
  h.set('accept','application/json');
  h.set('accept-encoding','identity');
  h.set('cookie','nexcontrol_session='+serviceCookie());
  return h;
}
async function upstream(req,pathname,method='GET',data){
  const u=new URL(pathname,'https://nexcontrol.local');
  const headers=safeHeaders(req);
  let body;
  if(data!==undefined){
    headers.set('content-type','application/json');
    body=JSON.stringify(data);
  }
  const response=await fetch(TARGET+u.search,{method,headers,body,redirect:'manual',signal:AbortSignal.timeout(30000)});
  const text=await response.text();
  let json;try{json=JSON.parse(text)}catch{json={error:text||('HTTP '+response.status)}}
  return {status:response.status,json};
}
async function agentCli(req,args,timeoutMs=45000){
  const created=await upstream(req,'/api/admin/agent/jobs','POST',{
    agentSlug:AGENT,
    kind:'runtime.exec',
    payload:{command:'node',args:['bots/nexaccount/cli.mjs',...args],root:'nexus',timeoutMs}
  });
  if(created.status>=400)return created;
  const jobId=created.json.jobId;
  if(!jobId)return {status:502,json:{ok:false,error:'agent_job_missing_id'}};
  const deadline=Date.now()+timeoutMs+15000;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,650));
    const state=await upstream(req,'/api/admin/agent/jobs?id='+encodeURIComponent(jobId));
    if(state.status>=400)return state;
    if(state.json.status==='failed')return {status:502,json:{ok:false,error:'pairing_service_failed'}};
    if(state.json.status==='succeeded'){
      const result=state.json.result||{};
      if(result.ok===false||Number(result.code||0)!==0)return {status:502,json:{ok:false,error:'pairing_service_failed'}};
      const raw=String(result.stdout||'').trim();
      try{return {status:200,json:JSON.parse(raw)}}catch{return {status:200,json:{ok:true}}}
    }
  }
  return {status:504,json:{ok:false,error:'pairing_service_timeout'}};
}
async function body(req){
  if(req.body&&typeof req.body==='object')return req.body;
  const chunks=[];let total=0;
  for await(const c of req){
    total+=c.length;if(total>8192)throw new Error('payload_too_large');
    chunks.push(c);
  }
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return {}}
}
function json(res,status,data){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.end(JSON.stringify(data));
}
async function asset(name,count,mime){
  const key=name+':'+count;
  if(assetCache.has(key))return assetCache.get(key);
  const parts=[];
  for(let i=0;i<count;i++){
    const p=path.join(root,'assets',name+'.b64.'+String(i).padStart(2,'0'));
    parts.push((await fs.readFile(p,'utf8')).trim());
  }
  const out={buf:Buffer.from(parts.join(''),'base64'),mime};
  assetCache.set(key,out);
  return out;
}
async function serveAsset(res,name,count,mime){
  const a=await asset(name,count,mime);
  res.statusCode=200;
  res.setHeader('content-type',a.mime);
  res.setHeader('content-length',String(a.buf.length));
  res.setHeader('cache-control','public, max-age=31536000, immutable');
  res.setHeader('x-content-type-options','nosniff');
  res.end(a.buf);
}
function page(res){
  const html=nexAiConnectPage();
  res.statusCode=200;
  res.setHeader('content-type','text/html; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','same-origin');
  res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy',"default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.end(html);
}
export async function handleNexAiPublic(req,res,u){
  if(req.method==='GET'&&(u.pathname==='/nexai/connect'||u.pathname==='/nexai/connect/')){page(res);return true;}
  if(req.method==='GET'&&u.pathname==='/nexai/assets/hero'){await serveAsset(res,'hero',1,'image/webp');return true;}
  if(req.method==='GET'&&u.pathname==='/nexai/assets/music'){await serveAsset(res,'music',1,'audio/mpeg');return true;}
  if(!u.pathname.startsWith('/api/nexai/'))return false;
  try{
    if(req.method==='POST'&&u.pathname==='/api/nexai/pair/start'){
      const r=await agentCli(req,['web-pair-start'],20000);
      json(res,r.status,r.json);return true;
    }
    if(req.method==='GET'&&u.pathname==='/api/nexai/pair/status'){
      const id=String(u.searchParams.get('id')||'');
      if(!/^[0-9a-f-]{20,50}$/i.test(id)){json(res,400,{ok:false,error:'invalid_pair_id'});return true;}
      const r=await agentCli(req,['web-pair-status',id],20000);
      json(res,r.status,r.json);return true;
    }
    if(req.method==='GET'&&u.pathname==='/api/nexai/health'){
      const r=await agentCli(req,['health'],20000);
      json(res,r.status,{ok:r.status===200});return true;
    }
    json(res,404,{ok:false,error:'not_found'});return true;
  }catch(e){
    const code=String(e?.message||e)==='service_auth_unavailable'?503:500;
    json(res,code,{ok:false,error:code===503?'pairing_temporarily_unavailable':'pairing_gateway_error'});
    return true;
  }
}
