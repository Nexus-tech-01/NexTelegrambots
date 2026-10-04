import crypto from 'node:crypto';
import http from 'node:http';
import { cfg, assertCoreConfig } from './config.mjs';
import { beginPairing, beginQrPairing, cancelPairing, cleanupPairings, pairingStatus, qrPairingStatus, setPairingConnectedHandler, submitPairingCode, submitPairingPassword } from './pairing.mjs';
import { animeRuntimeDedupe, animeRuntimeDiscover, animeRuntimePublishNow, animeRuntimeRebuild, attachConnectedClient, engineStatus, loadSavedRuntimes, reconcileRuntimes, runtimeAutoJoinAll, runtimeAutomationProbe, runtimeCommandTest, runtimeConnectionFor, runtimeConversationSend, runtimeGroupSmoke, runtimeMenuProbe, runtimeStatus, stopRuntimes } from './runtime.mjs';
import { listAccounts, patchSettings, closeStore } from './store.mjs';
import { startInlineBot, stopInlineBot } from './inline-bot.mjs';
import { loadBotToken } from './secrets.mjs';
import { ensureNexAiBot } from './bot-factory.mjs';
import { ensureAnalyticsIndex } from './analytics-indexer.mjs';
import { animeRetryQueue, animeSystemStatus } from './anime-ingest.mjs';
import { secondaryAnimeStatus, startSecondaryAnimeReader, stopSecondaryAnimeReader } from './anime-secondary-reader.mjs';

assertCoreConfig();
const PAIRING_ONLY=/^(?:1|true|yes|on)$/i.test(String(process.env.NEXACCOUNT_PAIRING_ONLY||'').trim());
const EMBEDDED_ANIME_ENABLED=!/^(?:0|false|no|off)$/i.test(String(process.env.NEXACCOUNT_EMBEDDED_ANIME||'true').trim());
const ANIME_WORKER_URL=String(process.env.NEXANIME_WORKER_URL||'http://127.0.0.1:18130').replace(/\/+$/,'');

async function standaloneAnimeStatus(){
  try{
    const response=await fetch(ANIME_WORKER_URL+'/health',{signal:AbortSignal.timeout(5000)});
    const data=await response.json();
    return {...data,httpStatus:response.status};
  }catch(error){
    return {ok:false,service:'nexanime-worker',independent:true,error:String(error?.message||error)};
  }
}

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
  if(PAIRING_ONLY){
    console.log('[NexAccount pairing-only] saved account '+String(account?.telegramUserId||'')+' for the production runtime');
    try{await client.disconnect()}catch{}
    return true;
  }
  if(!(await loadBotToken())){
    try{
      const made=await ensureNexAiBot(client,account);
      if(await loadBotToken()){
        const action=made.created?'created':made.recovered?'recovered':'restored';
        console.log('[NexAccount] NexAI '+action+' @'+String(made.username||cfg.botUsername||''));
        await startInlineBot();
      }else if(made?.reason){
        console.warn('[NexAccount BotFactory] token unavailable after pairing · '+made.reason);
      }
    }catch(e){
      console.error('[NexAccount BotFactory]',String(e?.message||e));
    }
  }
  const runtime=await attachConnectedClient(client,account);
  if(!runtime)throw new Error('RUNTIME_HANDOFF_BUSY');
  return true;
}

setPairingConnectedHandler(onPaired);

async function recoverInlineBotAfterRestore(){
  if(!cfg.coordinator||PAIRING_ONLY)return null;
  if(await loadBotToken())return startInlineBot();

  const ownerRuntime=runtimeConnectionFor(cfg.creatorUsername)||runtimeConnectionFor('');
  if(!ownerRuntime){
    console.warn('[NexAccount BotFactory] no connected owner runtime available to recover NexAI token');
    return null;
  }

  try{
    const made=await ensureNexAiBot(ownerRuntime.client,ownerRuntime.account);
    const token=await loadBotToken();
    if(!token){
      console.error('[NexAccount BotFactory] NexAI token recovery failed · '+String(made?.reason||'token_missing'));
      return null;
    }
    const action=made.created?'created':made.recovered?'recovered':'restored';
    console.log('[NexAccount] NexAI '+action+' after runtime restore @'+String(made.username||cfg.botUsername||''));
    return startInlineBot();
  }catch(error){
    console.error('[NexAccount BotFactory recovery]',String(error?.message||error));
    return null;
  }
}

