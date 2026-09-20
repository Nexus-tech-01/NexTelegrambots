import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT=path.resolve(process.env.NEXCONTROL_FLEET_ROOT||'.');
const ENTRY=path.resolve(ROOT,'nexcontrol/agent/index.mjs');
const CONFIG=path.resolve(ROOT,process.env.NEXCONTROL_AGENT_CONFIG||'nexcontrol/agent/agent.config.json');
const STATE_DIR=path.resolve(ROOT,'.nexcontrol/fleet');
const STATE_FILE=path.join(STATE_DIR,'status.json');
const LOCK_FILE=path.join(STATE_DIR,'launcher.lock.json');
const RESTART_MIN_MS=1500;
const RESTART_MAX_MS=15000;

const workers=[
  {slug:'nexus-failover-a',name:'Nexus Failover A'},
  {slug:'nexus-failover-b',name:'Nexus Failover B'},
  {slug:'nexus-watchdog',name:'Nexus Watchdog'}
];

await fs.mkdir(STATE_DIR,{recursive:true});

async function pidAlive(pid){
  if(!Number.isInteger(pid)||pid<=1)return false;
  try{process.kill(pid,0);return true}catch{return false}
}

try{
  const old=JSON.parse(await fs.readFile(LOCK_FILE,'utf8'));
  if(old?.pid&&await pidAlive(Number(old.pid))){
    console.log('[NexControlFleet] already running pid='+old.pid);
    process.exit(0);
  }
}catch{}

await fs.writeFile(LOCK_FILE,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()},null,2),{mode:0o600});

if(!fssync.existsSync(ENTRY))throw new Error('NexControl agent entry missing: '+ENTRY);
if(!fssync.existsSync(CONFIG))throw new Error('NexControl agent config missing: '+CONFIG);
if(!String(process.env.NEXCONTROL_AGENT_KEY||process.env.NEXCONTROL_FLEET_KEY||'').trim()){
  throw new Error('NEXCONTROL_AGENT_KEY/NEXCONTROL_FLEET_KEY missing');
}

const state=new Map(workers.map(w=>[w.slug,{
  slug:w.slug,name:w.name,pid:null,status:'starting',starts:0,restarts:0,lastStartAt:null,lastExitAt:null,lastExitCode:null,lastSignal:null
}]));
const children=new Map();
let stopping=false;

async function persist(){
  const payload={
    launcherPid:process.pid,
    updatedAt:new Date().toISOString(),
    stopping,
    workers:[...state.values()]
  };
  const tmp=STATE_FILE+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(payload,null,2),{mode:0o600});
  await fs.rename(tmp,STATE_FILE);
}

function pipe(child,slug,stream,label){
  stream?.on('data',chunk=>{
    const text=String(chunk);
    process[label]('[NexControlFleet]['+slug+'] '+text.replace(/\s+$/,''));
  });
}

function startWorker(def,delayMs=0){
  setTimeout(()=>{
    if(stopping)return;
    const row=state.get(def.slug);
    row.starts++;
    if(row.starts>1)row.restarts++;
    row.status='starting';
    row.lastStartAt=new Date().toISOString();

    const child=spawn(process.execPath,[ENTRY],{
      cwd:ROOT,
      env:{
        ...process.env,
        NEXCONTROL_AGENT_CONFIG:CONFIG,
        NEXCONTROL_AGENT_SLUG:def.slug,
        NEXCONTROL_AGENT_NAME:def.name
      },
      stdio:['ignore','pipe','pipe']
    });
    children.set(def.slug,child);
    row.pid=child.pid||null;
    row.status='running';
    persist().catch(()=>{});
    console.log('[NexControlFleet] '+def.slug+' started pid='+row.pid);

    pipe(child,def.slug,child.stdout,'log');
    pipe(child,def.slug,child.stderr,'error');

    child.on('error',error=>{
      console.error('[NexControlFleet] '+def.slug+' error '+String(error?.message||error));
    });

    child.on('exit',(code,signal)=>{
      children.delete(def.slug);
      row.pid=null;
      row.status=stopping?'stopped':'restarting';
      row.lastExitAt=new Date().toISOString();
      row.lastExitCode=code;
      row.lastSignal=signal||null;
      persist().catch(()=>{});
      if(stopping)return;
      const backoff=Math.min(RESTART_MAX_MS,RESTART_MIN_MS*Math.max(1,row.restarts+1));
      console.warn('[NexControlFleet] '+def.slug+' exited code='+String(code)+' signal='+String(signal||'')+'; restart in '+backoff+'ms');
      startWorker(def,backoff);
    });
  },delayMs);
}

for(let i=0;i<workers.length;i++)startWorker(workers[i],i*1200);
await persist();

async function shutdown(signal){
  if(stopping)return;
  stopping=true;
  console.log('[NexControlFleet] shutdown '+signal);
  for(const child of children.values()){
    try{child.kill('SIGTERM')}catch{}
  }
  await persist().catch(()=>{});
  await fs.rm(LOCK_FILE,{force:true}).catch(()=>{});
  setTimeout(()=>process.exit(0),2500).unref();
}

process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

const statusTimer=setInterval(()=>persist().catch(()=>{}),15000);
statusTimer.unref();

process.on('exit',()=>{
  try{fssync.rmSync(LOCK_FILE,{force:true})}catch{}
});
