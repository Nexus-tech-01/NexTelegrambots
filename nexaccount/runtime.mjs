import crypto from 'node:crypto';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage } from 'teleproto/events/index.js';
import { getInputChannel, getInputUser } from 'teleproto/Utils.js';
import { cfg, isOwnerId } from './config.mjs';
import { commandMap } from './commands.mjs';
import { accountAssignedToWorker, accountWithSession, acquireRuntimeLease, disableAccount, enableAccount, listAccountsForWorker, patchSettings, releaseRuntimeLease, renewRuntimeLease, settingsFor } from './store.mjs';
import { listStyles } from './styles.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { recordEvent } from './analytics.mjs';
import { ownerPanelText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { handleCompatCommand } from './compat.mjs';
import { menuModel, stylesModel } from './menu.mjs';
import { aiProviderStatus, generateAiReply } from './ai-engine.mjs';
import { stickerEngineDiagnostic } from './sticker-engine.mjs';
import { parseCommand, textOf } from './core/command-parser.mjs';
import { createCommandDeduper } from './core/command-deduper.mjs';
import { createRuntimeContext, clearRuntimeTimers } from './core/runtime-context.mjs';
import { routeEngineCommand } from './core/engine-router.mjs';
import { animeBeginRebuild, animeDedupePublishedEpisodeVariants, animeDiscoverNow, animeIngestStatus, handleAnimeIngestEvent, startAnimeIngest, stopAnimeIngest } from './anime-ingest.mjs';
import { sendTelegramMedia } from './media-send.mjs';
import { sendBrandedText } from './response-ui.mjs';
import { putInlineResponse } from './inline-response-store.mjs';

const commands=commandMap();
const runtimes=new Map();
const spamWindows=new Map();
const commandDeduper=createCommandDeduper();
const aiAutoWindows=new Map();
let reconcilingRuntimes=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ANIME_PRIMARY_PUBLISHER_ENABLED=/^(?:1|true|yes|on)$/i.test(String(process.env.NEXANIME_PRIMARY_PUBLISHER_ENABLED||'').trim());
const ANIME_PRIMARY_PUBLISHER_USERNAME=String(process.env.NEXANIME_PRIMARY_PUBLISHER_USERNAME||'').trim().replace(/^@/,'').toLowerCase();

function isPrimaryAnimePublisher(account){
  if(!ANIME_PRIMARY_PUBLISHER_ENABLED||!ANIME_PRIMARY_PUBLISHER_USERNAME)return false;
  const username=String(account?.username||'').trim().replace(/^@/,'').toLowerCase();
  return Boolean(username&&username===ANIME_PRIMARY_PUBLISHER_USERNAME);
}

function randomLong(){
  return BigInt.asIntN(64,BigInt('0x'+crypto.randomBytes(8).toString('hex')));
}
function utf16len(s){return Buffer.from(String(s),'utf16le').length/2}

function messageAuthorId(message){
  return String(message?.senderId||message?.fromId?.userId||message?.fromId?.channelId||'');
}

function connectedAccountIds(account){
  return new Set([
    account?.telegramUserId,
    account?.connectedTelegramUserId,
    account?.sessionTelegramUserId
  ].filter(v=>v!==undefined&&v!==null&&String(v)!=='').map(v=>String(v)));
}

async function messageAuthorIsBot(client,message,eventSender=null){
  if(eventSender?.bot===true)return true;
  const id=messageAuthorId(message);
  if(!id)return false;
  try{
    const entity=await client.getEntity(id);
    return entity?.bot===true;
  }catch{return false}
}

function isSelfAuthoredMessage(message,account){
  const selfIds=connectedAccountIds(account);
  if(!selfIds.size||!message)return false;
  if(message.out===true)return true;
  const author=messageAuthorId(message);
  if(author&&selfIds.has(author))return true;
  // Saved Messages can be represented as a self peer across synchronized sessions.
  const peerUserId=String(message?.peerId?.userId||'');
  if(peerUserId&&selfIds.has(peerUserId)&&message.fromId==null)return true;
  return false;
}

function claimCommand(telegramUserId,message){
  return commandDeduper.claim(telegramUserId,message);
}

async function sendText(client,peer,text){
  const value=String(text);
  if(cfg.botUsername){
    try{
      const token=await putInlineResponse(value);
      return await sendInline(client,peer,'reply:'+token);
    }catch(error){
      console.warn('[NexAccount inline reply fallback]',String(error?.message||error).slice(0,250));
    }
  }
  return sendBrandedText(client,peer,value);
}

function ownerFormattingEntities(text){
  const out=[new Api.MessageEntityBlockquote({offset:0,length:utf16len(text),collapsed:true})];
  const re=/\/[a-z][a-z0-9_]*/gi;
  for(const m of String(text).matchAll(re)){
    out.push(new Api.MessageEntityBotCommand({
      offset:utf16len(text.slice(0,m.index)),
      length:utf16len(m[0])
    }));
  }
  return out;
}

async function sendOwnerText(client,peer,text){
  try{return await client.sendMessage(peer,{message:String(text),formattingEntities:ownerFormattingEntities(String(text))})}
  catch{return sendText(client,peer,text)}
}

function creatorFormattingEntities(model){
  return model.entities.map(e=>{
    if(e.type==='expandable_blockquote'){
      return new Api.MessageEntityBlockquote({offset:e.offset,length:e.length,collapsed:true});
    }
    if(e.type==='text_link'){
      return new Api.MessageEntityTextUrl({offset:e.offset,length:e.length,url:e.url});
    }
    return null;
  }).filter(Boolean);
}

async function sendCreator(runtime,peer){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const model=creatorCaptionModel(settings.language||'fr');
  try{
    return await client.sendFile(peer,{
      file:creatorImagePath(),
      caption:model.text,
      formattingEntities:creatorFormattingEntities(model)
    });
  }catch(e){
    console.error('[NexAccount creator]',String(e.message||e));
    return client.sendMessage(peer,{message:model.text,formattingEntities:creatorFormattingEntities(model)}).catch(()=>sendText(client,peer,model.text));
  }
}

async function sendInline(client,peer,query){
  if(!cfg.botUsername)throw new Error('NEXAI_BOT_USERNAME/NEXAI_BOT_TOKEN non configuré');
  const inputPeer=await client.getInputEntity(peer);
  const bot=await client.getInputEntity('@'+cfg.botUsername);
  const errors=[];

  // Inline queries can briefly race the bot update loop after a restart.
  // Retry a few times before degrading the user experience.
  for(let attempt=0;attempt<3;attempt++){
    try{
      const results=await client.invoke(new Api.messages.GetInlineBotResults({
        bot,peer:inputPeer,query:String(query||'menu'),offset:''
      }));
      const result=results.results?.[0];
      if(!result)throw new Error('NexAI Inline Mode ne renvoie aucun résultat');
      return await client.invoke(new Api.messages.SendInlineBotResult({
        peer:inputPeer,randomId:randomLong(),queryId:results.queryId,id:result.id
      }));
    }catch(error){
      const reason=String(error?.errorMessage||error?.message||error||'unknown_error');
      errors.push(reason.slice(0,350));
      if(/INLINE_DISABLED|BOT_INLINE_DISABLED|USERNAME_NOT_OCCUPIED/i.test(reason))break;
      if(attempt<2)await sleep(250*(attempt+1));
    }
  }
  throw new Error('inline_menu_failed '+errors.join(' | '));
}

async function sendMenu(runtime,peer){
  const {client,account}=runtime;
  try{
    console.log('[NexAccount menu]',String(account.telegramUserId),'inline:start');
    const sent=await sendInline(client,peer,'menu');
    console.log('[NexAccount menu]',String(account.telegramUserId),'inline:sent');
    return sent;
  }catch(error){
    const reason=String(error?.errorMessage||error?.message||error||'unknown_error').slice(0,500);
    console.error('[NexAccount menu]',String(account.telegramUserId),'inline:failed',reason);
    const settings=await settingsFor(account.telegramUserId);
    const model=await menuModel({account,settings,commands,view:'home'});

    // Last-resort degradation: keep the real menu content and the artwork of
    // the active style. Do not display the old alarming "temporarily unavailable"
    // banner; users can still run every listed command while the inline layer
    // recovers on the next .menu.
    if(model.photoUrl){
      try{
        return await client.sendFile(peer,{
          file:model.photoUrl,
          caption:String(model.text||'NexAI').slice(0,1024)
        });
      }catch(photoError){
        console.error('[NexAccount menu]',String(account.telegramUserId),'fallback-photo:failed',String(photoError?.message||photoError).slice(0,350));
      }
    }
    return sendText(client,peer,String(model.text||'NexAI'));
  }
}

function inviteHash(value){
  const s=String(value||'').trim();
  const m=s.match(/(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
  return m?.[1]||'';
}

async function joinTarget(client,target){
  const raw=String(target||'').trim();
  if(!raw)throw new Error('Cible manquante');
  const hash=inviteHash(raw);
  if(hash)return client.invoke(new Api.messages.ImportChatInvite({hash}));
  const username=raw.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'').replace(/^@/,'').split(/[/?#]/)[0];
  const entity=await client.getInputEntity('@'+username);
  return client.invoke(new Api.channels.JoinChannel({channel:entity}));
}

async function premiumDenied(client,peer,name){
  await sendText(client,peer,'Cette commande ('+name+') nécessite Telegram Premium sur le compte connecté.');
}

async function handleStyle(runtime,peer,args,inlineName=''){
  const {account,client}=runtime;
  let n=Number(args?.[0]||inlineName.replace(/^style/i,''));
  if(!n){
    try{
      await sendInline(client,peer,'styles');
      return true;
    }catch(error){
      console.error('[NexAccount styles]',String(account.telegramUserId),'inline:failed',String(error?.errorMessage||error?.message||error).slice(0,350));
      const settings=await settingsFor(account.telegramUserId);
      const model=await stylesModel({account,settings});
      return sendText(client,peer,String(model.text||'NexAI · Styles'));
    }
  }
  const styles=await listStyles();
  if(!styles.some(s=>s.id===n)||n===0){
    await sendText(client,peer,'Style invalide. Utilise .style pour afficher les styles disponibles.');
    return;
  }
  await patchSettings(account.telegramUserId,{style:n});
  // Re-render immediately so a text command such as .style20 visibly applies
  // the new theme/artwork without requiring a second .menu command.
  return sendMenu(runtime,peer);
}

const LOCAL_OWNER_COMMANDS=new Set([
  'owner','users','botstats','activity','growth','commandstats','countries','languages','user'
]);

async function handleOwner(runtime,peer,name,args){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const lang=String(settings.language||'fr').toLowerCase().startsWith('en')?'en':'fr';
  let text='';
  if(name==='owner'||name==='users')text=await ownerPanelText(lang);
  else if(name==='botstats')text=await botStatsText(lang);
  else if(name==='activity')text=await activityText(lang);
  else if(name==='growth')text=await growthText(lang);
  else if(name==='commandstats')text=await commandStatsText(lang);
  else if(name==='countries')text=await countriesText(lang);
  else if(name==='languages')text=await languagesText(lang);
  else if(name==='user')text=await userText(args[0]||'',lang);
  if(text)await sendOwnerText(client,peer,text);
  return true;
}

function eventIsGroup(event){
  if(event?.isGroup===true)return true;
  const peer=event?.message?.peerId;
  return Boolean(peer?.chatId)||Boolean(peer?.channelId&&event?.isPrivate!==true);
}

async function userIsGroupAdmin(client,peer,userId){
  const id=String(userId||'');
  if(!id)return false;
  try{
    if(typeof client.getPermissions==='function'){
      const p=await client.getPermissions(peer,id);
      if(p?.isCreator||p?.isAdmin||p?.adminRights)return true;
    }
  }catch{}
  try{
    const channel=getInputChannel(await client.getInputEntity(peer));
    const participant=await client.getInputEntity(id);
    const r=await client.invoke(new Api.channels.GetParticipant({channel,participant}));
    const p=r?.participant;
    const kind=String(p?.className||p?.constructor?.name||'');
    if(/Creator|Admin/i.test(kind)||p?.adminRights)return true;
  }catch{}
  try{
    const ps=await client.getParticipants(peer,{limit:500});
    const user=ps.find(p=>String(p?.id||'')===id);
    const kind=String(user?.participant?.className||user?.participant?.constructor?.name||'');
    if(/Creator|Admin/i.test(kind)||user?.participant?.adminRights||user?.adminRights)return true;
  }catch{}
  return false;
}

async function accountIsGroupAdmin(client,peer,account){
  return userIsGroupAdmin(client,peer,account?.telegramUserId);
}

async function enforceCommandContext(runtime,event,cmd,displayName){
  const {client,account}=runtime;
  const peer=event.message.peerId;
  const group=eventIsGroup(event);
  const selfAuthored=isSelfAuthoredMessage(event.message,account);

  if(cmd.selfOnly&&!selfAuthored){
    await sendText(client,peer,'La commande .'+displayName+' est réservée au propriétaire du compte connecté.');
    return false;
  }
  if(cmd.privateOnly&&group){
    await sendText(client,peer,'La commande .'+displayName+' est réservée au privé.');
    return false;
  }
  if(cmd.groupOnly&&!group){
    await sendText(client,peer,'La commande .'+displayName+' est réservée aux groupes.');
    return false;
  }
  if(cmd.adminOnly){
    if(!group){
      await sendText(client,peer,'La commande .'+displayName+' nécessite un groupe.');
      return false;
    }
    if(!(await accountIsGroupAdmin(client,peer,account))){
      await sendText(client,peer,'Le compte connecté doit être administrateur pour exécuter .'+displayName+'.');
      return false;
    }
    if(!selfAuthored){
      const callerId=messageAuthorId(event.message);
      if(!callerId||!(await userIsGroupAdmin(client,peer,callerId))){
        await sendText(client,peer,'La commande .'+displayName+' est réservée aux administrateurs du groupe.');
        return false;
      }
    }
  }
  return true;
}

async function handleCommand(runtime,event,parsed){
  const {client,account}=runtime;
  const peer=event.message.peerId;
  if(/^style\d+$/i.test(parsed.name))return handleStyle(runtime,peer,[],parsed.name);
  if(parsed.name==='style')return handleStyle(runtime,peer,parsed.args);
  if(parsed.name==='menu')return sendMenu(runtime,peer);

  const cmd=commands.get(parsed.name);
  if(!cmd){
    const settings=await settingsFor(account.telegramUserId);
    const chatId=String(event.chatId||event.message?.chatId||event.message?.peerId?.channelId||event.message?.peerId?.chatId||'global');
    const custom=settings.groupPolicies?.[chatId]?.customCommands?.[parsed.name];
    if(custom){await sendText(client,peer,String(custom));return true}
    return false;
  }
  if(cmd.ownerOnly&&!isOwnerId(account.telegramUserId)){
    await sendText(client,peer,'Commande réservée au propriétaire de NexAi.');
    return true;
  }
  if(!(await enforceCommandContext(runtime,event,cmd,parsed.name)))return true;

  const name=cmd.handler||cmd.aliasFor||cmd.name;
  await recordEvent(account,'command',{source:'nexaccount',command:cmd.name,chatType:eventIsGroup(event)?'group':'private'}).catch(()=>{});

  if(name==='creator')return sendCreator(runtime,peer);
  // ownerOnly is an access-control flag, not an execution engine.
  // Only the native NexAI owner dashboard commands belong to handleOwner().
  // Other owner-only commands (mostly THE BIG DIPPER commands) must continue
  // through local compatibility routing after the owner identity check above.
  if(cmd.ownerOnly&&LOCAL_OWNER_COMMANDS.has(name))return handleOwner(runtime,peer,name,parsed.args);

  if(cmd.premium&&!account.premium){
    await premiumDenied(client,peer,name);
    return true;
  }
  const engineHandled=await routeEngineCommand({
    cmd,
    runtime,
    event,
    args:parsed.args,
    sendText
  });
  if(engineHandled)return true;

  const compatHandled=await handleCompatCommand({
    runtime,event,name,args:parsed.args,cmd,sendText,sendInline
  });
  if(compatHandled)return true;

  if(cmd.localOnly){
    await sendText(client,peer,'Erreur interne : la route locale de .'+cmd.name+' est indisponible.');
    return true;
  }

  switch(name){
    case 'ping':{
      const t=Date.now();
      await sendText(client,peer,'Pong · '+Math.max(1,Date.now()-t)+' ms');
      return true;
    }
    case 'alive':
      await sendText(client,peer,'NexAi · Dipper est actif sur ce compte.');
      return true;
    case 'account':
      await sendText(client,peer,'Compte : '+(account.username?'@'+account.username:account.firstName)+'\nTelegram Premium : '+(account.premium?'Oui':'Non')+'\nNexAccount : connecté');
      return true;
    case 'help':
      await sendText(client,peer,'Utilise .menu pour afficher le menu interactif.');
      return true;
    case 'join':
      try{await joinTarget(client,parsed.args[0]);await sendText(client,peer,'Cible rejointe.')}
      catch(e){await sendText(client,peer,'Impossible de rejoindre : '+String(e.errorMessage||e.message||e))}
      return true;
    case 'leave':
      try{
        const inputPeer=await client.getInputEntity(peer);
        await client.invoke(new Api.channels.LeaveChannel({channel:inputPeer}));
      }catch(e){await sendText(client,peer,'Impossible de quitter ce chat : '+String(e.errorMessage||e.message||e))}
      return true;
    default:
      await sendText(client,peer,'Erreur interne : aucune route d’exécution disponible pour .'+name+'.');
      return true;
  }
}

function eventChatKey(event){
  const message=event?.message||{};
  return String(event?.chatId||message.chatId||message.peerId?.channelId||message.peerId?.chatId||message.peerId?.userId||'global');
}

function autoFeaturesMuted(settings,event){
  const policy=settings?.groupPolicies?.[eventChatKey(event)]||{};
  if(policy.nexaiMuted!==true)return false;
  const until=Number(policy.nexaiMuteUntil||0);
  return until===0||until>Date.now();
}

function messageMentionsAccount(message,account){
  const id=String(account.telegramUserId||'');
  const username=String(account.username||'').replace(/^@/,'').toLowerCase();
  const text=textOf(message);
  if(username&&text.toLowerCase().includes('@'+username))return true;
  for(const entity of message?.entities||[]){
    const userId=String(entity?.userId||entity?.user?.id||'');
    if(userId&&userId===id)return true;
  }
  return false;
}

async function repliedToConnectedAccount(client,event,account){
  const id=Number(event?.message?.replyTo?.replyToMsgId||event?.message?.replyToMsgId||0);
  if(!id)return false;
  try{
    const rows=await client.getMessages(event.message.peerId,{ids:[id]});
    const source=Array.isArray(rows)?rows[0]:rows;
    return isSelfAuthoredMessage(source,account);
  }catch{return false}
}

async function maybeNlpMode(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  if(settings.nlpMode?.enabled!==true||autoFeaturesMuted(settings,event))return false;
  const message=event?.message;
  const raw=textOf(message);
  if(!raw||message?.media||isSelfAuthoredMessage(message,account))return false;
  const prefix=String(settings.prefix||'.');
  if((prefix&&raw.startsWith(prefix))||raw.startsWith('/'))return false;
  if(event?.sender?.bot===true)return false;

  const group=eventIsGroup(event);
  if(group){
    const mentioned=messageMentionsAccount(message,account);
    const replied=mentioned?false:await repliedToConnectedAccount(client,event,account);
    if(!mentioned&&!replied)return false;
  }

  const chat=eventChatKey(event),windowKey=String(account.telegramUserId)+':'+chat;
  const now=Date.now(),last=Number(aiAutoWindows.get(windowKey)||0);
  if(now-last<2500)return false;
  aiAutoWindows.set(windowKey,now);

  const username=String(account.username||'').replace(/^@/,'');
  const prompt=username?raw.replace(new RegExp('@'+username+'\\b','ig'),'').trim()||raw:raw;
  try{
    const inputPeer=await client.getInputEntity(message.peerId);
    await client.invoke(new Api.messages.SetTyping({peer:inputPeer,action:new Api.SendMessageTypingAction({})})).catch(()=>{});
    const result=await generateAiReply({
      accountId:account.telegramUserId,
      peer:chat,
      prompt,
      mode:'ai',
      language:settings.language||account.preferredLanguage||'fr'
    });
    await sendText(client,message.peerId,result.text);
    return true;
  }catch(e){
    console.error('[NexAccount nlp]',account.telegramUserId,String(e?.message||e));
    return false;
  }
}

async function maybeAutoReply(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const auto=settings.autoReply||{};
  if(auto.enabled!==true||!auto.url||autoFeaturesMuted(settings,event))return false;
  if(!messageMentionsAccount(event.message,account))return false;
  const delay=Math.max(0,Math.min(30000,Number(auto.delayMs)||0));
  if(delay)await sleep(delay);
  try{
    const response=await fetch(String(auto.url),{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('HTTP '+response.status);
    const size=Number(response.headers.get('content-length')||0);
    if(size>20*1024*1024)throw new Error('média > 20 Mo');
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length>20*1024*1024)throw new Error('média > 20 Mo');
    const mime=String(auto.mime||response.headers.get('content-type')||'application/octet-stream');
    await sendTelegramMedia(client,event.message.peerId,buffer,{fileName:'nexai-autoreply',mimeType:mime,kind:'auto'});
    return true;
  }catch(e){
    console.error('[NexAccount autoReply]',account.telegramUserId,String(e.message||e));
    return false;
  }
}

async function maybeAutoReact(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  if(autoFeaturesMuted(settings,event))return;
  const cfgReact=settings.autoReact||{};
  if(!cfgReact.enabled)return;
  const targets=Array.isArray(cfgReact.targets)?cfgReact.targets:[];
  if(!targets.length)return;
  const chatId=String(event.chatId||event.message?.chatId||'');
  let chat=event.chat||null;
  if(!chat){try{chat=await client.getEntity(event.message.peerId)}catch{}}
  const username=String(chat?.username||'').toLowerCase().replace(/^@/,'');
  const matched=targets.some(x=>{
    const v=String(x).trim().toLowerCase().replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'').replace(/^@/,'').split(/[/?#]/)[0];
    return v===chatId||v===username;
  });
  if(!matched)return;
  const reactions=Array.isArray(cfgReact.reactions)&&cfgReact.reactions.length?cfgReact.reactions:['🔥','❤️','👍'];
  const emoticon=reactions[Math.floor(Math.random()*reactions.length)];
  const peer=await client.getInputEntity(event.message.peerId);
  await client.invoke(new Api.messages.SendReaction({peer,msgId:event.message.id,reaction:[new Api.ReactionEmoji({emoticon})]})).catch(()=>{});
}

async function maybeAutoModerate(runtime,event){
  const {client,account}=runtime;
  const message=event.message;if(!message)return;
  const settings=await settingsFor(account.telegramUserId);
  const chatId=String(event.chatId||message.chatId||message.peerId?.channelId||message.peerId?.chatId||'global');
  const policy=settings.groupPolicies?.[chatId]||{};
  const text=textOf(message);
  const sender=String(message.senderId||event.senderId||'');
  if(Array.isArray(policy.whitelist)&&policy.whitelist.map(String).includes(sender))return;
  let remove=Array.isArray(policy.blacklist)&&policy.blacklist.map(String).includes(sender);
  if(!remove&&policy.antilink&&/(?:https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i.test(text))remove=true;
  if(!remove&&policy.antitag&&/@[A-Za-z0-9_]{3,}/.test(text))remove=true;
  if(!remove&&policy.antigroupmention&&(text.match(/@[A-Za-z0-9_]{3,}/g)||[]).length>=5)remove=true;
  if(!remove&&policy.antibadword){
    const bad=Array.isArray(policy.badwords)?policy.badwords:[];
    if(bad.some(w=>w&&text.toLowerCase().includes(String(w).toLowerCase())))remove=true;
  }
  if(!remove&&policy.antispam&&sender){
    const key=account.telegramUserId+':'+chatId+':'+sender,now=Date.now();
    const recent=(spamWindows.get(key)||[]).filter(t=>now-t<10000);recent.push(now);spamWindows.set(key,recent);
    if(recent.length>5)remove=true;
  }
  if(remove){
    // Never let automatic filters punish Telegram bots or group administrators.
    // Explicit moderation commands remain available to admins when action is intended.
    if(await messageAuthorIsBot(client,message,event?.sender))return;
    if(sender&&await userIsGroupAdmin(client,message.peerId,sender))return;
    try{await client.deleteMessages(message.peerId,[message.id],{revoke:true})}catch{}
  }
}

async function maybeServiceGreeting(runtime,event){
  const {client,account}=runtime;const message=event.message,action=message?.action;if(!action)return;
  const settings=await settingsFor(account.telegramUserId);
  const chatId=String(event.chatId||message.chatId||message.peerId?.channelId||message.peerId?.chatId||'global');
  const policy=settings.groupPolicies?.[chatId]||{};
  const kind=String(action.className||action.constructor?.name||'');
  if(/ChatAddUser|ChatJoinedByLink|ChatJoinedByRequest/i.test(kind)&&policy.welcome){
    await sendText(client,message.peerId,String(policy.welcomeText||'Bienvenue dans le groupe.')).catch(()=>{});
  }else if(/ChatDeleteUser/i.test(kind)&&policy.goodbye){
    await sendText(client,message.peerId,String(policy.goodbyeText||'À bientôt.')).catch(()=>{});
  }
}

async function maintainPresence(runtime){
  try{
    await runtime.client.invoke(new Api.account.UpdateStatus({offline:false}));
    runtime.lastPresenceAt=new Date();
  }catch(error){
    console.warn('[NexAccount presence]',String(runtime.account.telegramUserId),String(error?.errorMessage||error?.message||error).slice(0,300));
  }
}

async function configurePresence(runtime,enabled){
  if(runtime.presenceTimer){
    clearInterval(runtime.presenceTimer);
    runtime.presenceTimer=null;
  }
  if(enabled!==true)return false;
  const initialSettings=await settingsFor(id);
  await configurePresence(runtime,initialSettings.presence?.enabled===true);
  return true;
}

async function runAutoJoin(runtime){
  const settings=await settingsFor(runtime.account.telegramUserId);
  if(!settings.autoJoin?.enabled)return;
  const targets=Array.isArray(settings.autoJoin.targets)?settings.autoJoin.targets:[];
  for(const target of targets){
    try{await joinTarget(runtime.client,target)}catch{}
    await sleep(1200);
  }
}

function markRuntimeUpdate(runtime){
  runtime.lastUpdateAt=new Date();
  runtime.updateCount=(runtime.updateCount||0)+1;
}

async function syncRuntimeUpdates(runtime){
  if(runtime.syncing)return;
  runtime.syncing=true;
  const {client,account}=runtime;
  try{
    if(!client.connected){
      console.warn('[NexAccount updates]',String(account.telegramUserId),'disconnected; reconnecting');
      await client.connect();
    }
    await client.catchUp();
    runtime.lastCatchUpAt=new Date();
    runtime.catchUpFailures=0;
  }catch(error){
    runtime.catchUpFailures=(runtime.catchUpFailures||0)+1;
    console.error('[NexAccount updates]',String(account.telegramUserId),'catchup_failed',runtime.catchUpFailures,String(error?.errorMessage||error?.message||error).slice(0,500));
    if(runtime.catchUpFailures>=3){
      try{
        await client.disconnect();
        await sleep(750);
        await client.connect();
        await client.catchUp();
        runtime.lastCatchUpAt=new Date();
        runtime.catchUpFailures=0;
        console.log('[NexAccount updates]',String(account.telegramUserId),'stream_recovered');
      }catch(reconnectError){
        console.error('[NexAccount updates]',String(account.telegramUserId),'reconnect_failed',String(reconnectError?.errorMessage||reconnectError?.message||reconnectError).slice(0,500));
      }
    }
  }finally{
    runtime.syncing=false;
  }
}

async function maybeHandleSelfCommand(runtime,event,source='event'){
  const {client,account}=runtime;
  const message=event?.message;
  if(!message)return false;
  const settings=await settingsFor(account.telegramUserId);
  const selfAuthored=isSelfAuthoredMessage(message,account);
  const accessMode=settings.accessMode==='public'?'public':'private';
  if(!selfAuthored&&accessMode!=='public')return false;
  if(!selfAuthored&&await messageAuthorIsBot(client,message,event?.sender))return false;
  const parsed=parseCommand(textOf(message),settings.prefix||'.');
  if(!parsed)return false;
  if(!claimCommand(account.telegramUserId,message))return true;
  console.log(
    '[NexAccount command]',
    String(account.telegramUserId),
    parsed.name,
    'source='+source,
    'access='+accessMode,
    'self='+String(selfAuthored),
    'messageId='+String(message?.id||''),
    'out='+String(message?.out===true),
    'author='+messageAuthorId(message)
  );
  const handled=await handleCommand(runtime,event,parsed);
  if(handled===false){
    const lang=String(settings.language||account.preferredLanguage||'fr').toLowerCase();
    await sendText(
      client,
      message.peerId,
      lang.startsWith('en')
        ? 'Unknown command: '+String(settings.prefix||'.')+parsed.name+'. Use '+String(settings.prefix||'.')+'menu to see available commands.'
        : 'Commande inconnue : '+String(settings.prefix||'.')+parsed.name+'. Utilise '+String(settings.prefix||'.')+'menu pour voir les commandes disponibles.'
    );
  }
  return true;
}

function messageTimestampMs(message){
  const value=message?.date;
  if(value instanceof Date)return value.getTime();
  const n=Number(value||0);
  if(!Number.isFinite(n)||n<=0)return 0;
  return n>1e12?n:n*1000;
}

async function pollRecentCommands(runtime){
  if(runtime.pollingCommands)return;
  runtime.pollingCommands=true;
  const {client,account}=runtime;
  try{
    if(!client.connected)return;
    const settings=await settingsFor(account.telegramUserId);
    const prefix=String(settings.prefix||'.');
    const since=Number(runtime.commandPollStartedAt||runtime.startedAt?.getTime?.()||Date.now())-1500;
    const now=Date.now();

    async function inspect(message,isGroup=false){
      if(!message)return;
      const stamp=messageTimestampMs(message);
      if(stamp&&stamp<since)return;
      const selfAuthored=isSelfAuthoredMessage(message,account);
      const accessMode=settings.accessMode==='public'?'public':'private';
      if(!selfAuthored&&accessMode!=='public')return;
      const raw=textOf(message);
      // Polling only handles the configured account prefix. Internal
      // traffic uses slash commands and must never be re-consumed here.
      if(!prefix||!raw.startsWith(prefix))return;
      if(!parseCommand(raw,prefix))return;
      await maybeHandleSelfCommand(runtime,{message,isGroup},'poll');
    }

    // Saved Messages is a common control surface and is cheap to poll directly.
    try{
      const selfMessages=await client.getMessages('me',{limit:8});
      for(const message of [...selfMessages].reverse())await inspect(message,false);
    }catch(error){
      console.warn('[NexAccount command-poll]',String(account.telegramUserId),'self_history_failed',String(error?.errorMessage||error?.message||error).slice(0,300));
    }

    // Also cover commands typed in normal chats. getDialogs already carries the
    // current top message; only fetch a short tail when a very recent dialog
    // changed after our command and hid it from the top slot.
    const dialogs=await client.getDialogs({limit:24});
    for(const dialog of dialogs){
      const top=dialog?.message;
      const topStamp=messageTimestampMs(top);
      if(topStamp&&topStamp<since)continue;
      await inspect(top,dialog?.isGroup===true);

      const topRaw=textOf(top);
      const topIsOwnCommand=
        (isSelfAuthoredMessage(top,account)||settings.accessMode==='public')&&
        !!prefix&&
        topRaw.startsWith(prefix)&&
        !!parseCommand(topRaw,prefix);

      if(!topIsOwnCommand&&topStamp&&now-topStamp<45000){
        try{
          const recent=await client.getMessages(dialog.inputEntity||dialog.entity||dialog,{limit:5});
          for(const message of [...recent].reverse())await inspect(message,dialog?.isGroup===true);
        }catch{}
      }
    }

    runtime.lastCommandPollAt=new Date();
    runtime.commandPollFailures=0;
  }catch(error){
    runtime.commandPollFailures=(runtime.commandPollFailures||0)+1;
    console.error('[NexAccount command-poll]',String(account.telegramUserId),'failed',runtime.commandPollFailures,String(error?.errorMessage||error?.message||error).slice(0,500));
  }finally{
    runtime.pollingCommands=false;
  }
}

function rawCommandEvent(update,account){
  const self=BigInt(String(account.telegramUserId));
  if(update instanceof Api.UpdateNewMessage||update instanceof Api.UpdateNewChannelMessage){
    if(!(update.message instanceof Api.Message))return null;
    return {message:update.message,isGroup:!!(update.message?.peerId?.chatId||update.message?.peerId?.channelId)};
  }
  if(update instanceof Api.UpdateShortMessage){
    return {
      message:{
        out:update.out===true,
        id:update.id,
        peerId:new Api.PeerUser({userId:update.userId}),
        fromId:new Api.PeerUser({userId:update.out===true?self:update.userId}),
        message:update.message,
        date:update.date,
        entities:update.entities
      },
      isGroup:false
    };
  }
  if(update instanceof Api.UpdateShortChatMessage){
    return {
      message:{
        out:update.out===true,
        id:update.id,
        peerId:new Api.PeerChat({chatId:update.chatId}),
        fromId:new Api.PeerUser({userId:update.out===true?self:update.fromId}),
        message:update.message,
        date:update.date,
        entities:update.entities
      },
      isGroup:true
    };
  }
  return null;
}

export async function attachConnectedClient(client,account,{leaseOwned=false}={}){
  const id=String(account.telegramUserId);
  try{
    const me=await client.getMe();
    if(me?.id!==undefined&&me?.id!==null){
      account.connectedTelegramUserId=String(me.id);
      account.sessionTelegramUserId=String(me.id);
      if(account.connectedTelegramUserId!==id){
        console.warn('[NexAccount identity]',id,'session_user='+account.connectedTelegramUserId);
      }
      account.premium=me.premium===true;
      account.username=me.username||account.username;
      account.firstName=me.firstName||account.firstName;
    }
  }catch(error){
    console.warn('[NexAccount identity]',id,'getMe_failed',String(error?.errorMessage||error?.message||error).slice(0,300));
  }
  if(cfg.workerCount>1&&!accountAssignedToWorker(id)){
    try{await client.disconnect()}catch{}
    if(leaseOwned)await releaseRuntimeLease(id).catch(()=>{});
    return null;
  }
  if(!runtimes.has(id)&&runtimes.size>=cfg.maxRuntimesPerWorker){
    try{await client.disconnect()}catch{}
    if(leaseOwned)await releaseRuntimeLease(id).catch(()=>{});
    return null;
  }
  if(!leaseOwned){
    const leased=await acquireRuntimeLease(id);
    if(!leased){
      try{await client.disconnect()}catch{}
      return null;
    }
  }
  if(runtimes.has(id)){
    const old=runtimes.get(id);
    clearRuntimeTimers(old);
    await stopAnimeIngest(old).catch(()=>{});
    try{await old.client.disconnect()}catch{}
    runtimes.delete(id);
  }
  const runtime=createRuntimeContext({
    client,
    account,
    animePublisher:isPrimaryAnimePublisher(account)
  });
  runtime.setPresenceEnabled=enabled=>configurePresence(runtime,enabled);
  runtimes.set(id,runtime);

  client.addEventHandler(async event=>{
    markRuntimeUpdate(runtime);
    try{
      if(await maybeHandleSelfCommand(runtime,event,'outgoing'))return;
    }catch(e){
      console.error('[NexAccount outgoing]',id,String(e?.errorMessage||e?.message||e));
      try{await sendText(client,event.message?.peerId,'NexAi error: '+String(e?.errorMessage||e?.message||e).slice(0,300))}catch{}
    }
  },new NewMessage({outgoing:true}));

  client.addEventHandler(async event=>{
    markRuntimeUpdate(runtime);
    try{
      // Messages sent by this same account from another Telegram session may
      // arrive with out=false. Treat self-authored dot commands as commands.
      if(await maybeHandleSelfCommand(runtime,event,'incoming-self'))return;
      if(await handleAnimeIngestEvent(runtime,event))return;
      await maybeAutoModerate(runtime,event);
      await maybeServiceGreeting(runtime,event);
      await maybeAutoReact(runtime,event);
      const autoReplied=await maybeAutoReply(runtime,event);
      if(!autoReplied)await maybeNlpMode(runtime,event);
    }catch(e){console.error('[NexAccount incoming]',id,e)}
  },new NewMessage({incoming:true}));

  // Raw fallback: process command-bearing update shapes directly. This avoids
  // relying exclusively on NewMessage direction classification across sessions.
  client.addEventHandler(async update=>{
    try{
      const event=rawCommandEvent(update,account);
      if(!event)return;
      const settings=await settingsFor(id);
      const parsed=parseCommand(textOf(event.message),settings.prefix||'.');
      if(!parsed)return;
      console.log(
        '[NexAccount raw-command]',
        id,
        parsed.name,
        'type='+String(update?.className||update?.constructor?.name||'Update'),
        'out='+String(event.message?.out===true),
        'author='+messageAuthorId(event.message)
      );
      await maybeHandleSelfCommand(runtime,event,'raw');
    }catch(e){
      console.error('[NexAccount raw]',id,String(e?.errorMessage||e?.message||e));
    }
  });

  await startAnimeIngest(runtime).catch(e=>console.error('[NexAnime start]',id,String(e?.message||e)));

  runAutoJoin(runtime).catch(()=>{});
  runtime.autoJoinTimer=setInterval(()=>runAutoJoin(runtime).catch(()=>{}),30*60*1000);
  runtime.autoJoinTimer.unref?.();

  await maintainPresence(runtime);
  runtime.presenceTimer=setInterval(()=>maintainPresence(runtime).catch(()=>{}),45*1000);
  runtime.presenceTimer.unref?.();

  // Telegram can leave a session transport connected while the update stream
  // has silently stopped advancing. catchUp() asks Telegram for the missing
  // difference and dispatches those updates through the normal event handlers.
  await syncRuntimeUpdates(runtime);
  runtime.updateSyncTimer=setInterval(()=>syncRuntimeUpdates(runtime),cfg.updateSyncMs);
  runtime.updateSyncTimer.unref?.();

  await pollRecentCommands(runtime);
  runtime.commandPollTimer=setInterval(()=>pollRecentCommands(runtime),cfg.commandPollMs);
  runtime.commandPollTimer.unref?.();

  runtime.leaseTimer=setInterval(async()=>{
    try{
      const ok=await renewRuntimeLease(id);
      if(!ok){
        console.error('[NexAccount lease] lost '+id+' on '+cfg.workerId);
        await detachRuntime(id,{releaseLease:false});
      }
    }catch(e){
      console.error('[NexAccount lease] renew failed '+id,String(e?.message||e));
    }
  },Math.max(10000,Math.floor(cfg.runtimeLeaseMs/3)));
  runtime.leaseTimer.unref?.();

  console.log('[NexAccount] account '+id+' attached on '+cfg.workerId+(account.premium?' · Premium':''));
  return runtime;
}

export async function detachRuntime(telegramUserId,{releaseLease=true}={}){
  const id=String(telegramUserId);
  const runtime=runtimes.get(id);
  if(runtime){
    clearRuntimeTimers(runtime);
    await stopAnimeIngest(runtime).catch(()=>{});
    try{await runtime.client.disconnect()}catch{}
    runtimes.delete(id);
  }
  if(releaseLease)await releaseRuntimeLease(id).catch(()=>{});
  return true;
}

async function connectSavedAccount(publicAccount){
  const id=String(publicAccount.telegramUserId);
  if(runtimes.has(id))return id;
  if(runtimes.size>=cfg.maxRuntimesPerWorker)return null;
  if(cfg.workerCount>1&&!accountAssignedToWorker(id))return null;
  const leased=await acquireRuntimeLease(id);
  if(!leased)return null;
  try{
    const account=await accountWithSession(id);
    if(!account)throw new Error('No saved NexAccount session');
    const client=new TelegramClient(new StringSession(account.session),cfg.apiId,cfg.apiHash,{connectionRetries:5,autoReconnect:true});
    await client.connect();
    if(!(await client.isUserAuthorized())){
      const error=new Error('Saved Telegram session is no longer authorized');
      error.code='SESSION_UNAUTHORIZED';
      throw error;
    }
    const me=await client.getMe();
    account.premium=me.premium===true;
    account.username=me.username||account.username;
    account.firstName=me.firstName||account.firstName;
    const runtime=await attachConnectedClient(client,account,{leaseOwned:true});
    return runtime?id:null;
  }catch(error){
    await releaseRuntimeLease(id).catch(()=>{});
    if(error?.code==='SESSION_UNAUTHORIZED')await disableAccount(id).catch(()=>{});
    throw error;
  }
}

export async function reconnectRuntime(telegramUserId){
  const id=String(telegramUserId);
  await enableAccount(id);
  if(cfg.workerCount>1&&!accountAssignedToWorker(id))throw new Error('account_assigned_to_other_worker');
  return connectSavedAccount({telegramUserId:id});
}

export async function reconcileRuntimes(){
  if(reconcilingRuntimes)return [];
  reconcilingRuntimes=true;
  try{
    for(const id of [...runtimes.keys()]){
      if(cfg.workerCount>1&&!accountAssignedToWorker(id))await detachRuntime(id);
    }
    const capacity=Math.max(0,cfg.maxRuntimesPerWorker-runtimes.size);
    if(capacity<=0)return [];
    const accounts=await listAccountsForWorker({limit:Math.max(cfg.maxRuntimesPerWorker,cfg.maxRuntimesPerWorker*2)});
    const pending=accounts.filter(a=>!runtimes.has(String(a.telegramUserId))).slice(0,capacity);
    const loaded=[];
    let cursor=0;
    const workers=Array.from({length:Math.min(cfg.restoreConcurrency,pending.length)},async()=>{
      while(true){
        const index=cursor++;
        if(index>=pending.length)return;
        const publicAccount=pending[index];
        try{
          const id=await connectSavedAccount(publicAccount);
          if(id)loaded.push(id);
        }catch(e){
          console.error('[NexAccount restore]',publicAccount.telegramUserId,String(e?.message||e));
        }
      }
    });
    await Promise.all(workers);
    return loaded;
  }finally{
    reconcilingRuntimes=false;
  }
}

export async function loadSavedRuntimes(){
  return reconcileRuntimes();
}

export async function animeRuntimeDiscover(target=''){
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const runtime=[...runtimes.values()].find(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  if(!runtime)throw new Error('anime_listener_runtime_not_active');
  const discovery=await animeDiscoverNow(runtime);
  return {
    ok:true,
    telegramUserId:String(runtime.account.telegramUserId),
    username:runtime.account.username||'',
    ...discovery,
    anime:animeIngestStatus(runtime)
  };
}

export async function animeRuntimeRebuild(target='',deadline=null){
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const runtime=[...runtimes.values()].find(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  if(!runtime)throw new Error('anime_listener_runtime_not_active');
  return animeBeginRebuild(runtime,{deadline});
}


export async function animeRuntimeDedupe(target='',execute=false){
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const candidates=[...runtimes.values()].filter(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  const runtime=candidates.find(r=>r?.animeIngest?.publisher===true)||candidates[0];
  if(!runtime)throw new Error('anime_runtime_not_active');
  return animeDedupePublishedEpisodeVariants(runtime,{dryRun:execute!==true});
}

export async function runtimeCommandTest(telegramUserId,text='.menu',peer='me'){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  const {account}=runtime;
  const settings=await settingsFor(id);
  const parsed=parseCommand(String(text||''),settings.prefix||'.');
  if(!parsed)throw new Error('command_not_parsed');
  await handleCommand(runtime,{
    message:{
      peerId:peer||'me',
      id:0,
      out:true,
      fromId:{userId:account.telegramUserId},
      senderId:account.telegramUserId
    },
    sender:{
      id:account.telegramUserId,
      username:account.username||'',
      premium:account.premium===true,
      bot:false
    },
    isPrivate:true,
    isGroup:false
  },parsed);
  return {ok:true,telegramUserId:id,peer:String(peer||'me'),command:parsed.name};
}

export async function runtimeGroupSmoke(telegramUserId){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  const {client,account}=runtime;
  const settings=await settingsFor(id);
  const prefix=String(settings.prefix||'.');
  const title='NexAi QA '+Date.now();
  let inputChannel=null;
  let chatId='';
  const results=[];

  async function latestId(peer){
    const rows=await client.getMessages(peer,{limit:1});
    const row=Array.isArray(rows)?rows[0]:rows;
    return Number(row?.id||0);
  }
  async function run(peer,text,expected=[]){
    const before=await latestId(peer);
    const parsed=parseCommand(text,prefix);
    if(!parsed)throw new Error('group_smoke_command_not_parsed:'+text);
    let thrown='';
    try{
      await handleCommand(runtime,{
        chatId,
        message:{
          peerId:peer,
          id:0,
          out:true,
          fromId:{userId:account.telegramUserId},
          senderId:account.telegramUserId
        },
        sender:{
          id:account.telegramUserId,
          username:account.username||'',
          premium:account.premium===true,
          bot:false
        },
        isPrivate:false,
        isGroup:true
      },parsed);
    }catch(error){
      thrown=String(error?.errorMessage||error?.message||error).slice(0,400);
    }
    await sleep(250);
    const recent=await client.getMessages(peer,{limit:20});
    const outputs=[...(recent||[])]
      .filter(m=>Number(m?.id||0)>before)
      .sort((a,b)=>Number(a.id||0)-Number(b.id||0))
      .map(m=>textOf(m))
      .filter(Boolean);
    const joined=outputs.join('\n');
    const failed=Boolean(thrown)||/(?:impossible|erreur interne|introuvable|réservée|nécessite)/i.test(joined);
    const expectedOk=(expected||[]).every(x=>joined.includes(x));
    const row={text,ok:!failed&&expectedOk,outputs:outputs.slice(-6)};
    if(thrown)row.error=thrown;
    results.push(row);
    return row;
  }

  try{
    const created=await client.invoke(new Api.channels.CreateChannel({
      title,
      about:'Temporary NexAi automated QA group',
      megagroup:true
    }));
    const chat=(created?.chats||[]).find(x=>x?.id);
    if(!chat)throw new Error('group_smoke_create_failed');
    chatId=String(chat.id);
    inputChannel=getInputChannel(await client.getInputEntity(chat));

    if(cfg.botUsername){
      const botPeer=await client.getInputEntity('@'+cfg.botUsername);
      const botUser=getInputUser(botPeer);
      await client.invoke(new Api.channels.InviteToChannel({channel:inputChannel,users:[botUser]}));
      results.push({text:'invite_inline_bot',ok:true});
      await sleep(500);
    }

    await run(inputChannel,prefix+'id',['Chat ID']);
    await run(inputChannel,prefix+'groupname',[title]);
    await run(inputChannel,prefix+'groupstats',['Membres']);
    await run(inputChannel,prefix+'admins',['NexAi · Admins']);
    await run(inputChannel,prefix+'config',['NexAi · config']);
    await run(inputChannel,prefix+'risk',['Indice de risque']);
    await run(inputChannel,prefix+'antilink on',['ON']);
    await run(inputChannel,prefix+'antispam on',['ON']);
    await run(inputChannel,prefix+'antitag on',['ON']);
    await run(inputChannel,prefix+'antigroupmention on',['ON']);
    await run(inputChannel,prefix+'antibadword on',['ON']);
    await run(inputChannel,prefix+'setrules NEXAI_QA_RULE',['enregistré']);
    await run(inputChannel,prefix+'rules',['NEXAI_QA_RULE']);
    await run(inputChannel,prefix+'slowmode 10',['Slow mode : 10 s']);
    await run(inputChannel,prefix+'slowmode 0',['Slow mode : 0 s']);
    await run(inputChannel,prefix+'grouplink',['https://']);
    if(cfg.botUsername){
      await run(inputChannel,prefix+'tag @'+cfg.botUsername+' NEXAI_QA_TAG',['NEXAI_QA_TAG']);
      await run(inputChannel,prefix+'promote @'+cfg.botUsername,['Administrateur ajouté']);
      await run(inputChannel,prefix+'demote @'+cfg.botUsername,['Administrateur retiré']);
    }
    await run(inputChannel,prefix+'backup',['NexAi · Backup']);
    await run(inputChannel,prefix+'restore',['restaurée']);

    return {
      ok:results.every(x=>x.ok!==false),
      telegramUserId:id,
      temporaryGroup:title,
      chatId,
      results
    };
  }finally{
    if(inputChannel){
      try{await client.invoke(new Api.channels.DeleteChannel({channel:inputChannel}))}
      catch(error){results.push({text:'delete_temporary_group',ok:false,error:String(error?.message||error).slice(0,300)})}
    }
  }
}

export async function runtimeMenuProbe(telegramUserId,peer='me'){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  if(!cfg.botUsername)throw new Error('nexai_bot_username_missing');
  const inputPeer=await runtime.client.getInputEntity(peer||'me');
  const inlineBot=await runtime.client.getInputEntity('@'+cfg.botUsername);
  const results=await runtime.client.invoke(new Api.messages.GetInlineBotResults({
    bot:inlineBot,
    peer:inputPeer,
    query:'menu',
    offset:''
  }));
  const result=results.results?.[0];
  if(!result)throw new Error('inline_menu_no_result');
  return {
    ok:true,
    telegramUserId:id,
    botUsername:'@'+cfg.botUsername,
    resultType:String(result?.className||result?.constructor?.name||'inline-result'),
    resultId:String(result?.id||''),
    hasSendMessage:Boolean(result?.sendMessage)
  };
}

export async function engineStatus(){
  const runtime=[...runtimes.values()][0]||null;
  const providers=aiProviderStatus();
  let stickerProbe={ok:false,botReachable:false,localConversion:false,error:''};
  try{stickerProbe=await stickerEngineDiagnostic()}
  catch(error){stickerProbe.error=String(error?.message||error).slice(0,300)}
  return {
    ok:true,
    standalone:true,
    architecture:{
      version:3,
      sessionLayer:'NexAccount',
      engineLayer:'NexAI',
      presentationLayer:'Inline bot'
    },
    runtimeConnected:runtime?.client?.connected===true,
    engines:[
      {service:'ai',type:'local',configured:providers.length>0,reachable:providers.length>0,providers},
      {service:'download',type:'local',configured:true,reachable:true},
      {service:'group',type:'local',configured:true,reachable:true},
      {
        service:'sticker',
        type:'local',
        configured:stickerProbe.ok===true,
        reachable:stickerProbe.botReachable===true&&stickerProbe.localConversion===true,
        probe:stickerProbe
      },
      {service:'game',type:'local',configured:true,reachable:true},
      {service:'anime',type:'local',configured:true,reachable:true},
      {service:'audio',type:'local',configured:true,reachable:true}
    ]
  };
}

export function runtimeStatus(){
  return [...runtimes.values()].map(r=>({
    telegramUserId:r.account.telegramUserId,
    username:r.account.username,
    firstName:r.account.firstName,
    premium:r.account.premium,
    startedAt:r.startedAt,
    connected:r.client.connected===true,
    lastUpdateAt:r.lastUpdateAt,
    lastCatchUpAt:r.lastCatchUpAt,
    updateCount:r.updateCount||0,
    catchUpFailures:r.catchUpFailures||0,
    lastCommandPollAt:r.lastCommandPollAt,
    commandPollFailures:r.commandPollFailures||0,
    workerId:cfg.workerId,
    anime:animeIngestStatus(r)
  }));
}

export async function stopRuntimes(){
  for(const [id,r] of runtimes.entries()){
    clearRuntimeTimers(r);
    await stopAnimeIngest(r).catch(()=>{});
    try{await r.client.disconnect()}catch{}
    await releaseRuntimeLease(id).catch(()=>{});
  }
  runtimes.clear();
}
