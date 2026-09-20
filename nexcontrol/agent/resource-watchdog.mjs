import fs from 'node:fs/promises';
import fssync from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ROOT=path.resolve(process.env.NEXCONTROL_FLEET_ROOT||'.');
const CONFIG=path.resolve(ROOT,process.env.NEXCONTROL_AGENT_CONFIG||'nexcontrol/agent/agent.config.json');
const DEFAULT_STATE=path.join(ROOT,'.nexcontrol','runtime','resource-watchdog.json');
const LOCK_FILE=path.join(ROOT,'.nexcontrol','runtime','resource-watchdog.lock.json');
await fs.mkdir(path.dirname(LOCK_FILE),{recursive:true});
try{
  const old=JSON.parse(await fs.readFile(LOCK_FILE,'utf8'));
  const oldPid=Number(old?.pid||0);
  if(oldPid>1&&oldPid!==process.pid){
    try{process.kill(oldPid,0);console.log('[ResourceWatchdog] already running pid='+oldPid);process.exit(0)}catch{}
  }
}catch{}
await fs.writeFile(LOCK_FILE,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()},null,2),{mode:0o600});
const releaseLock=()=>{try{const row=JSON.parse(fssync.readFileSync(LOCK_FILE,'utf8'));if(Number(row?.pid)===process.pid)fssync.rmSync(LOCK_FILE,{force:true})}catch{}};
process.on('exit',releaseLock);


let cfg={};
try{cfg=JSON.parse(await fs.readFile(CONFIG,'utf8'))}catch{}
const user=cfg.resourceWatchdog||{};

const settings={
  intervalMs:Math.max(5000,Number(process.env.NEXCONTROL_RESOURCE_INTERVAL_MS||user.intervalMs||15000)),
  diskPath:path.resolve(ROOT,String(user.diskPath||'.')),
  thresholds:{
    memoryWarn:Number(user.thresholds?.memoryWarn??75),
    memoryRelief:Number(user.thresholds?.memoryRelief??85),
    memoryCritical:Number(user.thresholds?.memoryCritical??92),
    memoryEmergency:Number(user.thresholds?.memoryEmergency??96),
    diskWarn:Number(user.thresholds?.diskWarn??75),
    diskCleanup:Number(user.thresholds?.diskCleanup??80),
    diskCritical:Number(user.thresholds?.diskCritical??90),
    diskEmergency:Number(user.thresholds?.diskEmergency??95)
  },
  actionCooldownMs:Math.max(60000,Number(user.actionCooldownMs||600000)),
  criticalCooldownMs:Math.max(30000,Number(user.criticalCooldownMs||180000)),
  minimumRestartRssMb:Math.max(32,Number(user.minimumRestartRssMb||200)),
  stateFile:path.resolve(ROOT,String(user.stateFile||path.relative(ROOT,DEFAULT_STATE))),
  restartHook:path.resolve(ROOT,String(user.restartHook||cfg.restartHook?.path||'.nexcontrol/control/restart.json')),
  requireSupervisedParent:user.requireSupervisedParent!==false,
  parentPatterns:Array.isArray(user.parentPatterns)&&user.parentPatterns.length?user.parentPatterns.map(String):['scripts/orchestrator.mjs','orchestrator.mjs'],
  includeCmdline:Array.isArray(user.includeCmdline)&&user.includeCmdline.length?user.includeCmdline.map(String):['/bots/','bots/'],
  excludeCmdline:Array.isArray(user.excludeCmdline)&&user.excludeCmdline.length?user.excludeCmdline.map(String):['nexcontrol/agent','resource-watchdog','fleet-launcher','orchestrator.mjs'],
  cleanupTargets:Array.isArray(user.cleanupTargets)&&user.cleanupTargets.length?user.cleanupTargets:[
    {path:'.nexcontrol/backups',minAgeMinutes:1440,keepNewest:20,maxBytes:536870912},
    {path:'.nexcontrol/tmp',minAgeMinutes:120,keepNewest:0,maxBytes:268435456},
    {path:'tmp',minAgeMinutes:120,keepNewest:0,maxBytes:536870912},
    {path:'bots/nexdownloader/tmp',minAgeMinutes:120,keepNewest:0,maxBytes:536870912},
    {path:'bots/nexdownloader/downloads',minAgeMinutes:720,keepNewest:2,maxBytes:1073741824}
  ]
};

