import fs from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

const CHANNEL=String(process.env.NEXTECH_TELEGRAM_CHANNEL||'thenexusorigin').trim().replace(/^@/,'');
const TOKEN=String(process.env.NEXCANAL__BOT_TOKEN||process.env.NEXCANAL_BOT_TOKEN||'').trim();
const API_ID=Number(process.env.NEXCANAL__WATCHER_API_ID||process.env.NEXGROUP__TELEGRAM_API_ID||0);
const API_HASH=String(process.env.NEXCANAL__WATCHER_API_HASH||process.env.NEXGROUP__TELEGRAM_API_HASH||'').trim();
const USER_SESSION=String(process.env.NEXCANAL__WATCHER_SESSION||process.env.NEXGROUP__TELEGRAM_MTPROTO_SESSION||'').trim();
const INTERROUTE=String(process.env.NEX_INTERROUTE_URL||'http://127.0.0.1:18130').replace(/\/$/,'');
const STATE_FILE=String(process.env.NEXTECH_WHATSAPP_MIRROR_STATE_FILE||'/var/lib/nex/state/nexcanal/nextech-whatsapp-mirror-state.json');
const TMP_DIR=String(process.env.NEXTECH_WHATSAPP_MIRROR_TMP||'/var/lib/nex/tmp/internal-automation/nextech-channel-mirror');
const POLL_MS=Math.max(5000,Number(process.env.NEXTECH_WHATSAPP_MIRROR_POLL_MS||15000));
const BACKFILL_MS=Math.max(60*60*1000,Number(process.env.NEXTECH_WHATSAPP_MIRROR_BACKFILL_MS||24*60*60*1000));
const TMP_RETENTION_MS=Math.max(60*60*1000,Number(process.env.NEXTECH_WHATSAPP_MIRROR_RETENTION_MS||24*60*60*1000));
const CLEANUP_MS=Math.max(60*1000,Number(process.env.NEXTECH_WHATSAPP_MIRROR_CLEANUP_MS||15*60*1000));

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...x)=>console.log('[nextech-wa-mirror]',...x);
const warn=(...x)=>console.warn('[nextech-wa-mirror]',...x);

