import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SOURCE='tresor_universe';
const BRIDGE_URL=String(process.env.DARK_UNIVERSE_OTAKU_BRIDGE_URL||'http://127.0.0.1:18787/publish').trim();
const STATE_DIR=String(process.env.DARK_UNIVERSE_OTAKU_STATE_DIR||'/var/lib/nex/state/internal-automation/dark-universe-otaku');
const QUEUE_FILE=path.join(STATE_DIR,'queue.json');
const MEDIA_DIR=String(process.env.DARK_UNIVERSE_OTAKU_MEDIA_DIR||'/var/lib/nex/tmp/internal-automation/dark-universe-otaku');
const RETRY_TICK_MS=Math.max(1000,Number(process.env.DARK_UNIVERSE_OTAKU_RETRY_TICK_MS||3000));
const MEDIA_RETENTION_MS=Math.max(60*60*1000,Number(process.env.DARK_UNIVERSE_OTAKU_MEDIA_RETENTION_MS||24*60*60*1000));
const DONE_RETENTION_MS=Math.max(60*60*1000,Number(process.env.DARK_UNIVERSE_OTAKU_DONE_RETENTION_MS||7*24*60*60*1000));
const QUEUE_LOCK=path.join(STATE_DIR,'queue.lock');
const SUPERVISOR_PID_FILE=path.join(STATE_DIR,'supervisor.pid');
const WORKER_HEALTH_FILE=path.join(STATE_DIR,'worker-health.json');
const SUPERVISOR_HEALTH_FILE=path.join(STATE_DIR,'supervisor-health.json');
const LOG_DIR=path.join(STATE_DIR,'logs');
const WORKER_LOG_FILE=path.join(LOG_DIR,'worker.log');
const WORKER_ERR_FILE=path.join(LOG_DIR,'worker.err.log');
const SELF=fileURLToPath(import.meta.url);
const WORKER_MODE=process.argv.includes('--worker');
const SUPERVISE_MODE=process.argv.includes('--supervise');
const RESTART_SUPERVISOR_MODE=process.argv.includes('--restart-supervisor');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

let operationChain=Promise.resolve();
let writeChain=Promise.resolve();

function serialized(fn){
  const run=operationChain.then(fn,fn);
  operationChain=run.then(()=>undefined,()=>undefined);
  return run;
}

async function withQueueLock(fn){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const deadline=Date.now()+90000;
  let handle=null;
  while(Date.now()<deadline){
    try{
      handle=await fs.open(QUEUE_LOCK,'wx',0o600);
      break;
    }catch(error){
      if(error?.code!=='EEXIST')throw error;
      try{
        const stat=await fs.stat(QUEUE_LOCK);
        if(Date.now()-stat.mtimeMs>120000){
          await fs.rm(QUEUE_LOCK,{force:true});
          continue;
        }
      }catch{}
      await sleep(150);
    }
  }
  if(!handle)throw new Error('dark_universe_queue_lock_timeout');
  try{return await fn();}
  finally{
    try{await handle.close();}catch{}
    await fs.rm(QUEUE_LOCK,{force:true}).catch(()=>{});
  }
}

