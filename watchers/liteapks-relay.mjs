import fs from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { CustomFile } from 'teleproto/client/uploads.js';

const dst=(process.env.NEXCANAL__APK_DESTINATION||process.env.NEXCANAL__WATCHER_DESTINATION||'thenexusorigin').replace(/^@/,'').trim();
const token=(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const expectedScanner=String(process.env.NEXCANAL__WATCHER_EXPECTED_USERNAME||'tresor20009').trim().replace(/^@/,'').toLowerCase();
const apiId=Number(process.env.NEXCANAL__WATCHER_API_ID||process.env.NEXGROUP__TELEGRAM_API_ID||0);
const apiHash=(process.env.NEXCANAL__WATCHER_API_HASH||process.env.NEXGROUP__TELEGRAM_API_HASH||'').trim();
const sessionFile=process.env.NEX_LITEAPKS_SESSION_FILE||process.env.NEXCANAL__WATCHER_SESSION_FILE||'/home/container/.nexcontrol/nexcanal-reader-session.txt';
const stateFile=process.env.NEX_LITEAPKS_STATE_FILE||process.env.NEXCANAL__WATCHER_STATE_FILE||'/home/container/.nexcontrol/nexcanal-watch-state-v2.json';
const mediaTmpDir=process.env.NEX_LITEAPKS_MEDIA_TMP||process.env.NEXCANAL__WATCHER_MEDIA_TMP||'/home/container/.nexcontrol/nexcanal-media';
// Keep the shared APK cache short-lived. The mirror has durable recovery jobs,
// so a full-day retention only risks exhausting the VPS disk on large packages.
const mediaTmpRetentionMs=Math.max(60*60*1000,Number(process.env.NEXCANAL__WATCHER_MEDIA_RETENTION_MS||2*60*60*1000));
const mediaTmpCleanupMs=Math.max(60*1000,Number(process.env.NEXCANAL__WATCHER_MEDIA_CLEANUP_MS||15*60*1000));
const watcherIdentityFile=process.env.NEX_LITEAPKS_ID_FILE||process.env.NEXCANAL__WATCHER_ID_FILE||'/home/container/.nexcontrol/nexcanal-watcher-id.txt';
const publisherSessionFile=process.env.NEX_LITEAPKS_PUBLISHER_SESSION_FILE||'/var/lib/nex/sessions/internal/nexcanal-publisher-session.txt';
const poll=Math.max(1500,Number(process.env.NEXCANAL__WATCHER_POLL_MS||2500));
// Scan continuously, but pace public posts by logical publication batch.
// A descriptor (image/caption) and its matching APK belong to the same batch.
const publicationGapMs=Math.max(60*1000,Number(process.env.NEXCANAL__WATCHER_PUBLICATION_GAP_MS||2*60*60*1000));
const linkedBatchWindowMs=Math.max(60*1000,Number(process.env.NEXCANAL__WATCHER_LINK_WINDOW_MS||30*60*1000));
const botLimit=49*1024*1024;
const whatsappDirectFileLimit=19*1024*1024;
const smallDownloadTimeoutMs=Math.max(120000,Number(process.env.NEXCANAL__WATCHER_SMALL_DOWNLOAD_TIMEOUT_MS||300000));
const largeDownloadTimeoutMs=Math.max(180000,Number(process.env.NEXCANAL__WATCHER_LARGE_DOWNLOAD_TIMEOUT_MS||900000));
const largeUploadTimeoutMs=Math.max(180000,Number(process.env.NEXCANAL__WATCHER_LARGE_UPLOAD_TIMEOUT_MS||900000));
const serverCopyEnabled=/^(?:1|true|yes|on)$/i.test(String(process.env.NEXCANAL__WATCHER_SERVER_COPY_ENABLED||'false'));
const maxFetch=500;
const interrouteUrl=String(process.env.NEX_INTERROUTE_URL||'http://127.0.0.1:18130').replace(/\/$/,'');
const nextechMirrorTmpDir=String(process.env.NEXTECH_WHATSAPP_MIRROR_TMP||'/var/lib/nex/tmp/internal-automation/nextech-channel-mirror');
const nextechMirrorRetentionMs=Math.max(60*60*1000,Number(process.env.NEXTECH_WHATSAPP_MIRROR_RETENTION_MS||24*60*60*1000));
const nexusTechFacebookPageId=String(process.env.NEXTECH_FACEBOOK_PAGE_ID||'106458282029367').trim();

const sourceSpecs=[
  {key:'liteapks',username:'liteapks',kind:'liteapks'},
  {key:'imadeaux',username:'imadeaux',dialogId:'-1001918663716',titleMatch:/madeaux/i,kind:'imadeaux'}
];

const engagementJoinTargets=String(process.env.NEXAI_AUTO_JOIN_TARGETS||'thenexnews,tresor_universe,hackergrouptel,Tresortelegramgroup,thenexusorigin')
  .split(',').map(x=>x.trim().replace(/^@/,'')).filter(Boolean);
const engagementReactTargets=String(process.env.NEXAI_AUTO_REACT_TARGETS||'thenexnews,tresor_universe,thenexusorigin')
  .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean);
const engagementReactions=String(process.env.NEXAI_AUTO_REACT_EMOJIS||'🔥,❤️,👍')
  .split(',').map(x=>x.trim()).filter(Boolean);
const engagementPollMs=Math.max(5000,Number(process.env.NEXAI_AUTO_REACT_POLL_MS||8000));
const engagementJoinRetryMs=Math.max(5*60*1000,Number(process.env.NEXAI_AUTO_JOIN_RETRY_MS||30*60*1000));

