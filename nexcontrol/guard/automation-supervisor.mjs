import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ROOT=path.resolve(process.env.NEX_ROOT||'/opt/nex/current');
const RUNTIME=path.resolve(process.env.NEX_AUTOMATION_RUNTIME||path.join(ROOT,'.nexcontrol/runtime/automation-supervisor'));
const STATE_FILE=path.join(RUNTIME,'state.json');
const INCIDENTS_FILE=path.join(RUNTIME,'incidents.jsonl');
const REPAIR_QUEUE=path.join(RUNTIME,'repair-requests.jsonl');
const LOCK_FILE=path.join(RUNTIME,'automation-supervisor.lock.json');
const LITEAPK_STATE=process.env.NEX_LITEAPKS_STATE_FILE||'/var/lib/nex/state/internal-automation/nexcanal-watch-state-v2.json';
const INTERVAL_MS=Math.max(15000,Number(process.env.NEX_AUTOMATION_SUPERVISOR_INTERVAL_MS||60000));
const ANIME_STALE_MS=Math.max(2*60*1000,Number(process.env.NEX_AUTOMATION_ANIME_STALE_MS||15*60*1000));
const LITEAPK_STALE_MS=Math.max(60_000,Number(process.env.NEX_AUTOMATION_LITEAPK_STALE_MS||5*60*1000));
const PUBLICATION_OVERDUE_GRACE_MS=Math.max(60_000,Number(process.env.NEX_AUTOMATION_OVERDUE_GRACE_MS||20*60*1000));

await fs.mkdir(RUNTIME,{recursive:true});

