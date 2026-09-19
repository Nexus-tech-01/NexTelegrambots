import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

try{
  const cfg=JSON.parse(await fs.readFile(new URL('../.nexcontrol/nexcontrol-local.json',import.meta.url),'utf8'));
  if(cfg.adminPasswordHash)process.env.ADMIN_PASSWORD_HASH=String(cfg.adminPasswordHash);
}catch{}

process.env.SESSION_SECRET ||= process.env.NEXCONTROL_AGENT_KEY || process.env.NEXCONTROL_FLEET_KEY || crypto.randomBytes(32).toString('hex');

const {default:handler}=await import('./api/index.mjs');
const port=Number(process.env.NEXCONTROL_LOCAL_PORT||process.env.SERVER_PORT||25579);
const nexMetaPort=Number(process.env.NEXMETA_INTERNAL_PORT||3110);

function isNexMetaPublicPath(pathname){
  return pathname==='/connect/meta' ||
    pathname==='/oauth/meta/callback' ||
    pathname==='/webhooks/meta' ||
    pathname==='/health/meta' ||
    pathname.startsWith('/nexus-media/');
}

function proxyNexMeta(req,res){
  const url=new URL(req.url||'/','http://nexcontrol.local');
  const targetPath=url.pathname==='/health/meta'
    ? '/nexmeta/health'+url.search
    : url.pathname+url.search;

  const headers={...req.headers};
  headers.host=`127.0.0.1:${nexMetaPort}`;
  headers['x-forwarded-host']=String(req.headers.host||'');
  headers['x-forwarded-proto']=String(req.headers['x-forwarded-proto']||'https');

  const upstream=http.request({
    host:'127.0.0.1',
    port:nexMetaPort,
    method:req.method,
    path:targetPath,
    headers
  },upstreamRes=>{
    res.writeHead(upstreamRes.statusCode||502,upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error',error=>{
    console.error('[NexControlLocal][NexMeta]',error?.message||error);
    if(res.headersSent)return res.destroy(error);
    res.statusCode=502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','no-store');
    res.end(JSON.stringify({error:'nexmeta_unavailable'}));
  });

  req.pipe(upstream);
}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url||'/','http://nexcontrol.local');

  if(isNexMetaPublicPath(url.pathname)){
    return proxyNexMeta(req,res);
  }

  Promise.resolve(handler(req,res)).catch(error=>{
    console.error('[NexControlLocal]',error);
    if(!res.headersSent)res.setHeader('content-type','application/json; charset=utf-8');
    if(!res.writableEnded){res.statusCode=500;res.end(JSON.stringify({error:'internal_error'}));}
  });
});
server.keepAliveTimeout=65000;
server.headersTimeout=70000;
server.listen(port,'0.0.0.0',()=>console.log('[NexControlLocal] listening on',port,'· NexMeta public proxy ->',nexMetaPort));