const dlRe=/\b(download(?:\s+(?:fast|now|apk|direct))?|fast\s+download|direct\s+download|get\s+(?:apk|app)|install\s+now)\b/i;
const fileRe=/\.(?:apk|xapk|apks|apkm|zip)$/i;
const urlRe=/https?:\/\/[^\s<>]+/gi;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const opTimeoutMs=Math.max(5000,Number(process.env.NEXCANAL__WATCHER_OP_TIMEOUT_MS||20000));
const bootstrapLimit=Math.max(1,Math.min(maxFetch,Number(process.env.NEXCANAL__WATCHER_BOOTSTRAP_LIMIT||80)));
const bootstrapHours=Math.max(1,Number(process.env.NEXCANAL__WATCHER_BOOTSTRAP_HOURS||48));
const sourceResolveRetryMs=Math.max(30_000,Number(process.env.NEXCANAL__WATCHER_SOURCE_RESOLVE_RETRY_MS||60_000));
const apkRecoveryHours=Math.max(1,Number(process.env.NEXCANAL__WATCHER_RECOVERY_HOURS||48));
const apkRecoveryLimit=Math.max(20,Math.min(500,Number(process.env.NEXCANAL__WATCHER_RECOVERY_LIMIT||200)));
const destinationRecoveryLimit=Math.max(50,Math.min(500,Number(process.env.NEXCANAL__WATCHER_DESTINATION_RECOVERY_LIMIT||250)));
function withTimeout(promise,ms=opTimeoutMs,label='operation'){
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout after '+ms+'ms')),ms);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}
const log=(...x)=>console.log('[nexcanal-watcher]',...x);
const warn=(...x)=>console.warn('[nexcanal-watcher]',...x);

async function sessionSecret(){
  const direct=(process.env.NEXCANAL__WATCHER_SESSION||'').trim();
  if(direct)return direct;
  try{return (await fs.readFile(sessionFile,'utf8')).trim();}catch{return '';}
}

function engagementState(st){
  st.engagement=st.engagement||{};
  st.engagement.reactionCursors=st.engagement.reactionCursors||{};
  st.engagement.reactionStatus=st.engagement.reactionStatus||{};
  st.engagement.joinStatus=st.engagement.joinStatus||{};
  return st.engagement;
}
async function joinEngagementTargets(c,st,{force=false}={}){
  const es=engagementState(st);
  if(!force&&Date.now()-Number(es.lastJoinAt||0)<engagementJoinRetryMs)return;
  for(const raw of engagementJoinTargets){
    const username=String(raw).replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'').replace(/^@/,'').split(/[/?#]/)[0];
    if(!username)continue;
    try{
      const entity=await c.getInputEntity('@'+username);
      try{await c.invoke(new Api.channels.JoinChannel({channel:entity}));es.joinStatus[username]={ok:true,status:'joined',at:Date.now()};}
      catch(e){
        const m=String(e?.errorMessage||e?.message||e);
        if(/USER_ALREADY_PARTICIPANT/i.test(m))es.joinStatus[username]={ok:true,status:'already_joined',at:Date.now()};
        else throw e;
      }
      log('auto-join ok','@'+username,es.joinStatus[username].status);
    }catch(e){
      const m=String(e?.errorMessage||e?.message||e);
      es.joinStatus[username]={ok:false,error:m.slice(0,220),at:Date.now()};
      warn('auto-join failed','@'+username,m);
    }
  }
  es.lastJoinAt=Date.now();
  await save(st);
}
async function reactOne(c,username,m){
  const peer=await c.getInputEntity('@'+username);
  const emoji=engagementReactions[Math.abs(Number(m?.id||0))%engagementReactions.length]||'🔥';
  await c.invoke(new Api.messages.SendReaction({
    peer,
    msgId:Number(m.id),
    reaction:[new Api.ReactionEmoji({emoticon:emoji})]
  }));
  return emoji;
}
async function pollEngagementReactions(c,st){
  const es=engagementState(st);
  let changed=false;
  const now=Date.now();
  if(Number(es.reactionPausedUntil||0)>now)return;
  for(const username of engagementReactTargets){
    try{
      const entity=await c.getEntity('@'+username);
      let cursor=Number(es.reactionCursors[username]||0);
      if(!cursor){
        const latest=await c.getMessages(entity,{limit:1});
        const m=latest?.[0];
        if(m){
          try{
            const emoji=await reactOne(c,username,m);
            es.reactionStatus[username]={ok:true,msgId:Number(m.id),emoji,at:Date.now()};
            log('auto-react smoke','@'+username,'#'+m.id,emoji);
          }catch(e){
            const error=String(e?.errorMessage||e?.message||e);
            es.reactionStatus[username]={ok:false,msgId:Number(m.id),error:error.slice(0,220),at:Date.now()};
            warn('auto-react smoke failed','@'+username,error);
          }
          cursor=Number(m.id||0);
          es.reactionCursors[username]=cursor;
          changed=true;
        }
        continue;
      }
      const fresh=await c.getMessages(entity,{limit:100,minId:cursor});
      const list=(fresh||[]).filter(m=>Number(m.id)>cursor).sort((a,b)=>Number(a.id)-Number(b.id));
      // Never mass-react to a historical backlog after downtime/migration.
      // For a backlog, react only to the newest post and advance the cursor.
      const reactionList=list.length>3?[list[list.length-1]]:list;
      for(const m of reactionList){
        try{
          const emoji=await reactOne(c,username,m);
          es.reactionStatus[username]={ok:true,msgId:Number(m.id),emoji,at:Date.now()};
          log('auto-react','@'+username,'#'+m.id,emoji);
        }catch(e){
          const error=String(e?.errorMessage||e?.message||e);
          es.reactionStatus[username]={ok:false,msgId:Number(m.id),error:error.slice(0,220),at:Date.now()};
          const flood=error.match(/FLOOD_WAIT_(\d+)/i);
          if(flood){
            const waitMs=(Math.max(1,Number(flood[1]))+10)*1000;
            es.reactionPausedUntil=Date.now()+waitMs;
            // Skip historical reaction backlog; resume only for future posts.
            const newest=list[list.length-1];
            if(newest)es.reactionCursors[username]=Math.max(Number(es.reactionCursors[username]||0),Number(newest.id||0));
            warn('auto-react paused','@'+username,Math.ceil(waitMs/1000)+'s');
            changed=true;
            break;
          }
          warn('auto-react failed','@'+username,'#'+m.id,error);
        }
        es.reactionCursors[username]=Math.max(Number(es.reactionCursors[username]||0),Number(m.id||0));
        changed=true;
      }
    }catch(e){warn('auto-react scan failed','@'+username,String(e?.errorMessage||e?.message||e))}
  }
  if(changed)await save(st);
}

function filename(m){
  for(const a of m?.document?.attributes||[])if(a?.fileName)return String(a.fileName);
  return '';
}
function isApk(m){
  const mime=String(m?.document?.mimeType||'').toLowerCase();
  return !!m?.document&&(fileRe.test(filename(m))||mime.includes('android.package-archive'));
}
function isDescriptor(m){
  const t=String(m?.message||'');
  return !!t.trim()&&(dlRe.test(t)||/\bformat\s*:\s*(?:apk|xapk|apks|apkm)\b/i.test(t)||/\bmod\s+info\s*:/i.test(t)||(/\btitle\s*:/i.test(t)&&/\bversion\s*:/i.test(t)));
}
function version(t=''){
  return t.match(/(?:version|ver\.?|v)\s*[:\-]?\s*v?([0-9]+(?:\.[0-9A-Za-z]+){1,5})/i)?.[1]?.toLowerCase()||'';
}
function title(t=''){
  return t.match(/(?:^|\n)\s*[-•–—]?\s*title\s*:\s*([^\n]+)/i)?.[1]?.trim()||'';
}
function norm(s=''){
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function descriptorScore(p,m){
  if(!p)return 0;
  const h=norm(filename(m)+' '+String(m.message||''));
  let s=Date.now()-Number(p.at||0)<180000?1:0;
  const words=norm(p.title).split(' ').filter(x=>x.length>2);
  const hits=words.filter(x=>h.includes(x)).length;
  if(hits>=Math.min(2,words.length)&&hits)s+=3;
  else if(hits)s++;
  const v=version(filename(m)+' '+String(m.message||''));
  if(p.version&&v&&p.version===v)s+=4;
  return s;
}
function chooseUrl(m){
  const lines=String(m?.message||'').split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    if(!dlRe.test(lines[i]))continue;
    const a=lines[i].match(urlRe)?.[0];
    if(a)return a.replace(/[),.;]+$/,'');
    for(let j=i+1;j<=Math.min(i+2,lines.length-1);j++){
      const b=lines[j].match(urlRe)?.[0];
      if(b)return b.replace(/[),.;]+$/,'');
    }
  }
  return '';
}
function translateMadeauxLine(line=''){
  return String(line)
    .replace(/\bAnuncios eliminados\b/gi,'Ads removed')
    .replace(/\bPremium desbloqueado\b/gi,'Premium unlocked')
    .replace(/\bfunciones premium desbloqueadas\b/gi,'Premium features unlocked')
    .replace(/\bPermitido tomar capturas de pantalla y grabar en toda la app\b/gi,'Screenshots and screen recording enabled throughout the app')
    .replace(/\bGuardar contenido en grupos y canales restringidos\b/gi,'Saving content from restricted groups and channels enabled')
    .replace(/\bMultimedia con temporizador de autodestrucción no se elimina\b/gi,'Self-destruct media is not deleted')
    .replace(/\bDescargas optimizadas\b/gi,'Optimized downloads')
    .replace(/\bNotificación de actualización eliminada\b/gi,'Update notification removed')
    .replace(/\banuncios eliminados\b/gi,'ads removed')
    .replace(/\bservidores con la configuración abierta\b/gi,'servers with open configuration');
}
function clean(m,sourceKind,u){
  let lines=String(m?.message||'').split(/\r?\n/);
  lines=lines.filter(line=>{
    if(dlRe.test(line))return false;
    if(u&&line.includes(u))return false;
    if(sourceKind==='imadeaux'&&(/(?:canal|channel)\s*:\s*@?imadeaux/i.test(line)||/@imadeaux\b/i.test(line)))return false;
    return true;
  });
  if(sourceKind==='imadeaux')lines=lines.map(translateMadeauxLine);
  return lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
function markup(u){
  return u?{inline_keyboard:[[{text:'Download Fast ⬇️',url:u}]]}:undefined;
}
async function bot(method,fields,file){
  const endpoint=`https://api.telegram.org/bot${token}/${method}`;
  let r;
  if(file){
    const f=new FormData();
    for(const [k,v] of Object.entries(fields))if(v!==undefined&&v!==null&&v!=='')f.append(k,typeof v==='string'?v:JSON.stringify(v));
    f.append(file.field,new Blob([file.buf],{type:file.mime||'application/octet-stream'}),file.name);
    r=await fetch(endpoint,{method:'POST',body:f});
  }else{
    r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields)});
  }
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok)throw new Error(`${method}: ${j.description||r.status}`);
  return j.result;
}
function documentLocation(m){
  const doc=m?.document;
  if(!doc?.id||!doc?.accessHash)return null;
  return new Api.InputDocumentFileLocation({
    id:doc.id,
    accessHash:doc.accessHash,
    fileReference:doc.fileReference||Buffer.alloc(0),
    thumbSize:''
  });
}
async function downloadDocument(c,m,outputFile){
  const location=documentLocation(m);
  if(!location)throw new Error('document location unavailable');
  const opts={
    dcId:Number(m.document?.dcId||0)||undefined,
    fileSize:m.document?.size,
    partSizeKb:512,
    ...(outputFile?{outputFile}:{})
  };
  const out=await c.downloadFile(location,opts);
  if(!out&&outputFile)return outputFile;
  return out;
}
async function media(c,m){
  const b=m?.document
    ? await downloadDocument(c,m)
    : await c.downloadMedia(m.media,{workers:1});
  if(!b)throw new Error('media download failed');
  return Buffer.isBuffer(b)?b:Buffer.from(b);
}
async function cleanupMediaTmp(maxAgeMs=mediaTmpRetentionMs){
  await fs.mkdir(mediaTmpDir,{recursive:true});
  const now=Date.now();
  const entries=await fs.readdir(mediaTmpDir,{withFileTypes:true}).catch(()=>[]);
  for(const entry of entries){
    const full=path.join(mediaTmpDir,entry.name);
    let st;try{st=await fs.lstat(full)}catch{continue}
    if(now-st.mtimeMs<maxAgeMs)continue;
    await fs.rm(full,{recursive:true,force:true}).catch(()=>{});
  }
}
async function mediaToFile(c,m,name,cacheKey=''){
  await fs.mkdir(mediaTmpDir,{recursive:true});
  const safe=String(name||`package-${m.id}.apk`).replace(/[^A-Za-z0-9._ -]+/g,'_').slice(-160)||`package-${m.id}.apk`;
  const tag=String(cacheKey||m.id||'apk').replace(/[^A-Za-z0-9._-]+/g,'_').slice(-80)||String(m.id||'apk');
  const target=path.join(mediaTmpDir,`${tag}-${safe}`);
  const partial=target+'.part';
  const expected=Number(m?.document?.size||0);

  // A completed cached package can be reused by the WhatsApp mirror.
  try{
    const existing=await fs.stat(target);
    if(existing.isFile()&&existing.size>0&&(!expected||existing.size===expected)){
      const now=new Date();
      await fs.utimes(target,now,now).catch(()=>{});
      return {file:target,size:existing.size,cleanup:async()=>{await fs.rm(target,{force:true}).catch(()=>{});}};
    }
    // Never treat a truncated APK as complete.
    if(existing.isFile()&&expected&&existing.size<expected){
      await fs.rm(partial,{force:true}).catch(()=>{});
      await fs.rename(target,partial);
    }else if(existing.isFile()&&expected&&existing.size>expected){
      await fs.rm(target,{force:true}).catch(()=>{});
    }
  }catch{}

  try{
    if(m?.document){
      const location=documentLocation(m);
      if(!location)throw new Error('document location unavailable');

      let offset=0;
      try{
        const ps=await fs.stat(partial);
        if(ps.isFile())offset=ps.size;
      }catch{}
      if(expected&&offset>expected){
        await fs.rm(partial,{force:true});
        offset=0;
      }

      // Resume interrupted large downloads instead of restarting multi-GB APKs.
      if(!expected||offset<expected){
        const fh=await fs.open(partial,'a');
        try{
          const remaining=expected?expected-offset:undefined;
          let appended=0;
          for await(const chunk of c.iterDownload(location,{
            offset,
            ...(remaining?{limit:remaining}:{}),
            requestSize:512*1024,
            dcId:Number(m.document?.dcId||0)||undefined,
            requestTimeout:120000
          })){
            let data=chunk;
            if(remaining){
              const left=remaining-appended;
              if(left<=0)break;
              if(data.length>left)data=data.subarray(0,left);
            }
            if(data.length){
              await fh.write(data);
              appended+=data.length;
            }
            if(remaining&&appended>=remaining)break;
          }
        }finally{
          await fh.close();
        }
      }
    }else{
      await fs.rm(partial,{force:true}).catch(()=>{});
      const out=await c.downloadMedia(m.media,{outputFile:partial,workers:1});
      if(typeof out==='string'&&out&&out!==partial){
        await fs.rm(partial,{force:true}).catch(()=>{});
        await fs.rename(out,partial);
      }
    }

    const st=await fs.stat(partial);
    if(!st.isFile()||st.size<=0)throw new Error('media download produced an empty file');
    if(expected&&st.size!==expected)throw new Error(`APK download incomplete: ${st.size}/${expected}`);
    await fs.rm(target,{force:true}).catch(()=>{});
    await fs.rename(partial,target);
    const ready=await fs.stat(target);
    return {file:target,size:ready.size,cleanup:async()=>{await fs.rm(target,{force:true}).catch(()=>{});}};
  }catch(error){
    // Keep a valid partial file so the next retry can continue where it stopped.
    throw error;
  }
}

