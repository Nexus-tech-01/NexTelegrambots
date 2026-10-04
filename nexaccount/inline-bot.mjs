import fs from 'node:fs';
import { Bot, InputFile } from 'grammy';
import { cfg, isOwnerId, isOwnerIdentity } from './config.mjs';
import { loadBotToken } from './secrets.mjs';
import { commandMap } from './commands.mjs';
import { db, accountRecord, listConnectedAccounts, settingsFor, patchSettings, saveSharedBotIdentity, nexAiPremiumState, grantNexAiPremium, acquireServiceLease, renewServiceLease, releaseServiceLease, sharedGreetingPolicy, claimSharedGreetingDelivery, releaseSharedGreetingDelivery } from './store.mjs';
import { menuModel, stylesModel, customStyleModel } from './menu.mjs';
import { customStyleFor, normalizeCustomStyle } from './custom-style.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { getInlineResponse } from './inline-response-store.mjs';
import { observeUser, recordEvent } from './analytics.mjs';
import { ownerPanelText, usersText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { listStyles, toSmallCaps } from './styles.mjs';
import { animatedCustomEmojiEntitySpecs, animatedCustomEmojiEntitySpecsFromLibrary, ensureEmojiLibraryPalette, sanitizeAnimatedEmojiText } from './response-ui.mjs';
import { sessionsText } from './session-view.mjs';
import { bindReplyStorageChannel, resolveReplyStorageChannel, replyStorageStatus, saveReplyStorageBotToken, storeReplyVideo } from './reply-storage.mjs';

const commands=commandMap();
const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const INLINE_CUSTOM_EMOJI_GLYPHS={
  WAIT:'⏳',CHECK:'✅',ERROR:'❌',
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',SHIELD:'🔒',
  TOOLS:'🛠️',MEDIA:'🎞️',STICKER:'🎴',GAMES:'🎮',SEARCH:'🔎',ANIME:'🌸',
  PREMIUM:'👑',OWNER:'🔮',NEXTECH:'⚡',NEWS:'📰',DARK:'🕯️',BACK:'↩️',
  NEXT:'➡️',STYLE:'🎨'
};

function inlineCustomEmojiEntities(text,settings={}){
  return animatedCustomEmojiEntitySpecs(text,settings?.customEmojiIds||{});
}

const webPairUsers=new Map();
const photoFileIdCache=new Map();
const photoCachePending=new Map();
const botGreetingSeen=new Map();
let bot;
let replyArtworkBuffer=null;
const NEXAI_PREMIUM_STARS=250;
const NEXAI_PREMIUM_PERIOD_SECONDS=30*24*60*60;
const NEXAI_PREMIUM_PAYLOAD_PREFIX='nexai-premium-v1:';
const NEXAI_POLLER_LEASE_TTL_MS=Math.max(60_000,Number(process.env.NEXAI_POLLER_LEASE_TTL_MS||120_000));
const NEXAI_POLLER_LEASE_RENEW_MS=Math.max(15_000,Math.min(45_000,Number(process.env.NEXAI_POLLER_LEASE_RENEW_MS||30_000)));
const NEXAI_POLLER_CONFLICT_RETRIES=Math.max(3,Math.min(30,Number(process.env.NEXAI_POLLER_CONFLICT_RETRIES||12)));
let pollerLeaseKey='';
let pollerLeaseTimer=null;
let pollerSupervisorTimer=null;
let pollerSupervisorRunning=false;
let pollerSupervisorStopping=true;
let pollerRestartAttempt=0;

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function greetingBotDisplayName(user){
  return String([user?.first_name,user?.last_name].filter(Boolean).join(' ')||user?.username||user?.id||'Membre').trim();
}

// Keep the ornamental/smallcaps welcome style, but cap real pictographic emoji
// even when a group still has an older emoji-heavy custom template saved.
const GREETING_EMOJI_SEQUENCE_RE=/(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F)?(?:[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?(?:[\u{1F3FB}-\u{1F3FF}])?)*)/gu;
function compactGreetingEmojiNoise(value,maxEmoji=2){
  let kept=0;
  return String(value||'')
    .replace(GREETING_EMOJI_SEQUENCE_RE,emoji=>{
      kept+=1;
      return kept<=Math.max(0,Number(maxEmoji)||0)?emoji:'';
    })
    .split('\n')
    .map(line=>line.replace(/[ \t]{2,}/g,' ').replace(/[ \t]+$/,''))
    .join('\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

function greetingVisualTemplate(template,isWelcome){
  const raw=String(template||'').trim();
  const legacyWelcome=new Set([
    '👋 Bienvenue {mention} dans {group} !',
    'Bienvenue {name} dans {group}.'
  ]);
  const legacyGoodbye=new Set([
    '👋 Au revoir {mention}. À bientôt dans {group}.',
    'Au revoir {name}.'
  ]);
  let resolved=raw;
  if(isWelcome&&(!raw||legacyWelcome.has(raw))){
    resolved=[
      '╭▱▱ ᴡᴇʟᴄᴏᴍᴇ ▱▱ 🎉',
      '┃',
      '┃ 𓆩 {mention} 𓆪',
      '┃ ʙɪᴇɴᴠᴇɴᴜᴇ ᴅᴀɴs {group}',
      '┃',
      '╰▱▱▱▱▱▱▱▱▱▱▱▱▱'
    ].join('\n');
  }else if(!isWelcome&&(!raw||legacyGoodbye.has(raw))){
    resolved=[
      '╭▱▱ ɢᴏᴏᴅʙʏᴇ ▱▱ 🌙',
      '┃',
      '┃ 𓆩 {mention} 𓆪',
      '┃ ᴀ̀ ʙɪᴇɴᴛᴏ̂ᴛ • {group}',
      '┃',
      '╰▱▱▱▱▱▱▱▱▱▱▱▱▱'
    ].join('\n');
  }
  return compactGreetingEmojiNoise(resolved,isWelcome?2:1);
}

function renderBotGreetingText(template,users,chatTitle){
  const list=(Array.isArray(users)?users:[]).filter(Boolean);
  const safeUsers=list.length?list:[{id:'',first_name:'Membre'}];
  const names=safeUsers.map(greetingBotDisplayName);
  const first=safeUsers[0]||{};
  return String(template||'')
    .replaceAll('{mention}',names.join(', '))
    .replaceAll('{name}',names.join(', '))
    .replaceAll('{username}',first?.username?'@'+String(first.username).replace(/^@/,''):'')
    .replaceAll('{id}',String(first?.id||''))
    .replaceAll('{group}',String(chatTitle||'ce groupe'))
    .replaceAll('{count}',String(safeUsers.length));
}

function greetingMiniAppMarkup(){
  const username=String(cfg.botUsername||'').trim().replace(/^@/,'');
  const url=username
    ?'https://t.me/'+username+'?startapp=welcome'
    :String(cfg.connectUrl||'https://nex-telegrambots.vercel.app/');
  return {
    inline_keyboard:[[
      {text:'⚡ ᴏᴜᴠʀɪʀ ɴᴇxᴀɪ',url}
    ]]
  };
}

async function greetingProfilePhotoFileId(ctx,user){
  const memberId=Number(user?.id||0);
  const botId=Number(ctx.me?.id||0);
  const photoFor=async(id,label)=>{
    if(!id)return '';
    try{
      const photos=await ctx.api.getUserProfilePhotos(id,{offset:0,limit:1});
      const sizes=Array.isArray(photos?.photos?.[0])?photos.photos[0]:[];
      // Keep Telegram's original profile framing. No canvas crop, zoom or face-cut.
      return String(sizes.at(-1)?.file_id||sizes[0]?.file_id||'');
    }catch(error){
      console.warn('[NexAI greeting-avatar]',label,id,String(error?.description||error?.message||error).slice(0,280));
      return '';
    }
  };

  const memberPhoto=await photoFor(memberId,'member');
  if(memberPhoto)return memberPhoto;

  // A welcome must always keep the visual card. If the newcomer has no
  // profile photo, use NexAi's own Telegram profile photo instead of falling
  // back to a plain text welcome.
  if(botId&&botId!==memberId)return photoFor(botId,'nexai-fallback');
  return '';
}

async function greetingCaptionEntities(text){
  const value=String(text||'');
  const custom=await animatedCustomEmojiEntitySpecsFromLibrary(
    value,
    {},
    {sourceUsername:cfg.creatorUsername||'tresor20001'}
  ).catch(()=>[]);
  return [
    {type:'blockquote',offset:0,length:utf16len(value)},
    ...custom
  ];
}

function freshBotGreetingUsers(chatId,users,isWelcome){
  const now=Date.now();
  for(const [key,at] of botGreetingSeen){
    if(now-at>20_000)botGreetingSeen.delete(key);
  }
  const out=[];
  for(const user of users||[]){
    const id=String(user?.id||'');
    if(!id)continue;
    const key=[String(chatId),id,isWelcome?'welcome':'goodbye'].join(':');
    if(botGreetingSeen.has(key))continue;
    botGreetingSeen.set(key,now);
    out.push(user);
  }
  return out;
}

async function sendBotGreetingCard(ctx,chat,users,isWelcome,policy){
  const deliveryKind=isWelcome?'welcome':'goodbye';
  const deliveryUsers=[];
  for(const user of users||[]){
    try{
      if(await claimSharedGreetingDelivery(chat.id,user?.id,deliveryKind))deliveryUsers.push(user);
    }catch{
      deliveryUsers.push(user);
    }
  }
  if(!deliveryUsers.length)return true;
  const rawTemplate=isWelcome?policy.welcomeText:policy.goodbyeText;
  const template=greetingVisualTemplate(rawTemplate,isWelcome);
  const text=renderBotGreetingText(template,deliveryUsers,chat.title||'ce groupe').slice(0,1024);
  const entities=await greetingCaptionEntities(text);
  const reply_markup=greetingMiniAppMarkup();
  try{
    const profilePhoto=isWelcome?await greetingProfilePhotoFileId(ctx,deliveryUsers[0]):'';
    if(profilePhoto){
      await ctx.api.sendPhoto(chat.id,profilePhoto,{
        caption:text,
        caption_entities:entities,
        reply_markup
      });
    }else{
      await ctx.api.sendMessage(chat.id,text,{entities,reply_markup});
    }
    console.log('[NexAI greeting-bot]',isWelcome?'welcome':'goodbye','chat='+String(chat.id),'users='+deliveryUsers.map(x=>x.id).join(','),'profilePhoto='+Boolean(profilePhoto));
  }catch(error){
    for(const user of deliveryUsers){
      await releaseSharedGreetingDelivery(chat.id,user?.id,deliveryKind).catch(()=>{});
    }
    try{
      await ctx.api.sendMessage(chat.id,text,{
        entities:[{type:'blockquote',offset:0,length:utf16len(text)}],
        reply_markup
      });
    }catch{}
    console.error('[NexAI greeting-bot]',isWelcome?'welcome':'goodbye','chat='+String(chat.id),String(error?.description||error?.message||error).slice(0,500));
  }
  return true;
}

function chatMemberIsPresent(member){
  const status=String(member?.status||'');
  if(['creator','administrator','member'].includes(status))return true;
  if(status==='restricted')return member?.is_member===true;
  return false;
}

async function handleBotChatMember(ctx){
  const update=ctx.update?.chat_member;
  const chat=update?.chat;
  if(!update||!chat||chat.type==='private')return false;
  const before=chatMemberIsPresent(update.old_chat_member);
  const after=chatMemberIsPresent(update.new_chat_member);
  if(before===after)return false;
  const user=update.new_chat_member?.user||update.old_chat_member?.user;
  if(!user||String(user.id||'')===String(ctx.me?.id||''))return false;
  const isWelcome=!before&&after;
  const policy=await sharedGreetingPolicy(chat.id);
  if((isWelcome&&policy.welcome===false)||(!isWelcome&&policy.goodbye===false))return true;
  const users=freshBotGreetingUsers(chat.id,[user],isWelcome);
  if(!users.length)return true;
  return sendBotGreetingCard(ctx,chat,users,isWelcome,policy);
}

async function handleBotGreeting(ctx){
  const chat=ctx.chat;
  const message=ctx.message;
  if(!chat||!message||chat.type==='private')return false;

  const newcomers=(Array.isArray(message.new_chat_members)?message.new_chat_members:[])
    .filter(user=>String(user?.id||'')!==String(ctx.me?.id||''));
  const left=message.left_chat_member&&String(message.left_chat_member?.id||'')!==String(ctx.me?.id||'')
    ?[message.left_chat_member]
    :[];
  if(!newcomers.length&&!left.length)return false;

  const policy=await sharedGreetingPolicy(chat.id);
  const isWelcome=newcomers.length>0;
  if((isWelcome&&policy.welcome===false)||(!isWelcome&&policy.goodbye===false))return true;

  const users=freshBotGreetingUsers(chat.id,isWelcome?newcomers:left,isWelcome);
  if(!users.length)return true;
  return sendBotGreetingCard(ctx,chat,users,isWelcome,policy);
}
function telegramConflict409(error){
  const code=Number(error?.error_code||error?.error?.error_code||error?.error?.code||error?.code||0);
  const message=String(error?.description||error?.error?.description||error?.message||error?.error?.message||error||'');
  return code===409||/409: Conflict|terminated by other getUpdates request|only one bot instance/i.test(message);
}

async function startPollingWithTakeover(target){
  for(let attempt=1;attempt<=NEXAI_POLLER_CONFLICT_RETRIES;attempt++){
    try{
      await target.start({drop_pending_updates:false});
      return;
    }catch(error){
      if(!telegramConflict409(error))throw error;
      if(attempt>=NEXAI_POLLER_CONFLICT_RETRIES)throw error;
      const delay=Math.min(12_000,1200+(attempt-1)*900);
      console.warn('[NexAI poller] 409 conflict · retry '+attempt+'/'+NEXAI_POLLER_CONFLICT_RETRIES+' in '+delay+'ms');
      await wait(delay);
    }
  }
}

function clearPollerLeaseTimer(){
  if(pollerLeaseTimer)clearInterval(pollerLeaseTimer);
  pollerLeaseTimer=null;
}

function clearPollerSupervisorTimer(){
  if(pollerSupervisorTimer)clearTimeout(pollerSupervisorTimer);
  pollerSupervisorTimer=null;
}

function pollerRestartDelay(){
  return Math.min(30_000,1500*(2**Math.min(4,pollerRestartAttempt)));
}

function schedulePollerSupervisor(delayMs=0){
  if(pollerSupervisorStopping||pollerSupervisorRunning||pollerSupervisorTimer||!bot||!pollerLeaseKey)return;
  pollerSupervisorTimer=setTimeout(()=>{
    pollerSupervisorTimer=null;
    runPollerSupervisor().catch(error=>{
      console.error('[NexAI poller supervisor]',String(error?.message||error).slice(0,500));
    });
  },Math.max(0,Number(delayMs)||0));
  pollerSupervisorTimer.unref?.();
}

async function runPollerSupervisor(){
  if(pollerSupervisorStopping||pollerSupervisorRunning||!bot||!pollerLeaseKey)return false;
  pollerSupervisorRunning=true;
  const leaseKey=pollerLeaseKey;
  let ownsLease=false;
  try{
    ownsLease=await acquireServiceLease(leaseKey,cfg.workerId,NEXAI_POLLER_LEASE_TTL_MS);
    if(!ownsLease){
      console.warn('[NexAI poller] standby · another NexAccount worker owns '+leaseKey);
      return false;
    }

    clearPollerLeaseTimer();
    pollerLeaseTimer=setInterval(async()=>{
      const renewed=await renewServiceLease(leaseKey,cfg.workerId,NEXAI_POLLER_LEASE_TTL_MS).catch(()=>false);
      if(renewed)return;
      clearPollerLeaseTimer();
      console.error('[NexAI poller] lease lost · stopping local polling for takeover');
      try{await bot?.stop()}catch{}
    },NEXAI_POLLER_LEASE_RENEW_MS);
    pollerLeaseTimer.unref?.();

    pollerRestartAttempt=0;
    console.log('[NexAI poller] lease acquired · polling active');
    await startPollingWithTakeover(bot);
    if(!pollerSupervisorStopping){
      console.warn('[NexAI poller] polling stopped unexpectedly · scheduling recovery');
    }
    return true;
  }catch(error){
    console.error('[NexAI poller] polling failed',String(error?.description||error?.message||error).slice(0,700));
    return false;
  }finally{
    clearPollerLeaseTimer();
    if(ownsLease&&leaseKey){
      await releaseServiceLease(leaseKey,cfg.workerId).catch(()=>{});
    }
    pollerSupervisorRunning=false;
    if(!pollerSupervisorStopping&&pollerLeaseKey===leaseKey){
      pollerRestartAttempt=Math.min(8,pollerRestartAttempt+1);
      schedulePollerSupervisor(pollerRestartDelay());
    }
  }
}


const monoUiCache=new Map();

function monoUiKey(chatId){
  return 'nexai_mono_ui:'+String(chatId);
}

async function monoUiState(chatId){
  const key=String(chatId||'');
  if(!key)return null;
  if(monoUiCache.has(key))return monoUiCache.get(key);
  try{
    const d=await db();
    const row=await d.collection('nexaccount_system').findOne({_id:monoUiKey(key)});
    const state=row?.messageId?{chatId:key,messageId:Number(row.messageId)}:null;
    monoUiCache.set(key,state);
    return state;
  }catch{
    return null;
  }
}

async function rememberMonoUi(chatId,messageId){
  const key=String(chatId||'');
  const id=Number(messageId||0);
  if(!key||!id)return;
  const state={chatId:key,messageId:id};
  monoUiCache.set(key,state);
  try{
    const d=await db();
    await d.collection('nexaccount_system').updateOne(
      {_id:monoUiKey(key)},
      {$set:{chatId:key,messageId:id,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},
      {upsert:true}
    );
  }catch{}
}

async function forgetMonoUi(chatId,messageId=0){
  const key=String(chatId||'');
  if(!key)return;
  const current=monoUiCache.get(key);
  if(messageId&&current?.messageId&&Number(current.messageId)!==Number(messageId))return;
  monoUiCache.delete(key);
  try{
    const d=await db();
    const filter={_id:monoUiKey(key)};
    if(messageId)filter.messageId=Number(messageId);
    await d.collection('nexaccount_system').deleteOne(filter);
  }catch{}
}

async function removePreviousMonoUi(ctx,{exceptMessageId=0}={}){
  if(ctx.chat?.type!=='private'||!ctx.chat?.id)return;
  const state=await monoUiState(ctx.chat.id);
  const previousId=Number(state?.messageId||0);
  if(!previousId||previousId===Number(exceptMessageId||0))return;
  await ctx.api.deleteMessage(ctx.chat.id,previousId).catch(()=>{});
  await forgetMonoUi(ctx.chat.id,previousId);
}

async function monoReplyText(ctx,text,options={}){
  if(ctx.chat?.type!=='private')return ctx.reply(text,options);
  await removePreviousMonoUi(ctx);
  const message=await ctx.reply(text,options);
  await rememberMonoUi(ctx.chat.id,message?.message_id);
  return message;
}

async function monoReplyPhoto(ctx,photo,options={}){
  if(ctx.chat?.type!=='private')return ctx.replyWithPhoto(photo,options);
  await removePreviousMonoUi(ctx);
  const message=await ctx.replyWithPhoto(photo,options);
  await rememberMonoUi(ctx.chat.id,message?.message_id);
  return message;
}

async function monoReplyVideo(ctx,video,options={}){
  if(ctx.chat?.type!=='private')return ctx.replyWithVideo(video,options);
  await removePreviousMonoUi(ctx);
  const message=await ctx.replyWithVideo(video,options);
  await rememberMonoUi(ctx.chat.id,message?.message_id);
  return message;
}

async function adoptCallbackMonoUi(ctx){
  const message=ctx.callbackQuery?.message;
  if(ctx.chat?.type==='private'&&message?.message_id){
    await rememberMonoUi(ctx.chat.id,message.message_id);
  }
}

function nexAiReplyArtworkInput(){
  if(!replyArtworkBuffer){
    const encoded=fs.readFileSync(new URL('./assets/nexai-reply-artwork.jpg.b64',import.meta.url),'utf8').replace(/\\s+/g,'');
    replyArtworkBuffer=Buffer.from(encoded,'base64');
    if(!replyArtworkBuffer.length)throw new Error('nexai_reply_artwork_empty');
  }
  return new InputFile(replyArtworkBuffer,'nexai-reply-artwork.jpg');
}

async function sendReplyArtwork(ctx){
  try{
    return await ctx.replyWithPhoto(nexAiReplyArtworkInput());
  }catch(error){
    console.warn('[NexAI reply artwork]',String(error?.description||error?.message||error).slice(0,350));
    return null;
  }
}

async function cachePhotoFileId(photoUrl,chatId){
  const key=String(photoUrl||'').trim();
  if(!key||!chatId)return '';
  const cached=photoFileIdCache.get(key);
  if(cached)return cached;
  if(photoCachePending.has(key))return photoCachePending.get(key);

  const pending=(async()=>{
    let sent=null;
    try{
      sent=await bot.api.sendPhoto(chatId,key,{disable_notification:true});
      const photos=Array.isArray(sent?.photo)?sent.photo:[];
      const fileId=String(photos.at(-1)?.file_id||'');
      if(fileId){
        if(photoFileIdCache.size>=256){
          const first=photoFileIdCache.keys().next().value;
          if(first)photoFileIdCache.delete(first);
        }
        photoFileIdCache.set(key,fileId);
      }
      return fileId;
    }catch(error){
      console.warn('[NexAI artwork cache]',String(error?.description||error?.message||error).slice(0,350));
      return '';
    }finally{
      if(sent?.message_id)await bot.api.deleteMessage(chatId,sent.message_id).catch(()=>{});
      photoCachePending.delete(key);
    }
  })();
  photoCachePending.set(key,pending);
  return pending;
}

function rememberWebPair(userId){
  webPairUsers.set(String(userId),Date.now()+10*60*1000);
}

function webPairActive(userId){
  const key=String(userId);
  const until=Number(webPairUsers.get(key)||0);
  if(until>Date.now())return true;
  webPairUsers.delete(key);
  return false;
}

function callbackAccessAllowed(clickerId,accountId,accessMode='private',clickerUsername=''){
  return String(accessMode)==='public'
    ||String(clickerId)===String(accountId)
    ||isOwnerIdentity(clickerId,clickerUsername);
}

const CONNECT_TUTORIAL_CALLBACK='connect:tutorial';
const CONNECT_TUTORIAL_RECORD_ID='nexai_connection_tutorial';
const TELEGRAM_BOT_VIDEO_LIMIT=50*1024*1024;
const TELEGRAM_BOT_DOWNLOAD_LIMIT=20*1024*1024;

async function tutorialVideoConfig(){
  const d=await db();
  const row=await d.collection('nexaccount_system').findOne({_id:CONNECT_TUTORIAL_RECORD_ID});
  return {
    fileId:String(row?.fileId||''),
    fileUniqueId:String(row?.fileUniqueId||''),
    size:Number(row?.size||0),
    width:Number(row?.width||0),
    height:Number(row?.height||0),
    duration:Number(row?.duration||0),
    mimeType:String(row?.mimeType||'video/mp4'),
    storageChatId:String(row?.storageChatId||''),
    storageMessageId:Number(row?.storageMessageId||0),
    archived:row?.archived===true,
    setBy:String(row?.setBy||''),
    updatedAt:row?.updatedAt||null
  };
}

async function saveTutorialVideoConfig(value={}){
  const d=await db(),now=new Date();
  const clean={
    fileId:String(value.fileId||''),
    fileUniqueId:String(value.fileUniqueId||''),
    size:Number(value.size||0),
    width:Number(value.width||0),
    height:Number(value.height||0),
    duration:Number(value.duration||0),
    mimeType:String(value.mimeType||'video/mp4'),
    storageChatId:String(value.storageChatId||''),
    storageMessageId:Number(value.storageMessageId||0),
    archived:value.archived===true,
    setBy:String(value.setBy||''),
    updatedAt:now
  };
  if(!clean.fileId)throw new Error('tutorial_file_id_missing');
  await d.collection('nexaccount_system').updateOne(
    {_id:CONNECT_TUTORIAL_RECORD_ID},
    {$set:clean,$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
  return clean;
}

async function downloadMainBotFile(fileId){
  const info=await bot.api.getFile(String(fileId));
  const size=Number(info?.file_size||0);
  if(size>TELEGRAM_BOT_DOWNLOAD_LIMIT)throw new Error('tutorial_bot_download_limit');
  const filePath=String(info?.file_path||'');
  if(!filePath)throw new Error('tutorial_file_path_missing');
  const token=await loadBotToken();
  const response=await fetch('https://api.telegram.org/file/bot'+token+'/'+filePath,{
    signal:AbortSignal.timeout(45000)
  });
  if(!response.ok)throw new Error('tutorial_download_http_'+response.status);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(!buffer.length)throw new Error('tutorial_download_empty');
  if(buffer.length>TELEGRAM_BOT_DOWNLOAD_LIMIT)throw new Error('tutorial_bot_download_limit');
  return buffer;
}

async function archiveTutorialVideo(ctx,message,video){
  const size=Number(video?.file_size||0);

  if(size>0&&size<=TELEGRAM_BOT_DOWNLOAD_LIMIT){
    try{
      const buffer=await downloadMainBotFile(video.file_id);
      const stored=await storeReplyVideo(buffer,{
        telegramUserId:'tutorial:'+String(ctx.from?.id||''),
        filenamePrefix:'nexai-connection-tutorial-hq',
        caption:'NexAI · Tutoriel connexion · HQ'
      });
      return {
        archived:true,
        storageChatId:String(stored.chatId||''),
        storageMessageId:Number(stored.messageId||0),
        storageProvider:'nexai-storage-bot'
      };
    }catch(error){
      console.warn('[NexAI tutorial storage bot]',String(error?.description||error?.message||error).slice(0,400));
    }
  }

  try{
    const storage=await resolveReplyStorageChannel({discover:true});
    const copied=await ctx.api.copyMessage(
      storage.chatId,
      ctx.chat.id,
      Number(message.message_id),
      {
        caption:'NexAI · Tutoriel connexion · HQ',
        disable_notification:true,
        protect_content:true
      }
    );
    return {
      archived:true,
      storageChatId:String(storage.chatId||''),
      storageMessageId:Number(copied?.message_id||0),
      storageProvider:'nexai-main-bot-copy'
    };
  }catch(error){
    console.warn('[NexAI tutorial archive]',String(error?.description||error?.message||error).slice(0,400));
    return {archived:false,storageChatId:'',storageMessageId:0,storageProvider:'telegram-file-id'};
  }
}

function connectMarkup(lang){
  return {
    inline_keyboard:[
      [{
        text:lang==='en'?'Open Mini App':'Ouvrir la Mini App',
        web_app:{url:'https://nex-telegrambots.vercel.app/'}
      }],
      [{
        text:lang==='en'?'🎬 View tutorial':'🎬 Voir le tuto',
        callback_data:CONNECT_TUTORIAL_CALLBACK
      }]
    ]
  };
}

async function sendConnectTutorial(ctx,lang){
  const tutorial=await tutorialVideoConfig().catch(()=>({fileId:''}));
  if(tutorial.fileId){
    const caption=lang==='en'
      ? '🎬 NexAI · Connection tutorial\n\nFollow the video, then tap “Open Mini App”.'
      : '🎬 NexAI · Tutoriel de connexion\n\nSuis la vidéo, puis appuie sur « Ouvrir la Mini App ».';
    try{
      return await monoReplyVideo(ctx,tutorial.fileId,{
        caption,
        supports_streaming:true,
        reply_markup:{
          inline_keyboard:[[
            {
              text:lang==='en'?'Open Mini App':'Ouvrir la Mini App',
              web_app:{url:'https://nex-telegrambots.vercel.app/'}
            }
          ]]
        }
      });
    }catch(error){
      console.error('[NexAI tutorial send]',String(error?.description||error?.message||error).slice(0,500));
    }
  }

  const t=lang==='en'
    ? [
        '🎬 NEXAI · CONNECTION TUTORIAL',
        '',
        '1. Tap “Open Mini App”.',
        '2. Choose “By phone number”.',
        '3. Enter your Telegram number with the country code, then tap “Receive code”.',
        '4. Open the message sent by Telegram and copy the login code.',
        '5. Return to the NexAI Mini App and enter that code there.',
        '6. If 2FA is enabled, enter your Telegram 2FA password only inside the Mini App.',
        '7. Wait for “Account connected”. NexAI will then activate the session.',
        '',
        'Never send your login code or 2FA password in the bot chat.'
      ].join('\n')
    : [
        '🎬 NEXAI · TUTO CONNEXION',
        '',
        '1. Appuie sur « Ouvrir la Mini App ».',
        '2. Choisis « Par numéro ».',
        '3. Entre ton numéro Telegram avec l’indicatif du pays, puis appuie sur « Recevoir le code ».',
        '4. Ouvre le message envoyé par Telegram et copie le code de connexion.',
        '5. Reviens dans la Mini App NexAI et saisis ce code.',
        '6. Si la 2FA est activée, entre ton mot de passe Telegram uniquement dans la Mini App.',
        '7. Attends « Compte connecté ». NexAI activera ensuite la session.',
        '',
        'N’envoie jamais ton code de connexion ou ton mot de passe 2FA dans le chat du bot.'
      ].join('\n');
  return monoReplyText(ctx,t,{
    entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}],
    reply_markup:connectMarkup(lang),
    link_preview_options:{is_disabled:true}
  });
}

async function sendPairLink(ctx,lang){
  rememberWebPair(ctx.from.id);
  const t=lang==='en'
    ? 'Connect your Telegram account without leaving Telegram.\n\n1. Tap “Open Mini App”.\n2. Enter your Telegram phone number.\n3. Enter the login code only inside the Mini App.\n4. If Telegram asks for 2FA, enter the password only inside the Mini App.\n\nNever send a login code or 2FA password in this bot chat.'
    : 'Connecte ton compte Telegram sans quitter Telegram.\n\n1. Appuie sur « Ouvrir la Mini App ».\n2. Entre ton numéro Telegram.\n3. Entre le code de connexion uniquement dans la Mini App.\n4. Si Telegram demande la 2FA, entre le mot de passe uniquement dans la Mini App.\n\nN’envoie jamais un code de connexion ou un mot de passe 2FA dans ce chat.';
  return monoReplyText(ctx,t,{
    entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}],
    reply_markup:connectMarkup(lang),
    link_preview_options:{is_disabled:true}
  });
}

function stampMarkup(markup,accountId){
  const copy=structuredClone(markup||{inline_keyboard:[]});
  for(const row of copy.inline_keyboard||[]){
    for(const b of row){
      if(b.callback_data)b.callback_data=b.callback_data+'|'+String(accountId);
    }
  }
  return copy;
}

function portableMarkup(markup){
  const copy=structuredClone(markup||{inline_keyboard:[]});
  for(const row of copy.inline_keyboard||[]){
    for(const button of row){
      // Button colors and custom emoji are optional presentation features.
      // If Telegram rejects either capability, callbacks must still stay alive.
      delete button.style;
      delete button.icon_custom_emoji_id;
    }
  }
  return copy;
}

function portableEntities(entities,maxLength){
  const safe=new Set(['bot_command','blockquote','expandable_blockquote','text_link']);
  return (entities||[]).filter(e=>safe.has(e.type)&&e.offset+e.length<=maxLength);
}

function noEmojiPortableModel(model,maxLength=4096){
  const source=String(model?.text||'').slice(0,maxLength);
  const text=sanitizeAnimatedEmojiText(source,{});
  const allowed=new Set(['bot_command','blockquote','expandable_blockquote','text_link']);
  const entities=(model?.entities||[])
    .filter(e=>allowed.has(e.type)&&e.offset>=0&&e.length>0&&e.offset+e.length<=source.length)
    .map(e=>{
      const before=source.slice(0,e.offset);
      const inside=source.slice(e.offset,e.offset+e.length);
      return {
        ...e,
        offset:utf16len(sanitizeAnimatedEmojiText(before,{})),
        length:utf16len(sanitizeAnimatedEmojiText(inside,{}))
      };
    })
    .filter(e=>e.length>0);
  return {...model,text,entities};
}

function textInputContent(model,entities,disableArtwork=false){
  return {
    message_text:model.text.slice(0,4096),
    entities,
    link_preview_options:!disableArtwork&&model.photoUrl
      ?{url:model.photoUrl,prefer_large_media:true,show_above_text:true}
      :{is_disabled:true}
  };
}

function inlineCachedMediaResult(model,accountId,id,portable=false){
  const media=model?.media||{};
  const type=String(media.type||'');
  const fileId=String(media.fileId||'');
  if(!['photo','video'].includes(type)||!fileId)return null;
  const stamped=stampMarkup(model.reply_markup,accountId);
  const reply_markup=portable?portableMarkup(stamped):stamped;
  const safeModel=portable?noEmojiPortableModel(model,1024):model;
  const caption=String(safeModel.text||'').slice(0,1024);
  const caption_entities=(portable?safeModel.entities:model.entities).filter(e=>e.offset+e.length<=caption.length);
  if(type==='photo'){
    return {type:'photo',id,photo_file_id:fileId,caption,caption_entities,reply_markup};
  }
  return {type:'video',id,video_file_id:fileId,title:'NexAI',caption,caption_entities,reply_markup};
}

function inlineCachedPhotoResult(model,accountId,id,fileId,portable=false){
  const stamped=stampMarkup(model.reply_markup,accountId);
  const reply_markup=portable?portableMarkup(stamped):stamped;
  const safeModel=portable?noEmojiPortableModel(model,4096):model;
  const textEntities=portable?safeModel.entities:model.entities.filter(e=>e.offset+e.length<=4096);
  return {
    type:'photo',
    id,
    photo_file_id:fileId,
    input_message_content:textInputContent(safeModel,textEntities),
    reply_markup
  };
}

function inlineResult(model,accountId,id='menu',forceArticle=false,portable=false,disableArtwork=false){
  const stamped=stampMarkup(model.reply_markup,accountId);
  const reply_markup=portable?portableMarkup(stamped):stamped;
  const safeModel=portable?noEmojiPortableModel(model,4096):model;
  const textEntities=portable?safeModel.entities:model.entities.filter(e=>e.offset+e.length<=4096);
  const input_message_content=textInputContent(safeModel,textEntities,disableArtwork);

  // A photo result keeps a visual thumbnail in the inline picker, but
  // input_message_content makes Telegram send an editable TEXT message with
  // the artwork as a large link preview. This avoids the 1024-char caption
  // limit and keeps Home -> Category navigation in one stable message.
  if(model.photoUrl&&!forceArticle){
    return {
      type:'photo',id,
      photo_url:model.photoUrl,
      thumbnail_url:model.photoUrl,
      input_message_content,
      reply_markup
    };
  }
  return {
    type:'article',id,title:'NexAI',description:'NexAccount menu',
    input_message_content,
    reply_markup
  };
}

function inlineReplyModel(value,settings={}){
  const raw=sanitizeAnimatedEmojiText(String(value??'').trim(),settings?.customEmojiIds||{});
  const label='By Nextech';
  const maxBase=Math.max(0,4096-label.length-2);
  const base=raw.slice(0,maxBase);
  const text=(base?base+'\n\n':'')+label;
  const entities=[];

  for(const m of text.matchAll(/\/[a-z][a-z0-9_]{0,63}/gi)){
    entities.push({
      type:'bot_command',
      offset:utf16len(text.slice(0,m.index)),
      length:utf16len(m[0])
    });
  }
  entities.push(...inlineCustomEmojiEntities(text,settings));

  const linkStart=text.lastIndexOf(label);
  if(cfg.nextechUrl&&linkStart>=0){
    entities.push({
      type:'text_link',
      offset:utf16len(text.slice(0,linkStart)),
      length:utf16len(label),
      url:cfg.nextechUrl
    });
  }

  const customId=String(settings?.customEmojiIds?.NEXAI_EMOJI_NEXTECH||'').trim();
  const hasCustom=/^\d{5,30}$/.test(customId);
  const button={text:(hasCustom?'':'⚡ ')+'ɴᴇxᴛᴇᴄʜ',url:cfg.nextechUrl,style:'success'};
  if(hasCustom)button.icon_custom_emoji_id=customId;

  return {
    text,
    entities,
    reply_markup:{inline_keyboard:cfg.nextechUrl?[[button]]:[]},
    photoUrl:''
  };
}

async function inlineReplyModelFromLibrary(value,settings={}){
  const model=inlineReplyModel(value,settings);
  const withoutCustom=(model.entities||[]).filter(e=>e.type!=='custom_emoji');
  const libraryEntities=await animatedCustomEmojiEntitySpecsFromLibrary(
    model.text,
    settings?.customEmojiIds||{},
    {sourceUsername:cfg.creatorUsername||'tresor20001'}
  );
  return {...model,entities:[...withoutCustom,...libraryEntities]};
}

async function groupCardModelFromLibrary(row,settings={}){
  const payload=row?.payload&&typeof row.payload==='object'?row.payload:{};
  const text=String(payload.text||row?.text||'').slice(0,4096);
  const entities=(Array.isArray(payload.entities)?payload.entities:[])
    .filter(e=>e&&Number(e.offset)>=0&&Number(e.length)>0&&Number(e.offset)+Number(e.length)<=utf16len(text));
  const libraryEntities=await animatedCustomEmojiEntitySpecsFromLibrary(
    text,
    settings?.customEmojiIds||{},
    {sourceUsername:cfg.creatorUsername||'tresor20001'}
  ).catch(()=>[]);
  return {
    text,
    entities:[...entities,...libraryEntities],
    reply_markup:payload.reply_markup&&typeof payload.reply_markup==='object'
      ?payload.reply_markup
      :greetingMiniAppMarkup(),
    photoUrl:String(payload.photoUrl||'')
  };
}

async function modelFor(account,query){
  const entitlement=await nexAiPremiumState(account.telegramUserId).catch(()=>({active:false,expiresAt:null}));
  account={
    ...account,
    telegramPremium:account.telegramPremium===true||account.premium===true,
    nexaiPremium:isOwnerId(account.telegramUserId)||entitlement.active===true,
    nexaiPremiumExpiresAt:entitlement.expiresAt||null
  };
  const settings=await ensureEmojiLibraryPalette(account.telegramUserId,{
    sourceUsername:cfg.creatorUsername||'tresor20001'
  }).catch(()=>settingsFor(account.telegramUserId));
  const rawQuery=String(query||'').trim();
  const q=rawQuery.toLowerCase();
  if(q.startsWith('reply:')){
    const token=rawQuery.slice('reply:'.length).trim();
    const row=await getInlineResponse(token,account.telegramUserId);
    if(!row){
      console.warn('[NexAI inline reply] missing_or_expired',String(account.telegramUserId),token.slice(0,8));
      return null;
    }
    return inlineReplyModelFromLibrary(row.text,settings);
  }
  if(q.startsWith('groupcard:')){
    const token=rawQuery.slice('groupcard:'.length).trim();
    const row=await getInlineResponse(token,account.telegramUserId);
    if(!row){
      console.warn('[NexAI group card] missing_or_expired',String(account.telegramUserId),token.slice(0,8));
      return null;
    }
    return groupCardModelFromLibrary(row,settings);
  }
  if(q==='styles'||q==='style')return stylesModel({account,settings});
  if(q==='customstyle'||q==='custom-style')return customStyleModel({account,settings});
  if(q.startsWith('cat:')){
    const [,catRaw,pageRaw='0']=q.split(':');
    return menuModel({account,settings,commands,view:'category',category:String(catRaw||'').toUpperCase(),page:Number(pageRaw)||0});
  }
  return menuModel({account,settings,commands,view:'home'});
}

async function sendModelMessage(ctx,model,accountId){
  const rich=stampMarkup(model.reply_markup,accountId);
  const media=model?.media||{};
  const mediaType=String(media.type||'');
  const mediaFileId=String(media.fileId||'');
  if(mediaFileId&&['photo','video'].includes(mediaType)){
    const caption=String(model.text||'').slice(0,1024);
    const options={
      caption,
      caption_entities:(model.entities||[]).filter(e=>e.offset+e.length<=caption.length),
      reply_markup:rich
    };
    if(mediaType==='photo')return monoReplyPhoto(ctx,mediaFileId,options);
    return monoReplyVideo(ctx,mediaFileId,options);
  }
  const plain=portableMarkup(rich);
  const errors=[];
  const preview=model.photoUrl
    ?{url:model.photoUrl,prefer_large_media:true,show_above_text:true}
    :{is_disabled:true};
  const noEmoji=noEmojiPortableModel(model,4096);
  const attempts=[
    ['text-rich',model.text,model.entities.filter(e=>e.offset+e.length<=4096),preview,rich],
    ['text-portable-buttons',model.text,model.entities.filter(e=>e.offset+e.length<=4096),preview,plain],
    ['text-no-artwork',noEmoji.text,noEmoji.entities,{is_disabled:true},plain]
  ];

  for(const [kind,messageText,entities,link_preview_options,reply_markup] of attempts){
    try{
      return await monoReplyText(ctx,messageText.slice(0,4096),{
        entities,
        link_preview_options,
        reply_markup
      });
    }catch(error){
      errors.push(kind+':'+String(error?.description||error?.message||error).slice(0,350));
    }
  }
  throw new Error('menu_send_failed '+errors.join(' | '));
}

async function sendDirectMenu(ctx,account,query='menu'){
  const model=await modelFor(account,query);
  return sendModelMessage(ctx,model,account.telegramUserId);
}

async function editInline(ctx,model,accountId,{replaceMedia=false}={}){
  const target=ctx.callbackQuery.inline_message_id||ctx.callbackQuery.message;
  if(!target)throw new Error('callback_message_target_missing');
  const rich=stampMarkup(model.reply_markup,accountId);
  const markups=[['rich',rich],['portable',portableMarkup(rich)]];
  const errors=[];
  const preview=model.photoUrl
    ?{url:model.photoUrl,prefer_large_media:true,show_above_text:true}
    :{is_disabled:true};

  // New menus are always editable text messages. Artwork is optional:
  // a dead/unsupported preview must never prevent categories or styles from loading.
  const noEmoji=noEmojiPortableModel(model,4096);
  const textAttempts=[
    ['rich',model.text,rich,model.entities.filter(e=>e.offset+e.length<=4096),preview],
    ['portable-buttons',model.text,portableMarkup(rich),model.entities.filter(e=>e.offset+e.length<=4096),preview],
    ['no-artwork',noEmoji.text,portableMarkup(rich),noEmoji.entities,{is_disabled:true}]
  ];
  for(const [kind,messageText,reply_markup,entities,link_preview_options] of textAttempts){
    try{
      await ctx.editMessageText(messageText.slice(0,4096),{
        entities,
        link_preview_options,
        reply_markup
      });
      return 'text-'+kind;
    }catch(error){
      errors.push('text-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
    }
  }

  // Compatibility only for old photo-menu messages created before this
  // refactor. Never truncate a long category merely to fit a media caption.
  if(model.text.length<=1024){
    for(const [kind,reply_markup] of markups){
      try{
        await ctx.editMessageCaption({
          caption:kind==='rich'?model.text:noEmojiPortableModel(model,1024).text,
          caption_entities:kind==='rich'?model.entities.filter(e=>e.offset+e.length<=1024):noEmojiPortableModel(model,1024).entities,
          reply_markup
        });
        return 'legacy-caption-'+kind;
      }catch(error){
        errors.push('legacy-caption-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
      }
    }
  }

  throw new Error('menu_edit_failed '+errors.join(' | '));
}

async function preferredLanguage(userId,telegramLanguage=''){
  const s=await settingsFor(userId).catch(()=>null);
  const v=String(s?.language||telegramLanguage||'fr').toLowerCase();
  return v.startsWith('en')?'en':'fr';
}

function quotedEntities(text,commandsList=[]){
  const entities=[{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
  for(const c of commandsList){
    let from=0;
    while(true){
      const i=text.indexOf(c,from);
      if(i<0)break;
      entities.push({type:'bot_command',offset:utf16len(text.slice(0,i)),length:utf16len(c)});
      from=i+c.length;
    }
  }
  return entities;
}

function ownerEntities(text){
  const entities=[{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
  const re=/\/[a-z][a-z0-9_]*/gi;
  for(const m of text.matchAll(re)){
    entities.push({type:'bot_command',offset:utf16len(text.slice(0,m.index)),length:utf16len(m[0])});
  }
  return entities;
}

async function sendBareLanguage(ctx,arg=''){
  const value=String(arg||'').trim().toLowerCase();
  if(value==='fr'||value==='en'){
    await patchSettings(ctx.from.id,{language:value});
    const t=value==='fr'?'🇫🇷 ʟᴀɴɢᴜᴇ • ғʀᴀɴçᴀɪѕ':'🇬🇧 ʟᴀɴɢᴜᴀɢᴇ • ᴇɴɢʟɪѕʜ';
    return monoReplyText(ctx,t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
  }
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  const t=lang==='en'?'ᴜѕᴇ language fr ᴏʀ language en.':'ᴜᴛɪʟɪѕᴇ language fr ᴏᴜ language en.';
  return monoReplyText(ctx,t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
}


async function connectedAccountForStyle(ctx){
  const account=await accountRecord(ctx.from.id);
  if(account?.enabled===true)return account;
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  await sendPairLink(ctx,lang);
  return null;
}

async function updateCustomStyle(userId,patch={}){
  const settings=await settingsFor(userId);
  const current=customStyleFor(settings);
  const next=normalizeCustomStyle({
    ...current,
    ...patch,
    media:patch.media===undefined?current.media:patch.media
  });
  await patchSettings(userId,{customStyle:next});
  return next;
}

function styleArg(ctx){
  return String(ctx.match??ctx.__nexaiBareArgs??'').trim();
}

async function showCustomStyle(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  return sendDirectMenu(ctx,account,'customstyle');
}

async function configureCustomStyle(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const action=styleArg(ctx).toLowerCase();
  if(!action)return sendDirectMenu(ctx,account,'customstyle');
  if(action==='on'){
    await updateCustomStyle(ctx.from.id,{enabled:true});
  }else if(action==='off'){
    await updateCustomStyle(ctx.from.id,{enabled:false});
  }else if(action==='reset'){
    await patchSettings(ctx.from.id,{customStyle:normalizeCustomStyle({})});
  }else{
    return ctx.reply('Usage : /customstyle on | off | reset');
  }
  return sendDirectMenu(ctx,account,'customstyle');
}

async function configureBotName(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const value=styleArg(ctx).slice(0,32);
  if(!value)return ctx.reply('Usage : /botname <nom>');
  await patchSettings(ctx.from.id,{botDisplayName:value});
  return sendDirectMenu(ctx,account,'customstyle');
}

async function configureStyleName(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const value=styleArg(ctx).slice(0,32);
  if(!value)return ctx.reply('Usage : /stylename <nom>');
  await updateCustomStyle(ctx.from.id,{enabled:true,name:value});
  return sendDirectMenu(ctx,account,'customstyle');
}

async function configureStyleEmoji(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const values=styleArg(ctx).split(/\s+/).map(x=>x.trim()).filter(Boolean).slice(0,6);
  if(!values.length)return ctx.reply('Usage : /styleemoji ✨ ⚡ 🖤');
  const valid=values.filter(x=>{
    try{return /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(x)}catch{return /[^\x00-\x7F]/.test(x)}
  });
  if(!valid.length)return ctx.reply('Ajoute au moins un emoji valide.');
  await updateCustomStyle(ctx.from.id,{enabled:true,emojis:valid});
  return sendDirectMenu(ctx,account,'customstyle');
}

async function configureStyleTagline(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const value=styleArg(ctx).slice(0,96);
  await updateCustomStyle(ctx.from.id,{enabled:true,tagline:value});
  return sendDirectMenu(ctx,account,'customstyle');
}

async function configureStyleButtons(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const value=styleArg(ctx).toLowerCase();
  if(!['primary','success','danger'].includes(value)){
    return ctx.reply('Usage : /stylebuttons primary | success | danger');
  }
  await updateCustomStyle(ctx.from.id,{enabled:true,buttonStyle:value});
  return sendDirectMenu(ctx,account,'customstyle');
}

function repliedPhotoFile(message){
  const photos=Array.isArray(message?.reply_to_message?.photo)?message.reply_to_message.photo:[];
  const photo=photos.at(-1);
  return photo?{fileId:String(photo.file_id||''),fileUniqueId:String(photo.file_unique_id||'')} : null;
}

function repliedVideoFile(message){
  const video=message?.reply_to_message?.video;
  return video?{fileId:String(video.file_id||''),fileUniqueId:String(video.file_unique_id||'')} : null;
}

async function configureMenuMedia(ctx,type){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const file=type==='photo'?repliedPhotoFile(ctx.message):repliedVideoFile(ctx.message);
  if(!file?.fileId){
    return ctx.reply(type==='photo'
      ?'Réponds à une photo avec /menuphoto.'
      :'Réponds à une vidéo avec /menuvideo.');
  }
  await updateCustomStyle(ctx.from.id,{
    enabled:true,
    media:{type,fileId:file.fileId,fileUniqueId:file.fileUniqueId}
  });
  return sendDirectMenu(ctx,account,'menu');
}

async function configureMenuMediaState(ctx){
  const account=await connectedAccountForStyle(ctx);
  if(!account)return;
  const value=styleArg(ctx).toLowerCase();
  if(value!=='off'&&value!=='none'&&value!=='reset')return ctx.reply('Usage : /menumedia off');
  await updateCustomStyle(ctx.from.id,{media:{type:'',fileId:'',fileUniqueId:''}});
  return sendDirectMenu(ctx,account,'customstyle');
}

async function handleBareDirectCommand(ctx,text){
  const value=String(text||'').trim();
  if(!value)return false;
  const [rawName,...args]=value.split(/\s+/);
  const name=String(rawName||'').toLowerCase();

  if(name==='start'){await sendStart(ctx);return true}
  if(name==='menu'||name==='help'){
    const account=await accountRecord(ctx.from.id);
    if(!account||account.enabled!==true){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await sendPairLink(ctx,lang);
      return true;
    }
    await recordEvent(ctx.from,'command',{source:'nexai',command:name,chatType:ctx.chat?.type||'private'}).catch(()=>{});
    await sendDirectMenu(ctx,account,'menu');
    return true;
  }
  if(name==='style'||name==='styles'){
    const account=await accountRecord(ctx.from.id);
    if(!account||account.enabled!==true){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await sendPairLink(ctx,lang);
      return true;
    }
    await sendDirectMenu(ctx,account,'styles');
    return true;
  }

  if(['customstyle','botname','stylename','styleemoji','styletagline','stylebuttons','menuphoto','menuvideo','menumedia'].includes(name)){
    ctx.__nexaiBareArgs=args.join(' ');
    try{
      if(name==='customstyle')await configureCustomStyle(ctx);
      else if(name==='botname')await configureBotName(ctx);
      else if(name==='stylename')await configureStyleName(ctx);
      else if(name==='styleemoji')await configureStyleEmoji(ctx);
      else if(name==='styletagline')await configureStyleTagline(ctx);
      else if(name==='stylebuttons')await configureStyleButtons(ctx);
      else if(name==='menuphoto')await configureMenuMedia(ctx,'photo');
      else if(name==='menuvideo')await configureMenuMedia(ctx,'video');
      else if(name==='menumedia')await configureMenuMediaState(ctx);
    }finally{
      delete ctx.__nexaiBareArgs;
    }
    return true;
  }

  if(['creator','about','founder','ceo'].includes(name)){await sendCreator(ctx);return true}
  if(name==='language'){await sendBareLanguage(ctx,args[0]||'');return true}
  if(name==='pair'){
    if(ctx.chat?.type==='private'){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await sendPairLink(ctx,lang);
    }
    return true;
  }
  if(name==='cancel'){
    webPairUsers.delete(String(ctx.from.id));
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    const t=lang==='en'?'✦ ᴄᴏɴɴᴇᴄᴛɪᴏɴ ᴘʀᴏᴍᴘᴛ ᴄʟᴏѕᴇᴅ.':'✦ ᴘᴀʀᴄᴏᴜʀѕ ᴅᴇ ᴄᴏɴɴᴇxɪᴏɴ ғᴇʀᴍé.';
    await ctx.reply(t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
    return true;
  }
  if(name==='ping'){
    await recordEvent(ctx.from,'command',{source:'nexai',command:'ping',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    await ctx.reply('Pong');
    return true;
  }
  if(name==='alive'){
    await recordEvent(ctx.from,'command',{source:'nexai',command:'alive',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    await ctx.reply('NexAI · online');
    return true;
  }
  if(['owner','users','botstats','activity','growth','commandstats','countries','languages','user'].includes(name)){
    await sendOwner(ctx,name,args);
    return true;
  }
  return false;
}

async function sendStart(ctx){
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  const account=await accountRecord(ctx.from.id);
  if(account?.enabled===true){
    await recordEvent(ctx.from,'command',{source:'nexai',command:'start',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    return sendDirectMenu(ctx,account,'menu');
  }

  const text=lang==='en'
    ? ['♰ ɴᴇxᴀɪ','','🔗 ᴄᴏɴɴᴇᴄᴛ ʏᴏᴜʀ ᴛᴇʟᴇɢʀᴀᴍ ᴀᴄᴄᴏᴜɴᴛ','/pair','','/creator','/language'].join('\n')
    : ['♰ ɴᴇxᴀɪ','','🔗 ʀᴇʟɪᴇ ᴛᴏɴ ᴄᴏᴍᴘᴛᴇ ᴛᴇʟᴇɢʀᴀᴍ','/pair','','/creator','/language'].join('\n');

  try{
    return await monoReplyPhoto(ctx,nexAiReplyArtworkInput(),{
      caption:text,
      caption_entities:quotedEntities(text,['/pair','/creator','/language']),
      reply_markup:connectMarkup(lang)
    });
  }catch(error){
    console.warn('[NexAI start artwork]',String(error?.description||error?.message||error).slice(0,350));
    return monoReplyText(ctx,text,{
      entities:quotedEntities(text,['/pair','/creator','/language']),
      reply_markup:connectMarkup(lang),
      link_preview_options:{is_disabled:true}
    });
  }
}

async function sendCreator(ctx){
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  const model=creatorCaptionModel(lang);
  await recordEvent(ctx.from,'command',{source:'nexai',command:'creator',chatType:ctx.chat?.type||'private'}).catch(()=>{});
  try{
    return await monoReplyPhoto(ctx,new InputFile(creatorImagePath()),{
      caption:model.text,
      caption_entities:model.entities
    });
  }catch(e){
    console.error('[NexAI creator photo]',String(e.message||e));
    return monoReplyText(ctx,model.text,{entities:model.entities});
  }
}

async function sendOwner(ctx,kind,args=[]){
  if(!isOwnerId(ctx.from?.id))return;
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  let text='';
  if(kind==='owner')text=await ownerPanelText(lang);
  else if(kind==='users')text=await usersText(lang);
  else if(kind==='botstats')text=await botStatsText(lang);
  else if(kind==='activity')text=await activityText(lang);
  else if(kind==='growth')text=await growthText(lang);
  else if(kind==='commandstats')text=await commandStatsText(lang);
  else if(kind==='countries')text=await countriesText(lang);
  else if(kind==='languages')text=await languagesText(lang);
  else if(kind==='user')text=await userText(args[0]||'',lang);
  if(!text)return;
  const settings=await settingsFor(ctx.from.id).catch(()=>null);
  const safe=sanitizeAnimatedEmojiText(text,settings?.customEmojiIds||{});
  await recordEvent(ctx.from,'owner_command',{source:'nexai',command:kind,chatType:ctx.chat?.type||'private'}).catch(()=>{});
  return monoReplyText(ctx,safe,{entities:[
    ...ownerEntities(safe),
    ...animatedCustomEmojiEntitySpecs(safe,settings?.customEmojiIds||{})
  ]});
}

function telegramCommandMenu(){
  // Only commands with real Bot API handlers belong in Telegram's native slash
  // menu. NexAccount commands are executed by the connected user session with
  // its configured prefix (normally ".") and must never be advertised here.
  return [
    {command:'start',description:'Démarrer NexAI'},
    {command:'menu',description:'Ouvrir le menu principal'},
    {command:'help',description:'Afficher l’aide'},
    {command:'pair',description:'Connecter un compte Telegram'},
    {command:'settutorial',description:'Définir la vidéo tutoriel (owner)'},
    {command:'premium',description:'NexAI Premium / Telegram Premium'},
    {command:'language',description:'Changer la langue'},
    {command:'creator',description:'Afficher le créateur'},
    {command:'customstyle',description:'Créer ou modifier mon style de menu'}
  ];
}

function syntheticAccount(user){
  return {
    telegramUserId:String(user?.id||''),
    username:String(user?.username||''),
    firstName:String(user?.first_name||''),
    lastName:String(user?.last_name||''),
    premium:user?.is_premium===true,
    telegramPremium:user?.is_premium===true,
    enabled:true
  };
}

async function premiumPanel(ctx){
  const account=await accountRecord(ctx.from.id)||syntheticAccount(ctx.from);
  return sendDirectMenu(ctx,account,'cat:PREMIUM');
}

async function sendNexAiPremiumInvoice(userId){
  const id=String(userId||'');
  if(!id)throw new Error('premium_user_required');
  return bot.api.sendInvoice(
    id,
    'NexAI Premium',
    'Toutes les fonctions NexAI Premium pendant 30 jours. Renouvellement automatique en Telegram Stars.',
    NEXAI_PREMIUM_PAYLOAD_PREFIX+id,
    'XTR',
    [{label:'NexAI Premium · 30 jours',amount:NEXAI_PREMIUM_STARS}],
    {subscription_period:NEXAI_PREMIUM_PERIOD_SECONDS}
  );
}

async function syncTelegramCommandMenu(bot){
  const rows=telegramCommandMenu();
  await bot.api.setMyCommands(rows);
  await bot.api.setChatMenuButton({
    menu_button:{
      type:'web_app',
      text:'Open',
      web_app:{url:'https://nex-telegrambots.vercel.app/'}
    }
  });
  console.log('[NexAI] Telegram command menu synced · '+rows.length+' commands · Mini App menu button active');
}

export async function startInlineBot(){
  const token=await loadBotToken();
  if(!token){
    console.warn('[NexAccount] NexAI token missing: inline menus disabled');
    return null;
  }
  bot=new Bot(token);

  bot.use(async(ctx,next)=>{
    if(ctx.from)await observeUser(ctx.from,{source:'nexai'}).catch(()=>{});

    // Global monomessage guard for private chats: every visible NexAI reply
    // replaces the previous bot UI message instead of stacking another one.
    if(ctx.chat?.type==='private'){
      if(ctx.callbackQuery?.message?.message_id){
        await rememberMonoUi(ctx.chat.id,ctx.callbackQuery.message.message_id);
      }

      const originalReply=ctx.reply.bind(ctx);
      const originalReplyWithPhoto=ctx.replyWithPhoto.bind(ctx);
      const originalReplyWithVideo=ctx.replyWithVideo.bind(ctx);

      ctx.reply=async(text,options={})=>{
        await removePreviousMonoUi(ctx);
        const message=await originalReply(text,options);
        await rememberMonoUi(ctx.chat.id,message?.message_id);
        return message;
      };

      ctx.replyWithPhoto=async(photo,options={})=>{
        await removePreviousMonoUi(ctx);
        const message=await originalReplyWithPhoto(photo,options);
        await rememberMonoUi(ctx.chat.id,message?.message_id);
        return message;
      };

      ctx.replyWithVideo=async(video,options={})=>{
        await removePreviousMonoUi(ctx);
        const message=await originalReplyWithVideo(video,options);
        await rememberMonoUi(ctx.chat.id,message?.message_id);
        return message;
      };
    }

    return next();
  });

  bot.command('start',ctx=>sendStart(ctx));
  bot.command('menu',async ctx=>{
    const account=await accountRecord(ctx.from.id);
    if(!account||account.enabled!==true){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      return sendPairLink(ctx,lang);
    }
    await recordEvent(ctx.from,'command',{source:'nexai',command:'menu',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    return sendDirectMenu(ctx,account,'menu');
  });
  bot.command('help',async ctx=>{
    const account=await accountRecord(ctx.from.id);
    if(account?.enabled===true)return sendDirectMenu(ctx,account,'menu');
    return sendStart(ctx);
  });
  bot.command('premium',ctx=>premiumPanel(ctx));
  bot.command('customstyle',ctx=>configureCustomStyle(ctx));
  bot.command('botname',ctx=>configureBotName(ctx));
  bot.command('stylename',ctx=>configureStyleName(ctx));
  bot.command('styleemoji',ctx=>configureStyleEmoji(ctx));
  bot.command('styletagline',ctx=>configureStyleTagline(ctx));
  bot.command('stylebuttons',ctx=>configureStyleButtons(ctx));
  bot.command('menuphoto',ctx=>configureMenuMedia(ctx,'photo'));
  bot.command('menuvideo',ctx=>configureMenuMedia(ctx,'video'));
  bot.command('menumedia',ctx=>configureMenuMediaState(ctx));
  for(const name of ['creator','about','founder','ceo'])bot.command(name,ctx=>sendCreator(ctx));

  bot.command('language',async ctx=>{
    const arg=String(ctx.match||'').trim().toLowerCase();
    if(arg==='fr'||arg==='en'){
      await patchSettings(ctx.from.id,{language:arg});
      const t=arg==='fr'?'🇫🇷 ʟᴀɴɢᴜᴇ • ғʀᴀɴçᴀɪѕ':'🇬🇧 ʟᴀɴɢᴜᴀɢᴇ • ᴇɴɢʟɪѕʜ';
      return monoReplyText(ctx,t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
    }
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    const t=lang==='en'?'ᴜѕᴇ /language fr ᴏʀ /language en.':'ᴜᴛɪʟɪѕᴇ /language fr ᴏᴜ /language en.';
    return monoReplyText(ctx,t,{entities:quotedEntities(t,['/language'])});
  });

  bot.command('sessions',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const owner=isOwnerIdentity(ctx.from.id,ctx.from.username);
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    if(!owner){
      return ctx.reply(lang==='en'
        ?'This command is reserved for the NexAi owner.'
        :'Cette commande est réservée au propriétaire de NexAi.');
    }
    const live=await listConnectedAccounts();
    return monoReplyText(ctx,sessionsText(live,{
      viewerTelegramUserId:ctx.from.id,
      owner:true,
      language:lang
    }));
  });

  bot.command('setstoragetoken',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const owner=isOwnerIdentity(ctx.from.id,ctx.from.username);
    if(!owner)return ctx.reply('Cette commande est réservée au propriétaire de NexAi.');
    const token=String(ctx.match||'').trim();
    if(!token)return ctx.reply('Utilise /setstoragetoken suivi du nouveau token de @NexAiStorage_bot dans ce chat privé.');
    try{
      const saved=await saveReplyStorageBotToken(token);
      await ctx.deleteMessage().catch(()=>{});
      let status=null;
      try{status=await replyStorageStatus()}catch(error){
        return ctx.reply('Token NexAI Storage chiffré et enregistré. Chaîne non détectée : '+String(error?.message||error).slice(0,300));
      }
      return ctx.reply(
        'NexAI Storage configuré ✅\nBot : @'+String(saved.botUsername||status?.botUsername||'NexAiStorage_bot')+
        '\nChaîne : '+String(status?.title||status?.chatId||'détectée')+
        '\n/setreply utilisera désormais le coffre Telegram privé.'
      );
    }catch(error){
      return ctx.reply('Configuration NexAI Storage impossible : '+String(error?.message||error).slice(0,350));
    }
  });

  bot.command('storagestatus',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const owner=isOwnerIdentity(ctx.from.id,ctx.from.username);
    if(!owner)return ctx.reply('Cette commande est réservée au propriétaire de NexAi.');
    try{
      const status=await replyStorageStatus();
      return ctx.reply(
        'NexAI Storage ✅\nBot : @'+String(status.botUsername||'NexAiStorage_bot')+
        '\nChaîne : '+String(status.title||status.chatId||'détectée')
      );
    }catch(error){
      return ctx.reply('NexAI Storage : '+String(error?.message||error).slice(0,300)+
        '\n\nSi le bot est déjà admin, transfère ici un message récent de la chaîne puis réponds-y avec /setstoragechannel.');
    }
  });

  bot.command('setstoragechannel',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const owner=isOwnerIdentity(ctx.from.id,ctx.from.username);
    if(!owner)return ctx.reply('Cette commande est réservée au propriétaire de NexAi.');

    const replied=ctx.message?.reply_to_message;
    const messages=[replied,ctx.message].filter(Boolean);
    let channelId='';
    for(const message of messages){
      const origin=message?.forward_origin;
      if(origin?.type==='channel'&&origin?.chat?.id!=null){
        channelId=String(origin.chat.id);
        break;
      }
      const legacy=message?.forward_from_chat;
      if(legacy?.type==='channel'&&legacy?.id!=null){
        channelId=String(legacy.id);
        break;
      }
      if(message?.sender_chat?.type==='channel'&&message.sender_chat.id!=null){
        channelId=String(message.sender_chat.id);
        break;
      }
    }

    const arg=String(ctx.match||'').trim();
    const target=channelId||arg;
    if(!target){
      return ctx.reply(
        'Transfère un message récent de la chaîne NexAI Storage dans ce chat, puis réponds au message transféré avec /setstoragechannel.\n\n'+
        'Tu peux aussi utiliser /setstoragechannel -100… ou /setstoragechannel @username si la chaîne est publique.'
      );
    }

    try{
      const saved=await bindReplyStorageChannel(target);
      return ctx.reply(
        'NexAI Storage lié ✅\nBot : @'+String(saved.botUsername||'NexAiStorage_bot')+
        '\nChaîne : '+String(saved.title||saved.chatId)+
        '\nID : '+String(saved.chatId)+
        '\n\n/setreply peut maintenant enregistrer la note vidéo.'
      );
    }catch(error){
      return ctx.reply('Liaison NexAI Storage impossible : '+String(error?.message||error).slice(0,350));
    }
  });

  async function handleSetTutorial(ctx){
    if(ctx.chat?.type!=='private')return false;
    if(!isOwnerIdentity(ctx.from.id,ctx.from.username)){
      await ctx.reply('Cette commande est réservée au propriétaire de NexAi.');
      return true;
    }

    const replied=ctx.message?.reply_to_message;
    const media=replied?.video||replied?.document;
    const mime=String(media?.mime_type||'').toLowerCase();
    const isVideo=Boolean(replied?.video)||mime.startsWith('video/');
    if(!media?.file_id||!isVideo){
      await ctx.reply('Réponds à la vidéo du tutoriel avec /settutorial. La vidéo MP4 peut être envoyée comme vidéo ou comme fichier.');
      return true;
    }

    const size=Number(media.file_size||0);
    if(size>TELEGRAM_BOT_VIDEO_LIMIT){
      await ctx.reply('La vidéo dépasse 50 Mo. Telegram Bot API ne peut pas la renvoyer telle quelle.');
      return true;
    }

    try{
      let canonicalVideo=media;
      let normalizedMessage=null;

      // If Telegram classified the MP4 as a document, normalize it once into a
      // real Telegram video so the persistent file_id can be reused by sendVideo.
      if(!replied?.video){
        if(size>TELEGRAM_BOT_DOWNLOAD_LIMIT){
          await ctx.reply('Cette vidéo a été envoyée comme fichier et dépasse 20 Mo. Renvoie-la comme vidéo Telegram puis réponds avec /settutorial.');
          return true;
        }
        const buffer=await downloadMainBotFile(media.file_id);
        normalizedMessage=await ctx.api.sendVideo(ctx.chat.id,new InputFile(buffer,'nexai-connection-tutorial-hq.mp4'),{
          caption:'NexAI · Tutoriel connexion · HQ',
          supports_streaming:true,
          disable_notification:true
        });
        canonicalVideo=normalizedMessage?.video||canonicalVideo;
      }

      const previous=await tutorialVideoConfig().catch(()=>({}));
      const archive=await archiveTutorialVideo(ctx,normalizedMessage||replied,canonicalVideo);
      const saved=await saveTutorialVideoConfig({
        fileId:String(canonicalVideo.file_id),
        fileUniqueId:String(canonicalVideo.file_unique_id||''),
        size:Number(canonicalVideo.file_size||size||0),
        width:Number(canonicalVideo.width||0),
        height:Number(canonicalVideo.height||0),
        duration:Number(canonicalVideo.duration||0),
        mimeType:String(canonicalVideo.mime_type||mime||'video/mp4'),
        storageChatId:archive.storageChatId,
        storageMessageId:archive.storageMessageId,
        archived:archive.archived,
        setBy:String(ctx.from.id)
      });

      if(
        previous.archived===true&&
        previous.storageChatId&&
        previous.storageMessageId&&
        (
          previous.storageChatId!==saved.storageChatId||
          previous.storageMessageId!==saved.storageMessageId
        )
      ){
        await ctx.api.deleteMessage(previous.storageChatId,previous.storageMessageId).catch(()=>{});
      }

      if(normalizedMessage?.message_id){
        await ctx.api.deleteMessage(ctx.chat.id,normalizedMessage.message_id).catch(()=>{});
      }

      await ctx.reply(
        'Tutoriel NexAI enregistré ✅\n'+
        'Qualité : conservée via le fichier Telegram, sans réencodage à chaque envoi.\n'+
        'Taille : '+(saved.size?Math.round(saved.size/1024/1024*10)/10+' Mo':'Telegram')+'\n'+
        'Stockage : '+(archive.archived?'NexAI Storage + file_id Telegram persistant':'file_id Telegram persistant')+'\n\n'+
        'Le bouton « 🎬 Voir le tuto » enverra maintenant cette vidéo.'
      );
      return true;
    }catch(error){
      console.error('[NexAI settutorial]',String(error?.description||error?.message||error).slice(0,700));
      await ctx.reply('Enregistrement du tutoriel impossible : '+String(error?.description||error?.message||error).slice(0,400));
      return true;
    }
  }

  bot.command('settutorial',ctx=>handleSetTutorial(ctx));

  bot.command('tutorialstatus',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    if(!isOwnerIdentity(ctx.from.id,ctx.from.username)){
      return ctx.reply('Cette commande est réservée au propriétaire de NexAi.');
    }
    const t=await tutorialVideoConfig();
    return ctx.reply(
      t.fileId
        ? 'Tutoriel NexAI ✅\nVidéo configurée · '+(t.size?Math.round(t.size/1024/1024*10)/10+' Mo · ':'')+(t.archived?'archivée dans NexAI Storage':'stockée par file_id Telegram')
        : 'Tutoriel NexAI : aucune vidéo configurée. Réponds à une vidéo avec /settutorial.'
    );
  });

  bot.command('pair',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    return sendPairLink(ctx,lang);
  });

  bot.command('cancel',async ctx=>{
    webPairUsers.delete(String(ctx.from.id));
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    const t=lang==='en'?'✦ ᴄᴏɴɴᴇᴄᴛɪᴏɴ ᴘʀᴏᴍᴘᴛ ᴄʟᴏѕᴇᴅ.':'✦ ᴘᴀʀᴄᴏᴜʀѕ ᴅᴇ ᴄᴏɴɴᴇxɪᴏɴ ғᴇʀᴍé.';
    return monoReplyText(ctx,t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
  });

  bot.command('owner',ctx=>sendOwner(ctx,'owner'));
  bot.command('users',ctx=>sendOwner(ctx,'users'));
  bot.command('botstats',ctx=>sendOwner(ctx,'botstats'));
  bot.command('activity',ctx=>sendOwner(ctx,'activity'));
  bot.command('growth',ctx=>sendOwner(ctx,'growth'));
  bot.command('commandstats',ctx=>sendOwner(ctx,'commandstats'));
  bot.command('countries',ctx=>sendOwner(ctx,'countries'));
  bot.command('languages',ctx=>sendOwner(ctx,'languages'));
  bot.command('user',ctx=>sendOwner(ctx,'user',ctx.match?String(ctx.match).trim().split(/\s+/):[]));

  bot.on('message',async(ctx,next)=>{
    if(await handleBotGreeting(ctx))return;
    return next();
  });

  bot.on('chat_member',async ctx=>{
    await handleBotChatMember(ctx);
  });

  bot.on('pre_checkout_query',async ctx=>{
    const q=ctx.preCheckoutQuery;
    const expected=NEXAI_PREMIUM_PAYLOAD_PREFIX+String(q.from?.id||ctx.from?.id||'');
    const valid=String(q.invoice_payload||'')===expected
      &&String(q.currency||'')==='XTR'
      &&Number(q.total_amount)===NEXAI_PREMIUM_STARS;
    if(valid)return ctx.answerPreCheckoutQuery(true);
    return ctx.answerPreCheckoutQuery(false,{error_message:'Paiement NexAI Premium invalide. Relance /premium.'});
  });

  bot.on('message',async(ctx,next)=>{
    const payment=ctx.message?.successful_payment;
    if(!payment)return next();
    const expected=NEXAI_PREMIUM_PAYLOAD_PREFIX+String(ctx.from?.id||'');
    if(
      String(payment.invoice_payload||'')!==expected||
      String(payment.currency||'')!=='XTR'||
      Number(payment.total_amount)!==NEXAI_PREMIUM_STARS
    ){
      console.warn('[NexAI premium] ignored invalid successful_payment',String(ctx.from?.id||''));
      return;
    }
    const state=await grantNexAiPremium(ctx.from.id,{
      expirationDate:Number(payment.subscription_expiration_date)||0,
      chargeId:String(payment.telegram_payment_charge_id||''),
      providerChargeId:String(payment.provider_payment_charge_id||''),
      autoRenew:payment.is_recurring===true||payment.is_first_recurring===true,
      amount:Number(payment.total_amount)||NEXAI_PREMIUM_STARS,
      currency:String(payment.currency||'XTR')
    });
    const until=state.expiresAt?new Date(state.expiresAt).toISOString().slice(0,10):'30 jours';
    await ctx.reply('NexAI Premium activé ✅\nValide jusqu’au : '+until+'\nTelegram Premium reste un statut séparé.');
  });

  bot.on('message:text',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const text=String(ctx.message.text||'').trim();
    if(/^\/?settutorial(?:@[A-Za-z0-9_]+)?$/i.test(text)){
      await handleSetTutorial(ctx);
      return;
    }
    if(text.startsWith('/'))return;

    // The presentation bot also accepts native commands without a prefix.
    // Only explicit known command names are consumed, so normal conversation
    // text remains untouched.
    if(await handleBareDirectCommand(ctx,text))return;

    // Telegram automatically invalidates account login codes sent as messages
    // to any Telegram chat. Protect users who still try the legacy DM flow.
    if(webPairActive(ctx.from.id)&&/^[0-9-]{5,12}$/.test(text)){
      await ctx.deleteMessage().catch(()=>{});
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      const t=lang==='en'
        ? 'That login code is now unusable because it was sent in a Telegram chat. Request a new code from the secure page and enter it only there.'
        : 'Ce code est maintenant inutilisable parce qu’il a été envoyé dans un chat Telegram. Demande un nouveau code depuis la page sécurisée et saisis-le uniquement là-bas.';
      return ctx.reply(t,{
        entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}],
        reply_markup:connectMarkup(lang),
        link_preview_options:{is_disabled:true}
      });
    }
  });

  bot.on('inline_query',async ctx=>{
    await recordEvent(ctx.inlineQuery.from,'inline_query',{source:'nexai',chatType:'inline'}).catch(()=>{});
    const account=await accountRecord(ctx.inlineQuery.from.id);
    if(!account||account.enabled!==true){
      await ctx.answerInlineQuery([], {cache_time:0,is_personal:true});
      return;
    }
    const model=await modelFor(account,ctx.inlineQuery.query);
    if(!model){
      // Never inject an "expired response" message into the user's chat.
      // Returning no result makes the connected account fall back to a direct
      // branded Telegram message containing the real command response.
      await ctx.answerInlineQuery([],{cache_time:0,is_personal:true});
      return;
    }
    const resultId='nex-'+Date.now();
    const cachedPhotoId=model.photoUrl
      ?await cachePhotoFileId(model.photoUrl,account.telegramUserId)
      :'';
    const customMediaResult=inlineCachedMediaResult(model,account.telegramUserId,resultId,false);
    const customMediaPortable=inlineCachedMediaResult(model,account.telegramUserId,resultId,true);
    const attempts=[
      ...(customMediaResult?[['custom-media-rich',customMediaResult]]:[]),
      ...(customMediaPortable?[['custom-media-portable',customMediaPortable]]:[]),
      ...(cachedPhotoId?[['cached-photo-rich',inlineCachedPhotoResult(model,account.telegramUserId,resultId,cachedPhotoId,false)]]:[]),
      ['photo-rich',inlineResult(model,account.telegramUserId,resultId,false,false)],
      ['article-rich',inlineResult(model,account.telegramUserId,resultId,true,false)],
      ['article-portable',inlineResult(model,account.telegramUserId,resultId,true,true)],
      ['article-no-artwork',inlineResult(model,account.telegramUserId,resultId,true,true,true)]
    ];
    const errors=[];
    for(const [kind,result] of attempts){
      if(kind==='photo-rich'&&!model.photoUrl)continue;
      if(kind==='cached-photo-rich'&&!cachedPhotoId)continue;
      try{
        await ctx.answerInlineQuery([result],{cache_time:0,is_personal:true});
        if(errors.length)console.warn('[NexAI inline] recovered with',kind,'after',errors.join(' | '));
        return;
      }catch(error){
        errors.push(kind+':'+String(error?.description||error?.message||error).slice(0,350));
      }
    }
    throw new Error('inline_answer_failed '+errors.join(' | '));
  });

  bot.on('callback_query:data',async ctx=>{
    await adoptCallbackMonoUi(ctx);
    const raw=String(ctx.callbackQuery.data||'');
    console.log('[NexAI callback] received',raw.slice(0,120),'from='+String(ctx.from?.id||''),'inline='+String(!!ctx.callbackQuery.inline_message_id));
    if(raw===CONNECT_TUTORIAL_CALLBACK){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await ctx.answerCallbackQuery().catch(()=>{});
      await sendConnectTutorial(ctx,lang);
      await recordEvent(ctx.from,'callback',{source:'nexai',command:'connect:tutorial',chatType:ctx.chat?.type||'private'}).catch(()=>{});
      return;
    }
    const cut=raw.lastIndexOf('|');
    if(cut<0){await ctx.answerCallbackQuery();return}
    const action=raw.slice(0,cut),accountId=raw.slice(cut+1);
    if(action==='premium:buy'){
      try{
        await removePreviousMonoUi(ctx);
        const invoice=await sendNexAiPremiumInvoice(ctx.from.id);
        if(ctx.chat?.type==='private'&&invoice?.message_id){
          await rememberMonoUi(ctx.chat.id,invoice.message_id);
        }
        await ctx.answerCallbackQuery({text:'Facture NexAI Premium envoyée en privé.'});
      }catch(error){
        console.error('[NexAI premium invoice]',String(error?.description||error?.message||error).slice(0,500));
        await ctx.answerCallbackQuery({text:'Ouvre le bot en privé et utilise /premium.',show_alert:true}).catch(()=>{});
      }
      return;
    }
    const account=await accountRecord(accountId);
    if(!account||account.enabled!==true){await ctx.answerCallbackQuery({text:'Compte déconnecté.'});return}
    const settings=await settingsFor(accountId);
    if(!callbackAccessAllowed(ctx.from.id,accountId,settings.accessMode,ctx.from.username)){
      await ctx.answerCallbackQuery({text:'Ce menu appartient au compte connecté.',show_alert:false});
      return;
    }
    let model;
    let callbackText='';
    let replaceMedia=false;
    if(action==='menu:home'){
      model=await modelFor(account,'menu');
      replaceMedia=true;
    }else if(action==='menu:styles'){
      model=await modelFor(account,'styles');
      replaceMedia=true;
    }else if(action==='menu:customstyle'){
      model=await modelFor(account,'customstyle');
      replaceMedia=true;
    }else if(action==='custom:on'||action==='custom:off'||action==='custom:reset'){
      if(action==='custom:reset'){
        await patchSettings(accountId,{customStyle:normalizeCustomStyle({})});
        callbackText='Style personnel réinitialisé';
      }else{
        const current=customStyleFor(settings);
        const enabled=action==='custom:on';
        await patchSettings(accountId,{customStyle:normalizeCustomStyle({...current,enabled})});
        callbackText=enabled?'Style personnel activé':'Style personnel désactivé · le prochain /menu retire le média';
      }
      model=await modelFor(account,'customstyle');
      replaceMedia=true;
    }else if(action.startsWith('style:set:')){
      const styleId=Number(action.slice('style:set:'.length));
      const styles=await listStyles();
      const style=styles.find(s=>Number(s.id)===styleId&&Number(s.id)>0);
      if(!style){
        await ctx.answerCallbackQuery({text:'Style invalide.',show_alert:false});
        return;
      }
      await patchSettings(accountId,{style:styleId});
      model=await modelFor(account,'styles');
      callbackText='Style '+styleId+' · '+String(style.name||'NexAI')+' activé';
      replaceMedia=true;
    }else if(action.startsWith('cat:')){
      model=await modelFor(account,action);
    }else{
      await ctx.answerCallbackQuery();
      return;
    }

    try{
      const mode=await editInline(ctx,model,accountId,{replaceMedia});
      if(ctx.chat?.type==='private'&&ctx.callbackQuery?.message?.message_id){
        await rememberMonoUi(ctx.chat.id,ctx.callbackQuery.message.message_id);
      }
      console.log('[NexAI callback] edited',action,'mode='+mode);
      await recordEvent(ctx.from,'callback',{source:'nexai',command:action,chatType:'inline'}).catch(()=>{});
      if(callbackText)await ctx.answerCallbackQuery({text:callbackText});
      else await ctx.answerCallbackQuery();
    }catch(error){
      const reason=String(error?.description||error?.message||error).slice(0,700);
      console.error('[NexAI callback] failed',action,reason);
      await ctx.answerCallbackQuery({text:'Impossible de mettre à jour ce menu. Réessaie avec /Menu',show_alert:false}).catch(()=>{});
    }
  });

  bot.catch(e=>console.error('[NexAI Bot]',e.error||e));
  await syncTelegramCommandMenu(bot).catch(e=>console.error('[NexAI commands]',String(e?.description||e?.message||e)));
  const me=await bot.api.getMe();
  cfg.botUsername=String(me.username||cfg.botUsername||'').replace(/^@/,'');
  await saveSharedBotIdentity({
    username:cfg.botUsername,
    telegramBotId:String(me.id||'')
  }).catch(error=>console.warn('[NexAI bot identity] persist_failed',String(error?.message||error).slice(0,180)));

  pollerLeaseKey='nexai-inline:'+String(me.id||'unknown');
  pollerSupervisorStopping=false;
  pollerRestartAttempt=0;
  clearPollerSupervisorTimer();
  schedulePollerSupervisor(0);
  console.log('[NexAccount] inline bot @'+me.username+' API ready · supervised singleton poller');
  return bot;
}

export async function stopInlineBot(){
  pollerSupervisorStopping=true;
  clearPollerSupervisorTimer();
  clearPollerLeaseTimer();
  try{await bot?.stop()}catch{}
  if(pollerLeaseKey)await releaseServiceLease(pollerLeaseKey,cfg.workerId).catch(()=>{});
  pollerLeaseKey='';
  pollerRestartAttempt=0;
}


export const __test={stampMarkup,portableMarkup,inlineResult,inlineCachedPhotoResult,inlineReplyModel,telegramCommandMenu,callbackAccessAllowed,compactGreetingEmojiNoise,greetingVisualTemplate,greetingProfilePhotoFileId};