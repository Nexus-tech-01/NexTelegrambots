import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const sha=String(process.env.NEXAI_DEPLOY_SHA||'').trim();
if(!/^[0-9a-f]{40}$/i.test(sha))throw new Error('NEXAI_DEPLOY_SHA invalid');

const repo='Nexus-tech-01/NexTelegrambots';
const base=fs.realpathSync('/opt/nex/apps/public/nexai/current');
const target=path.join(base,'commands.mjs');
const service='nex-nexaccount.service';
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backupDir='/var/lib/nex/runtime/public/nexaccount/deploy-backups/purge-routing-'+stamp;
const backup=path.join(backupDir,'commands.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const run=(cmd,args,opts={})=>{
  const r=spawnSync(cmd,args,{encoding:'utf8',timeout:opts.timeout||60000,maxBuffer:8*1024*1024,cwd:opts.cwd||base,env:opts.env||process.env});
  return {ok:r.status===0&&!r.error,code:r.status,stdout:String(r.stdout||''),stderr:String(r.stderr||r.error?.message||'')};
};
async function fetchText(src){
  const r=await fetch('https://raw.githubusercontent.com/'+repo+'/'+sha+'/'+src,{signal:AbortSignal.timeout(30000),headers:{'user-agent':'nexai-purge-routing-hotfix/1'}});
  if(!r.ok)throw new Error('fetch '+src+' HTTP '+r.status);
  const t=await r.text();
  if(!t.trim())throw new Error('empty '+src);
  return t;
}
function copyMeta(src,dst){
  const st=fs.statSync(src);
  fs.chmodSync(dst,st.mode&0o777);
  try{fs.chownSync(dst,st.uid,st.gid)}catch{}
}
async function health(timeoutMs=90000){
  const end=Date.now()+timeoutMs;
  let last=null;
  while(Date.now()<end){
    try{
      const r=await fetch('http://127.0.0.1:18120/health',{signal:AbortSignal.timeout(4000)});
      const data=await r.json().catch(()=>null);
      last={status:r.status,data};
      if(r.ok&&data?.ok===true&&data?.pairingOnly!==true&&Number(data?.runtimeCount||0)>0)return last;
    }catch(e){last={error:String(e?.message||e)}}
    await sleep(1500);
  }
  throw new Error('health timeout '+JSON.stringify(last));
}
async function restart(){
  const r=run('systemctl',['restart',service],{cwd:'/',timeout:60000});
  if(!r.ok)throw new Error('restart failed: '+(r.stderr||r.stdout).slice(-1600));
  return health();
}

const report={ok:false,sha,base,steps:{}};
let changed=false;
try{
  const remote=await fetchText('nexaccount/commands.mjs');
  for(const marker of [
    "C('purge','GROUP'",
    "handler:'clean'",
    "C('clean','GROUP'"
  ])if(!remote.includes(marker))throw new Error('source marker missing: '+marker);
  report.steps.sourceValidated=true;

  fs.mkdirSync(backupDir,{recursive:true,mode:0o750});
  fs.copyFileSync(target,backup);
  copyMeta(target,backup);

  const tmp=target+'.purge-routing-'+process.pid+'.mjs';
  fs.writeFileSync(tmp,remote,{mode:fs.statSync(target).mode&0o777});
  copyMeta(target,tmp);
  const syntax=run(process.execPath,['--check',tmp]);
  if(!syntax.ok){try{fs.unlinkSync(tmp)}catch{};throw new Error('syntax failed: '+syntax.stderr.slice(-1600))}
  fs.renameSync(tmp,target);
  changed=true;
  report.steps.written=true;
  report.steps.syntax=true;

  const probe=run(process.execPath,['--input-type=module','-e',
    "const {commandMap}=await import('./commands.mjs?purge='+Date.now()); const m=commandMap(); const p=m.get('purge'); if(!p||p.hidden===true||p.handler!=='clean'||p.adminOnly!==true||p.groupOnly!==true) throw new Error('purge_registry_invalid '+JSON.stringify(p)); console.log(JSON.stringify({ok:true,name:p.name,handler:p.handler,hidden:Boolean(p.hidden)}));"
  ],{cwd:base,timeout:60000});
  if(!probe.ok)throw new Error('registry probe failed: '+(probe.stderr||probe.stdout).slice(-1800));
  report.steps.registry=JSON.parse(probe.stdout.trim()||'{}');

  report.steps.health=await restart();

  const after=run(process.execPath,['--input-type=module','-e',
    "const {commandMap}=await import('./commands.mjs?live='+Date.now()); const p=commandMap().get('purge'); if(!p||p.hidden===true||p.handler!=='clean') process.exit(2); console.log('PURGE_VISIBLE_LIVE');"
  ],{cwd:base,timeout:60000});
  if(!after.ok||!after.stdout.includes('PURGE_VISIBLE_LIVE'))throw new Error('live purge registry verification failed');
  report.steps.live={purgeVisible:true,handler:'clean',prefixlessReady:true,runtimeCount:Number(report.steps.health?.data?.runtimeCount||0)};
  report.ok=true;
  report.finishedAt=new Date().toISOString();
  console.log(JSON.stringify(report));
}catch(error){
  report.error=String(error?.stack||error).slice(0,5000);
  if(changed&&fs.existsSync(backup)){
    try{
      const tmp=target+'.rollback-'+process.pid+'.mjs';
      fs.copyFileSync(backup,tmp); copyMeta(backup,tmp); fs.renameSync(tmp,target);
      report.rollback={ok:true,health:await restart().catch(e=>({ok:false,error:String(e)}))};
    }catch(re){report.rollback={ok:false,error:String(re?.stack||re).slice(0,3000)}}
  }
  console.log(JSON.stringify(report));
  process.exitCode=1;
}
