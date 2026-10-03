import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sessionKey } from './config.mjs';
import { db, replyStorageConfig, saveReplyStorageConfig } from './store.mjs';

const DEFAULT_TOKEN_FILE='/var/lib/nex/runtime/public/nexaccount/nexai-storage-bot-token';
const DEFAULT_CHAT_ID_FILE='/var/lib/nex/runtime/public/nexaccount/nexai-storage-chat-id';
const MAX_REPLY_BYTES=20*1024*1024;
const STORAGE_TOKEN_RECORD_ID='nexai_reply_storage_bot_token';
const EXPECTED_STORAGE_BOT_USERNAME=String(process.env.NEXAI_STORAGE_BOT_USERNAME||'NexAiStorage_bot').trim().replace(/^@/,'').toLowerCase();
let storageTokenCache='';

function encryptStorageToken(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',sessionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,encrypted]).toString('base64');
}

function decryptStorageToken(value){
  try{
    const raw=Buffer.from(String(value||'').trim(),'base64');
    if(raw.length<29)return '';
    const iv=raw.subarray(0,12),tag=raw.subarray(12,28),encrypted=raw.subarray(28);
    const decipher=crypto.createDecipheriv('aes-256-gcm',sessionKey(),iv);
    decipher.setAuthTag(tag);
    const token=Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
    return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token)?token:'';
  }catch{return ''}
}

async function loadStorageTokenFromStore(){
  const d=await db();
  const row=await d.collection('nexaccount_system').findOne(
    {_id:STORAGE_TOKEN_RECORD_ID},
    {projection:{encryptedToken:1}}
  );
  return decryptStorageToken(row?.encryptedToken||'');
}

async function persistStorageToken(value,identity={}){
  const d=await db(),now=new Date();
  await d.collection('nexaccount_system').updateOne(
    {_id:STORAGE_TOKEN_RECORD_ID},
    {$set:{
      encryptedToken:encryptStorageToken(value),
      botId:String(identity?.id||''),
      botUsername:String(identity?.username||'').trim().replace(/^@/,''),
      updatedAt:now
    },$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
}

async function storageToken(){
  const fromEnv=String(process.env.NEXAI_STORAGE_BOT_TOKEN||'').trim();
  if(fromEnv)return fromEnv;
  if(storageTokenCache)return storageTokenCache;
  try{
    const stored=await loadStorageTokenFromStore();
    if(stored){
      storageTokenCache=stored;
      return stored;
    }
  }catch(error){
    console.warn('[NexAI Storage] encrypted token read failed',String(error?.message||error).slice(0,220));
  }
  const file=String(process.env.NEXAI_STORAGE_BOT_TOKEN_FILE||DEFAULT_TOKEN_FILE).trim();
  try{
    const token=String(await readFile(file,'utf8')).trim();
    if(token){
      storageTokenCache=token;
      return token;
    }
  }catch{}
  throw new Error('NexAI Storage bot non configuré');
}

async function storageChatOverride(){
  const fromEnv=String(process.env.NEXAI_STORAGE_CHAT_ID||'').trim();
  if(fromEnv)return {chatId:fromEnv,source:'env'};
  const file=String(process.env.NEXAI_STORAGE_CHAT_ID_FILE||DEFAULT_CHAT_ID_FILE).trim();
  try{
    const chatId=String(await readFile(file,'utf8')).trim();
    if(chatId)return {chatId,source:'file'};
  }catch{}
  return {chatId:'',source:''};
}

async function botApi(method,payload={},timeoutMs=30000){
  const token=await storageToken();
  const isForm=payload instanceof FormData;
  const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',
    headers:isForm?undefined:{'content-type':'application/json'},
    body:isForm?payload:JSON.stringify(payload||{}),
    signal:AbortSignal.timeout(timeoutMs)
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok||data?.ok!==true){
    const detail=String(data?.description||('HTTP '+response.status)).slice(0,500);
    throw new Error('NexAI Storage '+method+' : '+detail);
  }
  return data.result;
}

export async function saveReplyStorageBotToken(token){
  const value=String(token||'').trim();
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value))throw new Error('Token Telegram invalide');
  const response=await fetch('https://api.telegram.org/bot'+value+'/getMe',{
    signal:AbortSignal.timeout(10000)
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok||data?.ok!==true)throw new Error('Telegram a refusé le token NexAI Storage');
  const me=data.result||{};
  const username=String(me.username||'').trim().replace(/^@/,'');
  if(EXPECTED_STORAGE_BOT_USERNAME&&username.toLowerCase()!==EXPECTED_STORAGE_BOT_USERNAME){
    throw new Error('Ce token appartient à @'+(username||'inconnu')+', pas à @NexAiStorage_bot');
  }
  await persistStorageToken(value,me);
  storageTokenCache=value;
  return {ok:true,botId:String(me.id||''),botUsername:username};
}