async function runStartupSmoke(){
  const mode=String(process.env.NEXACCOUNT_STARTUP_SMOKE||'').trim().toLowerCase();
  if(!['1','true','yes','on','basic','full','download','health','group'].includes(mode))return;
  const active=runtimeStatus().find(row=>row.connected!==false)||runtimeStatus()[0];
  if(!active?.telegramUserId)throw new Error('startup_smoke_no_runtime');
  const id=String(active.telegramUserId);
  const basic=['.ping','.alive','.account','.settings','.style','.calc 2+2'];
  const full=[...basic,'.translate en bonjour','.ai Réponds seulement par OK.','.animeinfo Naruto'];
  const download=[
    '.song https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    '.video https://www.youtube.com/watch?v=aqz-KE-bpKQ'
  ];
  const commands=mode==='full'?full:mode==='download'?download:(mode==='health'||mode==='group')?[]:basic;
  const results=[];
  const menu=await runtimeMenuProbe(id,'me');
  results.push({type:'menu',ok:menu?.ok===true,resultType:menu?.resultType||null});
  const engines=await engineStatus();
  results.push({
    type:'engines',
    ok:engines?.ok===true,
    runtimeConnected:engines?.runtimeConnected===true,
    services:(engines?.engines||[]).map(row=>({
      service:row.service,
      configured:row.configured===true,
      reachable:row.reachable===true,
      ...(row.service==='sticker'&&row.probe?{probe:row.probe}:{})
    }))
  });
  for(const text of commands){
    try{
      const result=await runtimeCommandTest(id,text,'me');
      results.push({type:'command',text,ok:result?.ok===true});
    }catch(error){
      results.push({type:'command',text,ok:false,error:String(error?.message||error).slice(0,300)});
    }
  }
  if(mode==='group'){
    try{
      const group=await runtimeGroupSmoke(id);
      results.push({type:'group-smoke',...group});
    }catch(error){
      results.push({type:'group-smoke',ok:false,error:String(error?.message||error).slice(0,500)});
    }
  }
  console.log('[NexAccount startup-smoke]',JSON.stringify({mode,telegramUserId:id,results}));
}

