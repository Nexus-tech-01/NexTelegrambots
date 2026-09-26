import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BOOT_MS=Date.now();
const ROOT=path.resolve(process.env.NEX_ROOT||'/opt/nex/current');
const CONFIG=path.resolve(process.env.NEXGUARD_CONFIG||path.join(ROOT,'nexcontrol/guard/guard.config.json'));
const RUNTIME=path.resolve(process.env.NEXGUARD_RUNTIME||path.join(ROOT,'.nexcontrol/runtime/nexguard'));
const STATE_FILE=path.join(RUNTIME,'state.json');
const INCIDENTS_FILE=path.join(RUNTIME,'incidents.jsonl');
const REPAIR_QUEUE=path.join(RUNTIME,'repair-requests.jsonl');
const LOCK_FILE=path.join(RUNTIME,'nexguard.lock.json');

await fs.mkdir(RUNTIME,{recursive:true});

async function readJson(file,fallback={}){
  try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return fallback}
}
async function writeJsonAtomic(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});
  await fs.rename(tmp,file);
}
async function appendJsonl(file,row){
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.appendFile(file,JSON.stringify(row)+'\n',{mode:0o600});
}
function getField(obj,field){
  return String(field||'').split('.').filter(Boolean).reduce((v,k)=>v==null?undefined:v[k],obj);
}
function signature(target,result){
  return crypto.createHash('sha256')
    .update(JSON.stringify({name:target.name,type:target.type,error:result?.error||'',code:result?.code||'',status:result?.status||''}))
    .digest('hex').slice(0,20);
}
function nowIso(){return new Date().toISOString()}

const existingLock=await readJson(LOCK_FILE,null);
if(existingLock?.pid&&Number(existingLock.pid)!==process.pid){
  try{
    process.kill(Number(existingLock.pid),0);
    console.log('[NexGuard] already running pid='+existingLock.pid);
    process.exit(0);
  }catch{}
}
await writeJsonAtomic(LOCK_FILE,{pid:process.pid,startedAt:nowIso()});
const release=async()=>{try{const x=await readJson(LOCK_FILE,{});if(Number(x.pid)===process.pid)await fs.rm(LOCK_FILE,{force:true})}catch{}};
process.on('exit',()=>{});
process.on('SIGTERM',()=>{stopping=true});
process.on('SIGINT',()=>{stopping=true});

let config=await readJson(CONFIG,null);
if(!config){
  console.warn('[NexGuard] config not found:',CONFIG,'running observation-only with no configured targets');
  config={targets:[]};
}
const settings={
  intervalMs:Math.max(5000,Number(process.env.NEXGUARD_INTERVAL_MS||config.intervalMs||30000)),
  failureThreshold:Math.max(1,Number(config.failureThreshold||2)),
  repairCooldownMs:Math.max(30000,Number(config.repairCooldownMs||300000)),
  verifyDelayMs:Math.max(1000,Number(config.verifyDelayMs||8000)),
  targets:Array.isArray(config.targets)?config.targets:[]
};

let state=await readJson(STATE_FILE,{version:1,targets:{},signatures:{},startedAt:nowIso()});
state.targets=state.targets||{};
state.signatures=state.signatures||{};

