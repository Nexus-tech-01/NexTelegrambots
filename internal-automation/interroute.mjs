import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const HOST=process.env.INTERROUTE_HOST||'127.0.0.1';
const PORT=Math.max(1,Number(process.env.INTERROUTE_PORT||18130));
const DATA_DIR=process.env.INTERROUTE_DATA_DIR||'/var/lib/nex/queue/interroute';
const STATE_FILE=path.join(DATA_DIR,'state.json');
const MAX_ATTEMPTS=Math.max(2,Number(process.env.INTERROUTE_MAX_ATTEMPTS||8));
const TICK_MS=Math.max(500,Number(process.env.INTERROUTE_TICK_MS||2000));
const FACEBOOK_TIMEOUT_MS=Math.max(30000,Number(process.env.INTERROUTE_FACEBOOK_TIMEOUT_MS||120000));
const FACEBOOK_PAGE_ID=String(process.env.INTERROUTE_FACEBOOK_PAGE_ID||'106458282029367').trim();
const TG_TOKEN=String(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const META_KEY=String(process.env.NEXMETA_CONTROL_KEY||'').trim();
const BRIDGE_KEY=String(process.env.NEXCONTROL_BRIDGE_TOKEN||'').trim();
const META_URL=String(process.env.INTERROUTE_META_URL||'http://127.0.0.1:8788/internal/v1/actions');
const WA_URL=String(process.env.INTERROUTE_WA_URL||'http://127.0.0.1:18787/publish');
const TG_BASE=TG_TOKEN?'https://api.telegram.org/bot'+TG_TOKEN:'';
const TG_FILE_BASE=TG_TOKEN?'https://api.telegram.org/file/bot'+TG_TOKEN:'';
const FACEBOOK_MEDIA_PROXY_TTL_MS=Math.max(60000,Number(process.env.INTERROUTE_FACEBOOK_MEDIA_PROXY_TTL_MS||10*60*1000));
const facebookMediaProxy=new Map();
function imageMime(name='',hint=''){
  const h=String(hint||'').toLowerCase();
  if(h.startsWith('image/'))return h.split(';')[0];
  const n=String(name||'').toLowerCase().split(/[?#]/)[0];
  if(n.endsWith('.png'))return 'image/png';
  if(n.endsWith('.webp'))return 'image/webp';
  if(n.endsWith('.gif'))return 'image/gif';
  if(n.endsWith('.bmp'))return 'image/bmp';
  return 'image/jpeg';
}
function registerFacebookMedia(media){
  if(!media?.fileId&&!media?.localPath)return '';
  const token=crypto.randomBytes(24).toString('hex');
  facebookMediaProxy.set(token,{fileId:String(media.fileId||''),localPath:String(media.localPath||''),fileName:String(media.fileName||''),mimetype:String(media.mimetype||''),expiresAt:now()+FACEBOOK_MEDIA_PROXY_TTL_MS});
  return 'http://127.0.0.1:'+PORT+'/internal-media/'+token;
}
async function loadFacebookMedia(token){
  const item=facebookMediaProxy.get(String(token||''));
  if(!item||Number(item.expiresAt||0)<now()){facebookMediaProxy.delete(String(token||''));throw new Error('facebook_media_proxy_expired');}
  let bytes,mime=imageMime(item.fileName,item.mimetype);
  if(item.localPath){
    bytes=await fsp.readFile(item.localPath);
  }else if(item.fileId){
    if(!TG_FILE_BASE)throw new Error('telegram_publisher_unconfigured');
    const info=await tg('getFile',{file_id:item.fileId},30000);
    const filePath=String(info?.file_path||'');
    if(!filePath)throw new Error('telegram_getfile_missing_path');
    mime=imageMime(item.fileName||filePath,item.mimetype);
    const rr=await fetch(TG_FILE_BASE+'/'+filePath,{headers:{'user-agent':'Nexus-Interroute/1.1'},signal:AbortSignal.timeout(30000)});
    if(!rr.ok)throw new Error('telegram_file_fetch_http_'+rr.status);
    const declared=Number(rr.headers.get('content-length')||0);
    if(declared>25*1024*1024)throw new Error('facebook_media_too_large');
    bytes=Buffer.from(await rr.arrayBuffer());
  }else throw new Error('facebook_media_reference_missing');
  if(!bytes?.length)throw new Error('facebook_media_empty');
  if(bytes.length>25*1024*1024)throw new Error('facebook_media_too_large');
  return {bytes,mime};
}

const now=()=>Date.now();
const iso=()=>new Date().toISOString();
const cleanSource=v=>String(v||'').trim().replace(/^@/,'').toLowerCase();
const textOf=v=>String(v??'').slice(0,200000);
const safeUrl=v=>{try{const u=new URL(String(v||''));return /^https?:$/.test(u.protocol)?u.toString():'';}catch{return'';}};
const safeLocalPath=v=>{const p=path.resolve(String(v||''));return p.startsWith('/var/lib/nex/tmp/internal-automation/')?p:'';};
const json=(res,status,data)=>{const b=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(b),'cache-control':'no-store'});res.end(b);};
async function body(req){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>1048576)throw new Error('payload_too_large');chunks.push(c);}if(!chunks.length)return{};return JSON.parse(Buffer.concat(chunks).toString('utf8'));}