async function enqueueCrossPlatformMirror(body){
  try{
    const r=await fetch(interrouteUrl+'/events',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(15000)
    });
    const out=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error('interroute '+r.status+': '+String(out?.error||'enqueue failed'));
    return out;
  }catch(error){
    warn('cross-platform mirror enqueue failed',String(error?.message||error).slice(0,240));
    return null;
  }
}
function mirrorButtons(u){
  return u?[{text:'Download Fast',url:u}]:[];
}
function packageMime(name='',reported=''){
  const n=String(name).toLowerCase();
  if(n.endsWith('.apk')) return 'application/vnd.android.package-archive';
  if(n.endsWith('.xapk')||n.endsWith('.apks')||n.endsWith('.apkm')) return 'application/zip';
  return String(reported||'application/octet-stream');
}
async function mirrorDescriptor(m,sourceKind,sent){
  const u=chooseUrl(m),text=clean(m,sourceKind,u);
  const photos=Array.isArray(sent?.photo)?sent.photo:[];
  const last=photos.length?photos[photos.length-1]:null;
  const media=last?.file_id?[{type:'photo',fileId:last.file_id,fileName:'nextech-'+String(m.id)+'.jpg'}]:[];
  return enqueueCrossPlatformMirror({
    ownerDomain:'system',
    idempotencyKey:'nextech-mirror:descriptor:'+sourceKind+':'+String(m.id)+':v1',
    source:{platform:'telegram',name:'thenexusorigin',messageId:String(sent?.message_id||m.id),accountRole:'system-apk-worker'},
    content:{text,media,buttons:mirrorButtons(u)},
    routes:[{platform:'facebook',pageId:nexusTechFacebookPageId}]
  });
}
async function mirrorApk(m,sourceKind,sent,linked,mirrorVersion='v1'){
  const u=chooseUrl(m),name=filename(m)||('package-'+String(m.id)+'.apk');
  const text=linked?name:clean(m,sourceKind,u);
  const fileId=String(sent?.document?.file_id||'');
  const localPath=String(sent?.__nexLocalPath||'');
  const media=(fileId||localPath)?[{type:'document',fileId,localPath,fileName:name,mimetype:packageMime(name,m.document?.mimeType)}]:[];
  if(!media.length)throw new Error('APK mirror media reference missing; refusing filename-only publication');
  return enqueueCrossPlatformMirror({
    ownerDomain:'system',
    idempotencyKey:'nextech-mirror:apk:'+sourceKind+':'+String(m.id)+':'+mirrorVersion,
    source:{platform:'telegram',name:'thenexusorigin',messageId:String(sent?.message_id||m.id),accountRole:'system-apk-worker'},
    content:{text,media,buttons:mirrorButtons(u)},
    routes:[{platform:'whatsapp'}]
  });
}


