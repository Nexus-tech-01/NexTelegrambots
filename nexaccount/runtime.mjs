import crypto from 'node:crypto';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage } from 'teleproto/events/index.js';
import { cfg, isOwnerId } from './config.mjs';
import { commandMap } from './commands.mjs';
import { accountWithSession, listAccounts, patchSettings, settingsFor } from './store.mjs';
import { listStyles } from './styles.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { recordEvent } from './analytics.mjs';
import { ownerPanelText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';

const commands=commandMap();
const runtimes=new Map();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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

async function proxyCommand(client,peer,cmd,args){
  const botEntity=await client.getInputEntity(cmd.proxy);
  const sent=await client.sendMessage(botEntity,{message:'/'+cmd.name+(args.length?' '+args.join(' '):'')});
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
    await sleep(900);
    const msgs=await client.getMessages(botEntity,{limit:5});
    const response=msgs.find(m=>!m.out&&Number(m.id)>Number(sent.id));
    if(!response)continue;
    if(response.media)await client.forwardMessages(peer,{messages:[response.id],fromPeer:botEntity});
    else if(response.message)await client.sendMessage(peer,{message:response.message});
    return true;
  }
  throw new Error('Le bot source n’a pas répondu à temps');
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
  if(parsed.name==='menu')return sendInline(client,peer,'menu');

  const cmd=commands.get(parsed.name);
  if(!cmd)return false;
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
    try{await proxyCommand(client,peer,{...cmd,name},parsed.args)}
    catch(e){await sendText(client,peer,'Erreur '+name+' : '+String(e.message||e))}
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
      await sendText(client,peer,'La commande '+name+' est enregistrée dans NexAI mais son adaptateur Telegram n’est pas encore chargé.');
      return true;
  }
}

async function maybeAutoReact(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const cfgReact=settings.autoReact||{};
  if(!cfgReact.enabled)return;
  const targets=Array.isArray(cfgReact.targets)?cfgReact.targets:[];
  if(!targets.length)return;
  const chatId=String(event.chatId||event.message?.chatId||'');
  const username=String(event.chat?.username||'').toLowerCase();
  const matched=targets.some(x=>{
    const v=String(x).trim().toLowerCase().replace(/^@/,'');
    return v===chatId||v===username;
  });
  if(!matched)return;
  const reactions=Array.isArray(cfgReact.reactions)&&cfgReact.reactions.length?cfgReact.reactions:['🔥','❤️','👍'];
  const emoticon=reactions[Math.floor(Math.random()*reactions.length)];
  const peer=await client.getInputEntity(event.message.peerId);
  await client.invoke(new Api.messages.SendReaction({peer,msgId:event.message.id,reaction:[new Api.ReactionEmoji({emoticon})]})).catch(()=>{});
}

async function maybeAntiLink(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  if(!settings.antilink?.enabled)return;
  const text=textOf(event.message);
  if(!/(?:https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i.test(text))return;
  try{await client.deleteMessages(event.message.peerId,[event.message.id],{revoke:true})}catch{}
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

export async function attachConnectedClient(client,account){
  const id=String(account.telegramUserId);
  if(runtimes.has(id)){try{await runtimes.get(id).client.disconnect()}catch{}}
  const runtime={client,account,startedAt:new Date()};
  runtimes.set(id,runtime);

  client.addEventHandler(async event=>{
    try{
      const settings=await settingsFor(id);
      const parsed=parseCommand(textOf(event.message),settings.prefix||'.');
      if(parsed)await handleCommand(runtime,event,parsed);
    }catch(e){console.error('[NexAccount outgoing]',id,e)}
  },new NewMessage({outgoing:true}));

  client.addEventHandler(async event=>{
    try{
      await maybeAntiLink(runtime,event);
      await maybeAutoReact(runtime,event);
    }catch(e){console.error('[NexAccount incoming]',id,e)}
  },new NewMessage({incoming:true}));

  runAutoJoin(runtime).catch(()=>{});
  console.log('[NexAccount] account '+id+' attached'+(account.premium?' · Premium':''));
  return runtime;
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

export function runtimeStatus(){
  return [...runtimes.values()].map(r=>({
    telegramUserId:r.account.telegramUserId,
    username:r.account.username,
    firstName:r.account.firstName,
    premium:r.account.premium,
    startedAt:r.startedAt
  }));
}

export async function stopRuntimes(){
  for(const r of runtimes.values()){try{await r.client.disconnect()}catch{}}
  runtimes.clear();
}
