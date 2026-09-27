import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const HOST_ROOT=HERE.includes(path.join('bots','nexaccount','automation'))
  ?path.resolve(HERE,'../../..')
  :path.resolve(HERE,'..');
const STATE_DIR=process.env.NEXCANAL_WATCHER_RUNTIME_DIR||path.join(HOST_ROOT,'.nexcontrol','automation');
const PID_FILE=path.join(STATE_DIR,'nextech-supervisor.pid');
const LOG_FILE=path.join(STATE_DIR,'logs','nextech.log');
const ERR_FILE=path.join(STATE_DIR,'logs','nextech.err.log');
const RELAY=path.join(HERE,'liteapks-relay.mjs');
const supervise=process.argv.includes('--supervise');
const restart=process.argv.includes('--restart');

function parseEnvText(text){
  const out={};
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line.startsWith('#'))continue;
    const at=line.indexOf('=');
    if(at<1)continue;
    const key=line.slice(0,at).trim();
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))continue;
    let value=line.slice(at+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    out[key]=value;
  }
  return out;
}

async function loadEnvironment(){
  const candidates=[
    path.resolve(HERE,'../.env'),
    path.join(HOST_ROOT,'.env')
  ];
  for(const file of candidates){
    try{
      const parsed=parseEnvText(await fsp.readFile(file,'utf8'));
      for(const [key,value] of Object.entries(parsed)){
        if(process.env[key]===undefined&&value!=='')process.env[key]=value;
      }
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
    }
  }
}

async function pidAlive(pid){
  if(!Number.isInteger(pid)||pid<2)return false;
  try{process.kill(pid,0);return true}catch{return false}
}
async function oldPid(){
  try{return Number(await fsp.readFile(PID_FILE,'utf8'))||null}catch{return null}
}
async function stopPid(pid){
  if(!(await pidAlive(pid)))return;
  try{process.kill(pid,'SIGTERM')}catch{}
  for(let i=0;i<40;i++){
    if(!(await pidAlive(pid)))return;
    await new Promise(r=>setTimeout(r,250));
  }
  try{process.kill(pid,'SIGKILL')}catch{}
}

await loadEnvironment();
await fsp.mkdir(path.dirname(LOG_FILE),{recursive:true});

if(!supervise){
  const old=await oldPid();
  if(old&&await pidAlive(old)){
    if(!restart){
      console.log(JSON.stringify({ok:true,alreadyRunning:true,pid:old}));
      process.exit(0);
    }
    await stopPid(old);
  }
  const out=fs.openSync(LOG_FILE,'a');
  const err=fs.openSync(ERR_FILE,'a');
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--supervise'],{
    cwd:HERE,
    env:process.env,
    detached:true,
    stdio:['ignore',out,err]
  });
  child.unref();
  await fsp.writeFile(PID_FILE,String(child.pid),{mode:0o600});
  await new Promise(r=>setTimeout(r,750));
  if(!(await pidAlive(child.pid)))throw new Error('watcher_supervisor_failed_to_start');
  console.log(JSON.stringify({ok:true,pid:child.pid,supervised:true}));
  process.exit(0);
}

let child=null;
let stopping=false;
let backoff=3000;
async function terminate(){
  if(stopping)return;
  stopping=true;
  if(child&&child.exitCode==null){
    try{child.kill('SIGTERM')}catch{}
  }
  await fsp.rm(PID_FILE,{force:true}).catch(()=>{});
  setTimeout(()=>process.exit(0),1000).unref?.();
}
process.on('SIGTERM',terminate);
process.on('SIGINT',terminate);

while(!stopping){
  const started=Date.now();
  child=spawn(process.execPath,[RELAY],{
    cwd:HERE,
    env:process.env,
    stdio:['ignore','inherit','inherit']
  });
  const result=await new Promise(resolve=>{
    child.once('error',error=>resolve({error}));
    child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  child=null;
  if(stopping)break;
  const lived=Date.now()-started;
  if(lived>5*60_000)backoff=3000;
  const reason=result?.error?String(result.error?.message||result.error):('code='+String(result?.code)+' signal='+String(result?.signal||''));
  console.error('[NexTech supervisor] relay exited',reason,'restart in',backoff+'ms');
  await new Promise(r=>setTimeout(r,backoff));
  backoff=Math.min(60_000,backoff*2);
}
