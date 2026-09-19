import fs from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';

const dst=(process.env.NEXCANAL__WATCHER_DESTINATION||'thenexusorigin').replace(/^@/,'').trim();
const token=(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const apiId=Number(process.env.NEXCANAL__WATCHER_API_ID||process.env.NEXGROUP__TELEGRAM_API_ID||0);
const apiHash=(process.env.NEXCANAL__WATCHER_API_HASH||process.env.NEXGROUP__TELEGRAM_API_HASH||'').trim();
const sessionFile=process.env.NEXCANAL__WATCHER_SESSION_FILE||'/home/container/.nexcontrol/nexcanal-reader-session.txt';
const stateFile=process.env.NEXCANAL__WATCHER_STATE_FILE||'/home/container/.nexcontrol/nexcanal-watch-state-v2.json';
const mediaTmpDir=process.env.NEXCANAL__WATCHER_MEDIA_TMP||'/home/container/.nexcontrol/nexcanal-media';
const watcherIdentityFile=process.env.NEXCANAL__WATCHER_ID_FILE||'/home/container/.nexcontrol/nexcanal-watcher-id.txt';
const poll=Math.max(1500,Number(process.env.NEXCANAL__WATCHER_POLL_MS||2500));
const botLimit=49*1024*1024;
const maxFetch=500;

const sourceSpecs=[
  {key:'liteapks',username:'liteapks',kind:'liteapks'},
  {key:'imadeaux',dialogId:'-1001918663716',titleMatch:/madeaux/i,kind:'imadeaux'}
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
      for(const m of list){
        try{
          const emoji=await reactOne(c,username,m);
          es.reactionStatus[username]={ok:true,msgId:Number(m.id),emoji,at:Date.now()};
          log('auto-react','@'+username,'#'+m.id,emoji);
        }catch(e){
          const error=String(e?.errorMessage||e?.message||e);
          es.reactionStatus[username]={ok:false,msgId:Number(m.id),error:error.slice(0,220),at:Date.now()};
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
async function media(c,m){
  const b=await c.downloadMedia(m.media,{workers:1});
  if(!b)throw new Error('media download failed');
  return Buffer.isBuffer(b)?b:Buffer.from(b);
}
async function cleanupMediaTmp(maxAgeMs=6*60*60*1000){
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
async function mediaToFile(c,m,name){
  await fs.mkdir(mediaTmpDir,{recursive:true});
  const safe=String(name||`package-${m.id}.apk`).replace(/[^A-Za-z0-9._ -]+/g,'_').slice(-180)||`package-${m.id}.apk`;
  const target=path.join(mediaTmpDir,`${m.id}-${Date.now()}-${safe}`);
  const out=await c.downloadMedia(m.media,{outputFile:target});
  const file=typeof out==='string'&&out?out:target;
  const st=await fs.stat(file);
  return {file,size:st.size,cleanup:async()=>{await fs.rm(file,{force:true}).catch(()=>{});if(file!==target)await fs.rm(target,{force:true}).catch(()=>{});}};
}
async function postDescriptor(c,m,sourceKind){
  const u=chooseUrl(m),text=clean(m,sourceKind,u),kb=markup(u);
  if(m.photo){
    const b=await media(c,m);
    return bot('sendPhoto',{chat_id:`@${dst}`,caption:text.slice(0,1024),reply_markup:kb},{field:'photo',buf:b,name:`source-${m.id}.jpg`,mime:'image/jpeg'});
  }
  if(text||kb)return bot('sendMessage',{chat_id:`@${dst}`,text:text||'Download',reply_markup:kb,disable_web_page_preview:true});
}
async function postApk(c,dstEntity,m,sourceKind,linked){
  const name=filename(m)||`package-${m.id}.apk`;
  const size=Number(m.document?.size||0);
  const u=chooseUrl(m);
  const text=clean(m,sourceKind,u);
  const kb=markup(u);
  if(size&&size<=botLimit){
    const b=await media(c,m);
    return bot('sendDocument',{
      chat_id:`@${dst}`,
      caption:linked?'':text.slice(0,1024),
      reply_markup:linked?undefined:kb
    },{field:'document',buf:b,name,mime:m.document?.mimeType||'application/vnd.android.package-archive'});
  }
  if(!linked&&u&&(text||kb))await bot('sendMessage',{chat_id:`@${dst}`,text:text||name,reply_markup:kb,disable_web_page_preview:true});
  const tmp=await mediaToFile(c,m,name);
  try{
    return await c.sendFile(dstEntity,{file:new CustomFile(name,tmp.size,tmp.file),caption:linked||u?'':text.slice(0,1024),forceDocument:true,workers:1});
  }finally{await tmp.cleanup();}
}

async function load(){
  try{
    const x=JSON.parse(await fs.readFile(stateFile,'utf8'));
    x.sources=x.sources||{};
    x.queue=Array.isArray(x.queue)?x.queue:[];
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

function ensureSourceState(st,key){
  st.sources[key]=st.sources[key]||{cursor:0,descriptors:[]};
  st.sources[key].descriptors=Array.isArray(st.sources[key].descriptors)?st.sources[key].descriptors:[];
  return st.sources[key];
}
function queueKey(sourceKey,id){return sourceKey+':'+id;}
function isQueued(st,sourceKey,id){const k=queueKey(sourceKey,id);return st.queue.some(x=>x.key===k);}

async function discover(c,st,sources){
  let changed=false;
  for(const [key,source] of sources){
    const ss=ensureSourceState(st,key);
    if(!ss.cursor){
      const latest=await c.getMessages(source.entity,{limit:1});
      ss.cursor=Number(latest?.[0]?.id||0);
      log('initialized',key,'at',ss.cursor);
      changed=true;
      continue;
    }
    const fresh=await c.getMessages(source.entity,{limit:maxFetch,minId:Number(ss.cursor||0)});
    const list=fresh.filter(m=>Number(m.id)>Number(ss.cursor||0)).sort((a,b)=>Number(a.id)-Number(b.id));
    if(!list.length)continue;
    for(const m of list){
      const id=Number(m.id);
      if(!isQueued(st,key,id)){
        st.queue.push({key:queueKey(key,id),source:key,id,addedAt:Date.now(),retries:0,nextRetryAt:0});
        changed=true;
      }
      ss.cursor=Math.max(Number(ss.cursor||0),id);
    }
    log('discovered',list.length,'new message(s) from',key,'through',ss.cursor);
  }
  if(changed)await save(st);
}

function bestDescriptor(ss,m){
  const recent=(ss.descriptors||[]).filter(d=>Date.now()-Number(d.at||0)<10*60*1000&&!d.used);
  let best=null,bestScore=0;
  for(const d of recent){
    const s=descriptorScore(d,m);
    if(s>bestScore){best=d;bestScore=s;}
  }
  return bestScore>=2?best:null;
}
function pruneDescriptors(ss){
  const cutoff=Date.now()-30*60*1000;
  ss.descriptors=(ss.descriptors||[]).filter(d=>Number(d.at||0)>=cutoff).slice(-40);
}

async function processItem(c,destination,st,sources,item){
  const source=sources.get(item.source);
  if(!source)throw new Error('source unavailable: '+item.source);
  const ss=ensureSourceState(st,item.source);
  const rows=await c.getMessages(source.entity,{ids:[Number(item.id)]});
  const m=rows?.[0];
  if(!m)return {done:true,reason:'source-message-missing'};
  if(m?.noforwards||source.entity?.noforwards)return {done:true,reason:'protected'};
  if(isApk(m)){
    const linked=bestDescriptor(ss,m);
    await postApk(c,destination,m,source.kind,!!linked);
    if(linked)linked.used=true;
    pruneDescriptors(ss);
    return {done:true,reason:linked?'apk-linked':'apk-standalone'};
  }
  if(isDescriptor(m)){
    await postDescriptor(c,m,source.kind);
    ss.descriptors.push({
      id:Number(m.id),
      title:title(m.message||''),
      version:version(m.message||''),
      at:Date.now(),
      used:false
    });
    pruneDescriptors(ss);
    return {done:true,reason:'descriptor'};
  }
  return {done:true,reason:'ignored'};
}


const processing=new Set();
const workerLimit=Math.max(1,Math.min(4,Number(process.env.NEXCANAL__WATCHER_WORKERS||3)));

async function handleQueueItem(c,destination,st,sources,item){
  try{
    const result=await processItem(c,destination,st,sources,item);
    st.queue=st.queue.filter(x=>x.key!==item.key);
    await save(st);
    log('processed',item.key,result.reason,'queue',st.queue.length,'active',processing.size);
  }catch(e){
    item.retries=Number(item.retries||0)+1;
    item.lastError=String(e?.message||e).slice(0,300);
    item.lastAttemptAt=Date.now();
    item.nextRetryAt=Date.now()+Math.min(5*60*1000,Math.max(5000,5000*Math.pow(2,Math.min(item.retries-1,6))));
    await save(st);
    warn('message failed; queued for retry',item.key,'retry',item.retries,item.lastError);
  }finally{
    processing.delete(item.key);
  }
}

function kickWorkers(c,destination,st,sources){
  if(processing.size>=workerLimit)return;
  const ready=[...st.queue]
    .filter(item=>!processing.has(item.key)&&Number(item.nextRetryAt||0)<=Date.now())
    .sort((a,b)=>Number(a.addedAt||0)-Number(b.addedAt||0)||Number(a.id)-Number(b.id));
  for(const item of ready){
    if(processing.size>=workerLimit)break;
    processing.add(item.key);
    void handleQueueItem(c,destination,st,sources,item);
  }
}

async function run(session){
  if(!token||!apiId||!apiHash||!session)throw new Error('missing NexCanal watcher credentials');
  await cleanupMediaTmp();
  const c=new TelegramClient(new StringSession(session),apiId,apiHash,{connectionRetries:10,autoReconnect:true,floodSleepThreshold:60});
  await c.connect();
  if(!(await c.isUserAuthorized()))throw new Error('watcher session is not authorized');
  const me=await c.getMe();
  await fs.mkdir(path.dirname(watcherIdentityFile),{recursive:true}).catch(()=>{});
  await fs.writeFile(watcherIdentityFile,String(me?.id||''),{mode:0o600}).catch(e=>warn('watcher identity file',e?.message||e));
  log('connected as',me?.username?'@'+me.username:String(me?.id||'unknown'));
  const sources=await resolveSources(c);
  for(const spec of sourceSpecs)if(!sources.has(spec.key))throw new Error('required source unavailable: '+spec.key);
  const destination=await c.getEntity(dst);
  const st=await load();
  const es=engagementState(st);
  es.owner='nexcanal-watcher';
  es.ownerCheckedAt=Date.now();
  await save(st);
  await joinEngagementTargets(c,st,{force:true}).catch(e=>warn('engagement join bootstrap failed',e?.message||e));
  await pollEngagementReactions(c,st).catch(e=>warn('engagement reaction bootstrap failed',e?.message||e));
  let nextEngagementAt=Date.now()+engagementPollMs;

  // Migrate the old LiteAPK cursor if this is the first v2 run.
  try{
    const oldPath=process.env.NEXCANAL__WATCHER_OLD_STATE_FILE||'/home/container/.nexcontrol/nexcanal-liteapks-state.json';
    if(!st.sources?.liteapks?.cursor){
      const old=JSON.parse(await fs.readFile(oldPath,'utf8'));
      if(Number(old?.lastMessageId)>0)ensureSourceState(st,'liteapks').cursor=Number(old.lastMessageId);
    }
  }catch{}

  await discover(c,st,sources);
  log('watching', [...sources.keys()].join(', '),'-> @'+dst,'poll',poll+'ms');

  while(true){
    const live=await sessionSecret();
    if(!live)throw new Error('reader session disconnected');
    try{
      await discover(c,st,sources);
      kickWorkers(c,destination,st,sources);
      if(Date.now()>=nextEngagementAt){
        await joinEngagementTargets(c,st).catch(e=>warn('engagement join cycle failed',e?.message||e));
        await pollEngagementReactions(c,st).catch(e=>warn('engagement reaction cycle failed',e?.message||e));
        nextEngagementAt=Date.now()+engagementPollMs;
      }
    }catch(e){warn('cycle failed',e?.message||e);}
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