function telegramButtons(m){
  const rows=Array.isArray(m?.replyMarkup?.rows)?m.replyMarkup.rows:[];
  const out=[];
  for(const row of rows){
    for(const button of (Array.isArray(row?.buttons)?row.buttons:[])){
      const url=String(button?.url||'').trim();
      if(!/^https?:\/\//i.test(url))continue;
      out.push({text:String(button?.text||'Ouvrir').trim().slice(0,64),url});
    }
  }
  return out.slice(0,12);
}
function telegramDocumentName(m){
  const attrs=Array.isArray(m?.document?.attributes)?m.document.attributes:[];
  const named=attrs.find(x=>typeof x?.fileName==='string'&&x.fileName.trim());
  if(named?.fileName)return String(named.fileName).slice(0,255);
  const mime=String(m?.document?.mimeType||'').toLowerCase();
  const ext=mime==='application/vnd.android.package-archive'?'.apk':
    mime==='application/zip'?'.zip':
    mime.startsWith('video/')?'.mp4':
    mime.startsWith('audio/')?'.mp3':
    mime==='image/gif'?'.gif':'';
  return 'telegram-'+String(m?.id||Date.now())+ext;
}
function telegramDocumentType(m){
  const mime=String(m?.document?.mimeType||'').toLowerCase();
  if(mime.startsWith('video/'))return mime==='image/gif'?'animation':'video';
  if(mime.startsWith('audio/'))return 'audio';
  if(mime==='image/gif')return 'animation';
  if(mime.startsWith('image/'))return 'photo';
  return 'document';
}
async function mirrorChannelMedia(c,m){
  await fs.mkdir(nextechMirrorTmpDir,{recursive:true});
  if(m?.photo){
    const target=path.join(nextechMirrorTmpDir,'nextech-'+String(m.id)+'.jpg');
    const out=await c.downloadMedia(m.media,{outputFile:target,workers:1});
    const file=typeof out==='string'&&out?out:target;
    const st=await fs.stat(file);
    if(!st.isFile()||st.size<=0)throw new Error('nextech mirror photo download empty');
    return [{type:'photo',localPath:file,fileName:path.basename(file),mimetype:'image/jpeg'}];
  }
  if(m?.document){
    const name=telegramDocumentName(m);
    const target=path.join(nextechMirrorTmpDir,String(m.id)+'-'+name.replace(/[^A-Za-z0-9._-]+/g,'_'));
    const out=await downloadDocument(c,m,target);
    const file=typeof out==='string'&&out?out:target;
    const st=await fs.stat(file);
    if(!st.isFile()||st.size<=0)throw new Error('nextech mirror document download empty');
    return [{type:telegramDocumentType(m),localPath:file,fileName:name,mimetype:String(m.document?.mimeType||'application/octet-stream')}];
  }
  return [];
}
async function cleanupNextechMirrorTmp(){
  let entries=[];
  try{entries=await fs.readdir(nextechMirrorTmpDir,{withFileTypes:true});}catch{return;}
  const cutoff=Date.now()-nextechMirrorRetentionMs;
  for(const entry of entries){
    if(!entry.isFile())continue;
    const file=path.join(nextechMirrorTmpDir,entry.name);
    try{
      const st=await fs.stat(file);
      if(st.mtimeMs<cutoff)await fs.unlink(file);
    }catch{}
  }
}
async function mirrorNextechChannelMessage(c,m){
  const id=Number(m?.id||0);
  if(!id)return true;
  if(m?.action)return true;
  const text=String(m?.message||'').trim();
  const buttons=telegramButtons(m);
  const media=await mirrorChannelMedia(c,m);
  if(!text&&!buttons.length&&!media.length)return true;
  const out=await enqueueCrossPlatformMirror({
    ownerDomain:'system',
    idempotencyKey:'nextech-channel:'+String(id)+':v1',
    source:{platform:'telegram',name:'thenexusorigin',messageId:String(id),accountRole:'system-channel-mirror'},
    content:{text,media,buttons},
    routes:[{platform:'facebook',pageId:nexusTechFacebookPageId},{platform:'whatsapp'}]
  });
  return Boolean(out);
}
async function pollNextechChannelMirror(c,entity,st,{bootstrap=false}={}){
  st.nextechWhatsappMirror=st.nextechWhatsappMirror||{cursor:0,lastSuccessAt:0,lastError:null};
  const ms=st.nextechWhatsappMirror;
  if(!Number(ms.cursor||0)){
    const latest=await c.getMessages(entity,{limit:1});
    const newest=Array.isArray(latest)&&latest.length?Number(latest[0]?.id||0):0;
    if(newest){
      ms.cursor=newest;
      ms.lastSuccessAt=Date.now();
      ms.lastError=null;
      await save(st);
      log('Nextech WhatsApp mirror armed at message',newest);
    }
    return;
  }
  const fresh=await c.getMessages(entity,{limit:100,minId:Number(ms.cursor||0)});
  const list=(fresh||[]).filter(x=>Number(x?.id||0)>Number(ms.cursor||0)).sort((a,b)=>Number(a.id)-Number(b.id));
  for(const m of list){
    try{
      const ok=await mirrorNextechChannelMessage(c,m);
      if(!ok)throw new Error('interroute enqueue unavailable');
      ms.cursor=Number(m.id);
      ms.lastSuccessAt=Date.now();
      ms.lastError=null;
      await save(st);
      log('Nextech -> WhatsApp queued','#'+m.id);
    }catch(error){
      ms.lastError=String(error?.message||error).slice(0,300);
      ms.lastErrorAt=Date.now();
      await save(st);
      warn('Nextech -> WhatsApp mirror failed','#'+String(m?.id||'?'),ms.lastError);
      break;
    }
  }
  if(bootstrap&&list.length)log('Nextech WhatsApp mirror bootstrap processed',list.length);
}

async function postDescriptor(c,m,sourceKind){
  const u=chooseUrl(m),text=clean(m,sourceKind,u),kb=markup(u);
  if(m.photo){
    const b=await media(c,m);
    return bot('sendPhoto',{chat_id:`@${dst}`,caption:text.slice(0,1024),reply_markup:kb},{field:'photo',buf:b,name:`source-${m.id}.jpg`,mime:'image/jpeg'});
  }
  if(text||kb)return bot('sendMessage',{chat_id:`@${dst}`,text:text||'Download',reply_markup:kb,disable_web_page_preview:true});
}
async function postApk(c,publisher,dstEntity,m,sourceKind,linked,item){
  const name=filename(m)||`package-${m.id}.apk`;
  const u=chooseUrl(m);
  const text=clean(m,sourceKind,u);
  const kb=markup(u);
  const doc=m.document||m?.media?.document;
  if(serverCopyEnabled&&doc?.id&&doc?.accessHash){
    try{
      const input=new Api.InputDocument({id:doc.id,accessHash:doc.accessHash,fileReference:doc.fileReference||Buffer.alloc(0)});
      const peer=await publisher.getInputEntity(dstEntity);
      const randomId=BigInt.asIntN(64,(BigInt(Date.now())<<16n)|BigInt(Math.floor(Math.random()*65536)));
      let replyMarkup;
      if(!linked&&u){
        replyMarkup=new Api.ReplyInlineMarkup({rows:[new Api.KeyboardButtonRow({buttons:[new Api.KeyboardButtonUrl({text:'Download Fast ⬇️',url:u})]})]});
      }
      return await publisher.invoke(new Api.messages.SendMedia({
        peer,
        media:new Api.InputMediaDocument({id:input}),
        message:linked?'':text.slice(0,1024),
        randomId,
        replyMarkup
      }));
    }catch(e){warn('server-side document copy failed; falling back',e?.message||e);}
  }
  const size=Number(m.document?.size||0);
  if(size&&size<=Math.min(botLimit,whatsappDirectFileLimit)){
    const b=await withTimeout(media(c,m),smallDownloadTimeoutMs,'small APK download');
    return bot('sendDocument',{
      chat_id:`@${dst}`,
      caption:linked?'':text.slice(0,1024),
      reply_markup:linked?undefined:kb
    },{field:'document',buf:b,name,mime:m.document?.mimeType||'application/vnd.android.package-archive'});
  }
  if(!linked&&u&&(text||kb))await bot('sendMessage',{chat_id:`@${dst}`,text:text||name,reply_markup:kb,disable_web_page_preview:true});
  const tmp=await withTimeout(mediaToFile(c,m,name,item?.key||String(m.id||'')),largeDownloadTimeoutMs,'large APK download');
  const result=await withTimeout(
    publisher.sendFile(dstEntity,{file:new CustomFile(name,tmp.size,tmp.file),caption:linked||u?'':text.slice(0,1024),forceDocument:true,workers:1}),
    largeUploadTimeoutMs,
    'large APK upload'
  );
  // Keep the downloaded APK in the shared temp area long enough for the
  // WhatsApp publisher to stream the exact same file. Cleanup is handled by
  // the watcher's retention sweep after the mirror has had time to retry.
  return {__nexTelegramResult:result,__nexLocalPath:tmp.file,__nexLocalSize:tmp.size};
}

async function load(){
  try{
    const x=JSON.parse(await fs.readFile(stateFile,'utf8'));
    x.sources=x.sources||{};
    x.queue=Array.isArray(x.queue)?x.queue:[];
    x.deadLetter=Array.isArray(x.deadLetter)?x.deadLetter:[];
    // Retry items that only failed under the old too-short transfer limits.
    for(const item of x.queue){
      if(/(?:small|large) APK download timeout after (?:120000|180000)ms/i.test(String(item.lastError||''))){
        item.retries=0;item.nextRetryAt=0;item.lastError='';
      }
    }
    return x;
  }catch{return {version:2,sources:{},queue:[]};}
}
let saveChain=Promise.resolve();
async function save(s){
  saveChain=saveChain.then(async()=>{
    await fs.mkdir(path.dirname(stateFile),{recursive:true});
    const tmp=stateFile+'.tmp-'+process.pid;
    await fs.writeFile(tmp,JSON.stringify({...s,version:2,updatedAt:new Date().toISOString()}));
    await fs.rename(tmp,stateFile);
  });
  return saveChain;
}

async function resolveSources(c){
  const dialogs=[];
  for await(const d of c.iterDialogs({limit:500,archived:false}))dialogs.push(d);
  try{for await(const d of c.iterDialogs({limit:500,archived:true}))dialogs.push(d);}catch{}
  const out=new Map();
  for(const spec of sourceSpecs){
    if(spec.username){
      try{out.set(spec.key,{...spec,entity:await c.getEntity(spec.username)});continue;}catch(e){warn('username source resolve failed',spec.key,e?.message||e);}
    }
    const match=dialogs.find(d=>{
      const id=String(d?.id??'');
      const title=String(d?.title||'');
      return (spec.dialogId&&id===spec.dialogId)||(spec.titleMatch&&spec.titleMatch.test(title));
    });
    if(match?.entity)out.set(spec.key,{...spec,entity:match.entity,title:String(match.title||spec.key)});
    else warn('source unavailable',spec.key,spec.dialogId||'');
  }
  return out;
}

function apkFingerprint(m){
  if(!isApk(m))return '';
  const n=norm(filename(m));
  const size=Number(m?.document?.size||0);
  return n? n+'|'+String(size||0) : '';
}
async function recoverMissedApks(c,destinationEntity,st,sources){
  const cutoff=Date.now()-apkRecoveryHours*60*60*1000;
  const destRows=await withTimeout(
    c.getMessages(destinationEntity,{limit:destinationRecoveryLimit}),
    Math.max(opTimeoutMs,60000),
    'APK recovery destination scan'
  );
  const published=new Set((destRows||[]).map(apkFingerprint).filter(Boolean));
  let queued=0;
  for(const [key,source] of sources){
    try{
      const recent=await withTimeout(
        c.getMessages(source.entity,{limit:apkRecoveryLimit}),
        Math.max(opTimeoutMs,60000),
        key+' APK recovery scan'
      );
      for(const m of [...(recent||[])].sort((a,b)=>Number(a.id)-Number(b.id))){
        const id=Number(m?.id||0);
        const dateMs=Number(m?.date||0)*1000;
        if(!id||!isApk(m)||(dateMs&&dateMs<cutoff))continue;
        const fp=apkFingerprint(m);
        if(fp&&published.has(fp))continue;
        const qk=queueKey(key,id);
        const alreadyDone=(st.deadLetter||[]).some(x=>x.key===qk&&x.reason==='published');
        if(isQueued(st,key,id)||alreadyDone)continue;
        st.queue.push({
          key:qk,
          source:key,
          id,
          addedAt:Date.now(),
          retries:0,
          nextRetryAt:0,
          recovered:true
        });
        queued++;
      }
    }catch(error){
      warn('APK recovery scan failed; source continues normally',key,String(error?.message||error));
    }
  }
  if(queued){
    await save(st);
    log('recovery queued',queued,'missed APK(s) from last',apkRecoveryHours,'hour(s)');
  }else{
    log('recovery found no missing APKs in last',apkRecoveryHours,'hour(s)');
  }
}

function ensureSourceState(st,key){
  st.sources[key]=st.sources[key]||{cursor:0,descriptors:[]};
  st.sources[key].descriptors=Array.isArray(st.sources[key].descriptors)?st.sources[key].descriptors:[];
  return st.sources[key];
}
function queueKey(sourceKey,id){return sourceKey+':'+id;}
function isQueued(st,sourceKey,id){const k=queueKey(sourceKey,id);return st.queue.some(x=>x.key===k);}

function publicationState(st){
  st.publication=st.publication||{};
  st.publication.lastBatchAt=Number(st.publication.lastBatchAt||0);
  const open=st.publication.openBatch;
  if(open&&Number(open.expiresAt||0)<=Date.now())st.publication.openBatch=null;
  return st.publication;
}
function nextPublicationAt(st){
  return Number(publicationState(st).lastBatchAt||0)+publicationGapMs;
}
function isOpenBatchCompanion(st,item,descriptor){
  const open=publicationState(st).openBatch;
  if(!open||!descriptor)return false;
  return open.source===item.source
    && Number(open.descriptorId)===Number(descriptor.id)
    && Number(open.expiresAt||0)>Date.now();
}
function markBatchStart(st,{source,descriptorId=null}={}){
  const ps=publicationState(st);
  const now=Date.now();
  ps.lastBatchAt=now;
  ps.openBatch=descriptorId?{
    source,
    descriptorId:Number(descriptorId),
    startedAt:now,
    expiresAt:now+linkedBatchWindowMs
  }:null;
}
function closeOpenBatch(st){
  publicationState(st).openBatch=null;
}

const queueMessageCache=new Map();
async function queueMessage(c,source,st,item){
  const wantedKey=queueKey(item.source,Number(item.id));
  if(queueMessageCache.has(wantedKey))return queueMessageCache.get(wantedKey);
  const ids=[Number(item.id),...(st.queue||[]).filter(x=>x.source===item.source).map(x=>Number(x.id))]
    .filter((id,index,array)=>id>0&&array.indexOf(id)===index)
    .slice(0,50);
  const rows=await withTimeout(c.getMessages(source.entity,{ids}),Math.max(opTimeoutMs,60000),item.source+' queue batch fetch');
  const returned=new Set();
  for(const row of rows||[]){
    const id=Number(row?.id||0);
    if(!id)continue;
    returned.add(id);
    queueMessageCache.set(queueKey(item.source,id),row);
  }
  for(const id of ids)if(!returned.has(id))queueMessageCache.set(queueKey(item.source,id),null);
  return queueMessageCache.get(wantedKey)||null;
}

function isTlDecodeError(error){
  return /Constructor ID|TLObject/i.test(String(error?.message||error||''));
}
async function fetchSourceSince(c,source,key,cursor){
  try{
    const fresh=await withTimeout(c.getMessages(source.entity,{limit:maxFetch,minId:Number(cursor||0)}),opTimeoutMs,key+' bulk fetch');
    return {messages:fresh||[],scannedThrough:0,fallback:false};
  }catch(error){
    if(!isTlDecodeError(error))throw error;
    warn('bulk decode failed; isolating source messages',key,String(error?.message||error));
    const latestRows=await withTimeout(c.getMessages(source.entity,{limit:1}),opTimeoutMs,key+' latest');
    const latest=Number(latestRows?.[0]?.id||0);
    if(!latest||latest<=Number(cursor||0))return {messages:[],scannedThrough:Number(cursor||0),fallback:true};
    const start=Math.max(Number(cursor||0)+1,latest-maxFetch+1);
    const out=[];
    for(let id=start;id<=latest;id++){
      try{
        const rows=await withTimeout(c.getMessages(source.entity,{ids:[id]}),opTimeoutMs,key+' message '+id);
        const m=rows?.[0];
        if(m&&Number(m.id)>Number(cursor||0))out.push(m);
      }catch(one){
        warn('skipping undecodable source message',key,'#'+id,String(one?.message||one));
      }
    }
    return {messages:out,scannedThrough:latest,fallback:true};
  }
}
async function discover(c,st,sources){
  let changed=false;
  for(const [key,source] of sources){
    const ss=ensureSourceState(st,key);
    try{
      if(!ss.cursor){
        const recent=await withTimeout(c.getMessages(source.entity,{limit:bootstrapLimit}),opTimeoutMs,key+' bootstrap');
        const cutoff=Date.now()-bootstrapHours*60*60*1000;
        const list=[...recent].filter(m=>{const d=Number(m?.date||0);return !d||d*1000>=cutoff;}).sort((a,b)=>Number(a.id)-Number(b.id));
        for(const m of list){
          const id=Number(m.id);
          if(id&&!isQueued(st,key,id))st.queue.push({key:queueKey(key,id),source:key,id,addedAt:Date.now(),retries:0,nextRetryAt:0});
          ss.cursor=Math.max(Number(ss.cursor||0),id||0);
        }
        log('bootstrapped',key,list.length,'message(s) through',ss.cursor);
        changed=true;
        continue;
      }
      const before=Number(ss.cursor||0);
      const batch=await fetchSourceSince(c,source,key,before);
      const list=(batch.messages||[]).filter(m=>Number(m.id)>before).sort((a,b)=>Number(a.id)-Number(b.id));
      for(const m of list){
        const id=Number(m.id);
        if(!isQueued(st,key,id)){
          st.queue.push({key:queueKey(key,id),source:key,id,addedAt:Date.now(),retries:0,nextRetryAt:0});
          changed=true;
        }
        ss.cursor=Math.max(Number(ss.cursor||0),id);
      }
      if(batch.scannedThrough&&Number(batch.scannedThrough)>Number(ss.cursor||0)){
        ss.cursor=Number(batch.scannedThrough);
        changed=true;
      }
      if(list.length||batch.fallback)log('discovered',list.length,'new message(s) from',key,'through',ss.cursor,batch.fallback?'fallback':'bulk');
    }catch(error){
      warn('source scan failed; other sources continue',key,String(error?.message||error));
    }
  }
  if(changed)await save(st);
}

function bestDescriptor(ss,m){
  const messageId=Number(m?.id||0);
  const haystack=norm(filename(m)+' '+String(m?.message||''));
  const apkVersion=version(filename(m)+' '+String(m?.message||''));
  const candidates=(ss.descriptors||[])
    .filter(d=>!d.used&&Number(d.id)>0&&Number(d.id)<messageId&&messageId-Number(d.id)<=3)
    .map(d=>{
      const words=norm(d.title).split(' ').filter(x=>x.length>2);
      const hits=words.filter(x=>haystack.includes(x)).length;
      const versionMatch=!!(d.version&&apkVersion&&d.version===apkVersion);
      const titleMatch=hits>=Math.min(2,Math.max(1,words.length));
      const score=(versionMatch?10:0)+(titleMatch?6:0)+hits-(messageId-Number(d.id));
      return {d,versionMatch,titleMatch,score};
    })
    .filter(x=>(x.versionMatch&&x.titleMatch)||x.titleMatch);
  candidates.sort((a,b)=>b.score-a.score||Number(b.d.id)-Number(a.d.id));
  if(!candidates.length)return null;
  if(candidates.length>1&&candidates[0].score===candidates[1].score)return null;
  return candidates[0].d;
}
function pruneDescriptors(ss){
  const cutoff=Date.now()-30*60*1000;
  ss.descriptors=(ss.descriptors||[]).filter(d=>Number(d.at||0)>=cutoff).slice(-40);
}

async function processItem(c,publisher,destination,st,sources,item){
  const source=sources.get(item.source);
  if(!source)throw new Error('source unavailable: '+item.source);
  const ss=ensureSourceState(st,item.source);
  const m=await queueMessage(c,source,st,item);
  if(!m)return {done:true,reason:'source-message-missing'};
  if(m?.noforwards||source.entity?.noforwards)return {done:true,reason:'protected'};

  if(isApk(m)){
    const linked=bestDescriptor(ss,m);

    // Recovery-only jobs repair a WhatsApp mirror without duplicating the APK
    // in the Telegram Nextech channel. They reuse/resume the local package and
    // enqueue a fresh mirror idempotency version.
    if(item.whatsappRecoveryOnly){
      const name=filename(m)||`package-${m.id}.apk`;
      const tmp=await withTimeout(
        mediaToFile(c,m,name,item.key||String(m.id||'')),
        largeDownloadTimeoutMs,
        'WhatsApp APK recovery download'
      );
      await mirrorApk(
        m,
        source.kind,
        {__nexLocalPath:tmp.file,__nexLocalSize:tmp.size},
        Boolean(linked),
        String(item.mirrorVersion||'v2')
      );
      return {done:true,reason:'whatsapp-apk-recovery'};
    }

    const companion=isOpenBatchCompanion(st,item,linked);
    if(!companion){
      const nextAt=nextPublicationAt(st);
      if(Date.now()<nextAt)return {done:false,deferUntil:nextAt,reason:'publication-gap'};
    }

    const sent=await postApk(c,publisher,destination,m,source.kind,!!linked,item);
    await mirrorApk(m,source.kind,sent,!!linked);
    if(linked)linked.used=true;
    pruneDescriptors(ss);

    if(companion)closeOpenBatch(st);
    else markBatchStart(st,{source:item.source});

    return {done:true,reason:linked?'apk-linked':'apk-standalone'};
  }

  if(isDescriptor(m)){
    const nextAt=nextPublicationAt(st);
    if(Date.now()<nextAt)return {done:false,deferUntil:nextAt,reason:'publication-gap'};

    const sent=await postDescriptor(c,m,source.kind);
    await mirrorDescriptor(m,source.kind,sent);
    ss.descriptors.push({
      id:Number(m.id),
      title:title(m.message||''),
      version:version(m.message||''),
      at:Date.now(),
      used:false
    });
    pruneDescriptors(ss);
    markBatchStart(st,{source:item.source,descriptorId:Number(m.id)});
    return {done:true,reason:'descriptor-batch-start'};
  }

  return {done:true,reason:'ignored'};
}


const processing=new Set();
const processingSources=new Set();
// One publisher worker guarantees that unrelated batches cannot claim the same slot.
const workerLimit=1;

function transientFailureInfo(error){
  const message=String(error?.errorMessage||error?.message||error||'');
  const fileReferenceExpired=/FILE_REFERENCE_EXPIRED|file reference[^\n]*expired|must be refreshed/i.test(message);
  const flood=message.match(/FLOOD_WAIT_(\d+)/i)||message.match(/Please wait\s+(\d+)\s+seconds/i);
  const network=/\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|connection closed|connection reset|TIMEOUT)\b/i.test(message);
  const telegramTemporary=/\b(?:RPC_CALL_FAIL|INTERNAL_SERVER_ERROR|MSG_WAIT_FAILED|WORKER_BUSY_TOO_LONG|publisher MTProto cooldown)\b/i.test(message);
  const transient=fileReferenceExpired||!!flood||network||telegramTemporary||/\btimeout after \d+ms\b/i.test(message);
  const delayMs=flood
    ? (Math.max(1,Number(flood[1]||0))+5)*1000
    : fileReferenceExpired ? 3000
    : 15000;
  return {message,fileReferenceExpired,transient,delayMs};
}
function clearSourceMessageCache(sourceKey){
  const prefix=String(sourceKey)+':';
  for(const key of queueMessageCache.keys())if(key.startsWith(prefix))queueMessageCache.delete(key);
}

