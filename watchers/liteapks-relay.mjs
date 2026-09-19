import fs from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';

const primarySrc=(process.env.NEXCANAL__WATCHER_SOURCE||'liteapks').trim();
const dst=(process.env.NEXCANAL__WATCHER_DESTINATION||'thenexusorigin').replace(/^@/,'');
const token=(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const apiId=Number(process.env.NEXCANAL__WATCHER_API_ID||process.env.NEXGROUP__TELEGRAM_API_ID||0);
const apiHash=(process.env.NEXCANAL__WATCHER_API_HASH||process.env.NEXGROUP__TELEGRAM_API_HASH||'').trim();
const session=(process.env.NEXCANAL__WATCHER_SESSION||'').trim();
const stateFile=process.env.NEXCANAL__WATCHER_STATE_FILE||'/var/data/nexcanal-liteapks-state.json';
const poll=Math.max(5000,Number(process.env.NEXCANAL__WATCHER_POLL_MS||15000));
const botLimit=49*1024*1024;
const dlRe=/\b(download(?:\s+(?:fast|now|apk|direct))?|direct\s+download|get\s+(?:apk|app)|install\s+now)\b/i;
const fileRe=/\.(?:apk|xapk|apks|apkm|zip)$/i;
const urlRe=/https?:\/\/[^\s<>]+/gi;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...x)=>console.log('[nexcanal-watcher]',...x);
const warn=(...x)=>console.warn('[nexcanal-watcher]',...x);

const managedSources=[
  {key:'liteapks',ref:primarySrc,profile:'liteapks'},
  {key:'imadeaux',ref:(process.env.NEXCANAL__WATCHER_IMADEAUX_SOURCE||'https://t.me/+OktRwPgs8IhhMzE5').trim(),profile:'imadeaux'}
].filter((x,i,a)=>x.ref&&a.findIndex(y=>y.ref===x.ref)===i);

function filename(m){for(const a of m?.document?.attributes||[]) if(a?.fileName)return String(a.fileName);return ''}
function isApk(m){const mime=String(m?.document?.mimeType||'').toLowerCase();return !!m?.document&&(fileRe.test(filename(m))||mime.includes('android.package-archive'))}
function isDescriptor(m){const t=String(m?.message||'');return !!t.trim()&&(dlRe.test(t)||/\bformat\s*:\s*(?:apk|xapk|apks|apkm)\b/i.test(t)||/\bmod\s+info\s*:/i.test(t)||(/\btitle\s*:/i.test(t)&&/\bversion\s*:/i.test(t)))}
function version(t=''){return t.match(/(?:version|ver\.?|v)\s*[:\-]?\s*v?([0-9]+(?:\.[0-9A-Za-z]+){1,5})/i)?.[1]?.toLowerCase()||''}
function title(t=''){return t.match(/(?:^|\n)\s*[-•–—]?\s*title\s*:\s*([^\n]+)/i)?.[1]?.trim()||''}
function norm(s=''){return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function score(p,m){if(!p)return 0;const h=norm(filename(m)+' '+String(m.message||''));let s=Date.now()-p.at<45000?1:0;const words=norm(p.title).split(' ').filter(x=>x.length>2);const hits=words.filter(x=>h.includes(x)).length;if(hits>=Math.min(2,words.length)&&hits)s+=3;else if(hits)s++;const v=version(filename(m)+' '+String(m.message||''));if(p.version&&v&&p.version===v)s+=3;return s}
function chooseUrl(m){const lines=String(m?.message||'').split(/\r?\n/);for(let i=0;i<lines.length;i++){if(!dlRe.test(lines[i]))continue;const a=lines[i].match(urlRe)?.[0];if(a)return a.replace(/[),.;]+$/,'');for(let j=i+1;j<=Math.min(i+2,lines.length-1);j++){const b=lines[j].match(urlRe)?.[0];if(b)return b.replace(/[),.;]+$/,'')}}return ''}
function clean(m,u){return String(m?.message||'').split(/\r?\n/).filter(line=>!(dlRe.test(line)||(u&&line.includes(u)))).join('\n').replace(/\n{3,}/g,'\n\n').trim()}
function label(){return 'Download Fast ⬇️'}
function markup(u,m){return u?{inline_keyboard:[[{text:label(m),url:u}]]}:undefined}
function esc(s=''){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function stripSourceBranding(text=''){
  return String(text)
    .split(/\r?\n/)
    .filter(line=>!/@imadeaux\b/i.test(line)&&!/(?:https?:\/\/)?t\.me\/imadeaux\b/i.test(line)&&!/^\s*(?:𝘾𝙖𝙣𝙖𝙡|canal|channel)\s*:\s*@/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

function fallbackSpanishToEnglish(text=''){
  const exact=new Map([
    ['Anuncios eliminados','Ads removed'],
    ['Permitido tomar capturas de pantalla y grabar en toda la app','Screenshots and screen recording enabled throughout the app'],
    ['Guardar contenido en grupos y canales restringidos','Save content from restricted groups and channels'],
    ['Multimedia con temporizador de autodestrucción no se elimina','Self-destructing media is not deleted'],
    ['Descargas optimizadas','Optimized downloads'],
    ['Notificación de actualización eliminada','Update notification removed'],
    ['Cliente avanzado de Telegram con mayor personalización, potentes herramientas de organización y funciones adicionales para una experiencia más completa.','Advanced Telegram client with deeper customization, powerful organization tools, and additional features for a more complete experience.']
  ]);
  return String(text).split(/\r?\n/).map(line=>{
    const prefix=line.match(/^\s*[✅➡️📱🤖⚙️🟢]+\s*/u)?.[0]||'';
    const core=line.slice(prefix.length).trim();
    return exact.has(core)?`${prefix}${exact.get(core)}`:line;
  }).join('\n');
}

async function translateToEnglish(c,inputPeer,m,text){
  const cleaned=stripSourceBranding(text);
  if(!cleaned)return '';
  try{
    const r=await c.invoke(new Api.messages.TranslateText({peer:inputPeer,id:[Number(m.id)],toLang:'en'}));
    const translated=String(r?.result?.[0]?.text||'').trim();
    if(translated)return stripSourceBranding(translated);
  }catch(e){warn('telegram translation failed',m.id,e?.message||e)}
  return fallbackSpanishToEnglish(cleaned);
}

function formatImadeauxCaption(text=''){
  const cleanText=stripSourceBranding(text).replace(/\n{3,}/g,'\n\n').trim();
  const paras=cleanText.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
  const head=paras.slice(0,Math.min(2,paras.length)).join('\n\n');
  const body=paras.slice(Math.min(2,paras.length)).join('\n\n');
  const signature='<b>Channel: @thenexusorigin</b>';
  const headHtml=esc(head);
  let bodyPlain=body;
  const reserve=headHtml.length+signature.length+48;
  if(bodyPlain.length+reserve>1000)bodyPlain=bodyPlain.slice(0,Math.max(0,1000-reserve-1)).trimEnd()+'…';
  const quote=bodyPlain?`<blockquote expandable>${esc(bodyPlain)}</blockquote>`:'';
  return [headHtml,quote,signature].filter(Boolean).join('\n\n').slice(0,1024);
}

async function bot(method,fields,file){const endpoint=`https://api.telegram.org/bot${token}/${method}`;let r;if(file){const f=new FormData();for(const [k,v] of Object.entries(fields))if(v!==undefined&&v!==null&&v!=='')f.append(k,typeof v==='string'?v:JSON.stringify(v));f.append(file.field,new Blob([file.buf],{type:file.mime||'application/octet-stream'}),file.name);r=await fetch(endpoint,{method:'POST',body:f})}else r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields)});const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(`${method}: ${j.description||r.status}`);return j.result}
async function media(c,m){const b=await c.downloadMedia(m.media,{workers:1});if(!b)throw new Error('media download failed');return Buffer.isBuffer(b)?b:Buffer.from(b)}

