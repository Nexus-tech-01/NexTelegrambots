import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {appendJsonl,parseTargets,probeHttp,readJson,rememberIncident,requestRepair,singletonLock,sleep,writeJsonAtomic,nowIso,clip} from './supervision-core.mjs';

const ROOT=path.resolve(process.env.NEX_ROOT||process.env.NEXCONTROL_FLEET_ROOT||(fssync.existsSync('/opt/nex/current')?'/opt/nex/current':process.cwd()));
const RUNTIME=path.resolve(process.env.NEX_AUTOMATION_RUNTIME_DIR||path.join(ROOT,'.nexcontrol/runtime'));
const STATE_FILE=path.resolve(process.env.NEX_AUTOMATION_STATE_FILE||path.join(RUNTIME,'automation-supervisor.json'));
const INCIDENT_FILE=path.resolve(process.env.NEX_AUTOMATION_INCIDENT_FILE||path.join(RUNTIME,'automation-incidents.jsonl'));
const REPAIR_QUEUE=path.resolve(process.env.NEX_AUTOMATION_REPAIR_QUEUE||path.join(RUNTIME,'nexforge-repair-queue.jsonl'));
const LOCK_FILE=path.resolve(process.env.NEX_AUTOMATION_LOCK_FILE||path.join(RUNTIME,'automation-supervisor.lock.json'));
const INTERVAL=Math.max(15_000,Number(process.env.NEX_AUTOMATION_INTERVAL_MS||60_000));
const AUTO_REPAIR=String(process.env.NEX_AUTOMATION_AUTO_REPAIR||'true').toLowerCase()!=='false';
const SYSTEMD=String(process.env.NEX_AUTOMATION_SYSTEMD_REPAIR||'true').toLowerCase()!=='false';
const FAILURE_THRESHOLD=Math.max(2,Number(process.env.NEX_AUTOMATION_FAILURE_THRESHOLD||2));

const apkStateFile=process.env.NEXCANAL__WATCHER_STATE_FILE||(fssync.existsSync('/var/lib/nex/state/internal-automation/nexcanal-watch-state-v2.json')?'/var/lib/nex/state/internal-automation/nexcanal-watch-state-v2.json':path.join(ROOT,'.nexcontrol/nexcanal-watch-state-v2.json'));
const whatsappData=process.env.WHATSAPP_DATA_DIR||process.env.DATA_DIR||'/var/lib/nex/whatsapp-publisher';
const whatsappQueue=path.join(whatsappData,'queue.json');
const whatsappHistory=path.join(whatsappData,'history.json');
const animeModule=path.join(ROOT,'nexaccount/anime-ingest.mjs');

const defaultTargets=[
  {id:'whatsapp',url:'http://127.0.0.1:'+(process.env.NEX_WHATSAPP_PORT||8790)+'/healthz',optional:true,service:process.env.NEX_WHATSAPP_SERVICE||'nex-whatsapp-publisher.service'},
  ...(process.env.NEX_FACEBOOK_HEALTH_URL?[{id:'facebook',url:process.env.NEX_FACEBOOK_HEALTH_URL,service:process.env.NEX_FACEBOOK_SERVICE||'nex-facebook.service'}]:[]),
  ...(process.env.NEXNEWS_HEALTH_URL?[{id:'nexnews',url:process.env.NEXNEWS_HEALTH_URL,service:process.env.NEXNEWS_SERVICE||'nexnews-publisher.service'}]:[]),
  ...(process.env.NEXTECH_HEALTH_URL?[{id:'nextech',url:process.env.NEXTECH_HEALTH_URL,service:process.env.NEXTECH_SERVICE||'nex-liteapks-watcher.service'}]:[])
];
const targets=parseTargets(process.env.NEX_AUTOMATION_TARGETS_JSON,defaultTargets);

const lock=await singletonLock(LOCK_FILE,'nex-automation-supervisor');
if(!lock.ok){console.log('[NexAutomationSupervisor] already running pid='+lock.pid);process.exit(0)}
let state=await readJson(STATE_FILE,{version:1,startedAt:nowIso(),incidents:{},incidentOrder:[],learnedRules:{},checks:{},cycles:0});
let stopping=false;
process.on('SIGTERM',()=>stopping=true);
process.on('SIGINT',()=>stopping=true);