async function handleQueueItem(c,publisher,destination,st,sources,item){
  try{
    const result=await processItem(c,publisher,destination,st,sources,item);
    if(result?.done===false&&Number(result.deferUntil||0)>Date.now()){
      item.nextRetryAt=Number(result.deferUntil);
      item.lastError='';
      await save(st);
      log('deferred',item.key,result.reason,'until',new Date(item.nextRetryAt).toISOString());
      return;
    }
    st.queue=st.queue.filter(x=>x.key!==item.key);
    await save(st);
    log('processed',item.key,result.reason,'queue',st.queue.length,'active',processing.size);
  }catch(e){
    const failure=transientFailureInfo(e);
    item.lastError=failure.message.slice(0,300);
    item.lastAttemptAt=Date.now();
    if(failure.transient){
      if(failure.fileReferenceExpired)clearSourceMessageCache(item.source);
      item.transientFailures=Number(item.transientFailures||0)+1;
      item.nextRetryAt=Date.now()+failure.delayMs;
      await save(st);
      warn('transient failure; retry preserved',item.key,'attempt',item.transientFailures,item.lastError);
    }else{
      item.retries=Number(item.retries||0)+1;
      if(item.retries>=8){
        st.deadLetter=Array.isArray(st.deadLetter)?st.deadLetter:[];
        st.deadLetter.push({...item,deadLetterAt:Date.now()});
        st.deadLetter=st.deadLetter.slice(-200);
        st.queue=st.queue.filter(x=>x.key!==item.key);
        await save(st);
        warn('message quarantined after repeated permanent failures',item.key,'retries',item.retries,item.lastError);
      }else{
        item.nextRetryAt=Date.now()+Math.min(5*60*1000,Math.max(5000,5000*Math.pow(2,Math.min(item.retries-1,6))));
        await save(st);
        warn('message failed; queued for retry',item.key,'retry',item.retries,item.lastError);
      }
    }
  }finally{
    processing.delete(item.key);
    processingSources.delete(item.source);
  }
}

