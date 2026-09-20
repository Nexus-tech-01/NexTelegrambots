import crypto from 'node:crypto';
import http from 'node:http';
import { cfg, assertCoreConfig } from './config.mjs';
import { beginPairing, cancelPairing, cleanupPairings, pairingStatus, setPairingConnectedHandler, submitPairingCode, submitPairingPassword } from './pairing.mjs';
import { animeRuntimeDiscover, animeRuntimeRebuild, attachConnectedClient, engineStatus, loadSavedRuntimes, reconcileRuntimes, runtimeCommandTest, runtimeStatus, stopRuntimes } from './runtime.mjs';
import { listAccounts, patchSettings, closeStore } from './store.mjs';
import { startInlineBot, stopInlineBot } from './inline-bot.mjs';
import { loadBotToken } from './secrets.mjs';
import { ensureNexAiBot } from './bot-factory.mjs';
import { ensureAnalyticsIndex } from './analytics-indexer.mjs';
import { animeRetryQueue, animeSystemStatus } from './anime-ingest.mjs';
import { secondaryAnimeStatus, startSecondaryAnimeReader, stopSecondaryAnimeReader } from './anime-secondary-reader.mjs';

assertCoreConfig();

function json(res,status,data){
  const body=JSON.stringify(data);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body)});
  res.end(body);
}

function authorized(req){
  const expected=Buffer.from(String(cfg.controlKey||''));
  const actual=Buffer.from(String(req.headers['x-nexaccount-key']||''));
  return expected.length>0&&actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
}

async function body(req){
  const chunks=[];
  for await(const c of req)chunks.push(c);
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return {}}
}

async function onPaired(client,account){
  if(!(await loadBotToken())){
    try{
      const made=await ensureNexAiBot(client,account);
      if(made.created){
        console.log('[NexAccount] NexAI created @'+made.username);
        await startInlineBot();
      }
    }catch(e){
      console.error('[NexAccount BotFactory]',String(e?.message||e));
    }
  }
  await attachConnectedClient(client,account);
}

setPairingConnectedHandler(onPaired);

