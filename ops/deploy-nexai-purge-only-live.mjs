import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const sha=String(process.env.NEXAI_DEPLOY_SHA||'').trim();
if(!/^[0-9a-f]{40}$/i.test(sha))throw new Error('NEXAI_DEPLOY_SHA invalid');

const repo='Nexus-tech-01/NexTelegrambots';
const currentLink='/opt/nex/apps/public/nexai/current';
const base=fs.realpathSync(currentLink);
const service='nex-nexaccount.service';
const target=path.join(base,'compat.mjs');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backupDir='/var/lib/nex/runtime/public/nexaccount/deploy-backups/purge-only-'+stamp;
const backup=path.join(backupDir,'compat.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const run=(cmd,args,opts={})=>{
  const r=spawnSync(cmd,args,{
    encoding:'utf8',
    timeout:opts.timeout||120000,
    maxBuffer:8*1024*1024,
    cwd:opts.cwd||base,
    env:opts.env||process.env
  });
  return {ok:r.status===0&&!r.error,code:r.status,stdout:String(r.stdout||''),stderr:String(r.stderr||r.error?.message||'')};
};

async function fetchText(src){
  const url='https://raw.githubusercontent.com/'+repo+'/'+sha+'/'+src;
  const r=await fetch(url,{headers:{'user-agent':'nexai-purge-live-hotfix/1'},signal:AbortSignal.timeout(30000)});
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
    const show=run('systemctl',['show',service,'--no-page','--property=ActiveState,SubState,MainPID,ExecMainStatus'],{cwd:'/',timeout:15000});
    const props={};
    for(const line of show.stdout.split(/\r?\n/)){const i=line.indexOf('=');if(i>0)props[line.slice(0,i)]=line.slice(i+1)}
    try{
      const r=await fetch('http://127.0.0.1:18120/health',{signal:AbortSignal.timeout(4000)});
      const data=await r.json().catch(()=>null);
      last={props,status:r.status,data};
      if(r.ok&&data?.ok===true&&data?.pairingOnly!==true&&props.ActiveState==='active'&&props.SubState==='running'&&Number(props.MainPID)>1)return last;
    }catch(e){last={props,error:String(e?.message||e)}}
    await sleep(2000);
  }
  throw new Error('health timeout '+JSON.stringify(last));
}

async function restart(){
  const r=run('systemctl',['restart',service],{cwd:'/',timeout:60000});
  if(!r.ok)throw new Error('systemctl restart failed: '+(r.stderr||r.stdout).slice(-1600));
  return health();
}

const report={ok:false,sha,base,backupDir,steps:{}};
let changed=false;
try{
  const remote=await fetchText('nexaccount/compat.mjs');
  const markers=[
    "const requested=Math.max(1,Math.floor(Number(args[0])||20));",
    "const pageSize=Math.min(100,remaining);",
    "await client.deleteMessages(peer,ids,{revoke:true});",
    "deleted+' message(s) supprimé(s)."
  ];
  for(const marker of markers)if(!remote.includes(marker))throw new Error('purge source marker missing: '+marker);
  if(remote.includes('Math.min(100,Number(args[0])'))throw new Error('legacy purge hard cap still present');
  report.steps.sourceValidated=true;

  fs.mkdirSync(backupDir,{recursive:true,mode:0o750});
  fs.copyFileSync(target,backup);
  copyMeta(target,backup);

  const tmp=target+'.purge-hotfix-'+process.pid+'.mjs';
  fs.writeFileSync(tmp,remote,{mode:fs.statSync(target).mode&0o777});
  copyMeta(target,tmp);
  const syntax=run(process.execPath,['--check',tmp],{cwd:base,timeout:60000});
  if(!syntax.ok){try{fs.unlinkSync(tmp)}catch{};throw new Error('compat syntax failed: '+syntax.stderr.slice(-1800))}
  fs.renameSync(tmp,target);
  changed=true;
  report.steps.written=true;
  report.steps.syntax=true;

  const graph=run(process.execPath,['--input-type=module','-e',
    "await import('./compat.mjs'); const {commandMap}=await import('./commands.mjs'); const m=commandMap(); const p=m.get('purge'); if(!p||String(p.aliasFor||p.name)!=='clean') throw new Error('purge alias missing'); console.log('PURGE_MODULE_GRAPH_OK');"
  ],{cwd:base,timeout:90000});
  if(!graph.ok||!graph.stdout.includes('PURGE_MODULE_GRAPH_OK')){
    throw new Error('compat module graph / purge alias validation failed: '+(graph.stderr||graph.stdout).slice(-2200));
  }
  report.steps.moduleGraph=true;
  report.steps.purgeAlias=true;

  const remoteHash=crypto.createHash('sha256').update(remote).digest('hex');
  const liveHash=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if(remoteHash!==liveHash)throw new Error('live compat hash mismatch before restart');
  report.steps.sourceHash=remoteHash;

  report.steps.health=await restart();

  const afterHash=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if(afterHash!==remoteHash)throw new Error('live compat hash mismatch after restart');
  const live=fs.readFileSync(target,'utf8');
  if(!markers.every(marker=>live.includes(marker)))throw new Error('purge live markers missing after restart');

  report.steps.production={purgeReady:true,hardCap100:false,batchSize:100,compatSha256:afterHash};
  report.ok=true;
  report.finishedAt=new Date().toISOString();
  console.log(JSON.stringify(report));
}catch(error){
  report.error=String(error?.stack||error).slice(0,6000);
  if(changed&&fs.existsSync(backup)){
    try{
      const tmp=target+'.purge-rollback-'+process.pid+'.mjs';
      fs.copyFileSync(backup,tmp);
      copyMeta(backup,tmp);
      fs.renameSync(tmp,target);
      report.rollback={ok:true,health:await restart().catch(e=>({ok:false,error:String(e)}))};
    }catch(re){report.rollback={ok:false,error:String(re?.stack||re).slice(0,3000)}}
  }
  console.log(JSON.stringify(report));
  process.exitCode=1;
}