function channelFromUpdate(update){
  const membership=update?.my_chat_member;
  if(membership?.chat?.type==='channel'){
    const status=String(membership?.new_chat_member?.status||'');
    if(['administrator','creator','member'].includes(status))return membership.chat;
  }
  if(update?.channel_post?.chat?.type==='channel')return update.channel_post.chat;
  return null;
}

async function verifyStorageChannel(chatId){
  const chat=await botApi('getChat',{chat_id:String(chatId)});
  if(chat?.type!=='channel')throw new Error('Le coffre Telegram configuré n’est pas une chaîne');
  return chat;
}

export async function bindReplyStorageChannel(chatRef){
  const raw=String(chatRef||'').trim();
  if(!raw)throw new Error('Chaîne NexAI Storage manquante');
  let lookup=raw;
  const publicLink=raw.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{5,})\/?$/i);
  if(publicLink)lookup='@'+publicLink[1];
  if(!/^-?\d+$/.test(lookup)&&!/^@[A-Za-z0-9_]{5,}$/.test(lookup)){
    throw new Error('Utilise l’identifiant numérique de la chaîne, son @username public, ou réponds à un message transféré de la chaîne');
  }
  const [chat,me]=await Promise.all([
    verifyStorageChannel(lookup),
    botApi('getMe')
  ]);
  const admins=await botApi('getChatAdministrators',{chat_id:String(chat.id)});
  const own=Array.isArray(admins)&&admins.some(row=>
    String(row?.user?.id||'')===String(me?.id||'')&&
    ['administrator','creator'].includes(String(row?.status||''))
  );
  if(!own){
    throw new Error('@NexAiStorage_bot est présent mais n’est pas administrateur de cette chaîne');
  }
  const row=await saveReplyStorageConfig({
    chatId:String(chat.id),
    title:String(chat.title||''),
    botId:String(me?.id||''),
    botUsername:String(me?.username||'')
  });
  return {
    ok:true,
    chatId:String(row.chatId),
    title:String(row.title||''),
    botId:String(row.botId||''),
    botUsername:String(row.botUsername||'')
  };
}

export async function resolveReplyStorageChannel({discover=true}={}){
  const override=await storageChatOverride();
  if(override.chatId){
    const chat=await verifyStorageChannel(override.chatId);
    return {chatId:String(chat.id),title:String(chat.title||''),source:override.source};
  }

  const saved=await replyStorageConfig();
  if(saved.chatId){
    try{
      const chat=await verifyStorageChannel(saved.chatId);
      return {chatId:String(chat.id),title:String(chat.title||saved.title||''),source:'db'};
    }catch(error){
      if(!discover)throw error;
    }
  }
  if(!discover)throw new Error('Chaîne NexAI Storage non configurée');

  const me=await botApi('getMe');
  const webhook=await botApi('getWebhookInfo');
  if(String(webhook?.url||'')){
    await botApi('deleteWebhook',{drop_pending_updates:false});
  }
  const updates=await botApi('getUpdates',{
    offset:-100,
    limit:100,
    timeout:0,
    allowed_updates:['my_chat_member','channel_post']
  });

  const candidates=new Map();
  for(const update of Array.isArray(updates)?updates:[]){
    const chat=channelFromUpdate(update);
    if(chat?.id!=null)candidates.set(String(chat.id),chat);
  }

  const valid=[];
  for(const [id,chat] of candidates){
    try{
      const admins=await botApi('getChatAdministrators',{chat_id:id});
      const own=Array.isArray(admins)&&admins.some(row=>String(row?.user?.id||'')===String(me?.id||''));
      if(own)valid.push(chat);
    }catch{}
  }

  if(valid.length===0){
    throw new Error('Ajoute @NexAiStorage_bot comme administrateur de la chaîne de stockage puis relance /setreply');
  }
  if(valid.length>1){
    throw new Error('NexAI Storage est administrateur de plusieurs chaînes : définis NEXAI_STORAGE_CHAT_ID');
  }

  const chat=valid[0];
  const row=await saveReplyStorageConfig({
    chatId:String(chat.id),
    title:String(chat.title||''),
    botId:String(me?.id||''),
    botUsername:String(me?.username||'')
  });
  return {chatId:String(row.chatId),title:String(row.title||''),source:'discovered'};
}

