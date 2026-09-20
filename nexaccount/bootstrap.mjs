import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
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

if(restart){
  const pid=await oldPid();
  if(pid){
    try{process.kill(pid,'SIGTERM')}catch{}
    for(let i=0;i<20;i++){
      try{process.kill(pid,0)}catch{break}
      await new Promise(r=>setTimeout(r,250));
    }
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