async function route(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  try{
    if(req.method==='GET'&&url.pathname==='/health'){
      const runtimes=runtimeStatus();
      return json(res,200,{
        ok:true,
        service:'nexaccount',
        botConfigured:!!(await loadBotToken()),
        botUsername:cfg.botUsername||null,
        worker:{id:cfg.workerId,index:cfg.workerIndex,count:cfg.workerCount,capacity:cfg.maxRuntimesPerWorker},
        runtimeCount:runtimes.length,
        secondaryAnime:secondaryAnimeStatus()
      });
    }
    if(!authorized(req))return json(res,401,{ok:false,error:'unauthorized'});
    if(req.method==='GET'&&url.pathname==='/accounts'){
      return json(res,200,{ok:true,accounts:await listAccounts(),runtimes:runtimeStatus()});
    }
    if(req.method==='GET'&&url.pathname==='/engines'){
      return json(res,200,await engineStatus());
    }
    if(req.method==='GET'&&url.pathname==='/anime/status'){
      return json(res,200,{...(await animeSystemStatus()),secondaryReader:secondaryAnimeStatus()});
    }
    if(req.method==='POST'&&url.pathname==='/anime/discover'){
      const q=await body(req);
      return json(res,200,await animeRuntimeDiscover(q.telegramUserId||q.username||''));
    }
    if(req.method==='POST'&&url.pathname==='/anime/rebuild'){
      const q=await body(req);
      return json(res,200,await animeRuntimeRebuild(q.telegramUserId||q.username||'',q.deadline||null));
    }
    if(req.method==='POST'&&url.pathname==='/anime/retry'){
      const q=await body(req);
      return json(res,200,await animeRetryQueue({
        includeQuarantine:q.includeQuarantine!==false,
        includeFailures:q.includeFailures!==false
      }));
    }
    if(url.pathname.startsWith('/pair/')&&!cfg.coordinator){
      return json(res,409,{ok:false,error:'pairing_coordinator_only',coordinatorWorker:0});
    }
    if(req.method==='GET'&&url.pathname==='/pair/status'){
      return json(res,200,{ok:true,...await pairingStatus(url.searchParams.get('id')||'')});
    }
    if(req.method==='POST'&&url.pathname==='/pair/start'){
      const q=await body(req);
      const state=await beginPairing(q.phone);
      return json(res,200,{ok:true,...state});
    }
    if(req.method==='POST'&&url.pathname==='/pair/code'){
      const q=await body(req);
      const state=await submitPairingCode(q.id,q.code);
      return json(res,200,{ok:true,...state});
    }
    if(req.method==='POST'&&url.pathname==='/pair/password'){
      const q=await body(req);
      const state=await submitPairingPassword(q.id,q.password);
      return json(res,200,{ok:true,...state});
    }
    if(req.method==='POST'&&url.pathname==='/pair/cancel'){
      const q=await body(req);
      const state=await cancelPairing(q.id||'');
      return json(res,200,{ok:true,...state});
    }
    if(req.method==='POST'&&url.pathname==='/diagnostics/command'){
      const q=await body(req);
      if(!q.telegramUserId)return json(res,400,{ok:false,error:'telegramUserId required'});
      const result=await runtimeCommandTest(q.telegramUserId,q.text||'.menu',q.peer||'me');
      return json(res,200,result);
    }
    if(req.method==='POST'&&url.pathname==='/settings'){
      const q=await body(req);
      if(!q.telegramUserId)return json(res,400,{ok:false,error:'telegramUserId required'});
      const allowed={};
      for(const key of ['language','style','prefix','autoReact','autoJoin','welcome','goodbye','antilink']){
        if(q[key]!==undefined)allowed[key]=q[key];
      }
      const settings=await patchSettings(q.telegramUserId,allowed);
      return json(res,200,{ok:true,settings});
    }
    return json(res,404,{ok:false,error:'not_found'});
  }catch(e){
    console.error('[NexAccount HTTP]',e);
    return json(res,500,{ok:false,error:String(e?.message||e)});
  }
}

const server=http.createServer((req,res)=>route(req,res));
server.listen(cfg.port,cfg.host,async()=>{
  console.log('[NexAccount] local control http://'+cfg.host+':'+cfg.port);
  if(cfg.coordinator)await startInlineBot().catch(e=>console.error('[NexAI bot]',e));
  const loaded=await loadSavedRuntimes().catch(e=>{console.error('[NexAccount restore]',e);return[]});
  if(cfg.coordinator)await startSecondaryAnimeReader().catch(e=>console.error('[NexAnime secondary]',e));
  console.log('[NexAccount] worker '+cfg.workerIndex+'/'+cfg.workerCount+(cfg.coordinator?' · coordinator':'')+' restored '+loaded.length+' account(s), capacity '+cfg.maxRuntimesPerWorker);
});

const reconcile=setInterval(()=>reconcileRuntimes().catch(e=>console.error('[NexAccount reconcile]',e)),cfg.reconcileMs);
reconcile.unref();

const cleanup=setInterval(()=>cleanupPairings().catch(e=>console.error('[NexAccount pairing cleanup]',e)),60000);
cleanup.unref();

if(cfg.coordinator)ensureAnalyticsIndex({maxAgeMs:0,waitForFirst:false}).catch(e=>console.error('[NexAI analytics]',e));
const analyticsRefresh=cfg.coordinator
  ? setInterval(()=>ensureAnalyticsIndex({maxAgeMs:0,waitForFirst:false}).catch(e=>console.error('[NexAI analytics]',e)),5*60*1000)
  : null;
analyticsRefresh?.unref?.();

async function shutdown(){
  clearInterval(cleanup);
  clearInterval(reconcile);
  if(analyticsRefresh)clearInterval(analyticsRefresh);
  try{server.close()}catch{}
  if(cfg.coordinator)await stopInlineBot();
  if(cfg.coordinator)await stopSecondaryAnimeReader().catch(()=>{});
  await stopRuntimes();
  await closeStore();
  process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