export function replyStorageMediaFromMessage(message={}){
  return message?.video_note||message?.video||message?.document||message?.animation||null;
}

function replyStorageMediaType(message={}){
  if(message?.video_note)return 'video_note';
  if(message?.video)return 'video';
  if(message?.document)return 'document';
  if(message?.animation)return 'animation';
  return 'unknown';
}

export async function storeReplyVideo(buffer,{telegramUserId=''}={}){
  const media=Buffer.from(buffer||[]);
  if(!media.length)throw new Error('vidéo vide');
  if(media.length>MAX_REPLY_BYTES)throw new Error('vidéo > 20 Mo pour le coffre Telegram');
  const channel=await resolveReplyStorageChannel({discover:true});
  const form=new FormData();
  form.append('chat_id',channel.chatId);
  form.append('document',new Blob([media],{type:'video/mp4'}),'nexai-reply-'+Date.now()+'.mp4');
  form.append('disable_notification','true');
  form.append('protect_content','true');
  form.append('caption','NexAI Reply Media');
  const message=await botApi('sendDocument',form,60000);
  // Telegram may normalize an uploaded MP4 as document, video, video_note or
  // animation. The storage layer only needs the reusable Bot API file_id, so
  // never assume that sendDocument implies message.document in the response.
  const storedMedia=replyStorageMediaFromMessage(message);
  const fileId=String(storedMedia?.file_id||'');
  if(!fileId)throw new Error('Telegram n’a pas retourné de file_id exploitable pour la vidéo stockée');
  return {
    provider:'telegram-bot',
    chatId:channel.chatId,
    messageId:Number(message?.message_id||0),
    fileId,
    fileUniqueId:String(storedMedia?.file_unique_id||''),
    size:Number(storedMedia?.file_size||media.length),
    mediaType:replyStorageMediaType(message),
    owner:String(telegramUserId||''),
    storedAt:Date.now()
  };
}

export async function downloadReplyVideo(storage){
  const fileId=String(storage?.fileId||'').trim();
  if(!fileId)throw new Error('file_id NexAI Storage manquant');
  const info=await botApi('getFile',{file_id:fileId});
  const size=Number(info?.file_size||storage?.size||0);
  if(size>MAX_REPLY_BYTES)throw new Error('vidéo > 20 Mo pour le coffre Telegram');
  const filePath=String(info?.file_path||'');
  if(!filePath)throw new Error('Telegram n’a pas retourné de chemin de fichier');
  const token=await storageToken();
  const response=await fetch('https://api.telegram.org/file/bot'+token+'/'+filePath,{
    signal:AbortSignal.timeout(30000)
  });
  if(!response.ok)throw new Error('Téléchargement NexAI Storage impossible (HTTP '+response.status+')');
  const buffer=Buffer.from(await response.arrayBuffer());
  if(!buffer.length)throw new Error('vidéo NexAI Storage vide');
  if(buffer.length>MAX_REPLY_BYTES)throw new Error('vidéo > 20 Mo pour le coffre Telegram');
  return buffer;
}

export async function deleteStoredReplyVideo(storage){
  const chatId=String(storage?.chatId||'').trim();
  const messageId=Number(storage?.messageId||0);
  if(!chatId||!messageId)return false;
  try{
    return await botApi('deleteMessage',{chat_id:chatId,message_id:messageId})===true;
  }catch{return false}
}

export async function replyStorageStatus(){
  const tokenConfigured=await storageToken().then(()=>true).catch(()=>false);
  if(!tokenConfigured)return {ok:false,tokenConfigured:false};
  const me=await botApi('getMe');
  const channel=await resolveReplyStorageChannel({discover:true});
  return {
    ok:true,
    tokenConfigured:true,
    botUsername:String(me?.username||''),
    botId:String(me?.id||''),
    chatId:channel.chatId,
    title:channel.title||''
  };
}