async function postDescriptor(c,m){const u=chooseUrl(m),text=clean(m,u),kb=markup(u,m);if(m.photo){const b=await media(c,m);return bot('sendPhoto',{chat_id:`@${dst}`,caption:text.slice(0,1024),reply_markup:kb},{field:'photo',buf:b,name:`source-${m.id}.jpg`,mime:'image/jpeg'})}if(text||kb)return bot('sendMessage',{chat_id:`@${dst}`,text:text||'Download',reply_markup:kb,disable_web_page_preview:true})}
async function postApk(c,dstEntity,m,linked){const name=filename(m)||`package-${m.id}.apk`,size=Number(m.document?.size||0),u=chooseUrl(m),text=clean(m,u),kb=markup(u,m),b=await media(c,m);if(size&&size<=botLimit)return bot('sendDocument',{chat_id:`@${dst}`,caption:linked?'':text.slice(0,1024),reply_markup:linked?undefined:kb},{field:'document',buf:b,name,mime:m.document?.mimeType||'application/vnd.android.package-archive'});if(!linked&&u&&(text||kb))await bot('sendMessage',{chat_id:`@${dst}`,text:text||name,reply_markup:kb,disable_web_page_preview:true});return c.sendFile(dstEntity,{file:new CustomFile(name,b.length,'',b),caption:linked||u?'':text.slice(0,1024),forceDocument:true,workers:1})}
async function postImadeauxApk(c,dstEntity,sourceInput,m){
  const name=filename(m)||`package-${m.id}.apk`,size=Number(m.document?.size||0),raw=String(m.message||''),translated=await translateToEnglish(c,sourceInput,m,raw),caption=formatImadeauxCaption(translated||fallbackSpanishToEnglish(stripSourceBranding(raw))),b=await media(c,m);
  if(size&&size<=botLimit)return bot('sendDocument',{chat_id:`@${dst}`,caption,parse_mode:'HTML'},{field:'document',buf:b,name,mime:m.document?.mimeType||'application/vnd.android.package-archive'});
  return c.sendFile(dstEntity,{file:new CustomFile(name,b.length,'',b),caption,parseMode:'html',forceDocument:true,workers:1});
}
async function extraPhoto(c,m){const b=await media(c,m);return bot('sendPhoto',{chat_id:`@${dst}`},{field:'photo',buf:b,name:`source-${m.id}.jpg`,mime:'image/jpeg'})}