function kickWorkers(c,publisher,destination,st,sources){
  if(processing.size>=workerLimit)return;
  const open=publicationState(st).openBatch;
  const priority=item=>open
    && item.source===open.source
    && Number(item.id)>Number(open.descriptorId)
    && Number(item.id)-Number(open.descriptorId)<=3 ? 0 : 1;
  const ready=[...st.queue]
    .filter(item=>!processing.has(item.key)&&!processingSources.has(item.source)&&Number(item.nextRetryAt||0)<=Date.now())
    .sort((a,b)=>priority(a)-priority(b)||Number(a.addedAt||0)-Number(b.addedAt||0)||Number(a.id)-Number(b.id));
  for(const item of ready){
    if(processing.size>=workerLimit)break;
    if(processingSources.has(item.source))continue;
    processing.add(item.key);
    processingSources.add(item.source);
    void handleQueueItem(c,publisher,destination,st,sources,item);
  }
}

async function run(session){
  if(!token||!apiId||!apiHash||!session)throw new Error('missing NexCanal watcher credentials');
  await cleanupMediaTmp();
  let nextMediaCleanupAt=Date.now()+mediaTmpCleanupMs;
  const c=new TelegramClient(new StringSession(session),apiId,apiHash,{
    connectionRetries:10,
    autoReconnect:true,
    floodSleepThreshold:60,
    downloadPool:{requestDeadlineMs:120000,requestRetries:8,sessions:1,maxSessions:1,inflightPerDc:1}
  });
  c.onError=async(error)=>{
    const msg=String(error?.errorMessage||error?.message||error);
    const code=String(error?.code??error?.status??'');
    const req=String(error?.request?.className||error?.request?.constructor?.name||'');
    warn('mtproto client error','code='+code,'request='+req,msg);
  };
  // Durable guard around Teleproto's exported-DC sender. Some versions retry
  // auth.ExportAuthorization immediately on FLOOD_WAIT; never let that hammer Telegram.
  if(typeof c._connectSender==='function'&&!c.__nexDcFloodGuard){
    const rawConnectSender=c._connectSender.bind(c);
    c._connectSender=async(...args)=>{
      try{return await rawConnectSender(...args);}
      catch(error){
        const msg=String(error?.errorMessage||error?.message||error);
        const match=msg.match(/FLOOD_WAIT_(\d+)/i)||msg.match(/Please wait\s+(\d+)\s+seconds/i);
        if(!match)throw error;
        const seconds=Math.max(1,Number(match[1]||0))+2;
        warn('dc authorization cooldown','dc='+String(args[1]??'?'),seconds+'s');
        await sleep(seconds*1000);
        return c._connectSender(args[0],args[1],undefined,args[3]);
      }
    };
    c.__nexDcFloodGuard=true;
  }
  await c.connect();
  if(!(await c.isUserAuthorized()))throw new Error('watcher session is not authorized');
  const me=await c.getMe();
  const scannerUsername=String(me?.username||'').replace(/^@/,'').toLowerCase();
  if(expectedScanner&&scannerUsername!==expectedScanner){
    await c.disconnect().catch(()=>{});
    throw new Error('unexpected APK scanner account @'+(scannerUsername||'unknown')+'; expected @'+expectedScanner);
  }
  let publisherClient=null;
  let publisherInit=null;
  let publisherBlockedUntil=0;
  const ensurePublisher=async()=>{
    if(publisherClient)return publisherClient;
    if(publisherInit)return publisherInit;
    if(Date.now()<publisherBlockedUntil){
      throw new Error('publisher MTProto cooldown '+Math.ceil((publisherBlockedUntil-Date.now())/1000)+'s');
    }
    publisherInit=(async()=>{
      let saved='';
      try{saved=(await fs.readFile(publisherSessionFile,'utf8')).trim();}catch{}
      const client=new TelegramClient(new StringSession(saved),apiId,apiHash,{
        connectionRetries:10,
        autoReconnect:true,
        floodSleepThreshold:60,
        downloadPool:{requestDeadlineMs:120000,requestRetries:8,sessions:1,maxSessions:1,inflightPerDc:1}
      });
      try{
        await client.connect();
        if(!(await client.isUserAuthorized()))await client.start({botAuthToken:token});
        const publisherMe=await client.getMe();
        if(publisherMe?.bot!==true)throw new Error('NexCanal publisher session is not a bot');
        const persisted=String(client.session?.save?.()||'').trim();
        if(persisted){
          await fs.mkdir(path.dirname(publisherSessionFile),{recursive:true});
          const tmp=publisherSessionFile+'.tmp-'+process.pid;
          await fs.writeFile(tmp,persisted,{mode:0o600});
          await fs.rename(tmp,publisherSessionFile);
        }
        publisherClient=client;
        log('public publisher MTProto ready as',publisherMe?.username?'@'+publisherMe.username:String(publisherMe?.id||'NexCanal'));
        return client;
      }catch(e){
        const message=String(e?.errorMessage||e?.message||e);
        const wait=message.match(/FLOOD_WAIT_(\d+)/i)||message.match(/Please wait\s+(\d+)\s+seconds/i);
        if(wait){
          const seconds=Math.max(1,Number(wait[1]||0));
          publisherBlockedUntil=Date.now()+(seconds+10)*1000;
          warn('publisher MTProto paused',seconds+'s');
        }
        await client.disconnect().catch(()=>{});
        throw e;
      }finally{publisherInit=null;}
    })();
    return publisherInit;
  };
  const publisher={
    getInputEntity:async(...args)=>(await ensurePublisher()).getInputEntity(...args),
    invoke:async(...args)=>(await ensurePublisher()).invoke(...args),
    sendFile:async(...args)=>(await ensurePublisher()).sendFile(...args),
    disconnect:async()=>{
      const client=publisherClient;publisherClient=null;
      if(client)await client.disconnect().catch(()=>{});
    }
  };
  await fs.mkdir(path.dirname(watcherIdentityFile),{recursive:true}).catch(()=>{});
  await fs.writeFile(watcherIdentityFile,String(me?.id||''),{mode:0o600}).catch(e=>warn('watcher identity file',e?.message||e));
  log('scanner connected as',me?.username?'@'+me.username:String(me?.id||'unknown'));
  log('Bot API publisher ready as @'+dst+'; MTProto publisher will initialize only for large files');
  const sources=await resolveSources(c);
  for(const spec of sourceSpecs)if(!sources.has(spec.key))warn('source unavailable at startup; isolated retry enabled',spec.key);
  const destination='@'+dst;
  const nextechEntity=await c.getEntity(destination);
  const st=await load();
  const es=engagementState(st);
  es.owner='nexcanal-watcher';
  es.ownerCheckedAt=Date.now();
  await save(st);
  let engagementRunning=false;
  const runEngagement=async(force=false)=>{
    if(engagementRunning)return;
    engagementRunning=true;
    try{
      await withTimeout(joinEngagementTargets(c,st,{force}),15000,'engagement join');
      await withTimeout(pollEngagementReactions(c,st),15000,'engagement reactions');
    }catch(e){warn('engagement cycle failed',e?.message||e);}
    finally{engagementRunning=false;}
  };
  void runEngagement(true);
  let nextEngagementAt=Date.now()+engagementPollMs;
  let nextSourceResolveAt=Date.now()+sourceResolveRetryMs;
  let nextHeartbeatAt=0;

  // Migrate the old LiteAPK cursor if this is the first v2 run.
  try{
    const oldPath=process.env.NEXCANAL__WATCHER_OLD_STATE_FILE||'/home/container/.nexcontrol/nexcanal-liteapks-state.json';
    if(!st.sources?.liteapks?.cursor){
      const old=JSON.parse(await fs.readFile(oldPath,'utf8'));
      if(Number(old?.lastMessageId)>0)ensureSourceState(st,'liteapks').cursor=Number(old.lastMessageId);
    }
  }catch{}

  try{
    await recoverMissedApks(c,nextechEntity,st,sources);
    kickWorkers(c,publisher,destination,st,sources);
    await withTimeout(pollNextechChannelMirror(c,nextechEntity,st,{bootstrap:true}),opTimeoutMs,'initial Nextech WhatsApp mirror');
    await withTimeout(discover(c,st,sources),opTimeoutMs,'initial source discovery');
  }catch(e){
    await publisher.disconnect().catch(()=>{});
    await c.disconnect().catch(()=>{});
    throw e;
  }
  log('watching', [...sources.keys()].join(', '),'-> @'+dst,'poll',poll+'ms');

  while(true){
    const live=await sessionSecret();
    if(!live)throw new Error('reader session disconnected');
    try{
      if(Date.now()>=nextSourceResolveAt){
        nextSourceResolveAt=Date.now()+sourceResolveRetryMs;
        const refreshed=await withTimeout(resolveSources(c),opTimeoutMs,'source re-resolution');
        for(const [key,source] of refreshed)sources.set(key,source);
        for(const spec of sourceSpecs)if(!sources.has(spec.key))warn('source still unavailable; other APK sources continue',spec.key);
      }
      await withTimeout(discover(c,st,sources),opTimeoutMs,'source discovery');
      await withTimeout(pollNextechChannelMirror(c,nextechEntity,st),opTimeoutMs,'Nextech WhatsApp mirror');
      kickWorkers(c,publisher,destination,st,sources);
      if(Date.now()>=nextHeartbeatAt){
        nextHeartbeatAt=Date.now()+60_000;
        st.health={
          lastCycleAt:Date.now(),
          queueLength:Array.isArray(st.queue)?st.queue.length:0,
          deadLetterLength:Array.isArray(st.deadLetter)?st.deadLetter.length:0,
          processing:processing.size,
          lastBatchAt:Number(publicationState(st).lastBatchAt||0),
          nextPublicationAt:nextPublicationAt(st)
        };
        await save(st);
      }
      if(Date.now()>=nextMediaCleanupAt){
        nextMediaCleanupAt=Date.now()+mediaTmpCleanupMs;
        await cleanupMediaTmp().catch(e=>warn('media tmp cleanup failed',e?.message||e));
        await cleanupNextechMirrorTmp().catch(e=>warn('Nextech mirror tmp cleanup failed',e?.message||e));
      }
      if(Date.now()>=nextEngagementAt){
        nextEngagementAt=Date.now()+engagementPollMs;
        void runEngagement(false);
      }
    }catch(e){
      const message=String(e?.message||e);
      warn('cycle failed',message);
      if(/timeout/i.test(message)){await c.disconnect().catch(()=>{});throw e;}
    }
    await sleep(poll);
  }
}

let wait=5000;
for(;;){
  try{
    const session=await sessionSecret();
    if(!session){log('waiting for Telegram reader connection');await sleep(5000);continue;}
    wait=5000;
    await run(session);
  }catch(e){
    warn(e?.message||e);
    await sleep(wait);
    wait=Math.min(wait*2,60000);
  }
}