function log(...args){console.log('[DarkUniverse->OtakuWA]',...args)}
function warn(...args){console.warn('[DarkUniverse->OtakuWA]',...args)}
function safeName(value='media.bin'){
  const out=String(value||'media.bin').replace(/[^A-Za-z0-9._ -]+/g,'_').replace(/\s+/g,' ').trim();
  return (out||'media.bin').slice(-180);
}
async function readQueue(){
  try{
    const raw=JSON.parse(await fs.readFile(QUEUE_FILE,'utf8'));
    return Array.isArray(raw)?raw:[];
  }catch{return []}
}
async function writeQueue(queue){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const snapshot=JSON.stringify(queue,null,2);
  writeChain=writeChain.then(async()=>{
    const tmp=QUEUE_FILE+'.tmp-'+process.pid+'-'+Date.now();
    await fs.writeFile(tmp,snapshot,{mode:0o600});
    await fs.rename(tmp,QUEUE_FILE);
  });
  return writeChain;
}
function buttons(msg){
  const out=[],seen=new Set();
  const add=(text,url)=>{
    const u=String(url||'').trim();
    if(!/^https?:\/\//i.test(u)||seen.has(u))return;
    seen.add(u);
    out.push({text:(String(text||'Ouvrir').trim().slice(0,64)||'Ouvrir'),url:u});
  };
  for(const row of msg?.reply_markup?.inline_keyboard||[])for(const b of row||[])add(b?.text,b?.url);
  const body=String(msg?.text??msg?.caption??'');
  for(const e of [...(msg?.entities||[]),...(msg?.caption_entities||[])]){
    const off=Math.max(0,Number(e?.offset)||0),len=Math.max(0,Number(e?.length)||0);
    const label=len?body.slice(off,off+len):'Ouvrir';
    if(e?.type==='text_link')add(label,e?.url);
    else if(e?.type==='url'&&len)add(label,body.slice(off,off+len));
  }
  return out.slice(0,12);
}
async function media(api,msg){
  let type=null,fileId=null,fileName=null,mimetype=null;
  const photos=Array.isArray(msg?.photo)?msg.photo:[];
  if(photos.length){
    const p=photos[photos.length-1];
    type='photo';fileId=p?.file_id;fileName='dark-universe-'+String(msg.message_id)+'.jpg';mimetype='image/jpeg';
  }else if(msg?.video){
    type='video';fileId=msg.video.file_id;fileName=msg.video.file_name||('dark-universe-'+msg.message_id+'.mp4');mimetype=msg.video.mime_type||'video/mp4';
  }else if(msg?.animation){
    type='animation';fileId=msg.animation.file_id;fileName=msg.animation.file_name||('dark-universe-'+msg.message_id+'.gif');mimetype=msg.animation.mime_type||'image/gif';
  }else if(msg?.audio){
    type='audio';fileId=msg.audio.file_id;fileName=msg.audio.file_name||('dark-universe-'+msg.message_id+'.mp3');mimetype=msg.audio.mime_type||'audio/mpeg';
  }else if(msg?.document){
    type='document';fileId=msg.document.file_id;fileName=msg.document.file_name||('dark-universe-'+msg.message_id+'.bin');mimetype=msg.document.mime_type||'application/octet-stream';
  }
  if(!fileId)return [];
  const meta=await api.getFile(fileId);
  if(!meta?.file_path)throw new Error('Telegram getFile returned no file_path');
  const bytes=await api.downloadFile(meta.file_path);
  if(!bytes?.byteLength)throw new Error('Telegram media download was empty');
  await fs.mkdir(MEDIA_DIR,{recursive:true});
  const name=safeName(fileName);
  const target=path.join(MEDIA_DIR,String(msg.message_id)+'-'+name);
  await fs.writeFile(target,bytes,{mode:0o640});
  return [{type,localPath:target,fileName:name,mimetype,position:0}];
}
function sameJob(job,messageId){return String(job?.sourceMessageId||'')===String(messageId)}
async function enqueue(job){
  return serialized(()=>withQueueLock(async()=>{
    const queue=await readQueue();
    const existing=queue.find(x=>sameJob(x,job.sourceMessageId)&&['pending','done'].includes(String(x?.status||'')));
    if(existing)return {...existing,duplicate:true};
    queue.push(job);
    await writeQueue(queue);
    return job;
  }));
}
async function publish(job){
  const response=await fetch(BRIDGE_URL,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      id:'dark-universe:'+String(job.sourceMessageId)+':otaku-v1',
      source:SOURCE,
      sourceMessageId:String(job.sourceMessageId),
      text:job.text,
      mediaItems:job.media,
      buttons:job.buttons,
      createdAt:job.createdAt,
    }),
    signal:AbortSignal.timeout(15000)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('WhatsApp bridge '+response.status+': '+String(result?.error||'enqueue failed'));
  return result;
}
async function cleanup(queue){
  const now=Date.now();
  const kept=[];
  for(const job of queue){
    const completed=Date.parse(String(job?.completedAt||''));
    const drop=job?.status==='done'&&completed&&now-completed>DONE_RETENTION_MS;
    if(!drop)kept.push(job);
  }
  let entries=[];
  try{entries=await fs.readdir(MEDIA_DIR,{withFileTypes:true});}catch{return kept}
  const livePaths=new Set(kept.flatMap(x=>(x?.media||[]).map(m=>path.resolve(String(m?.localPath||''))).filter(Boolean)));
  for(const entry of entries){
    if(!entry.isFile())continue;
    const file=path.join(MEDIA_DIR,entry.name);
    try{
      const stat=await fs.stat(file);
      if(!livePaths.has(path.resolve(file))&&now-stat.mtimeMs>MEDIA_RETENTION_MS)await fs.rm(file,{force:true});
    }catch{}
  }
  return kept;
}
async function drain(){
  return serialized(()=>withQueueLock(async()=>{
    let queue=await readQueue();
    let changed=false;
    for(const job of queue){
      if(job.status!=='pending'||Number(job.nextAttemptAt||0)>Date.now())continue;
      job.attempts=Number(job.attempts||0)+1;
      job.lastAttemptAt=new Date().toISOString();
      try{
        const result=await publish(job);
        job.status='done';
        job.completedAt=new Date().toISOString();
        job.lastError=null;
        job.bridgeDuplicate=Boolean(result?.duplicate);
        log('published to Otaku Nexus','@'+SOURCE+' #'+String(job.sourceMessageId),job.bridgeDuplicate?'duplicate':'ok');
      }catch(error){
        job.lastError=String(error?.message||error).slice(0,600);
        job.nextAttemptAt=Date.now()+Math.min(300000,5000*(2**Math.min(6,job.attempts-1)));
        warn('retry scheduled','@'+SOURCE+' #'+String(job.sourceMessageId),job.lastError);
      }
      changed=true;
    }
    const compact=await cleanup(queue);
    if(changed||compact.length!==queue.length)await writeQueue(compact);
    return {processed:queue.filter(x=>x.status==='done').length,pending:queue.filter(x=>x.status==='pending').length};
  }));
}