async function checkSystemd(t){
  try{
    const {stdout}=await execFileAsync('/bin/systemctl',['is-active',String(t.service)],{timeout:Number(t.timeoutMs||5000)});
    const status=String(stdout||'').trim();
    return {ok:status==='active',status,error:status==='active'?'':'service_not_active'};
  }catch(error){
    return {ok:false,error:String(error?.message||error),code:error?.code||null};
  }
}
async function checkHttp(t){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Math.max(500,Number(t.timeoutMs||5000)));
  try{
    const started=Date.now();
    const res=await fetch(String(t.url),{method:t.method||'GET',signal:controller.signal,headers:t.headers||{}});
    const text=await res.text().catch(()=>'');
    const expected=Array.isArray(t.expectedStatus)?t.expectedStatus:[Number(t.expectedStatus||200)];
    return {ok:expected.includes(res.status),status:res.status,latencyMs:Date.now()-started,body:text.slice(0,500),error:expected.includes(res.status)?'':'unexpected_http_status'};
  }catch(error){
    return {ok:false,error:String(error?.name==='AbortError'?'http_timeout':error?.message||error)};
  }finally{clearTimeout(timeout)}
}
async function checkFileHeartbeat(t){
  try{
    const raw=await fs.readFile(path.resolve(String(t.path)),'utf8');
    const doc=JSON.parse(raw);
    const v=getField(doc,t.timestampField||'updatedAt');
    const ts=typeof v==='number'?v:Date.parse(String(v||''));
    const ageMs=Number.isFinite(ts)?Date.now()-ts:Infinity;
    const maxAgeMs=Math.max(1000,Number(t.maxAgeMs||300000));
    return {ok:ageMs<=maxAgeMs,ageMs,timestamp:v,error:ageMs<=maxAgeMs?'':'heartbeat_stale'};
  }catch(error){return {ok:false,error:'heartbeat_unreadable: '+String(error?.message||error)}}
}
async function checkCommand(t){
  const file=String(t.file||'').trim();
  const args=Array.isArray(t.args)?t.args.map(String):[];
  if(!file||!path.isAbsolute(file))return {ok:false,error:'command_requires_absolute_file'};
  try{
    const started=Date.now();
    const {stdout,stderr}=await execFileAsync(file,args,{timeout:Math.max(1000,Number(t.timeoutMs||30000)),cwd:t.cwd?path.resolve(String(t.cwd)):ROOT,env:{...process.env,...(t.env||{})},maxBuffer:1024*1024});
    return {ok:true,latencyMs:Date.now()-started,stdout:String(stdout||'').slice(-2000),stderr:String(stderr||'').slice(-1000)};
  }catch(error){
    return {ok:false,error:String(error?.message||error),code:error?.code||null,stdout:String(error?.stdout||'').slice(-1000),stderr:String(error?.stderr||'').slice(-2000)};
  }
}
async function runCheck(t){
  if(t.type==='systemd')return checkSystemd(t);
  if(t.type==='http')return checkHttp(t);
  if(t.type==='fileHeartbeat')return checkFileHeartbeat(t);
  if(t.type==='command')return checkCommand(t);
  return {ok:false,error:'unsupported_check_type'};
}

async function restartService(service){
  if(!/^[A-Za-z0-9_.@:-]+\.service$/.test(String(service||'')))return {ok:false,error:'invalid_service_name'};
  try{
    await execFileAsync('/bin/systemctl',['restart',String(service)],{timeout:30000});
    return {ok:true};
  }catch(error){return {ok:false,error:String(error?.message||error)}}
}
async function repairTarget(t){
  const r=t.repair||{};
  if(r.type==='restartService')return restartService(r.service);
  return {ok:false,error:'no_safe_repair'};
}

function updateLatencyBaseline(entry,result){
  if(!Number.isFinite(Number(result?.latencyMs)))return;
  const x=Number(result.latencyMs);
  const old=Number(entry.latencyEwma||x);
  entry.latencyEwma=Math.round((old*0.8+x*0.2)*100)/100;
  entry.maxObservedLatencyMs=Math.max(Number(entry.maxObservedLatencyMs||0),x);
}

async function registerIncident(t,result,entry){
  const sig=signature(t,result);
  const sigState=state.signatures[sig]||{count:0,firstSeenAt:nowIso(),lastSeenAt:null,improvementEmittedAt:null};
  sigState.count++;
  sigState.lastSeenAt=nowIso();
  state.signatures[sig]=sigState;
  const row={
    id:crypto.randomUUID(),
    signature:sig,
    target:t.name||t.service||t.url||t.path||'unknown',
    type:t.type,
    detectedAt:nowIso(),
    result,
    consecutiveFailures:entry.failures,
    recurrenceCount:sigState.count
  };
  await appendJsonl(INCIDENTS_FILE,row);

  const lastImprovement=Date.parse(String(sigState.improvementEmittedAt||0))||0;
  const recurring=sigState.count>=3&&Date.now()-lastImprovement>6*60*60*1000;
  if(recurring){
    sigState.improvementEmittedAt=nowIso();
    await appendJsonl(REPAIR_QUEUE,{
      id:crypto.randomUUID(),
      kind:'improvement_candidate',
      priority:'high',
      createdAt:nowIso(),
      incidentSignature:sig,
      target:row.target,
      instruction:'Diagnose the recurring failure, improve the relevant tests/detection/repair logic, use NexForge locks, commit to Git, run regression tests, deploy through NexControl, verify, and roll back on regression.',
      evidence:result
    });
  }
  return row;
}