async function readJson(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return fallback}}
async function writeJsonAtomic(file,data){
  const tmp=file+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});
  await fs.rename(tmp,file);
}
async function appendJsonl(file,row){await fs.appendFile(file,JSON.stringify(row)+'\n',{mode:0o600})}
function nowIso(){return new Date().toISOString()}
function sig(kind,evidence={}){
  return crypto.createHash('sha256').update(kind+'|'+JSON.stringify(evidence)).digest('hex').slice(0,20);
}
function normalizeDate(v){const n=typeof v==='number'?v:Date.parse(String(v||''));return Number.isFinite(n)?n:0}
function parseHealthUrls(){
  return String(process.env.NEX_AUTOMATION_HEALTH_URLS||'')
    .split(/[;,\n]+/)
    .map(x=>x.trim()).filter(Boolean)
    .map((entry,i)=>{
      const p=entry.indexOf('=');
      return p>0?{name:entry.slice(0,p).trim(),url:entry.slice(p+1).trim()}:{name:'health-'+(i+1),url:entry};
    })
    .filter(x=>/^https?:\/\//i.test(x.url));
}

const oldLock=await readJson(LOCK_FILE,null);
if(oldLock?.pid&&Number(oldLock.pid)!==process.pid){
  try{process.kill(Number(oldLock.pid),0);console.log('[AutomationSupervisor] already running pid='+oldLock.pid);process.exit(0)}catch{}
}
await writeJsonAtomic(LOCK_FILE,{pid:process.pid,startedAt:nowIso()});

let state=await readJson(STATE_FILE,{version:1,startedAt:nowIso(),cycles:0,signatures:{},metrics:{}});
state.signatures=state.signatures||{};
state.metrics=state.metrics||{};
let stopping=false;
process.on('SIGTERM',()=>{stopping=true});
process.on('SIGINT',()=>{stopping=true});

async function emitIncident(kind,severity,evidence,repairHint=''){
  const signature=sig(kind,evidence);
  const s=state.signatures[signature]||{count:0,firstSeenAt:nowIso(),lastSeenAt:null,lastRepairRequestAt:null};
  s.count++;
  s.lastSeenAt=nowIso();
  state.signatures[signature]=s;
  const row={id:crypto.randomUUID(),kind,severity,signature,detectedAt:nowIso(),recurrenceCount:s.count,evidence};
  await appendJsonl(INCIDENTS_FILE,row);

  const last=normalizeDate(s.lastRepairRequestAt);
  const shouldRequest=severity==='critical'||s.count>=2;
  if(shouldRequest&&Date.now()-last>15*60*1000){
    s.lastRepairRequestAt=nowIso();
    await appendJsonl(REPAIR_QUEUE,{
      id:crypto.randomUUID(),
      kind:'automation_repair',
      priority:severity,
      createdAt:nowIso(),
      incidentSignature:signature,
      incidentKind:kind,
      instruction:repairHint||'Diagnose this automation failure through NexForge. Acquire exclusive locks before editing. Persist code changes to Git, run targeted and regression tests, deploy via NexControl, verify production, and roll back on regression.',
      evidence
    });
  }
  return row;
}

function metric(name,value){
  const n=Number(value);
  if(!Number.isFinite(n))return;
  const m=state.metrics[name]||{samples:0,ewma:n,max:n,min:n};
  m.samples++;
  m.ewma=Math.round((Number(m.ewma||n)*0.85+n*0.15)*100)/100;
  m.max=Math.max(Number(m.max??n),n);
  m.min=Math.min(Number(m.min??n),n);
  m.last=n;
  m.updatedAt=nowIso();
  state.metrics[name]=m;
}

async function auditHealthEndpoints(){
  const rows=[];
  for(const item of parseHealthUrls()){
    const ctl=new AbortController();
    const timer=setTimeout(()=>ctl.abort(),5000);
    try{
      const started=Date.now();
      const res=await fetch(item.url,{signal:ctl.signal});
      const latencyMs=Date.now()-started;
      metric('http.'+item.name+'.latencyMs',latencyMs);
      rows.push({name:item.name,url:item.url,ok:res.ok,status:res.status,latencyMs});
      if(!res.ok)await emitIncident('health_endpoint_failed','high',{name:item.name,status:res.status,url:item.url},'Inspect the failing relay/service endpoint, its logs and upstream dependencies. Repair only after acquiring its NexForge resource lock.');
    }catch(error){
      const evidence={name:item.name,url:item.url,error:String(error?.name==='AbortError'?'timeout':error?.message||error)};
      rows.push({...evidence,ok:false});
      await emitIncident('health_endpoint_unreachable','high',evidence,'Inspect process/service health and network dependencies. Restart only the explicitly affected service, then verify the endpoint.');
    }finally{clearTimeout(timer)}
  }
  return rows;
}

async function auditLiteApk(){
  const st=await readJson(LITEAPK_STATE,null);
  if(!st){
    const evidence={stateFile:LITEAPK_STATE};
    await emitIncident('liteapk_state_unreadable','critical',evidence,'Use NexControl to inspect the LiteAPK watcher and its state/logs. Restore the watcher before touching queue data.');
    return {ok:false,...evidence};
  }
  const queue=Array.isArray(st.queue)?st.queue:[];
  metric('liteapk.queueLength',queue.length);
  const updated=normalizeDate(st.updatedAt);
  const ageMs=updated?Date.now()-updated:Infinity;
  const health=st.health||{};
  const processing=Number(health.processing||0);
  const nextPublicationAt=Number(health.nextPublicationAt||0);
  const ready=queue.filter(x=>Number(x.nextRetryAt||0)<=Date.now());
  const keys=new Map();
  const duplicateKeys=[];
  for(const item of queue){
    const k=String(item?.key||'');
    if(!k)continue;
    if(keys.has(k))duplicateKeys.push(k); else keys.set(k,true);
  }

  if(ageMs>LITEAPK_STALE_MS){
    await emitIncident('liteapk_heartbeat_stale','critical',{ageMs,updatedAt:st.updatedAt,queueLength:queue.length,processing},'Restart the LiteAPK watcher through NexControl, verify its heartbeat advances, then verify the next publication batch.');
  }
  if(duplicateKeys.length){
    await emitIncident('liteapk_queue_duplicates','high',{duplicates:[...new Set(duplicateKeys)].slice(0,50),queueLength:queue.length},'Inspect queue-generation/dedupe logic. Do not rewrite the live state file while the watcher is running; fix the producer and let the owner process reconcile safely.');
  }
  if(ready.length&&nextPublicationAt>0&&Date.now()>nextPublicationAt+PUBLICATION_OVERDUE_GRACE_MS&&processing===0){
    await emitIncident('liteapk_publication_overdue','critical',{ready:ready.length,queueLength:queue.length,nextPublicationAt,overdueMs:Date.now()-nextPublicationAt},'Inspect publication lease/batch state, Telegram publisher health and flood/rate-limit errors. Repair the blocked worker and verify one complete APK batch publishes together.');
  }
  return {ok:ageMs<=LITEAPK_STALE_MS&&!duplicateKeys.length,ageMs,queueLength:queue.length,ready:ready.length,processing,nextPublicationAt,duplicateKeys:duplicateKeys.length};
}

async function loadAnimeDb(){
  try{
    const mod=await import('../../nexaccount/store.mjs');
    return await mod.db();
  }catch(error){
    await emitIncident('anime_database_unavailable','critical',{error:String(error?.message||error)},'Verify NexAccount MongoDB configuration/connectivity and the anime runtime. Do not change publication state until the database connection is healthy.');
    return null;
  }
}

async function auditAnime(){
  const d=await loadAnimeDb();
  if(!d)return {ok:false,error:'db_unavailable'};
  const now=new Date();
  const cutoff=new Date(Date.now()-ANIME_STALE_MS);
  const queue=d.collection('nexanime_queue');
  const pubs=d.collection('nexanime_publications');
  const config=d.collection('nexanime_config');

  const [duplicatePublished,stalePublishing,publishingRows,scheduler,recentPublications]=await Promise.all([
    pubs.aggregate([
      {$match:{kind:'episode',purgedAt:{$exists:false},telegramMessageId:{$gt:0}}},
      {$group:{_id:{seriesKey:'$seriesKey',season:'$season',episode:'$episode'},count:{$sum:1},messages:{$push:'$telegramMessageId'},titles:{$addToSet:'$title'}}},
      {$match:{count:{$gt:1}}},
      {$limit:100}
    ]).toArray(),
    queue.find({status:'publishing',$or:[{claimAt:{$lt:cutoff}},{claimAt:{$exists:false}}]},{projection:{seriesKey:1,title:1,season:1,episode:1,claimAt:1,claimBy:1,dedupeKey:1}}).limit(100).toArray(),
    queue.find({status:'publishing'},{projection:{seriesKey:1,title:1,season:1,episode:1,claimAt:1,claimBy:1}}).limit(100).toArray(),
    config.findOne({_id:'scheduler'}),
    pubs.find({purgedAt:{$exists:false},telegramMessageId:{$gt:0}},{projection:{seriesKey:1,title:1,kind:1,season:1,episode:1,publishedAt:1,telegramMessageId:1}}).sort({publishedAt:-1}).limit(5000).toArray()
  ]);

  metric('anime.duplicatePublished',duplicatePublished.length);
  metric('anime.stalePublishing',stalePublishing.length);
  metric('anime.currentPublishing',publishingRows.length);

  if(duplicatePublished.length){
    await emitIncident('anime_duplicate_published_episode','critical',{duplicates:duplicatePublished.slice(0,30)},'Freeze further publication for the affected episode identities, inspect Telegram message IDs and publication records, keep exactly one canonical publication, then add a regression test for the duplicate path.');
  }
  if(stalePublishing.length){
    await emitIncident('anime_stale_publishing_claims','high',{count:stalePublishing.length,items:stalePublishing.slice(0,30)},'Let the anime stale-claim reconciler recover them. If it does not, inspect NexCanal handoff state and publisher logs before changing queue status.');
  }

  const publishingSeries=[...new Set(publishingRows.map(x=>String(x.seriesKey||'')).filter(Boolean))];
  if(publishingSeries.length>1){
    await emitIncident('anime_cross_series_concurrent_publish','critical',{series:publishingSeries,items:publishingRows.slice(0,50)},'Stop concurrent cross-series publishing, inspect the global publisher lease and scheduler ownership, then verify only one active series can claim items.');
  }

  const bySeries=new Map();
  for(const p of recentPublications){
    const key=String(p.seriesKey||'');
    if(!key)continue;
    if(!bySeries.has(key))bySeries.set(key,[]);
    bySeries.get(key).push(p);
  }
  const synopsisViolations=[];
  const orderViolations=[];
  for(const [seriesKey,rows] of bySeries){
    const chronological=[...rows].sort((a,b)=>normalizeDate(a.publishedAt)-normalizeDate(b.publishedAt));
    const presentation=chronological.find(x=>x.kind==='presentation'&&(x.episode==null));
    const episodes=chronological.filter(x=>x.kind==='episode'&&x.episode!=null);
    if(episodes.length){
      if(!presentation||normalizeDate(episodes[0].publishedAt)<normalizeDate(presentation.publishedAt)){
        synopsisViolations.push({seriesKey,title:episodes[0]?.title||presentation?.title||'',firstEpisode:episodes[0]?.episode,episodeMessageId:episodes[0]?.telegramMessageId,presentationMessageId:presentation?.telegramMessageId||null});
      }
      let prev=null;
      for(const ep of episodes){
        const cur={season:Number(ep.season??1),episode:Number(ep.episode)};
        if(prev&&(cur.season<prev.season||(cur.season===prev.season&&cur.episode<prev.episode))){
          orderViolations.push({seriesKey,title:ep.title,previous:prev,current:cur,messageId:ep.telegramMessageId});
          break;
        }
        prev=cur;
      }
    }
  }

  if(synopsisViolations.length){
    await emitIncident('anime_synopsis_order_violation','critical',{violations:synopsisViolations.slice(0,30)},'For future items, keep the hard synopsis gate enabled. For affected history, verify the correct anime identity and repair channel ordering only with explicit, verified Telegram message operations.');
  }
  if(orderViolations.length){
    await emitIncident('anime_episode_order_violation','critical',{violations:orderViolations.slice(0,30)},'Pause the affected series, verify source identity/season/episode metadata, rebuild its queue in strict numeric order, and add a regression test for the failure pattern.');
  }

  if(scheduler?.gapDetected){
    const gapAge=Date.now()-normalizeDate(scheduler.gapDetected.detectedAt);
    metric('anime.gapAgeMs',gapAge);
    if(gapAge>30*60*1000){
      await emitIncident('anime_persistent_episode_gap','high',{gapDetected:scheduler.gapDetected,gapAgeMs:gapAge},'Search/backfill the missing episode from trusted anime sources. Do not skip over the gap or relabel another media file as the missing episode.');
    }
  }

  // Low-risk deterministic repair: once an episode is already published,
  // queued alternate variants must never be published later as duplicates.
  const canonical=new Map();
  for(const p of recentPublications){
    if(p.kind!=='episode'||p.episode==null)continue;
    const k=[p.seriesKey,Number(p.season??1),Number(p.episode)].join('|');
    if(!canonical.has(k))canonical.set(k,p);
  }
  let suppressed=0;
  for(const p of canonical.values()){
    const res=await queue.updateMany(
      {seriesKey:p.seriesKey,kind:'episode',season:p.season??1,episode:p.episode,status:'queued'},
      {$set:{status:'superseded',supersededAt:now,supersededReason:'automation_supervisor_episode_already_published',preferredTelegramMessageId:p.telegramMessageId,updatedAt:now}}
    );
    suppressed+=Number(res.modifiedCount||0);
  }
  if(suppressed){
    await appendJsonl(INCIDENTS_FILE,{id:crypto.randomUUID(),kind:'anime_queued_duplicates_suppressed',severity:'info',detectedAt:nowIso(),count:suppressed});
  }

  return {
    ok:!duplicatePublished.length&&!stalePublishing.length&&publishingSeries.length<=1&&!synopsisViolations.length&&!orderViolations.length,
    duplicatePublished:duplicatePublished.length,
    stalePublishing:stalePublishing.length,
    publishingSeries,
    synopsisViolations:synopsisViolations.length,
    orderViolations:orderViolations.length,
    suppressedQueuedDuplicates:suppressed,
    gapDetected:scheduler?.gapDetected||null
  };
}

async function runCycle(){
  const started=Date.now();
  const [liteapk,anime,healthEndpoints]=await Promise.all([
    auditLiteApk().catch(error=>({ok:false,error:String(error?.message||error)})),
    auditAnime().catch(error=>({ok:false,error:String(error?.message||error)})),
    auditHealthEndpoints().catch(error=>[{ok:false,error:String(error?.message||error)}])
  ]);
  state.cycles=Number(state.cycles||0)+1;
  state.lastCycleAt=nowIso();
  state.lastCycleMs=Date.now()-started;
  state.last={liteapk,anime,healthEndpoints};
  state.pid=process.pid;
  await writeJsonAtomic(STATE_FILE,state);
  return state.last;
}

console.log('[AutomationSupervisor] started interval='+INTERVAL_MS+'ms');
while(!stopping){
  const started=Date.now();
  try{await runCycle()}catch(error){console.error('[AutomationSupervisor] cycle failed',String(error?.stack||error))}
  await sleep(Math.max(500,INTERVAL_MS-(Date.now()-started)));
}
try{const x=await readJson(LOCK_FILE,{});if(Number(x?.pid)===process.pid)await fs.rm(LOCK_FILE,{force:true})}catch{}
console.log('[AutomationSupervisor] stopped');
