import fs from 'node:fs/promises';
import http from 'node:http';

process.env.NEXACCOUNT_TELEGRAM_API_ID ||= process.env.NEXGROUP__TELEGRAM_API_ID || process.env.TELEGRAM_API_ID || '';
process.env.NEXACCOUNT_TELEGRAM_API_HASH ||= process.env.NEXGROUP__TELEGRAM_API_HASH || process.env.TELEGRAM_API_HASH || '';

const [{TelegramClient},{StringSession},{cfg,assertCoreConfig},relay]=await Promise.all([
  import('teleproto'),
  import('teleproto/sessions/index.js'),
  import('../config.mjs'),
  import('../automation/liteapks-relay.mjs')
]);
assertCoreConfig();

const HOST=String(process.env.NEXAPK_WORKER_HOST||'127.0.0.1');
const PORT=Math.max(1024,Number(process.env.NEXAPK_WORKER_PORT||18131));
const USERNAME=String(process.env.NEXAPK_SCANNER_USERNAME||'tresor20009').replace(/^@/,'').toLowerCase();
const SESSION_FILE=String(process.env.NEXAPK_SESSION_FILE||'/var/lib/nex/sessions/system/nexapk/'+USERNAME+'.session');
let client=null;
let controller=null;
let relayPromise=null;
let lastError='';
let stopping=false;

function reply(res,code,data){
  const body=JSON.stringify(data);
  res.writeHead(code,{'content-type':'application/json','content-length':Buffer.byteLength(body)});
  res.end(body);
}
function status(){
  return {
    ok:stopping!==true&&client?.connected===true&&Boolean(relayPromise)&&!lastError,
    service:'nexapk-worker',
    independent:true,
    username:'@'+USERNAME,
    connected:client?.connected===true,
    running:Boolean(relayPromise),
    lastError
  };
}

const session=String(await fs.readFile(SESSION_FILE,'utf8')).trim();
if(!session)throw new Error('empty independent APK session');
client=new TelegramClient(new StringSession(session),cfg.apiId,cfg.apiHash,{connectionRetries:8,autoReconnect:true});
await client.connect();
if(!(await client.isUserAuthorized()))throw new Error('independent APK session unauthorized');
const me=await client.getMe();
const actual=String(me?.username||'').replace(/^@/,'').toLowerCase();
if(actual!==USERNAME)throw new Error('APK session identity mismatch: expected @'+USERNAME+' got @'+actual);

controller=new AbortController();
relayPromise=Promise.resolve(relay.startEmbeddedLiteApksRelay(client,{
  signal:controller.signal,
  expectedUsername:USERNAME
}));
relayPromise.catch(error=>{
  if(controller?.signal?.aborted)return;
  lastError=String(error?.message||error).slice(0,600);
  console.error('[NexAPK worker]',lastError);
  setTimeout(()=>process.exit(1),100).unref?.();
}).finally(()=>{if(!controller?.signal?.aborted)relayPromise=null});

const server=http.createServer((req,res)=>{
  const url=new URL(req.url||'/','http://127.0.0.1');
  if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/health'||url.pathname==='/status'))return reply(res,status().ok?200:503,status());
  return reply(res,404,{ok:false,error:'not_found'});
});

async function shutdown(signal){
  if(stopping)return;
  stopping=true;
  console.log('[NexAPK worker] shutdown '+signal);
  server.close();
  try{controller?.abort()}catch{}
  await Promise.race([Promise.resolve(relayPromise).catch(()=>{}),new Promise(r=>setTimeout(r,2500))]).catch(()=>{});
  await client?.disconnect?.().catch(()=>{});
  process.exit(0);
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
server.listen(PORT,HOST,()=>console.log('[NexAPK worker] healthy on '+HOST+':'+PORT+' @'+USERNAME));