for(const [name,value] of Object.entries(settings.thresholds)){
  if(!Number.isFinite(value)||value<1||value>99)throw new Error('Invalid resource threshold '+name);
}
if(!(settings.thresholds.memoryWarn<settings.thresholds.memoryRelief&&settings.thresholds.memoryRelief<settings.thresholds.memoryCritical&&settings.thresholds.memoryCritical<settings.thresholds.memoryEmergency))throw new Error('Memory thresholds must be increasing');
if(!(settings.thresholds.diskWarn<settings.thresholds.diskCleanup&&settings.thresholds.diskCleanup<settings.thresholds.diskCritical&&settings.thresholds.diskCritical<settings.thresholds.diskEmergency))throw new Error('Disk thresholds must be increasing');

async function readText(file){try{return(await fs.readFile(file,'utf8')).trim()}catch{return''}}
function n(v){const x=Number(v);return Number.isFinite(x)&&x>=0?x:null}
async function cgroupMemory(){
  const v2Current=n(await readText('/sys/fs/cgroup/memory.current'));
  const v2MaxText=await readText('/sys/fs/cgroup/memory.max');
  const v2Max=v2MaxText&&v2MaxText!=='max'?n(v2MaxText):null;
  if(v2Current!=null&&v2Max&&v2Max<Number.MAX_SAFE_INTEGER)return{source:'cgroup-v2',used:v2Current,total:v2Max};
  const v1Current=n(await readText('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const v1Max=n(await readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  if(v1Current!=null&&v1Max&&v1Max<Number.MAX_SAFE_INTEGER&&v1Max<9e18)return{source:'cgroup-v1',used:v1Current,total:v1Max};
  const total=os.totalmem(),free=os.freemem();
  return{source:'host',used:Math.max(0,total-free),total};
}
async function disk(){
  const st=await fs.statfs(settings.diskPath),b=Number(st.bsize||4096),total=Number(st.blocks)*b,avail=Number(st.bavail)*b;
  return{path:settings.diskPath,total,available:avail,used:Math.max(0,total-avail),percent:total>0?((total-avail)/total)*100:0};
}
const pct=(used,total)=>total>0?(used/total)*100:0;
const mb=v=>Math.round(v/1024/1024);

async function entrySize(target){
  let total=0;
  async function walk(p){
    let st;try{st=await fs.lstat(p)}catch{return}
    if(st.isSymbolicLink())return;
    if(st.isFile()){total+=st.size;return}
    if(!st.isDirectory())return;
    let entries=[];try{entries=await fs.readdir(p,{withFileTypes:true})}catch{return}
    for(const e of entries)await walk(path.join(p,e.name));
  }
  await walk(target);return total;
}
async function cleanupTarget(spec,aggressive=false){
  const rel=String(spec.path||'').trim();
  if(!rel)return{path:rel,skipped:'empty'};
  const target=path.resolve(ROOT,rel),inside=path.relative(ROOT,target);
  if(inside.startsWith('..')||path.isAbsolute(inside))return{path:rel,skipped:'outside-root'};
  let entries;try{entries=await fs.readdir(target,{withFileTypes:true})}catch(e){return{path:rel,skipped:e?.code||'missing'}}

  const now=Date.now(),ageBase=Math.max(1,Number(spec.minAgeMinutes||120))*60000;
  const minAge=aggressive?Math.max(15*60000,ageBase*0.25):ageBase;
  const keepBase=Math.max(0,Number(spec.keepNewest||0));
  const keep=aggressive?Math.floor(keepBase/2):keepBase;
  const maxBytes=Math.max(0,Number(spec.maxBytes||0));
  const rows=[];
  for(const e of entries){
    const full=path.join(target,e.name);
    let st;try{st=await fs.lstat(full)}catch{continue}
    if(st.isSymbolicLink())continue;
    rows.push({name:e.name,full,mtime:st.mtimeMs,size:await entrySize(full)});
  }
  rows.sort((a,b)=>b.mtime-a.mtime);
  let total=rows.reduce((s,x)=>s+x.size,0),freed=0,removed=0;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],oldEnough=now-row.mtime>=minAge,overCap=maxBytes>0&&total>maxBytes;
    if(i<keep)continue;
    if(!oldEnough&&!overCap)continue;
    try{
      await fs.rm(row.full,{recursive:true,force:true});
      total=Math.max(0,total-row.size);freed+=row.size;removed++;
    }catch{}
  }
  return{path:rel,aggressive,removed,freedBytes:freed,remainingBytes:total};
}

