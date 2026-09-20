import crypto from 'node:crypto';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage } from 'teleproto/events/index.js';
import { cfg, isOwnerId } from './config.mjs';
import { commandMap } from './commands.mjs';
import { accountWithSession, disableAccount, enableAccount, listAccounts, patchSettings, settingsFor } from './store.mjs';
import { listStyles } from './styles.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { recordEvent } from './analytics.mjs';
import { ownerPanelText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { handleCompatCommand } from './compat.mjs';
import { menuModel } from './menu.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commands=commandMap();
const runtimes=new Map();
const spamWindows=new Map();
const proxyFlows=new WeakMap();
const handledCommands=new Map();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const PROXY_SERVICE_SPECS={
  nexdownloader:{
    usernameEnv:['NEXAI_NEXDOWNLOADER_BOT_USERNAME','NEXDOWNLOADER__BOT_USERNAME'],
    tokenEnv:['NEXDOWNLOADER__BOT_TOKEN','NEXDOWNLOADER_BOT_TOKEN'],
    fallback:'TheNexDownloader_bot'
  },
  nexgroup:{
    usernameEnv:['NEXAI_NEXGROUP_BOT_USERNAME','NEXGROUP__BOT_USERNAME'],
    tokenEnv:['NEXGROUP__BOT_TOKEN','NEXGROUP_BOT_TOKEN'],
    fallback:'DarkNexus01_bot'
  },
  nexgame:{
    usernameEnv:['NEXAI_NEXGAME_BOT_USERNAME','NEXGAME__BOT_USERNAME'],
    tokenEnv:['NEXGAME__BOT_TOKEN','NEXGAME_BOT_TOKEN'],
    fallback:'TheNexGame_bot'
  },
  nexstick:{
    usernameEnv:['NEXAI_NEXSTICK_BOT_USERNAME','NEXSTICK__BOT_USERNAME'],
    tokenEnv:['NEXSTICK__BOT_TOKEN','NEXSTICK_BOT_TOKEN'],
    fallback:'The_Nexus_techbot'
  },
  nexwhisper:{
    usernameEnv:['NEXAI_NEXWHISPER_BOT_USERNAME','NEXWHISPER__BOT_USERNAME'],
    tokenEnv:['NEXWHISPER__BOT_TOKEN','NEXWHISPER_BOT_TOKEN'],
    fallback:'Nexwhisper_bot'
  },
  nexcanal:{
    usernameEnv:['NEXAI_NEXCANAL_BOT_USERNAME','NEXCANAL__BOT_USERNAME'],
    tokenEnv:['NEXCANAL__BOT_TOKEN','NEXCANAL_BOT_TOKEN'],
    fallback:'the_big_dipper_bot'
  },
  stacy:{
    usernameEnv:['NEXAI_STACY_BOT_USERNAME','STACY_BOT_USERNAME'],
    tokenEnv:['STACY_BOT_TOKEN','STACY__BOT_TOKEN'],
    fallback:'Stacytg_bot'
  },
  dipper:{
    usernameEnv:['NEXAI_DIPPER_BOT_USERNAME','DIPPER_TELEGRAM_BOT_USERNAME'],
    tokenEnv:['DIPPER_TELEGRAM_BOT_TOKEN'],
    fallback:'the_big_dipper_bot'
  },
  nexai:{
    usernameEnv:['NEXAI_BOT_USERNAME'],
    tokenEnv:['NEXAI_BOT_TOKEN'],
    fallback:'NexAi01_bot'
  },
  nexmeta:{
    usernameEnv:['NEXAI_NEXMETA_BOT_USERNAME','NEXMETA_BOT_USERNAME'],
    tokenEnv:['NEXMETA_BOT_TOKEN','NEXMETA__BOT_TOKEN'],
    fallback:''
  }
};
const proxyIdentityCache=new Map();
const HERE=path.dirname(fileURLToPath(import.meta.url));
const ENGINE_REGISTRY_PATH=path.join(HERE,'engine-registry.json');

function loadEngineRegistry(){
  try{
    const raw=JSON.parse(fs.readFileSync(ENGINE_REGISTRY_PATH,'utf8'));
    return raw&&typeof raw==='object'?raw:{};
  }catch{return {}}
}

function registryUsername(service){
  const row=loadEngineRegistry()[String(service||'').toLowerCase()];
  return String(row?.username||'').trim().replace(/^@/,'');
}

function firstEnv(names=[]){
  for(const name of names){
    const value=String(process.env[name]||'').trim();
    if(value)return value;
  }
  return '';
}

async function botUsernameFromToken(token){
  if(!token)return '';
  const response=await fetch('https://api.telegram.org/bot'+token+'/getMe',{signal:AbortSignal.timeout(7000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data?.ok||!data.result?.username)return '';
  return String(data.result.username).replace(/^@/,'');
}

async function resolveProxyUsername(cmd){
  if(cmd?.proxy)return String(cmd.proxy).replace(/^@/,'');
  const service=String(cmd?.proxyService||cmd?.sourceBot||'').toLowerCase();
  if(!service)throw new Error('Aucun moteur source configuré pour '+String(cmd?.name||'cette commande'));
  if(proxyIdentityCache.has(service))return proxyIdentityCache.get(service);
  const spec=PROXY_SERVICE_SPECS[service];
  if(!spec)throw new Error('Moteur source inconnu : '+service);
  let username=registryUsername(service)||firstEnv(spec.usernameEnv).replace(/^@/,'');
  if(!username){
    for(const envName of spec.tokenEnv){
      const token=String(process.env[envName]||'').trim();
      if(!token)continue;
      username=await botUsernameFromToken(token).catch(()=>'');
      if(username)break;
    }
  }
  username=username||spec.fallback;
  if(!username)throw new Error('Le moteur '+service+' n’est pas configuré sur le serveur');
  proxyIdentityCache.set(service,username);
  return username;
}

function randomLong(){
  return BigInt.asIntN(64,BigInt('0x'+crypto.randomBytes(8).toString('hex')));
}
function textOf(message){return String(message?.message||message?.text||'').trim()}
function utf16len(s){return Buffer.from(String(s),'utf16le').length/2}

function parseCommand(text,prefix='.'){
  const t=String(text||'').trim();
  if(!t)return null;
  if(t.startsWith('/')){
    const [head,...args]=t.slice(1).split(/\s+/);
    return {name:head.replace(/@[^\s]+$/,'').toLowerCase(),args};
  }
  if(prefix&&t.startsWith(prefix)){
    const [head,...args]=t.slice(prefix.length).split(/\s+/);
    return {name:head.toLowerCase(),args};
  }
  return null;
}

function messageAuthorId(message){
  return String(message?.senderId||message?.fromId?.userId||message?.fromId?.channelId||'');
}

function isSelfAuthoredMessage(message,account){
  const self=String(account?.telegramUserId||'');
  if(!self||!message)return false;
  if(message.out===true)return true;
  if(messageAuthorId(message)===self)return true;
  // Saved Messages can be represented as a self peer across synchronized sessions.
  if(String(message?.peerId?.userId||'')===self&&message.fromId==null)return true;
  return false;
}

function commandEventKey(message){
  const peer=String(message?.peerId?.userId||message?.peerId?.chatId||message?.peerId?.channelId||'peer');
  return peer+':'+String(message?.id||'0');
}

function claimCommand(message){
  const key=commandEventKey(message);
  const now=Date.now();
  for(const [k,t] of handledCommands){
    if(now-t>10*60*1000)handledCommands.delete(k);
  }
  if(handledCommands.has(key))return false;
  handledCommands.set(key,now);
  return true;
}

async function sendText(client,peer,text){
  return client.sendMessage(peer,{message:String(text)});
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
  const results=await client.invoke(new Api.messages.GetInlineBotResults({
    bot,peer:inputPeer,query:String(query||'menu'),offset:''
  }));
  const result=results.results?.[0];
  if(!result)throw new Error('NexAI Inline Mode ne renvoie aucun résultat');
  return client.invoke(new Api.messages.SendInlineBotResult({
    peer:inputPeer,randomId:randomLong(),queryId:results.queryId,id:result.id
  }));
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
    const note=String(settings.language||'fr').toLowerCase().startsWith('en')
      ? '\n\nInline menu is temporarily unavailable. Text fallback is active.'
      : '\n\nLe menu inline est temporairement indisponible. Le mode texte de secours est actif.';
    return sendText(client,peer,String(model.text||'NexAI')+note);
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

function peerKey(peer){
  return String(peer?.userId||peer?.channelId||peer?.chatId||peer?.className||peer||'');
}
function flowMap(client){
  let map=proxyFlows.get(client);
  if(!map){map=new Map();proxyFlows.set(client,map)}
  return map;
}
function extractReplyButtons(message){
  const rows=message?.replyMarkup?.rows||[];
  const out=[];
  for(const row of rows)for(const b of row?.buttons||[]){
    const text=String(b?.text||'').trim();
    if(!text)continue;
    out.push({text,data:b?.data||null,url:b?.url||null});
  }
  return out;
}
async function relaySourceMessage(client,peer,botEntity,message){
  if(message.media)await client.forwardMessages(peer,{messages:[message.id],fromPeer:botEntity});
  else if(message.message)await client.sendMessage(peer,{message:message.message});
  const buttons=extractReplyButtons(message);
  if(buttons.length){
    const menu=['Actions du module :',...buttons.map((b,i)=>(i+1)+'. '+b.text+(b.url?' · '+b.url:''))].join('\n');
    await client.sendMessage(peer,{message:menu});
  }
  return buttons;
}
async function waitProxyResponses(client,peer,botEntity,afterId,{timeoutMs=25000}={}){
  const deadline=Date.now()+timeoutMs;
  let highest=Number(afterId||0),firstAt=0,last=null,lastButtons=[];
  while(Date.now()<deadline){
    await sleep(650);
    const msgs=await client.getMessages(botEntity,{limit:12});
    const fresh=msgs.filter(m=>!m.out&&Number(m.id)>highest).sort((a,b)=>Number(a.id)-Number(b.id));
    for(const response of fresh){
      highest=Math.max(highest,Number(response.id));
      last=response;
      lastButtons=await relaySourceMessage(client,peer,botEntity,response);
      if(!firstAt)firstAt=Date.now();
    }
    if(firstAt&&Date.now()-firstAt>1600)break;
  }
  return {last,lastButtons,highest};
}
async function proxyCommand(client,peer,cmd,args,event){
  const username=await resolveProxyUsername(cmd);
  const botEntity=await client.getInputEntity('@'+username);
  const contextual=cmd.proxyMode==='contextual'&&event?.isGroup===true;
  if(contextual){
    const fullBot=await client.getEntity('@'+username).catch(()=>null);
    const sourceId=String(fullBot?.id||'');
    const body='/'+cmd.name+'@'+username+(args.length?' '+args.join(' '):'');
    const sent=await client.sendMessage(peer,{message:body});
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      await sleep(700);
      const rows=await client.getMessages(peer,{limit:20});
      const response=rows.find(m=>{
        if(m.out||Number(m.id)<=Number(sent.id))return false;
        const sender=String(m.senderId||m.fromId?.userId||'');
        return !sourceId||sender===sourceId;
      });
      if(!response)continue;
      try{await client.deleteMessages(peer,[sent.id],{revoke:true})}catch{}
      return true;
    }
    throw new Error('Le moteur '+username+' n’a pas répondu dans ce groupe');
  }

  const body=cmd.proxyMode==='chat'
    ? String(args.join(' ')||cmd.name)
    : '/'+cmd.name+(args.length?' '+args.join(' '):'');
  const sent=await client.sendMessage(botEntity,{message:body});
  const result=await waitProxyResponses(client,peer,botEntity,sent.id);
  if(!result.last)throw new Error('Le bot source '+username+' n’a pas répondu à temps');
  flowMap(client).set(peerKey(peer),{
    botEntity,source:'@'+username,peer,lastBotMessageId:Number(result.last.id),
    buttons:result.lastButtons,expiresAt:Date.now()+10*60*1000
  });
  return true;
}

async function handleProxyFlowInput(runtime,event){
  const {client}=runtime;
  const key=peerKey(event.message?.peerId);
  const map=flowMap(client),flow=map.get(key);
  if(!flow)return false;
  if(Date.now()>flow.expiresAt){map.delete(key);return false}
  const raw=textOf(event.message);
  if(raw==='.cancelproxy'||raw==='/cancelproxy'){map.delete(key);await sendText(client,event.message.peerId,'Flux du module fermé.');return true}

  let sentId=flow.lastBotMessageId;
  const n=/^\d{1,2}$/.test(raw)?Number(raw):0;
  const button=n>0?flow.buttons?.[n-1]:null;
  if(button){
    if(button.url){await sendText(client,event.message.peerId,button.url);return true}
    if(button.data){
      await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer:flow.botEntity,msgId:flow.lastBotMessageId,data:button.data
      }));
      await sleep(800);
      const editedRows=await client.getMessages(flow.botEntity,{ids:[flow.lastBotMessageId]});
      const edited=Array.isArray(editedRows)?editedRows[0]:editedRows;
      if(edited){
        flow.buttons=await relaySourceMessage(client,event.message.peerId,flow.botEntity,edited);
        flow.lastBotMessageId=Number(edited.id);
      }
    }else{
      const sent=await client.sendMessage(flow.botEntity,{message:button.text});
      sentId=Number(sent.id);
    }
  }else if(event.message?.media){
    const forwarded=await client.forwardMessages(flow.botEntity,{messages:[event.message.id],fromPeer:event.message.peerId});
    const arr=Array.isArray(forwarded)?forwarded:[forwarded];sentId=Math.max(sentId,...arr.map(x=>Number(x?.id||0)));
  }else if(raw){
    const sent=await client.sendMessage(flow.botEntity,{message:raw});
    sentId=Number(sent.id);
  }else return false;

  const result=await waitProxyResponses(client,event.message.peerId,flow.botEntity,sentId,{timeoutMs:25000});
  if(result.last){
    flow.lastBotMessageId=Number(result.last.id);
    flow.buttons=result.lastButtons;
    flow.expiresAt=Date.now()+10*60*1000;
    map.set(key,flow);
  }
  return true;
}

