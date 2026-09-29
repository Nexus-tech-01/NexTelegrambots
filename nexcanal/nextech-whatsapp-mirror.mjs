import fs from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

const DEFAULT_CHANNELS=['thenexusorigin','thenexnews','tresor_universe','theotaku_nexus'];
const CHANNELS=[...new Set(
  String(process.env.NEX_WHATSAPP_MIRROR_CHANNELS||DEFAULT_CHANNELS.join(','))
    .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean)
)];
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
const ENTITY_RETRY_MS=Math.max(60*1000,Number(process.env.NEXTECH_WHATSAPP_MIRROR_ENTITY_RETRY_MS||5*60*1000));

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...x)=>console.log('[wa-channel-mirror]',...x);
const warn=(...x)=>console.warn('[wa-channel-mirror]',...x);

async function loadState(){
  try{
    const raw=JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    const cursors={...(raw?.cursors||{})};
    if(!cursors.thenexusorigin&&Number(raw?.cursor||0)>0)cursors.thenexusorigin=Math.max(0,Number(raw.cursor));
    return {
      cursors,
      lastSuccessAt:Number(raw?.lastSuccessAt)||0,
      lastErrors:raw?.lastErrors&&typeof raw.lastErrors==='object'?raw.lastErrors:{},
    };
  }catch{
    return {cursors:{},lastSuccessAt:0,lastErrors:{}};
  }
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
    out.push({text:(String(label||'Ouvrir').trim().slice(0,64)||'Ouvrir'),url});
  };
  const inspectButton=raw=>{
    const button=raw?.button||raw;
    add(raw?.text||raw?.title||button?.text||button?.title,raw?.url||raw?.href||button?.url||button?.href);
  };
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
  const messageText=String(message?.message||'');
  for(const entity of (Array.isArray(message?.entities)?message.entities:[])){
    const offset=Math.max(0,Number(entity?.offset)||0);
    const length=Math.max(0,Number(entity?.length)||0);
    const label=length?messageText.slice(offset,offset+length):'Ouvrir';
    const explicit=String(entity?.url||entity?.href||'').trim();
    if(explicit)add(label,explicit);
    else if(length){
      const visible=messageText.slice(offset,offset+length).trim();
      if(/^https?:\/\//i.test(visible))add(label,visible);
    }
    if(out.length>=12)break;
  }
  return out;
}
async function mediaItems(client,message,source){
  if(!message?.media)return [];
  await fs.mkdir(TMP_DIR,{recursive:true});
  let name,mimetype;
  if(message.photo){
    name=source+'-'+String(message.id)+'.jpg';
    mimetype='image/jpeg';
  }else if(message.document){
    name=documentName(message);
    mimetype=String(message.document?.mimeType||'application/octet-stream');
  }else return [];
  const target=path.join(TMP_DIR,safeName(source)+'-'+String(message.id)+'-'+safeName(name));
  const out=await client.downloadMedia(message.media,{outputFile:target,workers:1});
  const file=typeof out==='string'&&out?out:target;
  const stat=await fs.stat(file);
  if(!stat.isFile()||stat.size<=0)throw new Error('media download produced an empty file');
  return [{type:mediaType(message),localPath:file,fileName:name,mimetype,position:0}];
}
async function enqueue(client,message,source){
  const id=Number(message?.id||0);
  if(!id||message?.action)return {skipped:true};
  const text=String(message?.message||'').trim();
  const inlineButtons=buttons(message);
  let media=[];
  let mediaError=null;
  if(message?.media){
    try{media=await mediaItems(client,message,source);}
    catch(error){
      mediaError=String(error?.message||error).slice(0,500);
      warn('media degraded','@'+source,'#'+String(id),mediaError);
    }
  }
  if(!text&&!media.length&&!inlineButtons.length){
    if(mediaError)throw new Error('media unavailable: '+mediaError);
    return {skipped:true};
  }
  const body={
    ownerDomain:'system',
    idempotencyKey:'telegram-channel:'+source+':'+String(id)+':v3',
    source:{platform:'telegram',name:source,messageId:String(id),accountRole:'system-channel-mirror'},
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
function messageTimeMs(message){
  if(message?.date instanceof Date)return message.date.getTime();
  const n=Number(message?.date||0);
  return n>1e12?n:n*1000;
}
async function run(){
  if(!USER_SESSION||!API_ID||!API_HASH)throw new Error('missing Telegram user MTProto watcher credentials');
  const client=new TelegramClient(new StringSession(USER_SESSION),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true,floodSleepThreshold:60});
  const entities=new Map();
  const retryAt=new Map();
  try{
    await client.connect();
    const me=await client.getMe();
    if(me?.bot===true)throw new Error('WhatsApp mirror watcher must use a Telegram user session');
    const state=await loadState();
    log('connected as',me?.username?'@'+me.username:String(me?.id||'user'),'channels='+CHANNELS.map(x=>'@'+x).join(','));

    const getEntity=async source=>{
      if(entities.has(source))return entities.get(source);
      if(Date.now()<Number(retryAt.get(source)||0))return null;
      try{
        const entity=await client.getEntity('@'+source);
        entities.set(source,entity);
        retryAt.delete(source);
        log('watching @'+source,'cursor='+Number(state.cursors[source]||0));
        return entity;
      }catch(error){
        const msg=String(error?.errorMessage||error?.message||error).slice(0,300);
        state.lastErrors[source]=msg;
        retryAt.set(source,Date.now()+ENTITY_RETRY_MS);
        await saveState(state);
        warn('source unavailable @'+source,msg);
        return null;
      }
    };

    let nextCleanupAt=Date.now()+CLEANUP_MS;
    while(true){
      for(const source of CHANNELS){
        const entity=await getEntity(source);
        if(!entity)continue;
        let cursor=Math.max(0,Number(state.cursors[source]||0));
        try{
          if(!cursor){
            const bootstrap=await client.getMessages(entity,{limit:100});
            const cutoff=Date.now()-BACKFILL_MS;
            const recent=(bootstrap||[]).filter(m=>Number(m?.id||0)>0&&(!messageTimeMs(m)||messageTimeMs(m)>=cutoff));
            const ids=recent.map(m=>Number(m.id)).filter(Boolean);
            if(ids.length){
              cursor=Math.max(0,Math.min(...ids)-1);
              state.cursors[source]=cursor;
              await saveState(state);
              log('bootstrap backfill @'+source,ids.length,'post(s)','from #'+Math.min(...ids),'to #'+Math.max(...ids));
            }else{
              const latest=Number(bootstrap?.[0]?.id||0);
              if(latest){
                state.cursors[source]=latest;
                await saveState(state);
                continue;
              }
            }
          }

          const rows=await client.getMessages(entity,{limit:100,minId:Number(state.cursors[source]||0)});
          const fresh=(rows||[])
            .filter(m=>Number(m?.id||0)>Number(state.cursors[source]||0))
            .sort((a,b)=>Number(a.id)-Number(b.id));
          for(const message of fresh){
            try{
              const result=await enqueue(client,message,source);
              state.cursors[source]=Number(message.id);
              state.lastSuccessAt=Date.now();
              delete state.lastErrors[source];
              await saveState(state);
              log(result?.duplicate?'deduplicated':'queued','@'+source+' #'+String(message.id),'-> WhatsApp');
            }catch(error){
              state.lastErrors[source]=String(error?.message||error).slice(0,500);
              state.lastErrorAt=Date.now();
              await saveState(state);
              warn('message failed','@'+source,'#'+String(message?.id||'?'),state.lastErrors[source]);
              break;
            }
          }
        }catch(error){
          const msg=String(error?.errorMessage||error?.message||error).slice(0,500);
          state.lastErrors[source]=msg;
          await saveState(state);
          warn('poll failed @'+source,msg);
          if(/AUTH|SESSION|USER_DEACTIVATED|SESSION_REVOKED/i.test(msg))throw error;
        }
        await sleep(350);
      }
      if(Date.now()>=nextCleanupAt){
        nextCleanupAt=Date.now()+CLEANUP_MS;
        await cleanup().catch(()=>{});
      }
      await sleep(POLL_MS);
    }
  }finally{
    await client.disconnect().catch(()=>{});
  }
}

let delay=3000;
for(;;){
  try{await run();delay=3000;}
  catch(error){
    warn('worker restart',String(error?.errorMessage||error?.message||error));
    await sleep(delay);
    delay=Math.min(60000,delay*2);
  }
}
