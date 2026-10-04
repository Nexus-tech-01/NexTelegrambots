import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const sha=String(process.env.NEXAI_DEPLOY_SHA||'').trim();
if(!/^[0-9a-f]{40}$/i.test(sha))throw new Error('NEXAI_DEPLOY_SHA invalid');

const repo='Nexus-tech-01/NexTelegrambots';
const current='/opt/nex/apps/public/nexai/current';
const base=fs.realpathSync(current);
const files=['media-send.mjs','reply-storage.mjs','compat.mjs','runtime.mjs'];
const required={
  'media-send.mjs':['normalizeVideoNoteBuffer','preNormalizedVideoNoteMeta'],
  'reply-storage.mjs':['replyStorageJoinLink','createChatInviteLink','member_limit:1'],
  'compat.mjs':['ensureReplyHotCacheChannel','replyStorageJoinLink','Api.messages.ImportChatInvite','hotMessageId'],
  'runtime.mjs':['ensureReplyHotCacheChannel','replyStorageJoinLink','Api.messages.ImportChatInvite','loadMentionReplyHotMedia','client.sendFile(message.peerId','Reply vidéo prioritaire']
};
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backupDir='/var/lib/nex/runtime/public/nexaccount/deploy-backups/reply-speed-'+stamp;
fs.mkdirSync(backupDir,{recursive:true,mode:0o750});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run=(cmd,args,opts={})=>{
  const r=spawnSync(cmd,args,{encoding:'utf8',timeout:opts.timeout||120000,maxBuffer:4*1024*1024,cwd:opts.cwd||base});
  return {ok:r.status===0&&!r.error,code:r.status,stdout:String(r.stdout||''),stderr:String(r.stderr||r.error?.message||'')};
};
async function fetchText(file){
  const url='https://raw.githubusercontent.com/'+repo+'/'+sha+'/nexaccount/'+file;
  const r=await fetch(url,{headers:{'user-agent':'nexai-live-reply-deploy/1'},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('fetch '+file+' HTTP '+r.status);
  const text=await r.text();
  if(!text.trim())throw new Error('empty '+file);
  for(const marker of required[file]||[])if(!text.includes(marker))throw new Error(file+' missing '+marker);
  if(file==='runtime.mjs'&&text.includes("getMessages('me',{ids:[hotMessageId]"))throw new Error('Saved Messages hot cache forbidden');
  if(file==='compat.mjs'&&text.includes("sendTelegramMedia(client,'me',normalized.buffer"))throw new Error('Saved Messages setup forbidden');
  return text;
}
function copyMeta(src,dst){
  const st=fs.statSync(src);
  fs.chmodSync(dst,st.mode&0o777);
  try{fs.chownSync(dst,st.uid,st.gid)}catch{}
}
function restore(){
  for(const file of files){
    const src=path.join(backupDir,file),dst=path.join(base,file);
    if(fs.existsSync(src)){
      const tmp=dst+'.rollback-'+process.pid;
      fs.copyFileSync(src,tmp);copyMeta(dst,tmp);fs.renameSync(tmp,dst);
    }
  }
  run('systemctl',['restart','nex-nexaccount.service'],{cwd:'/'});
}
async function health(timeoutMs=80000){
  const end=Date.now()+timeoutMs;
  let last=null;
  while(Date.now()<end){
    const show=run('systemctl',['show','nex-nexaccount.service','--no-page','--property=ActiveState,SubState,MainPID,ExecMainStatus'],{cwd:'/'});
    const props={};
    for(const line of show.stdout.split(/\r?\n/)){const i=line.indexOf('=');if(i>0)props[line.slice(0,i)]=line.slice(i+1)}
    try{
      const r=await fetch('http://127.0.0.1:18120/health',{signal:AbortSignal.timeout(4000)});
      const data=await r.json().catch(()=>null);
      last={props,status:r.status,data};
      if(r.ok&&data?.ok===true&&data?.service==='nexaccount'&&data?.pairingOnly!==true&&Number(data?.runtimeCount||0)>0&&props.ActiveState==='active'&&props.SubState==='running')return last;
    }catch(e){last={props,error:String(e?.message||e)}}
    await sleep(2500);
  }
  throw new Error('health timeout '+JSON.stringify(last));
}

const report={ok:false,sha,base,backupDir,steps:{}};
let changed=false;
try{
  const remote={};
  for(const file of files)remote[file]=await fetchText(file);
  report.steps.sourceValidated=true;

  for(const file of files){
    const dst=path.join(base,file),bak=path.join(backupDir,file);
    fs.copyFileSync(dst,bak);
    const st=fs.statSync(dst);
    fs.chmodSync(bak,st.mode&0o777);
    try{fs.chownSync(bak,st.uid,st.gid)}catch{}
  }
  report.steps.backup=true;

  for(const file of files){
    const dst=path.join(base,file),tmp=dst+'.nxc-reply-'+process.pid;
    fs.writeFileSync(tmp,remote[file],{mode:fs.statSync(dst).mode&0o777});
    copyMeta(dst,tmp);
    fs.renameSync(tmp,dst);
  }
  changed=true;
  report.steps.written=true;

  for(const file of files){
    const check=run(process.execPath,['--check',path.join(base,file)],{cwd:base,timeout:60000});
    if(!check.ok)throw new Error('node --check '+file+': '+check.stderr.slice(-1200));
  }
  report.steps.syntax=true;

  const critical=run(process.execPath,['scripts/test-critical-routes.mjs'],{cwd:base,timeout:90000});
  if(!critical.ok)throw new Error('critical routes: '+critical.stderr.slice(-1600));
  report.steps.criticalRoutes=true;

  const media=run(process.execPath,['scripts/test-media-send.mjs'],{cwd:base,timeout:120000});
  if(!media.ok)throw new Error('media tests: '+media.stderr.slice(-1600));
  report.steps.mediaTest=true;

  const restart=run('systemctl',['restart','nex-nexaccount.service'],{cwd:'/',timeout:60000});
  if(!restart.ok)throw new Error('systemctl restart: '+restart.stderr.slice(-1200));
  report.steps.restart=true;

  const live=await health();
  report.steps.health=live;
  for(const file of files){
    const text=fs.readFileSync(path.join(base,file),'utf8');
    for(const marker of required[file])if(!text.includes(marker))throw new Error('live marker missing '+file+': '+marker);
  }
  report.steps.productionMarkers=true;
  report.ok=true;
  console.log(JSON.stringify(report));
}catch(e){
  report.error=String(e?.stack||e).slice(0,5000);
  if(changed){
    try{
      restore();
      report.rollback={restored:true,health:await health(80000).catch(err=>({ok:false,error:String(err)}))};
    }catch(re){report.rollback={restored:false,error:String(re?.stack||re).slice(0,3000)}}
  }
  console.log(JSON.stringify(report));
  process.exitCode=1;
}