async function pidAlive(pid){
  if(!Number.isInteger(pid)||pid<2)return false;
  try{process.kill(pid,0);return true;}catch{return false;}
}
async function readPid(file){
  try{return Number(String(await fs.readFile(file,'utf8')).trim())||null;}catch{return null;}
}
async function stopPid(pid){
  if(!(await pidAlive(pid)))return;
  try{process.kill(pid,'SIGTERM');}catch{}
  for(let i=0;i<40;i++){
    if(!(await pidAlive(pid)))return;
    await sleep(250);
  }
  try{process.kill(pid,'SIGKILL');}catch{}
}
async function writeHealth(file,payload){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const tmp=file+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify({...payload,updatedAt:new Date().toISOString()},null,2),{mode:0o600});
  await fs.rename(tmp,file);
}
export async function runDarkUniverseWhatsAppWorker(){
  await fs.mkdir(STATE_DIR,{recursive:true});
  while(true){
    try{
      const result=await drain();
      await writeHealth(WORKER_HEALTH_FILE,{ok:true,pid:process.pid,...result});
    }catch(error){
      await writeHealth(WORKER_HEALTH_FILE,{ok:false,pid:process.pid,error:String(error?.message||error).slice(0,800)}).catch(()=>{});
      warn('worker cycle failed',String(error?.message||error));
    }
    await sleep(RETRY_TICK_MS);
  }
}
async function superviseDarkUniverseWorker(){
  await fs.mkdir(LOG_DIR,{recursive:true});
  let child=null;
  let stopping=false;
  let backoff=2000;
  const terminate=async()=>{
    if(stopping)return;
    stopping=true;
    if(child&&child.exitCode==null){
      try{child.kill('SIGTERM');}catch{}
      for(let i=0;i<30&&child.exitCode==null;i++)await sleep(100);
      if(child.exitCode==null)try{child.kill('SIGKILL');}catch{}
    }
    await fs.rm(SUPERVISOR_PID_FILE,{force:true}).catch(()=>{});
    process.exit(0);
  };
  process.on('SIGTERM',()=>{void terminate();});
  process.on('SIGINT',()=>{void terminate();});
  await writeHealth(SUPERVISOR_HEALTH_FILE,{ok:true,pid:process.pid,state:'starting'});
  while(!stopping){
    const out=fsSync.openSync(WORKER_LOG_FILE,'a');
    const err=fsSync.openSync(WORKER_ERR_FILE,'a');
    const started=Date.now();
    child=spawn(process.execPath,[SELF,'--worker'],{
      cwd:path.dirname(SELF),
      env:process.env,
      stdio:['ignore',out,err]
    });
    await writeHealth(SUPERVISOR_HEALTH_FILE,{ok:true,pid:process.pid,workerPid:child.pid,state:'running'});
    const result=await new Promise(resolve=>{
      child.once('error',error=>resolve({error}));
      child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    try{fsSync.closeSync(out);}catch{}
    try{fsSync.closeSync(err);}catch{}
    child=null;
    if(stopping)break;
    const lived=Date.now()-started;
    if(lived>5*60_000)backoff=2000;
    const reason=result?.error?String(result.error?.message||result.error):('code='+String(result?.code)+' signal='+String(result?.signal||''));
    await writeHealth(SUPERVISOR_HEALTH_FILE,{ok:false,pid:process.pid,state:'restarting',reason,backoffMs:backoff}).catch(()=>{});
    warn('worker exited',reason,'restart in',backoff+'ms');
    await sleep(backoff);
    backoff=Math.min(60000,backoff*2);
  }
}
export async function ensureDarkUniverseWhatsAppSupervisor({restart=false}={}){
  await fs.mkdir(LOG_DIR,{recursive:true});
  const old=await readPid(SUPERVISOR_PID_FILE);
  if(old&&await pidAlive(old)){
    if(!restart)return {ok:true,alreadyRunning:true,pid:old};
    await stopPid(old);
  }
  const out=fsSync.openSync(WORKER_LOG_FILE,'a');
  const err=fsSync.openSync(WORKER_ERR_FILE,'a');
  const child=spawn(process.execPath,[SELF,'--supervise'],{
    cwd:path.dirname(SELF),
    env:process.env,
    detached:true,
    stdio:['ignore',out,err]
  });
  child.unref();
  try{fsSync.closeSync(out);}catch{}
  try{fsSync.closeSync(err);}catch{}
  await fs.writeFile(SUPERVISOR_PID_FILE,String(child.pid),{mode:0o600});
  await sleep(500);
  if(!(await pidAlive(child.pid)))throw new Error('dark_universe_supervisor_failed_to_start');
  return {ok:true,pid:child.pid,restarted:Boolean(restart)};
}

export async function mirrorDarkUniverseChannelPostToWhatsApp(api,update){
  const msg=update?.channel_post;
  if(!msg||msg?.chat?.type!=='channel')return {skipped:true};
  const username=String(msg?.chat?.username||'').replace(/^@/,'').toLowerCase();
  if(username!==SOURCE)return {skipped:true};
  const id=Number(msg?.message_id||0);
  if(!id)return {skipped:true};

  const text=String(msg?.text??msg?.caption??'').trim();
  const links=buttons(msg);
  if(!links.length)links.push({text:'Voir sur Telegram',url:'https://t.me/'+username+'/'+String(id)});

  let items=[];
  let mediaError=null;
  if(msg?.photo||msg?.video||msg?.animation||msg?.audio||msg?.document){
    try{items=await media(api,msg);}
    catch(error){mediaError=String(error?.message||error).slice(0,500);warn('media degraded #'+id,mediaError)}
  }
  if(!text&&!items.length&&!links.length){
    if(mediaError)throw new Error(mediaError);
    return {skipped:true};
  }

  const job={
    id:'dark-universe:'+String(id),
    source:SOURCE,
    sourceMessageId:String(id),
    text,
    buttons:links,
    media:items,
    status:'pending',
    attempts:0,
    nextAttemptAt:0,
    createdAt:new Date().toISOString(),
  };
  const out=await enqueue(job);
  ensureDarkUniverseWhatsAppSupervisor().catch(error=>warn('supervisor ensure failed',String(error?.message||error)));
  return {ok:true,duplicate:Boolean(out?.duplicate),queued:true,source:SOURCE,sourceMessageId:String(id)};
}

if(WORKER_MODE){
  await runDarkUniverseWhatsAppWorker();
}else if(SUPERVISE_MODE){
  await superviseDarkUniverseWorker();
}else if(RESTART_SUPERVISOR_MODE){
  const result=await ensureDarkUniverseWhatsAppSupervisor({restart:true});
  console.log(JSON.stringify(result));
}else{
  void ensureDarkUniverseWhatsAppSupervisor().catch(error=>warn('startup supervisor ensure failed',String(error?.message||error)));
}