async function incident(kind,target,severity,message,details={}){
  const row=rememberIncident(state,{kind,target,severity,message,details});
  await appendJsonl(INCIDENT_FILE,{...row,observedAt:nowIso()}).catch(()=>{});
  if(Number(row.count||0)>=FAILURE_THRESHOLD){
    const marker=row.id+':'+row.count;
    if(state.lastEscalationMarker!==marker){
      await appendJsonl(REPAIR_QUEUE,{
        type:'automation.repair',source:'automation-supervisor',fingerprint:row.id,
        severity,target,message:row.message,occurrences:row.count,details,
        constraints:{strict:true,requireLock:true,verifyBeforeDeploy:true,rollbackOnRegression:true},requestedAt:nowIso()
      }).catch(()=>{});
      state.lastEscalationMarker=marker;
    }
  }
  return row;
}

async function auditAnime(){
  try{
    await fs.access(animeModule);
    const mod=await import(path.toNamespacedPath(animeModule)+'?supervisor='+Date.now());
    if(typeof mod.animeSupervisorAudit!=='function')return {ok:false,skipped:'animeSupervisorAudit_not_exported'};
    return await mod.animeSupervisorAudit({repair:AUTO_REPAIR,source:'automation-supervisor'});
  }catch(error){
    return {ok:false,error:clip(error?.stack||error?.message||error,1500)};
  }
}

async function auditApk(){
  const st=await readJson(apkStateFile,null);
  if(!st)return {ok:false,error:'apk_state_unreadable',stateFile:apkStateFile};
  const now=Date.now();
  const updated=Date.parse(String(st.updatedAt||''));
  const queue=Array.isArray(st.queue)?st.queue:[];
  const pub=st.publication||{};
  const ledger=Array.isArray(pub.ledger)?pub.ledger:[];
  const stale=!Number.isFinite(updated)||now-updated>5*60_000;
  const duplicateKeys=[];
  const seen=new Set();
  for(const row of ledger){
    const key=String(row?.key||'');
    if(!key)continue;
    if(seen.has(key)&&!duplicateKeys.includes(key))duplicateKeys.push(key);
    seen.add(key);
  }
  const unrelatedGapViolations=[];
  const ordered=[...ledger].filter(x=>Number(x?.at||0)>0).sort((a,b)=>Number(a.at)-Number(b.at));
  for(let i=1;i<ordered.length;i++){
    const a=ordered[i-1],b=ordered[i];
    const companion=Boolean(a.batchId&&a.batchId===b.batchId);
    if(!companion&&Number(b.at)-Number(a.at)<60_000)unrelatedGapViolations.push({previous:a.key,current:b.key,gapMs:Number(b.at)-Number(a.at)});
  }
  return {
    ok:!stale&&!duplicateKeys.length&&!unrelatedGapViolations.length,
    stale,updatedAt:st.updatedAt||null,queueLength:queue.length,
    processing:Number(st.health?.processing||0),nextPublicationAt:Number(st.health?.nextPublicationAt||0),
    duplicateKeys:duplicateKeys.slice(0,20),gapViolations:unrelatedGapViolations.slice(-20),ledgerSize:ledger.length
  };
}

async function auditWhatsapp(){
  const q=await readJson(whatsappQueue,[]);
  const history=await readJson(whatsappHistory,[]);
  const now=Date.now();
  const pending=(Array.isArray(q)?q:[]).filter(x=>x.status==='pending');
  const stuck=pending.filter(x=>Number(x.nextAttemptAt||0)<now-15*60_000);
  const done=(Array.isArray(history)?history:[]).filter(x=>x.type==='published');
  const seen=new Set(),duplicates=[];
  for(const row of done){
    const key=String(row.publicationId||'')+'|'+String(row.destination||'');
    if(!row.publicationId)continue;
    if(seen.has(key)&&!duplicates.includes(key))duplicates.push(key);
    seen.add(key);
  }
  return {ok:stuck.length===0&&duplicates.length===0,pending:pending.length,stuck:stuck.slice(0,20).map(x=>({id:x.id,publicationId:x.publication?.id,destination:x.destination,attempts:x.attempts,nextAttemptAt:x.nextAttemptAt,lastError:x.lastError})),duplicates:duplicates.slice(0,20)};
}

