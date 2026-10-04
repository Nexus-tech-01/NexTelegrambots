import fs from 'node:fs/promises';
import http from 'node:http';

process.env.NEXACCOUNT_TELEGRAM_API_ID ||= process.env.NEXGROUP__TELEGRAM_API_ID || process.env.TELEGRAM_API_ID || '';
process.env.NEXACCOUNT_TELEGRAM_API_HASH ||= process.env.NEXGROUP__TELEGRAM_API_HASH || process.env.TELEGRAM_API_HASH || '';

const [{TelegramClient},{StringSession},{NewMessage},{cfg,assertCoreConfig},anime]=await Promise.all([
  import('teleproto'),
  import('teleproto/sessions/index.js'),
  import('teleproto/events/index.js'),
  import('../config.mjs'),
  import('../anime-ingest.mjs')
]);

assertCoreConfig();

const HOST=String(process.env.NEXANIME_WORKER_HOST||'127.0.0.1');
const PORT=Math.max(1024,Number(process.env.NEXANIME_WORKER_PORT||18130));
const SESSION_DIR=String(process.env.NEXANIME_SESSION_DIR||'/var/lib/nex/sessions/system/nexanime');
const PRIMARY=String(process.env.NEXANIME_PRIMARY_USERNAME||'tresor20001').replace(/^@/,'').toLowerCase();
const SCANNERS=[...new Set(
  String(process.env.NEXANIME_SCANNER_USERNAMES||'tresor20009')
    .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean)
)];
const runtimes=new Map();
let stopping=false;

const sessionPath=username=>SESSION_DIR+'/'+username+'.session';

async function connectRuntime(username,{publisher=false}={}){
  const session=String(await fs.readFile(sessionPath(username),'utf8')).trim();
  if(!session)throw new Error('empty independent session for @'+username);
  const client=new TelegramClient(new StringSession(session),cfg.apiId,cfg.apiHash,{
    connectionRetries:8,
    autoReconnect:true
  });
  await client.connect();
  if(!(await client.isUserAuthorized()))throw new Error('independent session unauthorized for @'+username);
  const me=await client.getMe();
  const actual=String(me?.username||'').replace(/^@/,'').toLowerCase();
  if(actual!==username)throw new Error('session identity mismatch: expected @'+username+' got @'+actual);
  const runtime={
    client,
    account:{
      telegramUserId:String(me.id),
      username:String(me.username||''),
      firstName:String(me.firstName||''),
      premium:me.premium===true
    },
    animePublisher:publisher===true,
    animeScanDisabled:false,
    standaloneAnimeWorker:true,
    startedAt:new Date()
  };
  const started=await anime.startAnimeIngest(runtime);
  if(!started)throw new Error('anime ingest refused for @'+username);
  client.addEventHandler(async event=>{
    try{await anime.handleAnimeIngestEvent(runtime,event)}
    catch(error){console.error('[NexAnime worker event]',username,String(error?.message||error).slice(0,400))}
  },new NewMessage({incoming:true}));
  runtime.catchUpTimer=setInterval(async()=>{
    try{
      if(!client.connected)await client.connect();
      await client.catchUp?.();
    }catch(error){
      console.warn('[NexAnime worker catchup]',username,String(error?.message||error).slice(0,250));
    }
  },60_000);
  runtime.catchUpTimer.unref?.();
  runtimes.set(username,runtime);
  return runtime;
}

function status(){
  const rows=[...runtimes.entries()].map(([username,runtime])=>({
    username:'@'+username,
    connected:runtime.client?.connected===true,
    publisher:runtime.animePublisher===true,
    anime:anime.animeIngestStatus(runtime)
  }));
  const primary=rows.find(x=>x.username.toLowerCase()==='@'+PRIMARY);
  return {
    ok:stopping!==true&&primary?.connected===true&&primary?.anime?.publisher===true,
    service:'nexanime-worker',
    independent:true,
    primary:'@'+PRIMARY,
    listeners:rows,
    startedAt:process.env.NEXANIME_WORKER_STARTED_AT||null
  };
}

function runtimeFor(target='',publisher=false){
  const q=String(target||'').trim().replace(/^@/,'').toLowerCase();
  const list=[...runtimes.values()];
  if(q){
    const exact=list.find(r=>String(r.account?.username||'').toLowerCase()===q||String(r.account?.telegramUserId||'')===q);
    if(exact&&(!publisher||exact.animePublisher===true))return exact;
  }
  return publisher?list.find(r=>r.animePublisher===true):list[0];
}

async function readBody(req){
  const chunks=[];
  for await(const c of req)chunks.push(c);
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return {}}
}

function reply(res,code,data){
  const body=JSON.stringify(data);
  res.writeHead(code,{'content-type':'application/json','content-length':Buffer.byteLength(body)});
  res.end(body);
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/','http://127.0.0.1');
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/health'||url.pathname==='/status'))return reply(res,200,status());
    if(req.method!=='POST')return reply(res,405,{ok:false,error:'method_not_allowed'});
    const body=await readBody(req);
    if(url.pathname==='/publish-now'){
      const runtime=runtimeFor(body.telegramUserId||body.username||'',true);
      if(!runtime)throw new Error('anime_publisher_runtime_not_active');
      return reply(res,200,await anime.animePublishNow(runtime));
    }
    if(url.pathname==='/discover'){
      const runtime=runtimeFor(body.telegramUserId||body.username||'',false);
      if(!runtime)throw new Error('anime_listener_runtime_not_active');
      return reply(res,200,{ok:true,...await anime.animeDiscoverNow(runtime),anime:anime.animeIngestStatus(runtime)});
    }
    if(url.pathname==='/rebuild'){
      const runtime=runtimeFor(body.telegramUserId||body.username||'',false);
      if(!runtime)throw new Error('anime_listener_runtime_not_active');
      return reply(res,200,await anime.animeBeginRebuild(runtime,{deadline:body.deadline||null}));
    }
    if(url.pathname==='/dedupe'){
      const runtime=runtimeFor(body.telegramUserId||body.username||'',true)||runtimeFor('',false);
      if(!runtime)throw new Error('anime_runtime_not_active');
      return reply(res,200,await anime.animeDedupePublishedEpisodeVariants(runtime,{dryRun:body.execute!==true}));
    }
    return reply(res,404,{ok:false,error:'not_found'});
  }catch(error){
    reply(res,500,{ok:false,error:String(error?.message||error).slice(0,1000)});
  }
});

async function shutdown(signal){
  if(stopping)return;
  stopping=true;
  console.log('[NexAnime worker] shutdown '+signal);
  server.close();
  for(const runtime of runtimes.values()){
    if(runtime.catchUpTimer)clearInterval(runtime.catchUpTimer);
    await anime.stopAnimeIngest(runtime).catch(()=>{});
    await runtime.client?.disconnect?.().catch(()=>{});
  }
  process.exit(0);
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

await fs.mkdir(SESSION_DIR,{recursive:true});
await connectRuntime(PRIMARY,{publisher:true});
for(const username of SCANNERS){
  if(username===PRIMARY)continue;
  await connectRuntime(username,{publisher:false});
}
server.listen(PORT,HOST,()=>console.log('[NexAnime worker] healthy on '+HOST+':'+PORT+' primary=@'+PRIMARY));
