import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {appendJsonl,parseTargets,probeHttp,readJson,rememberIncident,requestRepair,run,singletonLock,sleep,writeJsonAtomic,nowIso,clip,listProcessMatches} from './supervision-core.mjs';

const ROOT=path.resolve(process.env.NEX_ROOT||process.env.NEXCONTROL_FLEET_ROOT||(fssync.existsSync('/opt/nex/current')?'/opt/nex/current':process.cwd()));
const RUNTIME=path.resolve(process.env.NEXGUARD_RUNTIME_DIR||path.join(ROOT,'.nexcontrol/runtime'));
const STATE_FILE=path.resolve(process.env.NEXGUARD_STATE_FILE||path.join(RUNTIME,'nexguard.json'));
const INCIDENT_FILE=path.resolve(process.env.NEXGUARD_INCIDENT_FILE||path.join(RUNTIME,'nexguard-incidents.jsonl'));
const REPAIR_QUEUE=path.resolve(process.env.NEXGUARD_REPAIR_QUEUE||path.join(RUNTIME,'nexforge-repair-queue.jsonl'));
const LOCK_FILE=path.resolve(process.env.NEXGUARD_LOCK_FILE||path.join(RUNTIME,'nexguard.lock.json'));
const INTERVAL=Math.max(15_000,Number(process.env.NEXGUARD_INTERVAL_MS||60_000));
const REGRESSION_MS=Math.max(5*60_000,Number(process.env.NEXGUARD_REGRESSION_MS||30*60_000));
const FAILURE_THRESHOLD=Math.max(2,Number(process.env.NEXGUARD_FAILURE_THRESHOLD||3));
const AUTO_REPAIR=String(process.env.NEXGUARD_AUTO_REPAIR||'true').toLowerCase()!=='false';
const SYSTEMD=String(process.env.NEXGUARD_SYSTEMD_REPAIR||'true').toLowerCase()!=='false';

const defaultTargets=[
  {id:'main-http',url:'http://127.0.0.1:'+(process.env.PORT||10000)+'/health',optional:true,service:process.env.NEX_MAIN_SERVICE||''},
  {id:'nexaccount',url:'http://127.0.0.1:'+(process.env.NEXACCOUNT_PORT||3491)+'/health',optional:true,service:process.env.NEXACCOUNT_SERVICE||'nexaccount.service'},
  {id:'whatsapp-publisher',url:'http://127.0.0.1:'+(process.env.NEX_WHATSAPP_PORT||8790)+'/healthz',optional:true,service:process.env.NEX_WHATSAPP_SERVICE||'nex-whatsapp-publisher.service'}
];
const targets=parseTargets(process.env.NEXGUARD_TARGETS_JSON,defaultTargets);
const processPatterns=String(process.env.NEXGUARD_PROCESS_PATTERNS||'scripts/orchestrator.mjs,nexaccount/daemon.mjs,watchers/liteapks-relay.mjs').split(',').map(x=>x.trim()).filter(Boolean);

const lock=await singletonLock(LOCK_FILE,'nexguard');
if(!lock.ok){console.log('[NexGuard] already running pid='+lock.pid);process.exit(0)}

let state=await readJson(STATE_FILE,{version:1,startedAt:nowIso(),targets:{},incidents:{},incidentOrder:[],learnedRules:{},cycles:0});
state.version=1;
state.startedAt=state.startedAt||nowIso();
let stopping=false,lastRegressionAt=Number(state.lastRegressionAtMs||0);
process.on('SIGTERM',()=>stopping=true);
process.on('SIGINT',()=>stopping=true);

async function queueForAi(row,context={}){
  if(Number(row.count||0)<FAILURE_THRESHOLD)return;
  const marker=String(row.id)+':'+String(row.count);
  if(state.lastEscalationMarker===marker)return;
  const task={
    type:'nexguard.repair',
    source:'nexguard',
    fingerprint:row.id,
    severity:row.severity,
    target:row.target,
    message:row.message,
    occurrences:row.count,
    context,
    constraints:{requireLock:true,verifyBeforeDeploy:true,rollbackOnRegression:true},
    requestedAt:nowIso()
  };
  await appendJsonl(REPAIR_QUEUE,task);
  state.lastEscalationMarker=marker;
}

