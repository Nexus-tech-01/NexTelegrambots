import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE='tresor_universe';
const BRIDGE_URL=String(process.env.DARK_UNIVERSE_OTAKU_BRIDGE_URL||'http://127.0.0.1:18787/publish').trim();
const STATE_DIR=String(process.env.DARK_UNIVERSE_OTAKU_STATE_DIR||'/var/lib/nex/state/internal-automation/dark-universe-otaku');
const QUEUE_FILE=path.join(STATE_DIR,'queue.json');
const MEDIA_DIR=String(process.env.DARK_UNIVERSE_OTAKU_MEDIA_DIR||'/var/lib/nex/tmp/internal-automation/dark-universe-otaku');
const RETRY_TICK_MS=Math.max(1000,Number(process.env.DARK_UNIVERSE_OTAKU_RETRY_TICK_MS||3000));
const MEDIA_RETENTION_MS=Math.max(60*60*1000,Number(process.env.DARK_UNIVERSE_OTAKU_MEDIA_RETENTION_MS||24*60*60*1000));
const DONE_RETENTION_MS=Math.max(60*60*1000,Number(process.env.DARK_UNIVERSE_OTAKU_DONE_RETENTION_MS||7*24*60*60*1000));

let processing=false;
let writeChain=Promise.resolve();

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
  const queue=await readQueue();
  const existing=queue.find(x=>sameJob(x,job.sourceMessageId)&&['pending','done'].includes(String(x?.status||'')));
  if(existing)return {...existing,duplicate:true};
  queue.push(job);
  await writeQueue(queue);
  return job;
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
  if(processing)return;
  processing=true;
  try{
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
        log('queued to Otaku Nexus','@'+SOURCE+' #'+String(job.sourceMessageId),job.bridgeDuplicate?'duplicate':'ok');
      }catch(error){
        job.lastError=String(error?.message||error).slice(0,600);
        job.nextAttemptAt=Date.now()+Math.min(300000,5000*(2**Math.min(6,job.attempts-1)));
        warn('retry scheduled','@'+SOURCE+' #'+String(job.sourceMessageId),job.lastError);
      }
      changed=true;
    }
    const compact=await cleanup(queue);
    if(changed||compact.length!==queue.length)await writeQueue(compact);
  }finally{processing=false}
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
  drain().catch(error=>warn('drain error',String(error?.message||error)));
  return {ok:true,duplicate:Boolean(out?.duplicate),queued:true,source:SOURCE,sourceMessageId:String(id)};
}

setInterval(()=>drain().catch(error=>warn('background drain error',String(error?.message||error))),RETRY_TICK_MS).unref?.();
void drain().catch(()=>{});