async function auditTarget(target){
  const result=await probeHttp(target.url,{timeoutMs:Number(target.timeoutMs||8000),headers:target.headers||{}});
  const ok=result.ok;
  const id=String(target.id||target.url);
  const prior=state.checks[id]||{failures:0};
  state.checks[id]={...prior,ok,lastCheckAt:nowIso(),latencyMs:result.latencyMs,status:result.status,failures:ok?0:Number(prior.failures||0)+1};
  if(!ok&&state.checks[id].failures>=FAILURE_THRESHOLD&&AUTO_REPAIR){
    const cooldown=Number(prior.lastRepairAtMs||0)+10*60_000;
    if(Date.now()>=cooldown){
      const repair=await requestRepair({root:ROOT,target:id,reason:'Automation health failure '+clip(result.error||result.status,300),service:String(target.service||''),allowSystemd:SYSTEMD});
      state.checks[id].lastRepairAtMs=Date.now();state.checks[id].lastRepairAt=nowIso();state.checks[id].lastRepair=repair;
      return {id,ok:false,result,repair};
    }
  }
  return {id,ok,result};
}

async function cycle(){
  const started=Date.now();state.cycles=Number(state.cycles||0)+1;state.lastCycleStartedAt=nowIso();
  const results={};
  results.anime=await auditAnime();
  if(!results.anime.ok&&!results.anime.skipped)await incident('anime','pipeline','critical',results.anime.error||'Anime invariants violated',results.anime);
  else if(Array.isArray(results.anime.incidents)&&results.anime.incidents.length){
    for(const x of results.anime.incidents.slice(0,30))await incident('anime',x.target||x.kind||'pipeline',x.severity||'warning',x.message||x.kind||'anime invariant',x);
  }

  results.apk=await auditApk();
  if(!results.apk.ok){
    const severity=results.apk.stale?'critical':'warning';
    await incident('apk','nextech',severity,results.apk.stale?'APK watcher heartbeat stale':'APK publication invariant violated',results.apk);
    if(AUTO_REPAIR&&results.apk.stale){
      results.apk.repair=await requestRepair({root:ROOT,target:'apk-watcher',reason:'APK watcher state stale',service:process.env.NEX_APK_SERVICE||'nex-liteapks-watcher.service',allowSystemd:SYSTEMD});
    }
  }

  results.whatsapp=await auditWhatsapp();
  if(!results.whatsapp.ok)await incident('relay','whatsapp','warning','WhatsApp relay invariant violated',results.whatsapp);

  results.targets=[];
  for(const t of targets){
    const r=await auditTarget(t);results.targets.push(r);
    if(!r.ok&&!t.optional)await incident('health',String(t.id||t.url),'critical',r.result?.error||('HTTP '+r.result?.status),r);
  }

  state.lastCycleFinishedAt=nowIso();state.lastCycleDurationMs=Date.now()-started;state.lastResults=results;
  state.health={
    ok:Boolean(results.anime?.ok||results.anime?.skipped)&&results.apk?.ok!==false&&results.whatsapp?.ok!==false&&results.targets.every(x=>x.ok||targets.find(t=>String(t.id||t.url)===x.id)?.optional),
    anime:results.anime?.ok===true,apk:results.apk?.ok===true,whatsapp:results.whatsapp?.ok===true,
    targetFailures:results.targets.filter(x=>!x.ok).map(x=>x.id),learnedRuleCount:Object.keys(state.learnedRules||{}).length
  };
  await writeJsonAtomic(STATE_FILE,state);
  console.log('[NexAutomationSupervisor] cycle',JSON.stringify(state.health));
}

console.log('[NexAutomationSupervisor] started interval='+INTERVAL+'ms root='+ROOT);
while(!stopping){
  try{await cycle()}catch(error){
    await incident('supervisor','cycle','critical',error?.stack||error?.message||error,{phase:'cycle'}).catch(()=>{});
    await writeJsonAtomic(STATE_FILE,state).catch(()=>{});
    console.error('[NexAutomationSupervisor]',error);
  }
  if(!stopping)await sleep(INTERVAL);
}
await writeJsonAtomic(STATE_FILE,{...state,stoppedAt:nowIso()}).catch(()=>{});