async function checkTarget(target){
  const id=String(target.id||target.url||target.service||'target');
  const prior=state.targets[id]||{consecutiveFailures:0};
  if(!target.url)return {id,ok:true,skipped:'no-url'};
  const result=await probeHttp(target.url,{timeoutMs:Number(target.timeoutMs||8000),headers:target.headers||{}});
  const expected=Array.isArray(target.expectedStatuses)?target.expectedStatuses:null;
  const ok=result.ok && (!expected||expected.includes(Number(result.status)));
  const row={...prior,id,url:target.url,lastCheckAt:nowIso(),lastLatencyMs:result.latencyMs,lastStatus:result.status,ok};
  if(ok){
    row.consecutiveFailures=0;
    row.lastHealthyAt=nowIso();
    state.targets[id]=row;
    return {id,ok:true,result};
  }

  row.consecutiveFailures=Number(prior.consecutiveFailures||0)+1;
  row.lastError=clip(result.error||JSON.stringify(result.body||'http_'+result.status),500);
  state.targets[id]=row;
  const incident=rememberIncident(state,{kind:'health',target:id,severity:row.consecutiveFailures>=FAILURE_THRESHOLD?'critical':'warning',message:row.lastError,details:{url:target.url,status:result.status,failures:row.consecutiveFailures}});

  if(target.optional===true&&result.status===0&&row.consecutiveFailures===1){
    return {id,ok:false,optional:true,result,incident};
  }

  if(AUTO_REPAIR&&row.consecutiveFailures>=FAILURE_THRESHOLD){
    const cooldown=Number(row.lastRepairAtMs||0)+Math.max(60_000,Number(target.repairCooldownMs||10*60_000));
    if(Date.now()>=cooldown){
      const repair=await requestRepair({root:ROOT,target:id,reason:'NexGuard health failure: '+row.lastError,service:String(target.service||''),allowSystemd:SYSTEMD});
      row.lastRepairAt=nowIso();row.lastRepairAtMs=Date.now();row.lastRepair=repair;
      await queueForAi(incident,{probe:result,repair});
      return {id,ok:false,result,incident,repair};
    }
  }
  await queueForAi(incident,{probe:result});
  return {id,ok:false,result,incident};
}

async function regressionChecks(){
  const checks=[];
  const candidates=[
    {id:'nexaccount-regression',cwd:path.join(ROOT,'nexaccount'),command:'npm',args:['run','check']},
    {id:'watchers-syntax',cwd:ROOT,command:'node',args:['--check',path.join(ROOT,'watchers/liteapks-relay.mjs')]},
    {id:'nexguard-syntax',cwd:ROOT,command:'node',args:['--check',path.join(ROOT,'watchers/nexguard.mjs')]},
    {id:'automation-supervisor-syntax',cwd:ROOT,command:'node',args:['--check',path.join(ROOT,'watchers/automation-supervisor.mjs')]}
  ];
  for(const c of candidates){
    try{await fs.access(c.cwd);await fs.access(c.args.at(-1)?.startsWith('/')?c.args.at(-1):c.cwd)}catch{continue}
    const result=await run(c.command,c.args,{cwd:c.cwd,timeoutMs:c.id==='nexaccount-regression'?8*60_000:60_000});
    checks.push({id:c.id,ok:result.ok,error:result.ok?'':clip(result.stderr||result.error,1000)});
    if(!result.ok){
      const incident=rememberIncident(state,{kind:'regression',target:c.id,severity:'critical',message:result.stderr||result.error||'regression failed',details:{stdout:result.stdout}});
      await queueForAi(incident,{check:c,result});
    }
  }
  lastRegressionAt=Date.now();state.lastRegressionAtMs=lastRegressionAt;state.lastRegressionAt=nowIso();state.lastRegressionChecks=checks;
  return checks;
}

async function cycle(){
  const started=Date.now();
  state.cycles=Number(state.cycles||0)+1;
  state.lastCycleStartedAt=nowIso();
  const targetResults=[];
  for(const target of targets)targetResults.push(await checkTarget(target));
  const processes=await listProcessMatches(processPatterns);
  state.processSnapshot={at:nowIso(),matches:processes.slice(0,100)};
  if(processPatterns.length&&!processes.length){
    const incident=rememberIncident(state,{kind:'process',target:'core-processes',severity:'critical',message:'No expected Nexus process matched',details:{patterns:processPatterns}});
    await queueForAi(incident,{patterns:processPatterns});
  }
  if(Date.now()-lastRegressionAt>=REGRESSION_MS)await regressionChecks();
  state.lastCycleFinishedAt=nowIso();state.lastCycleDurationMs=Date.now()-started;state.lastResults=targetResults;
  state.health={
    ok:targetResults.every(x=>x.ok||x.optional),
    targetCount:targetResults.length,
    failing:targetResults.filter(x=>!x.ok&&!x.optional).map(x=>x.id),
    learnedRuleCount:Object.keys(state.learnedRules||{}).length
  };
  await writeJsonAtomic(STATE_FILE,state);
  console.log('[NexGuard] cycle',JSON.stringify(state.health));
}

console.log('[NexGuard] started interval='+INTERVAL+'ms root='+ROOT);
while(!stopping){
  try{await cycle()}catch(error){
    const incident=rememberIncident(state,{kind:'nexguard',target:'cycle',severity:'critical',message:error?.stack||error?.message||error});
    await queueForAi(incident,{phase:'cycle'}).catch(()=>{});
    await writeJsonAtomic(STATE_FILE,state).catch(()=>{});
    console.error('[NexGuard]',error);
  }
  if(!stopping)await sleep(INTERVAL);
}
await writeJsonAtomic(STATE_FILE,{...state,stoppedAt:nowIso()}).catch(()=>{});