await fsp.mkdir(DATA_DIR,{recursive:true});
let state={version:1,events:[],history:[]};
try{state=JSON.parse(await fsp.readFile(STATE_FILE,'utf8'));}catch{}
state.events=Array.isArray(state.events)?state.events:[];
state.history=Array.isArray(state.history)?state.history:[];
let writeChain=Promise.resolve();
function persist(){writeChain=writeChain.then(async()=>{const tmp=STATE_FILE+'.tmp-'+process.pid;await fsp.writeFile(tmp,JSON.stringify(state),{mode:0o640});await fsp.rename(tmp,STATE_FILE);});return writeChain;}
function history(entry){state.history.unshift({at:iso(),...entry});if(state.history.length>2000)state.history.length=2000;}
function authorized(req){
  const remote=req.socket?.remoteAddress||'';
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote);
}
function normalizeMedia(raw){
  const arr=Array.isArray(raw)?raw:(raw?[raw]:[]);
  return arr.map((m,i)=>({type:String(m?.type||m?.mediaType||m?.media_type||'document').toLowerCase(),fileId:String(m?.fileId||m?.telegram_file_id||m?.telegramFileId||''),url:safeUrl(m?.url),localPath:safeLocalPath(m?.localPath||m?.local_path),fileName:String(m?.fileName||m?.filename||m?.original_name||('media-'+(i+1))).slice(0,255),mimetype:String(m?.mimetype||m?.mime_type||'').slice(0,120),position:Number(m?.position??i)})).filter(m=>m.fileId||m.url||m.localPath).sort((a,b)=>a.position-b.position);
}
function normalizeButtons(raw){const arr=Array.isArray(raw)?raw:[];return arr.flatMap(x=>Array.isArray(x)?x:[x]).map(x=>({text:String(x?.text||x?.label||'Ouvrir').slice(0,64),url:safeUrl(x?.url)})).filter(x=>x.url).slice(0,100);}
function normalizeRoute(r){
  const platform=String(r?.platform||'').toLowerCase();
  if(!['telegram','whatsapp','facebook','test'].includes(platform))throw new Error('unsupported_route:'+platform);
  return {id:String(r?.id||crypto.randomUUID()),platform,destination:String(r?.destination||'').trim(),pageId:String(r?.pageId||'').trim(),status:'pending',attempts:0,nextAttemptAt:0,lastError:null,result:null,completedAt:null};
}
function normalizeEvent(raw){
  const ownerDomain=String(raw?.ownerDomain||raw?.domain||'').toLowerCase();
  if(ownerDomain!=='system')throw new Error('interroute_internal_only');
  const source=cleanSource(raw?.source?.name||raw?.source||raw?.channelUsername);
  const sourceMessageId=raw?.source?.messageId??raw?.sourceMessageId??raw?.telegramMessageId??null;
  const idem=String(raw?.idempotencyKey||((source||'system')+':'+String(sourceMessageId??raw?.id??crypto.randomUUID()))).slice(0,500);
  const routes=(Array.isArray(raw?.routes)?raw.routes:[]).map(normalizeRoute);
  if(!routes.length)throw new Error('routes_required');
  return {id:String(raw?.id||crypto.randomUUID()),schemaVersion:1,idempotencyKey:idem,ownerDomain:'system',source:{platform:String(raw?.source?.platform||'telegram'),name:source,messageId:sourceMessageId,accountRole:String(raw?.source?.accountRole||'system-scanner')},content:{text:textOf(raw?.content?.text??raw?.text??raw?.caption),media:normalizeMedia(raw?.content?.media??raw?.mediaItems??raw?.media),buttons:normalizeButtons(raw?.content?.buttons??raw?.buttons),telegramCopy:(raw?.content?.telegramCopy&&raw.content.telegramCopy.fromChatId&&Number(raw.content.telegramCopy.messageId)>0)?{fromChatId:String(raw.content.telegramCopy.fromChatId),messageId:Number(raw.content.telegramCopy.messageId)}:null},routes,dryRun:Boolean(raw?.dryRun),createdAt:iso(),updatedAt:iso(),status:'queued'};
}
function eventDone(e){return e.routes.every(r=>['succeeded','skipped','dead_letter'].includes(r.status));}
function eventStatus(e){if(!eventDone(e))return e.routes.some(r=>r.status==='running')?'running':'queued';if(e.routes.every(r=>['succeeded','skipped'].includes(r.status)))return 'succeeded';return 'partial_failure';}
async function tg(method,payload,timeout=30000){
  if(!TG_BASE)throw new Error('telegram_publisher_unconfigured');
  const r=await fetch(TG_BASE+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok){const e=new Error(j.description||('telegram_http_'+r.status));e.retryAfter=Number(j?.parameters?.retry_after||0);throw e;}
  return j.result;
}
async function telegramUpload(method,payload,fileField,media,timeout=120000){
  if(!TG_BASE)throw new Error('telegram_publisher_unconfigured');
  let bytes,mime=String(media?.mimetype||'application/octet-stream'),name=String(media?.fileName||'media.bin');
  if(media?.localPath){
    bytes=await fsp.readFile(media.localPath);
  }else if(media?.url){
    const res=await fetch(media.url,{headers:{'user-agent':'Nexus-Interroute/1.0'},signal:AbortSignal.timeout(30000)});
    if(!res.ok)throw new Error('telegram_media_fetch_http_'+res.status);
    const len=Number(res.headers.get('content-length')||0);
    if(len>50*1024*1024)throw new Error('telegram_media_fetch_too_large');
    mime=String(res.headers.get('content-type')||mime).split(';')[0]||mime;
    const ab=await res.arrayBuffer();
    if(ab.byteLength>50*1024*1024)throw new Error('telegram_media_fetch_too_large');
    bytes=Buffer.from(ab);
  }else{
    throw new Error('telegram_media_reference_missing');
  }
  const form=new FormData();
  for(const [key,value] of Object.entries(payload||{})){
    if(value===undefined||value===null)continue;
    form.append(key,typeof value==='object'?JSON.stringify(value):String(value));
  }
  form.append(fileField,new Blob([bytes],{type:mime}),name);
  const res=await fetch(TG_BASE+'/'+method,{method:'POST',body:form,signal:AbortSignal.timeout(timeout)});
  const out=await res.json().catch(()=>({}));
  if(!res.ok||!out.ok){const e=new Error(out.description||('telegram_http_'+res.status));e.retryAfter=Number(out?.parameters?.retry_after||0);throw e;}
  return out.result;
}
function replyMarkup(buttons){if(!buttons.length)return undefined;const rows=[];for(let i=0;i<buttons.length;i+=2)rows.push(buttons.slice(i,i+2).map(b=>({text:b.text,url:b.url})));return {inline_keyboard:rows};}
async function publishTelegram(e,r){
  if(e.dryRun)return {dryRun:true,platform:'telegram'};
  const chat_id=r.destination;if(!chat_id)throw new Error('telegram_destination_required');
  const c=e.content,buttons=replyMarkup(c.buttons);
  if(c.telegramCopy){
    return {message:await tg('copyMessage',{chat_id,from_chat_id:c.telegramCopy.fromChatId,message_id:c.telegramCopy.messageId,caption:c.text.slice(0,1024),parse_mode:'HTML',...(buttons?{reply_markup:buttons}:{})},120000)};
  }
  if(!c.media.length)return {message:await tg('sendMessage',{chat_id,text:c.text||'Publication Nextech',parse_mode:'HTML',...(buttons?{reply_markup:buttons}:{})})};
  const first=c.media[0];
  const common={chat_id,caption:c.text.slice(0,1024),parse_mode:'HTML',...(buttons?{reply_markup:buttons}:{})};
  const type=first.type;
  const method=type==='photo'||type==='image'?'sendPhoto':type==='animation'?'sendAnimation':type==='video'?'sendVideo':type==='voice'?'sendVoice':type==='audio'?'sendAudio':'sendDocument';
  const field=method==='sendPhoto'?'photo':method==='sendAnimation'?'animation':method==='sendVideo'?'video':method==='sendVoice'?'voice':method==='sendAudio'?'audio':'document';
  if(first.localPath){
    return {message:await telegramUpload(method,common,field,first,120000),uploaded:true};
  }
  if(first.fileId){
    return {message:await tg(method,{...common,[field]:first.fileId},120000)};
  }
  if(first.url){
    try{
      return {message:await tg(method,{...common,[field]:first.url},120000)};
    }catch(error){
      const directError=String(error?.message||error);
      try{
        return {message:await telegramUpload(method,common,field,first,120000),uploaded:true,directUrlError:directError};
      }catch(uploadError){
        if(type==='photo'||type==='image'){
          const message=await tg('sendMessage',{chat_id,text:c.text||'Publication Nextech',parse_mode:'HTML',...(buttons?{reply_markup:buttons}:{})},60000);
          return {message,degradedMedia:true,mediaError:String(uploadError?.message||uploadError),directUrlError:directError};
        }
        throw uploadError;
      }
    }
  }
  throw new Error('telegram_media_reference_missing');
}
async function publishWhatsApp(e){
  if(e.dryRun)return {dryRun:true,platform:'whatsapp'};
  const payload={id:e.idempotencyKey,source:e.source.name,sourceMessageId:e.source.messageId,text:e.content.text,mediaItems:e.content.media,buttons:e.content.buttons,createdAt:e.createdAt};
  const res=await fetch(WA_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  const out=await res.json().catch(()=>({}));if(!res.ok)throw new Error(out.error||('whatsapp_http_'+res.status));return out;
}
function facebookAdapt(e){
  const c=e.content,apkLike=c.media.some(m=>m.type==='document'||m.type==='file'||/\.(?:apk|xapk|apks|zip|rar|7z)$/i.test(m.fileName));
  if(apkLike)return {skip:true,reason:'facebook_incompatible_document'};
  const links=c.buttons.map(b=>b.text+': '+b.url),message=[c.text,...links].filter(Boolean).join('\n\n').slice(0,63206);
  const image=c.media.find(m=>m.type==='photo'||m.type==='image'||String(m.mimetype||'').toLowerCase().startsWith('image/')||/\.(?:jpe?g|png|webp|gif|bmp)$/i.test(m.fileName||''));
  const link=image?(c.buttons.map(b=>b.url).find(Boolean)||''):(c.media.map(m=>m.url).find(Boolean)||c.buttons.map(b=>b.url).find(Boolean)||'');
  return {skip:false,message,link,image:image||null};
}
async function publishFacebook(e,r){
  if(e.dryRun)return {dryRun:true,platform:'facebook'};
  const a=facebookAdapt(e);if(a.skip)return {skipped:true,reason:a.reason};
  if(!META_KEY)throw new Error('facebook_publisher_unconfigured');
  const pageId=String(r.pageId||FACEBOOK_PAGE_ID||'').trim();
  const mediaUrl=a.image?(a.image.url||registerFacebookMedia(a.image)):'';
  const payload={action:'publish_page_post',message:a.message,link:a.link||undefined,mediaUrl:mediaUrl||undefined,fileName:a.image?.fileName||undefined,published:true,idempotencyKey:e.idempotencyKey,sourceMessageId:e.source?.messageId??undefined,...(pageId?{pageId}:{})};
  const res=await fetch(META_URL,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+META_KEY},body:JSON.stringify(payload),signal:AbortSignal.timeout(FACEBOOK_TIMEOUT_MS)});
  const out=await res.json().catch(()=>({}));if(!res.ok)throw new Error(out.error||out.message||('facebook_http_'+res.status));return out;
}
async function deliver(e,r){if(r.platform==='telegram')return publishTelegram(e,r);if(r.platform==='whatsapp')return publishWhatsApp(e,r);if(r.platform==='facebook')return publishFacebook(e,r);return {dryRun:true,platform:'test'};}
let processing=false;
async function tick(){
  if(processing)return;processing=true;
  try{
    const t=now();
    for(const e of state.events){
      for(const r of e.routes){
        if(r.status!=='pending'||Number(r.nextAttemptAt||0)>t)continue;
        r.status='running';r.attempts=Number(r.attempts||0)+1;e.updatedAt=iso();await persist();
        try{
          const out=await deliver(e,r);
          r.status=out?.skipped?'skipped':'succeeded';r.result=out;r.lastError=null;r.completedAt=iso();
          history({type:'route_succeeded',eventId:e.id,routeId:r.id,platform:r.platform,destination:r.destination,attempts:r.attempts,status:r.status});
        }catch(err){
          r.lastError=String(err?.message||err).slice(0,1000);const retryAfter=Number(err?.retryAfter||0);
          if(r.attempts>=MAX_ATTEMPTS){r.status='dead_letter';r.completedAt=iso();history({type:'route_dead_letter',eventId:e.id,routeId:r.id,platform:r.platform,error:r.lastError,attempts:r.attempts});}
          else{r.status='pending';r.nextAttemptAt=now()+(retryAfter?retryAfter*1000:Math.min(300000,5000*2**Math.min(6,r.attempts-1)));history({type:'route_retry',eventId:e.id,routeId:r.id,platform:r.platform,error:r.lastError,attempts:r.attempts});}
        }
        e.status=eventStatus(e);e.updatedAt=iso();await persist();
      }
      e.status=eventStatus(e);
    }
    if(state.events.length>5000)state.events=state.events.slice(-5000);
    await persist();
  }finally{processing=false;}
}
setInterval(()=>tick().catch(e=>console.error('[Interroute tick]',e)),TICK_MS).unref();

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname.startsWith('/internal-media/')){
      if(!authorized(req))return json(res,401,{error:'unauthorized'});
      const token=decodeURIComponent(url.pathname.slice('/internal-media/'.length));
      try{
        const media=await loadFacebookMedia(token);
        facebookMediaProxy.delete(token);
        res.writeHead(200,{'content-type':media.mime,'content-length':media.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});
        res.end(media.bytes);
      }catch(error){
        return json(res,404,{error:String(error?.message||error).slice(0,200)});
      }
      return;
    }
    if(req.method==='GET'&&url.pathname==='/healthz'){const counts=state.events.reduce((a,e)=>(a[e.status]=(a[e.status]||0)+1,a),{});return json(res,200,{ok:true,service:'interroute',version:'1.0.0',queue:counts,events:state.events.length,telegramConfigured:Boolean(TG_TOKEN),facebookConfigured:Boolean(META_KEY)});}
    if(!authorized(req))return json(res,401,{error:'unauthorized'});
    if(req.method==='GET'&&url.pathname==='/stats'){const routes={};for(const e of state.events)for(const r of e.routes){const k=r.platform+':'+r.status;routes[k]=(routes[k]||0)+1;}return json(res,200,{ok:true,events:state.events.length,routes,history:state.history.slice(0,50)});}
    if(req.method==='GET'&&url.pathname.startsWith('/events/')){const id=decodeURIComponent(url.pathname.slice('/events/'.length)),e=state.events.find(x=>x.id===id||x.idempotencyKey===id);return e?json(res,200,{ok:true,event:e}):json(res,404,{error:'not_found'});}
    if(req.method==='POST'&&url.pathname.startsWith('/events/')&&url.pathname.endsWith('/requeue')){
      const raw=url.pathname.slice('/events/'.length,-'/requeue'.length).replace(/\/$/,'');
      const id=decodeURIComponent(raw);
      const e=state.events.find(x=>x.id===id||x.idempotencyKey===id);
      if(!e)return json(res,404,{error:'not_found'});
      const q=await body(req);
      const wanted=new Set((Array.isArray(q?.platforms)?q.platforms:(q?.platform?[q.platform]:[])).map(x=>String(x||'').toLowerCase()).filter(Boolean));
      const requeued=[];
      for(const r of e.routes){
        if(r.status!=='dead_letter')continue;
        if(wanted.size&&!wanted.has(String(r.platform||'').toLowerCase()))continue;
        const previousError=r.lastError;
        const previousAttempts=Number(r.attempts||0);
        r.status='pending';
        r.attempts=0;
        r.nextAttemptAt=0;
        r.lastError=null;
        r.result=null;
        r.completedAt=null;
        requeued.push({routeId:r.id,platform:r.platform,destination:r.destination,previousAttempts,previousError});
        history({type:'route_requeued',eventId:e.id,routeId:r.id,platform:r.platform,destination:r.destination,previousAttempts,previousError});
      }
      if(!requeued.length)return json(res,200,{ok:true,eventId:e.id,requeued:0,status:e.status});
      e.status=eventStatus(e);
      e.updatedAt=iso();
      await persist();
      tick().catch(()=>{});
      return json(res,202,{ok:true,eventId:e.id,idempotencyKey:e.idempotencyKey,requeued:requeued.length,routes:requeued,status:e.status});
    }
    if(req.method==='POST'&&url.pathname==='/events'){const incoming=normalizeEvent(await body(req)),existing=state.events.find(e=>e.idempotencyKey===incoming.idempotencyKey);if(existing)return json(res,200,{ok:true,duplicate:true,eventId:existing.id,status:existing.status});state.events.push(incoming);history({type:'event_queued',eventId:incoming.id,idempotencyKey:incoming.idempotencyKey,routes:incoming.routes.map(r=>r.platform)});await persist();tick().catch(()=>{});return json(res,202,{ok:true,duplicate:false,eventId:incoming.id,status:incoming.status});}
    return json(res,404,{error:'not_found'});
  }catch(err){return json(res,400,{error:String(err?.message||err).slice(0,500)});}
});
server.listen(PORT,HOST,()=>console.log('[Interroute] http://'+HOST+':'+PORT));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{await persist().catch(()=>{});server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
