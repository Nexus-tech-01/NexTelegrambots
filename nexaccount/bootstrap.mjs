import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertAnimeRuntimeContract } from './anime-contract.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

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

async function loadHostEnvironment(){
  const candidates=[
    path.join(here,'.env'),
    path.resolve(here,'../..','.env')
  ];
  for(const file of candidates){
    let parsed;
    try{parsed=parseEnvText(await fsp.readFile(file,'utf8'))}
    catch(error){if(error?.code==='ENOENT')continue;throw error}
    for(const [key,value] of Object.entries(parsed)){
      if(process.env[key]===undefined&&value!=='')process.env[key]=value;
    }
  }

  // Backward-compatible one-way bootstrap for shared Telegram application
  // credentials. These are MTProto application credentials, not a dependency
  // on any sibling bot or its runtime.
  if(!process.env.NEXACCOUNT_TELEGRAM_API_ID||!process.env.NEXACCOUNT_TELEGRAM_API_HASH){
    const idKey=Object.keys(process.env).find(k=>k.endsWith('__TELEGRAM_API_ID')&&process.env[k]);
    if(idKey){
      const hashKey=idKey.replace(/API_ID$/,'API_HASH');
      if(process.env[hashKey]){
        process.env.NEXACCOUNT_TELEGRAM_API_ID ||= process.env[idKey];
        process.env.NEXACCOUNT_TELEGRAM_API_HASH ||= process.env[hashKey];
      }
    }
  }
}

await loadHostEnvironment();
const productionMode=process.argv.includes('--production');
if(productionMode){
  // Production may only be started from the canonical systemd-managed tree.
  // Starting the agent/worktree copy would load the same MTProto sessions in
  // parallel and Telegram can invalidate them with AUTH_KEY_DUPLICATED.
  const canonicalRoot='/opt/nex/apps/public/nexai';
  const canonicalHere=here===path.join(canonicalRoot,'current')
    ||here.startsWith(path.join(canonicalRoot,'releases')+path.sep);
  if(!canonicalHere){
    console.error('[NexAccount protection] refusing auxiliary production runtime from '+here);
    process.exit(1);
  }
  // The main VPS must always run the full command runtime. A stale host-level
  // pairing-only flag from the legacy bridge must never silence every account.
  process.env.NEXACCOUNT_PAIRING_ONLY='false';
}
const stateDir=path.resolve(here,'.runtime');
const workerIndex=Math.max(0,Number(process.env.NEXACCOUNT_WORKER_INDEX||0));
const workerSuffix=workerIndex===0?'':'-worker-'+workerIndex;
const pidFile=path.join(stateDir,'nexaccount'+workerSuffix+'.pid');
const logFile=path.join(stateDir,'nexaccount'+workerSuffix+'.log');
const port=Number(process.env.NEXACCOUNT_PORT||(3491+workerIndex));
const restart=process.argv.includes('--restart');

async function healthy(){
  try{
    const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(2000)});
    return r.ok;
  }catch{return false}
}

async function oldPid(){
  try{
    const pid=Number(await fsp.readFile(pidFile,'utf8'));
    return Number.isInteger(pid)&&pid>1?pid:null;
  }catch{return null}
}

await fsp.mkdir(stateDir,{recursive:true});
if(await healthy()&&!restart){
  console.log('NexAccount already running');
  process.exit(0);
}

const embeddedAnimeEnabled=!/^(?:0|false|no|off)$/i.test(String(process.env.NEXACCOUNT_EMBEDDED_ANIME||'true').trim());
if(embeddedAnimeEnabled){
  try{
    const animeGate=await assertAnimeRuntimeContract(here);
    console.log('[NexAnime protection] NEXANIME_PROTECTION_GATE_V1 ok files='+animeGate.files.length);
  }catch(error){
    console.error('[NexAnime protection] refusing start/restart before stopping the healthy runtime:',String(error?.message||error));
    process.exit(1);
  }
}else{
  console.log('[NexAccount] embedded NexAnime disabled; standalone worker owns anime runtime');
}

async function pidAlive(pid){
  if(!pid)return false;
  try{process.kill(pid,0);return true}catch{return false}
}

async function processCommandLine(pid){
  if(!pid)return '';
  try{
    const raw=await fsp.readFile('/proc/'+pid+'/cmdline');
    return raw.toString('utf8').replace(/\0/g,' ').trim();
  }catch{return ''}
}

async function isNexAccountDaemonPid(pid){
  const cmd=await processCommandLine(pid);
  if(!cmd)return false;
  const daemon=path.join(here,'daemon.mjs');
  return cmd.includes(daemon)||(cmd.includes('daemon.mjs')&&cmd.includes('nexaccount'));
}

async function forgetStalePid(pid){
  try{await fsp.unlink(pidFile)}catch(error){if(error?.code!=='ENOENT')console.warn('Could not remove stale NexAccount pid file:',String(error?.message||error))}
  if(pid)console.warn('Ignored stale NexAccount pid file pointing to unrelated pid='+pid);
}

async function stopOldProcess(pid){
  if(!pid||!(await pidAlive(pid)))return;
  if(!(await isNexAccountDaemonPid(pid))){
    await forgetStalePid(pid);
    return;
  }
  try{process.kill(pid,'SIGTERM')}catch{}
  for(let i=0;i<60;i++){
    if(!(await pidAlive(pid)))return;
    await new Promise(r=>setTimeout(r,250));
  }
  console.warn('NexAccount old pid '+pid+' did not stop after SIGTERM; forcing SIGKILL');
  try{process.kill(pid,'SIGKILL')}catch{}
  for(let i=0;i<20;i++){
    if(!(await pidAlive(pid)))return;
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error('Refusing to start a second NexAccount daemon while pid '+pid+' is still alive');
}

if(restart){
  const pid=await oldPid();
  await stopOldProcess(pid);
  // A live listener with a missing/stale pid file is still an active daemon.
  // Starting another process here would reuse the same MTProto StringSessions
  // and Telegram would permanently invalidate those auth keys.
  if(await healthy())throw new Error('Refusing duplicate NexAccount start: port '+port+' is still owned by an existing runtime');
}else{
  const pid=await oldPid();
  if(pid&&await pidAlive(pid)){
    if(await isNexAccountDaemonPid(pid)){
      console.log('NexAccount process already running pid='+pid);
      process.exit(0);
    }
    await forgetStalePid(pid);
  }
}

const fd=fs.openSync(logFile,'a');
const child=spawn(process.execPath,[path.join(here,'daemon.mjs')],{
  cwd:here,
  detached:true,
  stdio:['ignore',fd,fd],
  env:process.env
});
child.unref();
await fsp.writeFile(pidFile,String(child.pid));
for(let i=0;i<30;i++){
  await new Promise(r=>setTimeout(r,500));
  if(await healthy()){
    console.log('NexAccount started pid='+child.pid);
    process.exit(0);
  }
}
console.log('NexAccount spawned pid='+child.pid+'; health not ready yet');
