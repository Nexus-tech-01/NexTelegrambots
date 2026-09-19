import http from 'node:http';
import { cfg, assertCoreConfig } from './config.mjs';
import { beginPairing, cleanupPairings, pairingStatus, submitPairingCode, submitPairingPassword } from './pairing.mjs';
import { attachConnectedClient, loadSavedRuntimes, runtimeStatus, stopRuntimes } from './runtime.mjs';
import { listAccounts, patchSettings, closeStore } from './store.mjs';
import { startInlineBot, stopInlineBot } from './inline-bot.mjs';
import { loadBotToken } from './secrets.mjs';
import { ensureNexAiBot } from './bot-factory.mjs';
import { ensureAnalyticsIndex } from './analytics-indexer.mjs';
import { commandMap, registrySummary } from './commands.mjs';

assertCoreConfig();

function json(res,status,data){
  const body=JSON.stringify(data);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body)});
  res.end(body);
}

async function body(req){
  const chunks=[];
  for await(const c of req)chunks.push(c);
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return {}}
}

async function route(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  try{
    if(req.method==='GET'&&url.pathname==='/health'){
      const registry=registrySummary(commandMap());
      return json(res,200,{ok:true,service:'nexaccount',botConfigured:!!(await loadBotToken()),botUsername:cfg.botUsername||null,commands:registry,runtimes:runtimeStatus()});
    }
    if(req.method==='GET'&&url.pathname==='/accounts'){
      return json(res,200,{ok:true,accounts:await listAccounts(),runtimes:runtimeStatus()});
    }
    if(req.method==='GET'&&url.pathname==='/pair/status'){
      return json(res,200,{ok:true,...pairingStatus(url.searchParams.get('id')||'')});
    }
    if(req.method==='POST'&&url.pathname==='/pair/start'){
      const q=await body(req);
      const state=await beginPairing(q.phone,async(client,account)=>{
        await attachConnectedClient(client,account);
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
      });
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
  await startInlineBot().catch(e=>console.error('[NexAI bot]',e));
  const loaded=await loadSavedRuntimes().catch(e=>{console.error('[NexAccount restore]',e);return[]});
  console.log('[NexAccount] restored '+loaded.length+' account(s)');
});

const cleanup=setInterval(cleanupPairings,60000);
cleanup.unref();

ensureAnalyticsIndex({maxAgeMs:0,waitForFirst:false}).catch(e=>console.error('[NexAI analytics]',e));
const analyticsRefresh=setInterval(()=>ensureAnalyticsIndex({maxAgeMs:0,waitForFirst:false}).catch(e=>console.error('[NexAI analytics]',e)),5*60*1000);
analyticsRefresh.unref();

async function shutdown(){
  clearInterval(cleanup);
  clearInterval(analyticsRefresh);
  try{server.close()}catch{}
  await stopInlineBot();
  await stopRuntimes();
  await closeStore();
  process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
