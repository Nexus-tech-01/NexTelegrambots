import { readFile } from 'node:fs/promises';
import { replyStorageConfig, saveReplyStorageConfig } from './store.mjs';

const DEFAULT_TOKEN_FILE='/var/lib/nex/runtime/public/nexaccount/nexai-storage-bot-token';
const DEFAULT_CHAT_ID_FILE='/var/lib/nex/runtime/public/nexaccount/nexai-storage-chat-id';
const MAX_REPLY_BYTES=20*1024*1024;

async function storageToken(){
  const fromEnv=String(process.env.NEXAI_STORAGE_BOT_TOKEN||'').trim();
  if(fromEnv)return fromEnv;
  const file=String(process.env.NEXAI_STORAGE_BOT_TOKEN_FILE||DEFAULT_TOKEN_FILE).trim();
  try{
    const token=String(await readFile(file,'utf8')).trim();
    if(token)return token;
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
  const document=message?.document;
  const fileId=String(document?.file_id||'');
  if(!fileId)throw new Error('Telegram n’a pas retourné de file_id pour la vidéo');
  return {
    provider:'telegram-bot',
    chatId:channel.chatId,
    messageId:Number(message?.message_id||0),
    fileId,
    fileUniqueId:String(document?.file_unique_id||''),
    size:Number(document?.file_size||media.length),
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
