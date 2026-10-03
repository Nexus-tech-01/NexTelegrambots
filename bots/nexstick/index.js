import crypto from 'node:crypto';
import { addStickerWatermark, removeStickerWatermark, roundSticker, normalizeSticker } from './src/sticker-transform.mjs';
import { rememberPack, packsFor, closeStore } from './src/store.mjs';

const TOKEN=String(process.env.BOT_TOKEN||process.env.NEXSTICK__BOT_TOKEN||process.env.NEXSTICK_BOT_TOKEN||'').trim();
if(!TOKEN)throw new Error('NexStick BOT_TOKEN absent');

const API='https://api.telegram.org/bot'+TOKEN+'/';
const FILE_API='https://api.telegram.org/file/bot'+TOKEN+'/';
const MAX_PACK=Math.max(1,Math.min(120,Number(process.env.NEXSTICK_MAX_PACK_SIZE||120)));
const PREVIEW_TTL=15*60*1000;
const GAP=Math.max(250,Number(process.env.NEXSTICK_MUTATION_GAP_MS||800));
const pending=new Map();
let stopping=false,offset=0,botUsername='The_Nexus_techbot';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=v=>String(v??'').trim();

function adminIds(){
  return new Set(clean(process.env.ADMIN_IDS||'').split(/[,\s]+/).filter(Boolean).map(String));
}
function isAdmin(id){return adminIds().has(String(id))}
function safeBase(value,max=32){
  let s=clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9_]+/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
  if(!/^[a-z]/.test(s))s='nx_'+s;
  return s.slice(0,max).replace(/_+$/,'')||'nexstick';
}
function setName(userId,label='pack'){
  const suffix='_by_'+safeBase(botUsername,28).replace(/_bot$/,'_bot');
  const unique='_'+Number(userId).toString(36).slice(-7)+'_'+Date.now().toString(36).slice(-7)+'_'+crypto.randomBytes(2).toString('hex');
  const max=Math.max(1,64-suffix.length-unique.length);
  return (safeBase(label,max)+unique+suffix).replace(/_+/g,'_').slice(0,64);
}
function defaultSetName(userId){
  const suffix='_by_'+safeBase(botUsername,28).replace(/_bot$/,'_bot');
  const base=('nexstick_'+Number(userId).toString(36)).replace(/_+/g,'_');
  return (base.slice(0,64-suffix.length)+suffix).slice(0,64);
}
function packLink(name){return 'https://t.me/addstickers/'+name}
function stickerFormat(sticker){
  if(sticker?.is_video)return 'video';
  if(sticker?.is_animated)return 'animated';
  return 'static';
}
function mimeForFormat(format){
  if(format==='video')return 'video/webm';
  if(format==='animated')return 'application/x-tgsticker';
  return 'image/webp';
}
function tokenize(text=''){
  const out=[];let cur='',quote='',esc=false;
  for(const ch of String(text)){
    if(esc){cur+=ch;esc=false;continue}
    if(ch==='\\'){esc=true;continue}
    if(quote){if(ch===quote){quote=''}else cur+=ch;continue}
    if(ch==='"'||ch==="'"){quote=ch;continue}
    if(/\s/.test(ch)){if(cur){out.push(cur);cur=''}}else cur+=ch;
  }
  if(cur)out.push(cur);
  return out;
}
function parseFlags(args=[]){
  const flags={},words=[];
  for(const raw of args){
    if(!raw.startsWith('--')){words.push(raw);continue}
    const body=raw.slice(2),i=body.indexOf('=');
    if(i<0)flags[body.toLowerCase()]=true;
    else flags[body.slice(0,i).toLowerCase()]=body.slice(i+1);
  }
  return {flags,words};
}
function opacityValue(value,fallback=.18){
  if(value===undefined||value===true||value==='')return fallback;
  let n=Number(value);
  if(!Number.isFinite(n))return fallback;
  if(n>1)n/=100;
  return Math.max(.02,Math.min(.90,n));
}
function numberValue(value,fallback,min,max){
  const n=Number(value);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}
function commandOf(text=''){
  if(!String(text).startsWith('/'))return null;
  const [head,...rest]=tokenize(text);
  const name=head.slice(1).split('@')[0].toLowerCase();
  return {name,args:rest};
}
function replySourceMessage(msg){return msg?.reply_to_message||msg}
function sourceSticker(msg){return replySourceMessage(msg)?.sticker||null}