async function cleanupDisk(aggressive=false){
  const results=[];
  for(const target of settings.cleanupTargets)results.push(await cleanupTarget(target,aggressive));
  return{aggressive,results,freedBytes:results.reduce((s,x)=>s+Number(x.freedBytes||0),0)};
}

async function procInfo(pid){
  try{
    const [status,cmdBuf]=await Promise.all([fs.readFile('/proc/'+pid+'/status','utf8'),fs.readFile('/proc/'+pid+'/cmdline')]);
    const ppid=Number((status.match(/^PPid:\s+(\d+)$/m)||[])[1]||0);
    const rssKb=Number((status.match(/^VmRSS:\s+(\d+)\s+kB$/m)||[])[1]||0);
    const cmdline=cmdBuf.toString('utf8').split('\0').filter(Boolean).join(' ');
    return{pid,ppid,rssKb,cmdline};
  }catch{return null}
}
async function cmdline(pid){try{return(await fs.readFile('/proc/'+pid+'/cmdline')).toString('utf8').split('\0').filter(Boolean).join(' ')}catch{return''}}
function hasAny(s,patterns){return patterns.some(p=>s.includes(p))}
async function largestSupervisedBot(){
  if(process.platform!=='linux')return null;
  let ids=[];try{ids=(await fs.readdir('/proc')).filter(x=>/^\d+$/.test(x)).map(Number)}catch{return null}
  const rows=[];
  for(const pid of ids){
    if(pid<=1||pid===process.pid)continue;
    const info=await procInfo(pid);if(!info||!info.cmdline)continue;
    if(!hasAny(info.cmdline,settings.includeCmdline)||hasAny(info.cmdline,settings.excludeCmdline))continue;
    if(settings.requireSupervisedParent){
      const parent=await cmdline(info.ppid);
      if(!hasAny(parent,settings.parentPatterns))continue;
    }
    rows.push(info);
  }
  rows.sort((a,b)=>b.rssKb-a.rssKb);
  return rows[0]||null;
}
async function requestRestart(reason){
  try{
    await fs.mkdir(path.dirname(settings.restartHook),{recursive:true});
    await fs.writeFile(settings.restartHook,JSON.stringify({target:'all',reason,requestedAt:new Date().toISOString(),nonce:crypto.randomUUID?.()||String(Date.now())},null,2),{mode:0o600});
    return{queued:true,hook:settings.restartHook};
  }catch(error){return{queued:false,error:String(error?.message||error)}}
}
async function relieveMemory(level){
  if(typeof global.gc==='function'){try{global.gc()}catch{}}
  const candidate=await largestSupervisedBot();
  const minimum=level==='emergency'?64:level==='critical'?100:settings.minimumRestartRssMb;
  if(candidate&&candidate.rssKb>=minimum*1024){
    try{
      process.kill(candidate.pid,'SIGTERM');
      return{action:'signal-supervised-bot',level,pid:candidate.pid,rssMb:Math.round(candidate.rssKb/1024),cmdline:candidate.cmdline.slice(0,500)};
    }catch(error){return{action:'signal-failed',level,pid:candidate.pid,error:String(error?.message||error)}}
  }
  if(level==='emergency')return{action:'restart-hook',level,...await requestRestart('Resource watchdog emergency memory pressure')};
  return{action:'no-safe-candidate',level};
}

