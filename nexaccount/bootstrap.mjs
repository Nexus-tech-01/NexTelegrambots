import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const stateDir=path.resolve(here,'.runtime');
const pidFile=path.join(stateDir,'nexaccount.pid');
const logFile=path.join(stateDir,'nexaccount.log');
const port=Number(process.env.NEXACCOUNT_PORT||3491);

async function healthy(){
  try{
    const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(2000)});
    return r.ok;
  }catch{return false}
}

await fsp.mkdir(stateDir,{recursive:true});
if(await healthy()){
  console.log('NexAccount already running');
  process.exit(0);
}

try{
  const old=Number(await fsp.readFile(pidFile,'utf8'));
  if(Number.isInteger(old)&&old>1)process.kill(old,0);
}catch{}

const fd=fs.openSync(logFile,'a');
const child=spawn(process.execPath,[path.join(here,'daemon.mjs')],{
  cwd:here,
  detached:true,
  stdio:['ignore',fd,fd],
  env:process.env
});
child.unref();
await fsp.writeFile(pidFile,String(child.pid));
for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,500));
  if(await healthy()){
    console.log('NexAccount started pid='+child.pid);
    process.exit(0);
  }
}
console.log('NexAccount spawned pid='+child.pid+'; health not ready yet');