async function route(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  try{
    if(req.method==='GET'&&url.pathname==='/health'){
      const runtimes=runtimeStatus();
      return json(res,200,{
        ok:true,
        service:'nexaccount',
        architecture:{version:3,sessionLayer:'NexAccount',engineLayer:'NexAI',presentationLayer:'Inline bot'},
        botConfigured:!!(await loadBotToken()),
        botUsername:cfg.botUsername||null,
        worker:{id:cfg.workerId,index:cfg.workerIndex,count:cfg.workerCount,capacity:cfg.maxRuntimesPerWorker},
        runtimeCount:runtimes.length,
        pairingOnly:PAIRING_ONLY,
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
      if(!EMBEDDED_ANIME_ENABLED)return json(res,200,await standaloneAnimeStatus());
      return json(res,200,{...(await animeSystemStatus()),secondaryReader:secondaryAnimeStatus()});
    }
    if(req.method==='POST'&&url.pathname==='/anime/discover'){
      const q=await body(req);
      return json(res,200,await animeRuntimeDiscover(q.telegramUserId||q.username||''));
    }
    if(req.method==='POST'&&url.pathname==='/anime/publish-now'){
      const q=await body(req);
      return json(res,200,await animeRuntimePublishNow(q.telegramUserId||q.username||''));
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
    if(req.method==='POST'&&url.pathname==='/anime/dedupe'){
      const q=await body(req);
      return json(res,200,await animeRuntimeDedupe(
        q.telegramUserId||q.username||'',
        q.execute===true
      ));
    }
    if(url.pathname.startsWith('/pair/')&&!cfg.coordinator){
      return json(res,409,{ok:false,error:'pairing_coordinator_only',coordinatorWorker:0});
    }
    if(req.method==='GET'&&url.pathname==='/pair/status'){
      return json(res,200,{ok:true,...await pairingStatus(url.searchParams.get('id')||'')});
    }
    if(req.method==='GET'&&url.pathname==='/pair/qr-status'){
      return json(res,200,{ok:true,...await qrPairingStatus(url.searchParams.get('id')||'')});
    }
    if(req.method==='POST'&&url.pathname==='/pair/qr-start'){
      const state=await beginQrPairing();
      return json(res,200,{ok:true,...state});
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
    if(req.method==='POST'&&url.pathname==='/conversation/send'){
      const q=await body(req);
      if(!q.chatId)return json(res,400,{ok:false,error:'chatId required'});
      return json(res,200,await runtimeConversationSend(q.telegramUserId||'',q));
    }
    if(req.method==='POST'&&url.pathname==='/diagnostics/command'){
      const q=await body(req);
      if(!q.telegramUserId)return json(res,400,{ok:false,error:'telegramUserId required'});
      const result=await runtimeCommandTest(q.telegramUserId,q.text||'.menu',q.peer||'me');
      return json(res,200,result);
    }
    if(req.method==='POST'&&url.pathname==='/diagnostics/menu'){
      const q=await body(req);
      if(!q.telegramUserId)return json(res,400,{ok:false,error:'telegramUserId required'});
      return json(res,200,await runtimeMenuProbe(q.telegramUserId,q.peer||'me'));
    }
    if(req.method==='POST'&&url.pathname==='/diagnostics/group'){
      const q=await body(req);
      if(!q.telegramUserId)return json(res,400,{ok:false,error:'telegramUserId required'});
      return json(res,200,await runtimeGroupSmoke(q.telegramUserId));
    }
    if(req.method==='POST'&&url.pathname==='/diagnostics/auto-join'){
      const q=await body(req);
      return json(res,200,await runtimeAutoJoinAll(q.telegramUserId||q.username||''));
    }
    if(req.method==='POST'&&url.pathname==='/diagnostics/automations'){
      const q=await body(req);
      return json(res,200,await runtimeAutomationProbe(q.telegramUserId||q.username||''));
    }
    if(req.method==='POST'&&url.pathname==='/settings'){
      const q=await body(req);
      if(!q.telegramUserId)return json(res,400,{ok:false,error:'telegramUserId required'});
      const allowed={};
      for(const key of ['language','style','prefix','accessMode','menuImageUrl','menuImageStyle','botDisplayName','customEmojiIds','autoReact','autoJoin','welcome','goodbye','antilink']){
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
  console.log('[NexAccount] local control http://'+cfg.host+':'+cfg.port+(PAIRING_ONLY?' · pairing-only':''));

  const hadBotToken=cfg.coordinator&&!PAIRING_ONLY
    ?Boolean(await loadBotToken())
    :false;
  if(hadBotToken){
    await startInlineBot().catch(e=>console.error('[NexAI bot]',e));
  }

  const loaded=PAIRING_ONLY
    ?[]
    :await loadSavedRuntimes().catch(e=>{console.error('[NexAccount restore]',e);return[]});

  if(cfg.coordinator&&!PAIRING_ONLY&&!hadBotToken){
    await recoverInlineBotAfterRestore();
  }

  if(cfg.coordinator&&!PAIRING_ONLY)await startSecondaryAnimeReader().catch(e=>console.error('[NexAnime secondary]',e));
  console.log('[NexAccount] worker '+cfg.workerIndex+'/'+cfg.workerCount+(cfg.coordinator?' · coordinator':'')+(PAIRING_ONLY?' · pairing-only':'')+' restored '+loaded.length+' account(s), capacity '+cfg.maxRuntimesPerWorker);
  if(!PAIRING_ONLY)await runStartupSmoke().catch(error=>console.error('[NexAccount startup-smoke]',String(error?.message||error)));
});

const reconcile=PAIRING_ONLY
  ?null
  :setInterval(()=>reconcileRuntimes().catch(e=>console.error('[NexAccount reconcile]',e)),cfg.reconcileMs);
reconcile?.unref?.();

const cleanup=setInterval(()=>cleanupPairings().catch(e=>console.error('[NexAccount pairing cleanup]',e)),60000);
cleanup.unref();

if(cfg.coordinator&&!PAIRING_ONLY)ensureAnalyticsIndex({maxAgeMs:0,waitForFirst:false}).catch(e=>console.error('[NexAI analytics]',e));
const analyticsRefresh=cfg.coordinator&&!PAIRING_ONLY
  ? setInterval(()=>ensureAnalyticsIndex({maxAgeMs:0,waitForFirst:false}).catch(e=>console.error('[NexAI analytics]',e)),5*60*1000)
  : null;
analyticsRefresh?.unref?.();

async function shutdown(){
  clearInterval(cleanup);
  if(reconcile)clearInterval(reconcile);
  if(analyticsRefresh)clearInterval(analyticsRefresh);
  try{server.close()}catch{}
  if(cfg.coordinator&&!PAIRING_ONLY)await stopInlineBot();
  if(cfg.coordinator&&!PAIRING_ONLY)await stopSecondaryAnimeReader().catch(()=>{});
  await stopRuntimes();
  await closeStore();
  process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