async function premiumDenied(client,peer,name){
  await sendText(client,peer,'Cette commande ('+name+') est disponible uniquement pour les utilisateurs Premium.');
}

async function handleStyle(runtime,peer,args,inlineName=''){
  const {account,client}=runtime;
  let n=Number(args?.[0]||inlineName.replace(/^style/i,''));
  if(!n){await sendInline(client,peer,'styles');return}
  const styles=await listStyles();
  if(!styles.some(s=>s.id===n)||n===0){
    await sendText(client,peer,'Style invalide. Utilise .style pour afficher les styles disponibles.');
    return;
  }
  await patchSettings(account.telegramUserId,{style:n});
  const s=styles.find(x=>x.id===n);
  await sendText(client,peer,'Style changé : '+s.name+' ('+n+').');
}

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
  if(cmd.ownerOnly&&!isOwnerId(account.telegramUserId))return true;

  const name=cmd.aliasFor||cmd.name;
  await recordEvent(account,'command',{source:'nexaccount',command:name,chatType:'account'}).catch(()=>{});

  if(name==='creator')return sendCreator(runtime,peer);
  if(cmd.ownerOnly)return handleOwner(runtime,peer,name,parsed.args);

  if(cmd.premium&&!account.premium){
    await premiumDenied(client,peer,name);
    return true;
  }
  if(cmd.proxy){
    const proxyName=cmd.sourceCommand||name;
    try{await proxyCommand(client,peer,{...cmd,name:proxyName},parsed.args,event)}
    catch(e){await sendText(client,peer,'Erreur '+name+' : '+String(e.message||e))}
    return true;
  }

  const compatHandled=await handleCompatCommand({
    runtime,event,name,args:parsed.args,cmd,sendText,proxyCommand,sendInline
  });
  if(compatHandled)return true;

  if(cmd.sourceBot){
    const proxyName=cmd.sourceCommand||name;
    const mode=cmd.sourceBot==='nexgroup'?'contextual':cmd.proxyMode;
    try{
      await proxyCommand(client,peer,{...cmd,name:proxyName,proxyService:cmd.sourceBot,proxyMode:mode},parsed.args,event);
    }catch(e){
      await sendText(client,peer,'Erreur '+name+' : '+String(e.message||e));
    }
    return true;
  }

  switch(name){
    case 'ping':{
      const t=Date.now();
      await sendText(client,peer,'Pong · '+Math.max(1,Date.now()-t)+' ms');
      return true;
    }
    case 'alive':
      await sendText(client,peer,'NexAccount est actif sur ce compte.');
      return true;
    case 'account':
      await sendText(client,peer,'Compte : '+(account.username?'@'+account.username:account.firstName)+'\nPremium : '+(account.premium?'Oui':'Non')+'\nNexAccount : connecté');
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

async function maybeNlpMode(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  if(settings.nlpMode?.enabled!==true||autoFeaturesMuted(settings,event))return false;
  const raw=textOf(event.message);
  if(!raw||event.message?.media)return false;
  try{
    await proxyCommand(client,event.message.peerId,{
      name:'ai',proxy:'@Stacytg_bot',proxyMode:'chat'
    },[raw],event);
  }catch(e){
    console.error('[NexAccount nlp]',account.telegramUserId,String(e.message||e));
  }
  return true;
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
    const ext=mime.includes('video')?'mp4':mime.includes('audio')?'mp3':mime.includes('image')?'jpg':'bin';
    await client.sendFile(event.message.peerId,{file:buffer,fileName:'nexai-autoreply.'+ext});
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
  if(remove){try{await client.deleteMessages(message.peerId,[message.id],{revoke:true})}catch{}}
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
  const {account}=runtime;
  const message=event?.message;
  if(!message||!isSelfAuthoredMessage(message,account))return false;
  const settings=await settingsFor(account.telegramUserId);
  const parsed=parseCommand(textOf(message),settings.prefix||'.');
  if(!parsed)return false;
  if(!claimCommand(message))return true;
  console.log(
    '[NexAccount command]',
    String(account.telegramUserId),
    parsed.name,
    'source='+source,
    'messageId='+String(message?.id||''),
    'out='+String(message?.out===true),
    'author='+messageAuthorId(message)
  );
  await handleCommand(runtime,event,parsed);
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
      if(!isSelfAuthoredMessage(message,account))return;
      const raw=textOf(message);
      // Polling only handles the configured account prefix. Internal proxy
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
        isSelfAuthoredMessage(top,account)&&
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

export async function attachConnectedClient(client,account){
  const id=String(account.telegramUserId);
  if(runtimes.has(id)){try{await runtimes.get(id).client.disconnect()}catch{}}
  const runtime={
    client,
    account,
    startedAt:new Date(),
    lastUpdateAt:null,
    lastCatchUpAt:null,
    updateCount:0,
    catchUpFailures:0,
    syncing:false,
    commandPollStartedAt:Date.now(),
    lastCommandPollAt:null,
    commandPollFailures:0,
    pollingCommands:false
  };
  runtimes.set(id,runtime);

  client.addEventHandler(async event=>{
    markRuntimeUpdate(runtime);
    try{
      if(await maybeHandleSelfCommand(runtime,event,'outgoing'))return;
      if(!(await handleProxyFlowInput(runtime,event)))await maybeNlpMode(runtime,event);
    }catch(e){
      console.error('[NexAccount outgoing]',id,String(e?.errorMessage||e?.message||e));
      try{await sendText(client,event.message?.peerId,'NexAccount error: '+String(e?.errorMessage||e?.message||e).slice(0,300))}catch{}
    }
  },new NewMessage({outgoing:true}));

  client.addEventHandler(async event=>{
    markRuntimeUpdate(runtime);
    try{
      // Messages sent by this same account from another Telegram session may
      // arrive with out=false. Treat self-authored dot commands as commands.
      if(await maybeHandleSelfCommand(runtime,event,'incoming-self'))return;
      await maybeAutoModerate(runtime,event);
      await maybeServiceGreeting(runtime,event);
      await maybeAutoReact(runtime,event);
      await maybeAutoReply(runtime,event);
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

  runAutoJoin(runtime).catch(()=>{});
  runtime.autoJoinTimer=setInterval(()=>runAutoJoin(runtime).catch(()=>{}),30*60*1000);
  runtime.autoJoinTimer.unref?.();

  // Telegram can leave a session transport connected while the update stream
  // has silently stopped advancing. catchUp() asks Telegram for the missing
  // difference and dispatches those updates through the normal event handlers.
  await syncRuntimeUpdates(runtime);
  runtime.updateSyncTimer=setInterval(()=>syncRuntimeUpdates(runtime),8000);
  runtime.updateSyncTimer.unref?.();

  await pollRecentCommands(runtime);
  runtime.commandPollTimer=setInterval(()=>pollRecentCommands(runtime),3000);
  runtime.commandPollTimer.unref?.();

  console.log('[NexAccount] account '+id+' attached'+(account.premium?' · Premium':''));
  return runtime;
}

export async function detachRuntime(telegramUserId){
  const id=String(telegramUserId);
  const runtime=runtimes.get(id);
  if(runtime){
    if(runtime.autoJoinTimer)clearInterval(runtime.autoJoinTimer);
    if(runtime.updateSyncTimer)clearInterval(runtime.updateSyncTimer);
    if(runtime.commandPollTimer)clearInterval(runtime.commandPollTimer);
    try{await runtime.client.disconnect()}catch{}
    runtimes.delete(id);
  }
  return true;
}

export async function reconnectRuntime(telegramUserId){
  const id=String(telegramUserId);
  await enableAccount(id);
  try{
    const account=await accountWithSession(id);
    if(!account)throw new Error('No saved NexAccount session');
    const client=new TelegramClient(new StringSession(account.session),cfg.apiId,cfg.apiHash,{connectionRetries:5,autoReconnect:true});
    await client.connect();
    if(!(await client.isUserAuthorized()))throw new Error('Saved Telegram session is no longer authorized');
    const me=await client.getMe();
    account.premium=me.premium===true;
    account.username=me.username||account.username;
    account.firstName=me.firstName||account.firstName;
    return attachConnectedClient(client,account);
  }catch(error){
    await disableAccount(id).catch(()=>{});
    throw error;
  }
}

export async function loadSavedRuntimes(){
  const accounts=await listAccounts();
  const loaded=[];
  for(const publicAccount of accounts){
    try{
      const account=await accountWithSession(publicAccount.telegramUserId);
      const client=new TelegramClient(new StringSession(account.session),cfg.apiId,cfg.apiHash,{connectionRetries:5,autoReconnect:true});
      await client.connect();
      const me=await client.getMe();
      account.premium=me.premium===true;
      account.username=me.username||account.username;
      await attachConnectedClient(client,account);
      loaded.push(account.telegramUserId);
    }catch(e){
      console.error('[NexAccount restore]',publicAccount.telegramUserId,String(e.message||e));
    }
  }
  return loaded;
}

export async function runtimeCommandTest(telegramUserId,text='.menu',peer='me'){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  const settings=await settingsFor(id);
  const parsed=parseCommand(String(text||''),settings.prefix||'.');
  if(!parsed)throw new Error('command_not_parsed');
  await handleCommand(runtime,{message:{peerId:peer||'me',id:0},isGroup:false},parsed);
  return {ok:true,telegramUserId:id,peer:String(peer||'me'),command:parsed.name};
}

export async function engineStatus(){
  const registry=loadEngineRegistry();
  const runtime=[...runtimes.values()][0]||null;
  const rows=[];
  for(const [service,row] of Object.entries(registry)){
    if(!row||typeof row!=='object'||Array.isArray(row))continue;
    const username=String(row?.username||'').trim().replace(/^@/,'');
    const item={
      service,
      username:username||null,
      enabled:row?.enabled!==false,
      configured:!!username,
      reachable:null,
      error:null
    };
    if(!username){rows.push(item);continue}
    if(!runtime?.client?.connected){
      item.reachable=false;
      item.error='runtime_not_connected';
      rows.push(item);
      continue;
    }
    try{
      const entity=await runtime.client.getEntity('@'+username);
      item.reachable=!!entity;
      item.telegramId=entity?.id?String(entity.id):null;
      item.bot=entity?.bot===true;
    }catch(error){
      item.reachable=false;
      item.error=String(error?.errorMessage||error?.message||error).slice(0,300);
    }
    rows.push(item);
  }
  return {ok:true,runtimeConnected:runtime?.client?.connected===true,engines:rows};
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
    commandPollFailures:r.commandPollFailures||0
  }));
}

export async function stopRuntimes(){
  for(const r of runtimes.values()){
    if(r.autoJoinTimer)clearInterval(r.autoJoinTimer);
    if(r.updateSyncTimer)clearInterval(r.updateSyncTimer);
    if(r.commandPollTimer)clearInterval(r.commandPollTimer);
    try{await r.client.disconnect()}catch{}
  }
  runtimes.clear();
}