async function load(){try{return JSON.parse(await fs.readFile(stateFile,'utf8'))}catch{return {sources:{}}}}
async function save(s){await fs.mkdir(path.dirname(stateFile),{recursive:true});await fs.writeFile(stateFile,JSON.stringify({...s,updatedAt:new Date().toISOString()}))}
function sourceState(st,key){st.sources=st.sources||{};if(!st.sources[key])st.sources[key]={lastMessageId:key==='liteapks'?Number(st.lastMessageId||0):0};return st.sources[key]}
function inviteHash(ref=''){return String(ref).match(/(?:t\.me\/\+|t\.me\/joinchat\/)([A-Za-z0-9_-]+)/i)?.[1]||''}

async function resolveSource(c,spec){
  const hash=inviteHash(spec.ref);
  if(!hash)return c.getEntity(String(spec.ref).replace(/^@/,''));
  try{
    const checked=await c.invoke(new Api.messages.CheckChatInvite({hash}));
    if(checked?.chat)return checked.chat;
    const joined=await c.invoke(new Api.messages.ImportChatInvite({hash}));
    const chat=joined?.chats?.[0];
    if(!chat)throw new Error('invite imported but no chat returned');
    return chat;
  }catch(e){
    if(/USER_ALREADY_PARTICIPANT/i.test(String(e?.message||e))){
      const checked=await c.invoke(new Api.messages.CheckChatInvite({hash}));
      if(checked?.chat)return checked.chat;
    }
    throw e;
  }
}

async function run(){
  if(!token||!apiId||!apiHash||!session)throw new Error('missing NexCanal watcher credentials');
  const c=new TelegramClient(new StringSession(session),apiId,apiHash,{connectionRetries:10,autoReconnect:true});
  await c.connect();
  if(!(await c.isUserAuthorized()))throw new Error('watcher session is not authorized');
  const destination=await c.getEntity(dst);
  const st=await load();
  const sources=[];
  for(const spec of managedSources){
    const entity=await resolveSource(c,spec);
    const input=await c.getInputEntity(entity);
    const ss=sourceState(st,spec.key);
    if(!ss.lastMessageId){const latest=await c.getMessages(entity,{limit:1});ss.lastMessageId=Number(latest?.[0]?.id||0);log('initialized',spec.key,'at',ss.lastMessageId)}
    sources.push({...spec,entity,input,pending:null});
    log('watching',spec.key,'-> @'+dst);
  }
  await save(st);

  while(true){
    for(const source of sources){
      const ss=sourceState(st,source.key);
      try{
        const fresh=await c.getMessages(source.entity,{limit:100,minId:Number(ss.lastMessageId||0)});
        const list=fresh.filter(m=>Number(m.id)>Number(ss.lastMessageId||0)).sort((a,b)=>Number(a.id)-Number(b.id));
        for(const m of list){
          const id=Number(m.id);
          try{
            if(m?.noforwards||source.entity?.noforwards){warn(source.key,'protected message skipped',id)}
            else if(source.profile==='imadeaux'){
              if(isApk(m)){await postImadeauxApk(c,destination,source.input,m);log('relayed translated apk',source.key,id)}
              else log('ignored non-apk post',source.key,id);
            }
            else if(isApk(m)){
              const linked=!!source.pending&&Date.now()-source.pending.at<120000&&score(source.pending,m)>=2;
              await postApk(c,destination,m,linked);log('relayed file',source.key,id,linked?'linked':'standalone');if(linked)source.pending=null;
            }
            else if(isDescriptor(m)){
              const gid=m.groupedId!=null?String(m.groupedId):'';
              const group=gid?list.filter(x=>String(x.groupedId??'')===gid):[m];
              const primary=group.find(x=>String(x.message||'').trim())||m;
              if(primary.id!==m.id)continue;
              await postDescriptor(c,primary);
              for(const x of group)if(x.id!==primary.id&&x.photo)await extraPhoto(c,x);
              source.pending={id:Number(primary.id),title:title(primary.message||''),version:version(primary.message||''),at:Date.now()};
              log('relayed descriptor',source.key,primary.id);
            }
            else{source.pending=null;log('ignored non-app post',source.key,id)}
          }catch(e){warn(source.key,'message failed',id,e?.message||e)}
          finally{ss.lastMessageId=Math.max(Number(ss.lastMessageId||0),id);await save(st)}
        }
      }catch(e){warn(source.key,'poll failed',e?.message||e)}
    }
    await sleep(poll);
  }
}

let wait=15000;for(;;){try{await run()}catch(e){warn(e?.message||e);await sleep(wait);wait=Math.min(wait*2,300000)}}