async function loadState(){
  try{
    const raw=JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    return {cursor:Math.max(0,Number(raw?.cursor)||0),lastSuccessAt:Number(raw?.lastSuccessAt)||0,lastError:raw?.lastError||null};
  }catch{return {cursor:0,lastSuccessAt:0,lastError:null};}
}
async function saveState(state){
  await fs.mkdir(path.dirname(STATE_FILE),{recursive:true});
  const tmp=STATE_FILE+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify({...state,updatedAt:new Date().toISOString()},null,2),{mode:0o600});
  await fs.rename(tmp,STATE_FILE);
}
function safeName(value='media.bin'){
  const out=String(value||'media.bin').replace(/[\\/:*?"<>|\u0000-\u001f]+/g,'_').replace(/\s+/g,' ').trim();
  return (out||'media.bin').slice(-180);
}
function documentName(message){
  for(const attr of message?.document?.attributes||[]){
    if(typeof attr?.fileName==='string'&&attr.fileName.trim())return safeName(attr.fileName);
  }
  const mime=String(message?.document?.mimeType||'').toLowerCase();
  const ext=mime==='application/vnd.android.package-archive'?'.apk':
    mime==='application/zip'?'.zip':
    mime.startsWith('video/')?'.mp4':
    mime.startsWith('audio/')?'.mp3':
    mime==='image/gif'?'.gif':'';
  return 'telegram-'+String(message?.id||Date.now())+ext;
}
function mediaType(message){
  if(message?.photo)return 'photo';
  const mime=String(message?.document?.mimeType||'').toLowerCase();
  if(mime==='image/gif')return 'animation';
  if(mime.startsWith('video/'))return 'video';
  if(mime.startsWith('audio/'))return 'audio';
  if(mime.startsWith('image/'))return 'photo';
  return 'document';
}
function buttons(message){
  const out=[];
  const seen=new Set();
  const add=(label,value)=>{
    const url=String(value||'').trim();
    if(!/^https?:\/\//i.test(url)||seen.has(url))return;
    seen.add(url);
    out.push({
      text:(String(label||'Ouvrir').trim().slice(0,64)||'Ouvrir'),
      url
    });
  };
  const inspectButton=raw=>{
    const button=raw?.button||raw;
    add(
      raw?.text||raw?.title||button?.text||button?.title,
      raw?.url||raw?.href||button?.url||button?.href
    );
  };

  // Teleproto/GramJS can expose the same inline keyboard through different
  // shapes depending on the version. Keep every URL button instead of relying
  // on replyMarkup.rows only.
  for(const markup of [message?.replyMarkup,message?.reply_markup]){
    for(const row of markup?.rows||[]){
      for(const button of row?.buttons||[]){
        inspectButton(button);
        if(out.length>=12)return out;
      }
    }
  }
  for(const row of (Array.isArray(message?.buttons)?message.buttons:[])){
    const cells=Array.isArray(row)?row:(Array.isArray(row?.buttons)?row.buttons:[row]);
    for(const button of cells){
      inspectButton(button);
      if(out.length>=12)return out;
    }
  }

  // Some NexTech/LiteAPK posts expose a URL as a Telegram text_link entity
  // rather than a reply-markup button. Preserve those links as CTA candidates.
  const messageText=String(message?.message||'');
  for(const entity of (Array.isArray(message?.entities)?message.entities:[])){
    const offset=Math.max(0,Number(entity?.offset)||0);
    const length=Math.max(0,Number(entity?.length)||0);
    const label=length?messageText.slice(offset,offset+length):'Ouvrir';
    const explicit=String(entity?.url||entity?.href||'').trim();
    if(explicit){
      add(label,explicit);
    }else if(length){
      const visible=messageText.slice(offset,offset+length).trim();
      if(/^https?:\/\//i.test(visible))add(label,visible);
    }
    if(out.length>=12)break;
  }
  return out;
}

async function mediaItems(client,message){
  if(!message?.media)return [];
  await fs.mkdir(TMP_DIR,{recursive:true});
  let name,mimetype;
  if(message.photo){
    name='nextech-'+String(message.id)+'.jpg';
    mimetype='image/jpeg';
  }else if(message.document){
    name=documentName(message);
    mimetype=String(message.document?.mimeType||'application/octet-stream');
  }else return [];
  const target=path.join(TMP_DIR,String(message.id)+'-'+safeName(name));
  const out=await client.downloadMedia(message.media,{outputFile:target,workers:1});
  const file=typeof out==='string'&&out?out:target;
  const stat=await fs.stat(file);
  if(!stat.isFile()||stat.size<=0)throw new Error('media download produced an empty file');
  return [{type:mediaType(message),localPath:file,fileName:name,mimetype,position:0}];
}
async function enqueue(client,message){
  const id=Number(message?.id||0);
  if(!id||message?.action)return {skipped:true};
  const text=String(message?.message||'').trim();
  const inlineButtons=buttons(message);
  let media=[];
  let mediaError=null;
  if(message?.media){
    try{
      media=await mediaItems(client,message);
    }catch(error){
      mediaError=String(error?.message||error).slice(0,500);
      warn('media degraded','#'+String(id),mediaError);
    }
  }
  // A single broken/oversized Telegram media item must never freeze the
  // mirror cursor forever. If the post still has useful caption/CTA content,
  // enqueue that immediately and let later posts continue normally.
  if(!text&&!media.length&&!inlineButtons.length){
    if(mediaError)throw new Error('media unavailable: '+mediaError);
    return {skipped:true};
  }
  const body={
    ownerDomain:'system',
    idempotencyKey:'nextech-channel:'+String(id)+':v2-download-links',
    source:{platform:'telegram',name:'thenexusorigin',messageId:String(id),accountRole:'system-channel-mirror'},
    content:{text,media,buttons:inlineButtons},
    routes:[{platform:'whatsapp'}]
  };
  const response=await fetch(INTERROUTE+'/events',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(15000)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('interroute '+response.status+': '+String(result?.error||'enqueue failed'));
  return result;
}
async function cleanup(){
  let entries=[];
  try{entries=await fs.readdir(TMP_DIR,{withFileTypes:true});}catch{return;}
  const cutoff=Date.now()-TMP_RETENTION_MS;
  for(const entry of entries){
    if(!entry.isFile())continue;
    const file=path.join(TMP_DIR,entry.name);
    try{const stat=await fs.stat(file);if(stat.mtimeMs<cutoff)await fs.rm(file,{force:true});}catch{}
  }
}
async function run(){
  if(!USER_SESSION||!API_ID||!API_HASH)throw new Error('missing Telegram user MTProto watcher credentials');
  const client=new TelegramClient(new StringSession(USER_SESSION),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true,floodSleepThreshold:60});
  try{
    await client.connect();
    const me=await client.getMe();
    if(me?.bot===true)throw new Error('Nextech mirror watcher must use a Telegram user session');
    const entity=await client.getEntity('@'+CHANNEL);
    const state=await loadState();
    log('connected as',me?.username?'@'+me.username:String(me?.id||'bot'),'watching @'+CHANNEL,'cursor='+state.cursor);
    if(!state.cursor){
      const bootstrap=await client.getMessages(entity,{limit:100});
      const cutoff=Date.now()-BACKFILL_MS;
      const recent=(bootstrap||[]).filter(m=>{
        const t=m?.date instanceof Date?m.date.getTime():Number(m?.date||0)*1000;
        return Number(m?.id||0)>0 && (!t||t>=cutoff);
      });
      const ids=recent.map(m=>Number(m.id)).filter(Boolean);
      if(ids.length){
        state.cursor=Math.max(0,Math.min(...ids)-1);
        await saveState(state);
        log('bootstrap backfill',ids.length,'Nextech post(s)','from #'+Math.min(...ids),'to #'+Math.max(...ids));
      }
    }
    let nextCleanupAt=Date.now()+CLEANUP_MS;
    while(true){
      const rows=await client.getMessages(entity,{limit:100,minId:Number(state.cursor||0)});
      const fresh=(rows||[]).filter(m=>Number(m?.id||0)>Number(state.cursor||0)).sort((a,b)=>Number(a.id)-Number(b.id));
      for(const message of fresh){
        try{
          const result=await enqueue(client,message);
          state.cursor=Number(message.id);
          state.lastSuccessAt=Date.now();
          state.lastError=null;
          await saveState(state);
          log(result?.duplicate?'deduplicated':'queued','Nextech #'+String(message.id),'-> WhatsApp');
        }catch(error){
          state.lastError=String(error?.message||error).slice(0,500);
          state.lastErrorAt=Date.now();
          await saveState(state);
          warn('message failed','#'+String(message?.id||'?'),state.lastError);
          break;
        }
      }
      if(Date.now()>=nextCleanupAt){nextCleanupAt=Date.now()+CLEANUP_MS;await cleanup().catch(()=>{});}
      await sleep(POLL_MS);
    }
  }finally{
    await client.disconnect().catch(()=>{});
  }
}

let delay=3000;
for(;;){
  try{await run();delay=3000;}
  catch(error){warn('worker restart',String(error?.errorMessage||error?.message||error));await sleep(delay);delay=Math.min(60000,delay*2);}
}