async function processTarget(t){
  const key=String(t.name||t.service||t.url||t.path||crypto.createHash('sha1').update(JSON.stringify(t)).digest('hex'));
  const existing=state.targets[key];
  const entry=existing||{failures:0,successes:0,lastRepairAt:0,lastIncidentAt:0,lastCheckedMs:0};
  const targetIntervalMs=Math.max(settings.intervalMs,Number(t.intervalMs||settings.intervalMs));
  const initialDelayMs=Math.max(0,Number(t.initialDelayMs||0));
  if(!existing&&initialDelayMs>0&&Date.now()-BOOT_MS<initialDelayMs)return;
  if(Date.now()-Number(entry.lastCheckedMs||0)<targetIntervalMs)return;
  entry.lastCheckedMs=Date.now();
  const result=await runCheck(t);
  entry.lastCheckedAt=nowIso();
  entry.lastResult=result;
  updateLatencyBaseline(entry,result);

  if(result.ok){
    entry.successes=Number(entry.successes||0)+1;
    entry.failures=0;
    entry.lastHealthyAt=nowIso();
    state.targets[key]=entry;
    return;
  }

  entry.failures=Number(entry.failures||0)+1;
  entry.lastFailedAt=nowIso();
  state.targets[key]=entry;
  if(entry.failures<settings.failureThreshold)return;

  const incident=await registerIncident(t,result,entry);
  entry.lastIncidentAt=Date.now();

  const repair=t.repair||{};
  const canRepair=repair.type&&Date.now()-Number(entry.lastRepairAt||0)>=settings.repairCooldownMs;
  if(!canRepair){
    await appendJsonl(REPAIR_QUEUE,{
      id:crypto.randomUUID(),kind:'repair_required',priority:'high',createdAt:nowIso(),
      incidentSignature:incident.signature,target:incident.target,
      instruction:'Investigate this failed NexGuard check through NexForge/NexControl. Acquire a resource lock before modifying anything. Do not make an unverified production change.',
      evidence:result
    });
    return;
  }

  entry.lastRepairAt=Date.now();
  const repairResult=await repairTarget(t);
  entry.lastRepairResult=repairResult;
  if(!repairResult.ok){
    await appendJsonl(REPAIR_QUEUE,{
      id:crypto.randomUUID(),kind:'repair_failed',priority:'critical',createdAt:nowIso(),
      incidentSignature:incident.signature,target:incident.target,repairResult,
      instruction:'Automatic deterministic repair failed. Diagnose with logs, patch through Git, run targeted and regression tests, deploy and verify via NexControl.'
    });
    return;
  }

  await sleep(settings.verifyDelayMs);
  const verified=await runCheck(t);
  entry.lastRepairVerification=verified;
  if(verified.ok){
    entry.failures=0;
    entry.lastHealthyAt=nowIso();
    await appendJsonl(INCIDENTS_FILE,{id:crypto.randomUUID(),kind:'auto_repaired',signature:incident.signature,target:incident.target,repairedAt:nowIso(),repair,verification:verified});
  }else{
    await appendJsonl(REPAIR_QUEUE,{
      id:crypto.randomUUID(),kind:'repair_unverified',priority:'critical',createdAt:nowIso(),
      incidentSignature:incident.signature,target:incident.target,
      instruction:'The safe repair ran but health is still failing. Escalate to an AI worker through NexForge; lock the resource, inspect logs, patch, test, deploy, verify or roll back.',
      evidence:verified
    });
  }
}

let stopping=false;
console.log('[NexGuard] started targets='+settings.targets.length+' interval='+settings.intervalMs+'ms');

while(!stopping){
  const cycleStarted=Date.now();
  for(const t of settings.targets){
    try{await processTarget(t)}catch(error){
      console.error('[NexGuard] target error',t?.name||'',String(error?.stack||error));
    }
  }
  state.updatedAt=nowIso();
  state.pid=process.pid;
  await writeJsonAtomic(STATE_FILE,state).catch(e=>console.error('[NexGuard] state write failed',String(e?.message||e)));
  const wait=Math.max(250,settings.intervalMs-(Date.now()-cycleStarted));
  await sleep(wait);
}
await release();
console.log('[NexGuard] stopped');
