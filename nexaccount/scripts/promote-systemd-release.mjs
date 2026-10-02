import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const sourceRoot=path.resolve(here,'..');
const appRoot=path.resolve(process.env.NEXACCOUNT_PUBLIC_ROOT||'/opt/nex/apps/public/nexai');
const releasesRoot=path.join(appRoot,'releases');
const currentLink=path.join(appRoot,'current');
const service=String(process.env.NEXACCOUNT_SYSTEMD_SERVICE||'nex-nexaccount.service');
const healthPort=Number(process.env.NEXACCOUNT_LIVE_PORT||18120);
const tokenExternal=path.resolve(process.env.NEXAI_BOT_TOKEN_FILE||'/var/lib/nex/runtime/public/nexaccount/nexai-bot-token.enc');

function run(command,args,timeout=120000){
  const r=spawnSync(command,args,{encoding:'utf8',timeout});
  if(r.status!==0)throw new Error(command+' '+args.join(' ')+' failed: '+String(r.stderr||r.stdout).slice(-2400));
  return String(r.stdout||'').trim();
}
function withinReleases(target){
  const resolved=path.resolve(target);
  const prefix=releasesRoot.endsWith(path.sep)?releasesRoot:releasesRoot+path.sep;
  if(!resolved.startsWith(prefix))throw new Error('Refusing release outside '+releasesRoot);
  return resolved;
}
async function health(){
  try{
    const r=await fetch('http://127.0.0.1:'+healthPort+'/health',{signal:AbortSignal.timeout(2000)});
    const data=await r.json();
    return r.ok?data:null;
  }catch{return null}
}
async function waitHealthy(){
  let last=null;
  for(let i=0;i<35;i++){
    last=await health();
    if(last?.ok===true&&last?.botConfigured===true)return last;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('NexAccount health did not become ready: '+JSON.stringify(last));
}
async function atomicSwitch(target){
  const dest=withinReleases(target);
  if(!fs.existsSync(dest))throw new Error('Release does not exist: '+dest);
  const previous=fs.realpathSync(currentLink);
  const temp=currentLink+'.next-'+process.pid;
  await fsp.rm(temp,{force:true});
  await fsp.symlink(dest,temp);
  let switched=false;
  try{
    run('systemctl',['stop',service],60000);
    run('systemctl',['daemon-reload'],30000);
    await fsp.rename(temp,currentLink);
    switched=true;
    run('systemctl',['start',service],60000);
    const live=await waitHealthy();
    return {previousRelease:previous,currentRelease:dest,health:live};
  }catch(error){
    await fsp.rm(temp,{force:true}).catch(()=>{});
    if(switched){
      try{run('systemctl',['stop',service],30000)}catch{}
      const rollback=currentLink+'.rollback-'+process.pid;
      try{
        await fsp.rm(rollback,{force:true});
        await fsp.symlink(previous,rollback);
        await fsp.rename(rollback,currentLink);
        run('systemctl',['daemon-reload'],30000);
        run('systemctl',['start',service],60000);
      }catch(rollbackError){
        throw new Error(String(error?.message||error)+'; rollback failed: '+String(rollbackError?.message||rollbackError));
      }
    }
    throw error;
  }
}
async function ensurePersistentToken(previous){
  if(fs.existsSync(tokenExternal))return;
  const local=path.join(previous,'.runtime','nexai-bot-token.enc');
  if(!fs.existsSync(local))return;
  await fsp.mkdir(path.dirname(tokenExternal),{recursive:true});
  await fsp.copyFile(local,tokenExternal);
  try{
    const st=fs.statSync(path.dirname(tokenExternal));
    await fsp.chown(tokenExternal,st.uid,st.gid);
  }catch{}
  await fsp.chmod(tokenExternal,0o600);
}
async function promote(label){
  const previous=fs.realpathSync(currentLink);
  for(const required of ['daemon.mjs','runtime.mjs','inline-bot.mjs','store.mjs','premium-engine.mjs','package.json']){
    if(!fs.existsSync(path.join(sourceRoot,required)))throw new Error('Incomplete NexAccount source: missing '+required);
  }
  const safe=String(label||'manual').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').slice(0,24)||'manual';
  const destination=withinReleases(path.join(releasesRoot,'gha-'+safe+'-'+Date.now()));
  await fsp.mkdir(releasesRoot,{recursive:true});
  await fsp.cp(sourceRoot,destination,{
    recursive:true,
    filter:(src)=>{
      const rel=path.relative(sourceRoot,src);
      const parts=rel.split(path.sep).filter(Boolean);
      return !parts.includes('.runtime')&&!parts.includes('.git');
    }
  });
  // Agent-side fs.write intentionally creates files with restrictive modes (0600).
  // Production runs as nex-public:nex, so make the copied release group-readable/traversable
  // without making source files world-readable.
  run('chgrp',['-R',String(process.env.NEXACCOUNT_SYSTEMD_GROUP||'nex'),destination],30000);
  run('chmod',['-R','g+rX',destination],30000);
  await ensurePersistentToken(previous);
  const result=await atomicSwitch(destination);
  return {ok:true,mode:'promote',...result};
}
async function rollback(target){
  const result=await atomicSwitch(withinReleases(target));
  return {ok:true,mode:'rollback',...result};
}

const [mode,arg]=process.argv.slice(2);
let result;
if(mode==='--promote')result=await promote(arg);
else if(mode==='--rollback')result=await rollback(arg);
else throw new Error('Usage: promote-systemd-release.mjs --promote <label> | --rollback <release>');
process.stdout.write(JSON.stringify(result)+'\n');