async function writeState(data){
  try{
    await fs.mkdir(path.dirname(settings.stateFile),{recursive:true});
    const tmp=settings.stateFile+'.tmp';
    await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});
    await fs.rename(tmp,settings.stateFile);
  }catch(error){console.error('[ResourceWatchdog] state write failed',String(error?.message||error))}
}

let lastDiskAction=0,lastMemoryAction=0,lastLevel='normal',stopping=false;
process.on('SIGTERM',()=>stopping=true);
process.on('SIGINT',()=>stopping=true);
console.log('[ResourceWatchdog] started interval='+settings.intervalMs+'ms');

while(!stopping){
  const started=Date.now();
  try{
    const [memBefore,diskBefore]=await Promise.all([cgroupMemory(),disk()]);
    const memoryPercent=pct(memBefore.used,memBefore.total),diskPercent=diskBefore.percent;
    const actions=[];
    let level='normal';

    if(memoryPercent>=settings.thresholds.memoryEmergency||diskPercent>=settings.thresholds.diskEmergency)level='emergency';
    else if(memoryPercent>=settings.thresholds.memoryCritical||diskPercent>=settings.thresholds.diskCritical)level='critical';
    else if(memoryPercent>=settings.thresholds.memoryRelief||diskPercent>=settings.thresholds.diskCleanup)level='cleanup';
    else if(memoryPercent>=settings.thresholds.memoryWarn||diskPercent>=settings.thresholds.diskWarn)level='warning';

    const diskCooldown=level==='critical'||level==='emergency'?settings.criticalCooldownMs:settings.actionCooldownMs;
    if(diskPercent>=settings.thresholds.diskCleanup&&Date.now()-lastDiskAction>=diskCooldown){
      const aggressive=diskPercent>=settings.thresholds.diskCritical;
      actions.push({type:'disk-cleanup',...await cleanupDisk(aggressive)});
      lastDiskAction=Date.now();
    }

    const memoryCooldown=memoryPercent>=settings.thresholds.memoryCritical?settings.criticalCooldownMs:settings.actionCooldownMs;
    if(memoryPercent>=settings.thresholds.memoryRelief&&Date.now()-lastMemoryAction>=memoryCooldown){
      const memLevel=memoryPercent>=settings.thresholds.memoryEmergency?'emergency':memoryPercent>=settings.thresholds.memoryCritical?'critical':'relief';
      actions.push({type:'memory-relief',...await relieveMemory(memLevel)});
      lastMemoryAction=Date.now();
    }

    const [memAfter,diskAfter]=await Promise.all([cgroupMemory(),disk()]);
    const state={
      updatedAt:new Date().toISOString(),
      pid:process.pid,
      level,
      memory:{source:memAfter.source,usedBytes:memAfter.used,totalBytes:memAfter.total,usedMb:mb(memAfter.used),totalMb:mb(memAfter.total),percent:Number(pct(memAfter.used,memAfter.total).toFixed(2))},
      disk:{path:diskAfter.path,usedBytes:diskAfter.used,totalBytes:diskAfter.total,availableBytes:diskAfter.available,percent:Number(diskAfter.percent.toFixed(2))},
      thresholds:settings.thresholds,
      actions
    };
    await writeState(state);
    if(level!==lastLevel||actions.length){
      console.log('[ResourceWatchdog] level='+level+' ram='+state.memory.percent+'% disk='+state.disk.percent+'% actions='+JSON.stringify(actions).slice(0,4000));
      lastLevel=level;
    }
  }catch(error){
    console.error('[ResourceWatchdog]',new Date().toISOString(),String(error?.stack||error));
  }
  await sleep(Math.max(1000,settings.intervalMs-(Date.now()-started)));
}
console.log('[ResourceWatchdog] stopped');