async function request(method,payload={},opts={}){
  const retries=opts.retries??3;
  for(let attempt=0;;attempt++){
    try{
      let response;
      if(opts.file){
        const form=new FormData();
        for(const [k,v] of Object.entries(payload||{})){
          if(v===undefined||v===null)continue;
          form.append(k,typeof v==='string'?v:JSON.stringify(v));
        }
        form.append(opts.file.field||'sticker_file',new Blob([opts.file.buffer],{type:opts.file.mime||'application/octet-stream'}),opts.file.filename||'file.bin');
        response=await fetch(API+method,{method:'POST',body:form,signal:AbortSignal.timeout(opts.timeout||65000)});
      }else{
        response=await fetch(API+method,{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify(payload||{}),
          signal:AbortSignal.timeout(opts.timeout||65000)
        });
      }
      const data=await response.json().catch(()=>null);
      if(response.ok&&data?.ok)return data.result;
      const retryAfter=Number(data?.parameters?.retry_after||0);
      if(attempt<retries&&(response.status===429||response.status>=500)){
        await sleep(Math.max(700,retryAfter*1000||1000*(attempt+1)));
        continue;
      }
      const e=new Error(clean(data?.description)||('Telegram '+method+' HTTP '+response.status));
      e.status=response.status;e.telegram=data;throw e;
    }catch(error){
      if(attempt<retries&&(error?.name==='TimeoutError'||error?.name==='AbortError'||/fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(error?.message||error)))){
        await sleep(1000*(attempt+1));continue;
      }
      throw error;
    }
  }
}
async function sendMessage(chatId,text,extra={}){
  return request('sendMessage',{chat_id:chatId,text:String(text).slice(0,4000),...extra});
}
async function editMessage(chatId,messageId,text,extra={}){
  return request('editMessageText',{chat_id:chatId,message_id:messageId,text:String(text).slice(0,4000),...extra}).catch(()=>null);
}
async function answerCallback(id,text=''){
  return request('answerCallbackQuery',{callback_query_id:id,text:String(text).slice(0,180)}).catch(()=>null);
}
async function sendPreparedSticker(chatId,prepared){
  return request('sendSticker',{chat_id:chatId},{
    file:{field:'sticker',buffer:prepared.buffer,mime:prepared.mime,filename:prepared.filename},
    timeout:90000
  });
}
async function getFileBuffer(fileId,mimeHint='application/octet-stream'){
  const f=await request('getFile',{file_id:fileId});
  if(!f?.file_path)throw new Error('Fichier Telegram introuvable.');
  const r=await fetch(FILE_API+f.file_path,{signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw new Error('Téléchargement Telegram HTTP '+r.status);
  const b=Buffer.from(await r.arrayBuffer());
  if(!b.length)throw new Error('Fichier Telegram vide.');
  return {buffer:b,mime:mimeHint,filePath:f.file_path};
}
async function sourceFromSticker(sticker){
  return getFileBuffer(sticker.file_id,mimeForFormat(stickerFormat(sticker)));
}
async function sourceFromMessage(msg){
  const m=replySourceMessage(msg);
  if(m?.sticker)return sourceFromSticker(m.sticker);
  if(m?.photo?.length){
    const p=m.photo[m.photo.length-1];
    return getFileBuffer(p.file_id,'image/jpeg');
  }
  if(m?.video)return getFileBuffer(m.video.file_id,m.video.mime_type||'video/mp4');
  if(m?.animation)return getFileBuffer(m.animation.file_id,m.animation.mime_type||'video/mp4');
  if(m?.document)return getFileBuffer(m.document.file_id,m.document.mime_type||'application/octet-stream');
  throw new Error('Réponds à un sticker, une image ou une vidéo.');
}

function inputFromExisting(sticker){
  return {sticker:sticker.file_id,format:stickerFormat(sticker),emoji_list:[clean(sticker.emoji)||'✨']};
}
function inputFromPrepared(prepared,emoji='✨'){
  return {sticker:'attach://sticker_file',format:prepared.format,emoji_list:[clean(emoji)||'✨']};
}
async function createSetPrepared(userId,title,name,prepared,emoji='✨'){
  return request('createNewStickerSet',{
    user_id:userId,name,title:clean(title).slice(0,64)||'NexStick',
    stickers:[inputFromPrepared(prepared,emoji)],sticker_type:'regular'
  },{
    file:{field:'sticker_file',buffer:prepared.buffer,mime:prepared.mime,filename:prepared.filename},
    timeout:120000
  });
}
async function addPrepared(userId,name,prepared,emoji='✨'){
  return request('addStickerToSet',{user_id:userId,name,sticker:inputFromPrepared(prepared,emoji)},{
    file:{field:'sticker_file',buffer:prepared.buffer,mime:prepared.mime,filename:prepared.filename},
    timeout:120000
  });
}
async function createSetExisting(userId,title,name,sticker){
  return request('createNewStickerSet',{
    user_id:userId,name,title:clean(title).slice(0,64)||'NexStick',
    stickers:[inputFromExisting(sticker)],sticker_type:'regular'
  },{timeout:90000});
}
async function addExisting(userId,name,sticker){
  return request('addStickerToSet',{user_id:userId,name,sticker:inputFromExisting(sticker)},{timeout:90000});
}
async function remember(userId,title,name,count,meta={}){
  await rememberPack(userId,{title,name,link:packLink(name),count,...meta}).catch(()=>{});
}

async function membershipAllowed(userId){
  if(isAdmin(userId))return true;
  const chats=[process.env.REQUIRED_CHANNEL,process.env.REQUIRED_GROUP_1,process.env.REQUIRED_GROUP_2,process.env.REQUIRED_CHANNEL_2].map(clean).filter(Boolean);
  for(const chat of chats){
    try{
      const m=await request('getChatMember',{chat_id:chat,user_id:userId},{retries:0,timeout:12000});
      if(['left','kicked'].includes(m?.status))return false;
    }catch(error){
      console.warn('[NexStick] membership check skipped',chat,String(error?.message||error));
    }
  }
  return true;
}
async function requireMembership(msg){
  const ok=await membershipAllowed(msg.from.id);
  if(ok)return true;
  await sendMessage(msg.chat.id,'NexStick est réservé aux membres des espaces Nextech requis. Rejoins-les puis réessaie.');
  return false;
}

function transformConfig(op,args){
  const {flags,words}=parseFlags(args);
  if(op==='watermark'){
    const text=clean(words.join(' ')||flags.text||flags.name);
    if(!text)throw new Error('Ajoute le texte du filigrane. Exemple : /filitake Nextech --opacity=15 --position=bottom');
    return {
      op,text,title:clean(flags.title||text).slice(0,64),
      color:clean(flags.color||'#FFFFFF'),opacity:opacityValue(flags.opacity,.18),
      position:clean(flags.position||'bottom').toLowerCase(),
      size:numberValue(flags.size,0,0,96),
      rotation:flags.rotation===undefined?null:numberValue(flags.rotation,0,-180,180),
      repeat:Boolean(flags.repeat)||['repeat','tile','tiled'].includes(clean(flags.position).toLowerCase()),
      outline:!flags['no-outline']
    };
  }
  if(op==='remove'){
    return {op,title:clean(flags.title||words.join(' ')||'NexStick Clean').slice(0,64),zone:clean(flags.zone||'bottom').toLowerCase()};
  }
  return {op:'round',title:clean(flags.title||words.join(' ')||'NexStick Round').slice(0,64)};
}
async function transformSource(source,cfg){
  if(cfg.op==='watermark')return addStickerWatermark(source,cfg);
  if(cfg.op==='remove')return removeStickerWatermark(source,{zone:cfg.zone});
  if(cfg.op==='round')return roundSticker(source);
  return normalizeSticker(source);
}
function describeConfig(cfg){
  if(cfg.op==='watermark'){
    return ['Filigrane : '+cfg.text,'Couleur : '+cfg.color,'Opacité : '+Math.round(cfg.opacity*100)+'%','Position : '+cfg.position,cfg.size?'Taille : '+cfg.size:'',cfg.rotation!==null?'Rotation : '+cfg.rotation+'°':'',cfg.repeat?'Répétition : oui':''].filter(Boolean).join('\n');
  }
  if(cfg.op==='remove')return 'Suppression du filigrane\nZone : '+cfg.zone;
  return 'Conversion en sticker rond';
}

async function previewTransform(msg,op,args){
  const srcMsg=replySourceMessage(msg);
  const st=srcMsg?.sticker||null;
  const source=await sourceFromMessage(msg);
  const cfg=transformConfig(op,args);
  const prepared=await transformSource(source,cfg);
  await sendPreparedSticker(msg.chat.id,prepared);
  const id=crypto.randomBytes(8).toString('hex');
  pending.set(id,{id,userId:msg.from.id,chatId:msg.chat.id,sourceSticker:st?{file_id:st.file_id,set_name:st.set_name||'',emoji:st.emoji||'✨',is_animated:Boolean(st.is_animated),is_video:Boolean(st.is_video)}:null,cfg,createdAt:Date.now()});
  const buttons=[[{text:'✅ Appliquer à ce sticker',callback_data:'nxst:'+id+':one'}]];
  if(st?.set_name)buttons[0].push({text:'✅ Appliquer au pack',callback_data:'nxst:'+id+':pack'});
  buttons.push([{text:'❌ Annuler',callback_data:'nxst:'+id+':cancel'}]);
  await sendMessage(msg.chat.id,'Aperçu NexStick\n\n'+describeConfig(cfg)+'\n\nChoisis où appliquer la transformation.',{reply_markup:{inline_keyboard:buttons}});
}

async function transformPackJob(job,scope,statusMessageId){
  const {userId,chatId,cfg,sourceSticker}=job;
  let stickers=[],sourceTitle='NexStick';
  if(scope==='pack'){
    const set=await request('getStickerSet',{name:sourceSticker.set_name},{timeout:30000});
    stickers=(set?.stickers||[]).slice(0,MAX_PACK);
    sourceTitle=set?.title||'NexStick';
  }else{
    stickers=[sourceSticker].filter(Boolean);
  }
  if(!stickers.length)throw new Error('Aucun sticker à transformer.');
  const title=clean(cfg.title||(sourceTitle+' · NexStick')).slice(0,64);
  const name=setName(userId,title);
  let created=false,done=0,failed=0;

  for(let i=0;i<stickers.length;i++){
    const sticker=stickers[i];
    try{
      const source=await sourceFromSticker(sticker);
      const prepared=await transformSource(source,cfg);
      if(!created){await createSetPrepared(userId,title,name,prepared,sticker.emoji||'✨');created=true}
      else await addPrepared(userId,name,prepared,sticker.emoji||'✨');
      done++;
    }catch(error){
      failed++;
      console.error('[NexStick transform]',i+1,String(error?.message||error));
      if(!created&&i===stickers.length-1)throw error;
    }
    if(i===0||(i+1)%4===0||i===stickers.length-1){
      await editMessage(chatId,statusMessageId,'NexStick transforme le pack… '+(i+1)+'/'+stickers.length+' · réussis '+done+(failed?' · ignorés '+failed:''));
    }
    await sleep(GAP);
  }
  if(!created)throw new Error('Aucun sticker n’a pu être transformé.');
  await remember(userId,title,name,done,{operation:cfg.op,failed});
  await editMessage(chatId,statusMessageId,'✅ Terminé · '+done+' sticker(s)'+(failed?' · '+failed+' ignoré(s)':'')+'\n'+packLink(name));
}

async function clonePack(msg,args){
  const st=sourceSticker(msg);
  if(!st?.set_name)throw new Error('Réponds à un sticker appartenant à un pack.');
  const set=await request('getStickerSet',{name:st.set_name});
  const stickers=(set?.stickers||[]).slice(0,MAX_PACK);
  if(!stickers.length)throw new Error('Pack vide.');
  const {flags,words}=parseFlags(args);
  const title=clean(flags.title||words.join(' ')||set.title||'NexStick Clone').slice(0,64);
  const name=setName(msg.from.id,title);
  const status=await sendMessage(msg.chat.id,'NexStick clone le pack… 0/'+stickers.length);
  let done=0;
  for(let i=0;i<stickers.length;i++){
    const s=stickers[i];
    if(i===0)await createSetExisting(msg.from.id,title,name,s);
    else await addExisting(msg.from.id,name,s);
    done++;
    if(i===0||(i+1)%8===0||i===stickers.length-1)await editMessage(msg.chat.id,status.message_id,'NexStick clone le pack… '+(i+1)+'/'+stickers.length);
    await sleep(GAP);
  }
  await remember(msg.from.id,title,name,done,{operation:'clone'});
  await editMessage(msg.chat.id,status.message_id,'✅ Pack cloné · '+done+' sticker(s)\n'+packLink(name));
}

async function createPack(msg,args){
  const {flags,words}=parseFlags(args);
  const source=await sourceFromMessage(msg);
  let prepared=await normalizeSticker(source);
  const title=clean(flags.title||words.join(' ')||'NexStick Pack').slice(0,64);
  if(flags.round||flags.rond)prepared=await roundSticker(source);
  const wm=flags.watermark||flags.filigrane;
  if(wm){
    prepared=await addStickerWatermark(source,{
      text:wm===true?title:String(wm),color:clean(flags.color||'#FFFFFF'),
      opacity:opacityValue(flags.opacity,.18),position:clean(flags.position||'bottom'),
      size:numberValue(flags.size,0,0,96),rotation:flags.rotation===undefined?null:numberValue(flags.rotation,0,-180,180),
      repeat:Boolean(flags.repeat)
    });
  }
  const name=setName(msg.from.id,title);
  await createSetPrepared(msg.from.id,title,name,prepared,'✨');
  await remember(msg.from.id,title,name,1,{operation:'create'});
  await sendMessage(msg.chat.id,'✅ Pack créé\n'+packLink(name));
}

async function addDefaultSticker(msg){
  const srcMsg=replySourceMessage(msg),st=srcMsg?.sticker||null;
  let existing=null,prepared=null,emoji=st?.emoji||'✨';
  if(st)existing=st;else prepared=await normalizeSticker(await sourceFromMessage(msg));
  const name=defaultSetName(msg.from.id);
  let exists=true;
  try{await request('getStickerSet',{name},{retries:0})}catch{exists=false}
  if(!exists){
    if(existing)await createSetExisting(msg.from.id,'NexStick · '+(msg.from.first_name||'Pack'),name,existing);
    else await createSetPrepared(msg.from.id,'NexStick · '+(msg.from.first_name||'Pack'),name,prepared,emoji);
  }else{
    if(existing)await addExisting(msg.from.id,name,existing);
    else await addPrepared(msg.from.id,name,prepared,emoji);
  }
  await remember(msg.from.id,'NexStick',name,1,{operation:'sticker'});
  await sendMessage(msg.chat.id,'✅ Sticker ajouté\n'+packLink(name));
}

async function stickerInfo(msg){
  const st=sourceSticker(msg);
  if(!st)throw new Error('Réponds à un sticker.');
  let title='',count='';
  if(st.set_name){
    try{const set=await request('getStickerSet',{name:st.set_name});title=set.title||'';count=String(set.stickers?.length||'')}catch{}
  }
  await sendMessage(msg.chat.id,['NexStick · Sticker info','Emoji : '+(st.emoji||'?'),'Format : '+stickerFormat(st),st.set_name?'Pack : '+(title||st.set_name):'Pack : privé/inconnu',count?'Stickers : '+count:'',st.set_name?'Lien : '+packLink(st.set_name):''].filter(Boolean).join('\n'));
}

async function myPacks(msg){
  const rows=await packsFor(msg.from.id);
  if(!rows.length)return sendMessage(msg.chat.id,'Aucun pack NexStick enregistré pour ce compte.');
  const text=rows.slice(0,20).map((p,i)=>(i+1)+'. '+clean(p.title||p.name)+'\n'+clean(p.link||packLink(p.name))).join('\n\n');
  await sendMessage(msg.chat.id,'Mes packs NexStick\n\n'+text);
}

const HELP=`NexStick · Stickers & Packs

/filitake Texte — ajouter un filigrane
/filigrane Texte — alias
/watermark Texte — alias
/delfilig — retirer un filigrane
/ultratake — retirer + recréer le pack
/noteclone — convertir en stickers ronds
/take [nom] — cloner un pack
/clonepack [nom] — cloner un pack
/createpack [nom] — créer un pack
/sticker — ajouter au pack personnel
/stickerinfo — infos du sticker
/mypacks — tes packs

Options filigrane :
--color=#FFFFFF
--opacity=18
--position=bottom
--size=28
--rotation=-20
--repeat

Suppression :
--zone=bottom
Zones : top, center, bottom, top-left, top-right, bottom-left, bottom-right ou x,y,w,h.

Les transformations affichent toujours un aperçu avant application.`;

async function handleCommand(msg,cmd){
  if(!await requireMembership(msg))return;
  const aliases={filigrane:'filitake',watermark:'filitake',unwatermark:'delfilig',removefiligrane:'delfilig',round:'noteclone',rond:'noteclone',take:'clonepack'};
  const name=aliases[cmd.name]||cmd.name;
  if(['start','help','menu'].includes(name))return sendMessage(msg.chat.id,HELP);
  if(name==='mypacks')return myPacks(msg);
  if(name==='stickerinfo')return stickerInfo(msg);
  if(name==='clonepack')return clonePack(msg,cmd.args);
  if(name==='createpack')return createPack(msg,cmd.args);
  if(name==='sticker')return addDefaultSticker(msg);
  if(name==='filitake')return previewTransform(msg,'watermark',cmd.args);
  if(name==='delfilig'||name==='ultratake')return previewTransform(msg,'remove',cmd.args);
  if(name==='noteclone')return previewTransform(msg,'round',cmd.args);
  return sendMessage(msg.chat.id,'Commande inconnue. Utilise /help.');
}

async function handleCallback(q){
  const data=clean(q.data);
  if(!data.startsWith('nxst:'))return;
  const [,id,action]=data.split(':');
  const job=pending.get(id);
  if(!job)return answerCallback(q.id,'Aperçu expiré.');
  if(Number(q.from.id)!==Number(job.userId))return answerCallback(q.id,'Ce bouton ne t’appartient pas.');
  if(Date.now()-job.createdAt>PREVIEW_TTL){pending.delete(id);return answerCallback(q.id,'Aperçu expiré.');}
  if(action==='cancel'){
    pending.delete(id);await answerCallback(q.id,'Annulé.');
    if(q.message)await editMessage(q.message.chat.id,q.message.message_id,'❌ Transformation annulée.');
    return;
  }
  if(!['one','pack'].includes(action))return;
  if(!job.sourceSticker)return answerCallback(q.id,'Cette source ne peut être appliquée qu’en aperçu.');
  if(action==='pack'&&!job.sourceSticker.set_name)return answerCallback(q.id,'Ce sticker n’a pas de pack accessible.');
  pending.delete(id);
  await answerCallback(q.id,'Transformation lancée.');
  const status=await sendMessage(job.chatId,'NexStick prépare la transformation…');
  transformPackJob(job,action,status.message_id).catch(async error=>{
    console.error('[NexStick callback job]',String(error?.stack||error));
    await editMessage(job.chatId,status.message_id,'❌ '+String(error?.message||error).slice(0,3500));
  });
}

async function handleUpdate(update){
  if(update.callback_query)return handleCallback(update.callback_query);
  const msg=update.message;
  if(!msg?.from||msg.from.is_bot)return;
  const cmd=commandOf(msg.text||msg.caption||'');
  if(!cmd)return;
  try{await handleCommand(msg,cmd)}
  catch(error){
    console.error('[NexStick command]',cmd.name,String(error?.stack||error));
    await sendMessage(msg.chat.id,'❌ '+String(error?.message||error).slice(0,3500)).catch(()=>{});
  }
}

async function bootstrap(){
  const me=await request('getMe',{}, {timeout:15000});
  botUsername=me?.username||botUsername;
  await request('deleteWebhook',{drop_pending_updates:false},{retries:1,timeout:15000}).catch(()=>{});
  console.log('[NexStick] online @'+botUsername);
  setInterval(()=>{
    const now=Date.now();
    for(const [id,job] of pending)if(now-job.createdAt>PREVIEW_TTL)pending.delete(id);
  },60000).unref();

  while(!stopping){
    try{
      const updates=await request('getUpdates',{offset,timeout:45,limit:50,allowed_updates:['message','callback_query']},{retries:0,timeout:55000});
      for(const update of updates||[]){
        offset=Math.max(offset,Number(update.update_id||0)+1);
        await handleUpdate(update);
      }
    }catch(error){
      console.error('[NexStick polling]',String(error?.message||error));
      await sleep(/409/.test(String(error?.message||error))?15000:2500);
    }
  }
}

for(const sig of ['SIGINT','SIGTERM']){
  process.on(sig,()=>{stopping=true;closeStore().finally(()=>process.exit(0));});
}
bootstrap().catch(error=>{
  console.error('[NexStick fatal]',error);
  process.exitCode=1;
});
