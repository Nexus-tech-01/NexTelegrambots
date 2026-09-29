import crypto from 'node:crypto';
import { Api } from 'teleproto';
import { getInputChannel, getInputUser } from 'teleproto/Utils.js';
import { cfg, isOwnerId } from './config.mjs';
import { customEmojiLibraryStats, listConnectedAccounts, patchSettings, settingsFor } from './store.mjs';
import { sessionsText } from './session-view.mjs';
import { toSmallCaps } from './styles.mjs';
import { AUDIO_LAB_COMMANDS, handleAudioLabCommand } from './audio-lab.mjs';
import { canHandleDownloadCommand, handleDownloadCommand } from './dipper-fallback.mjs';
import { canHandleStickerCommand, handleStickerCommand } from './sticker-engine.mjs';
import { canHandleAiCommand, handleAiCommand } from './ai-engine.mjs';
import { canHandleGameCommand, handleGameCommand } from './game-engine.mjs';
import { sendTelegramMedia } from './media-send.mjs';
import { commandMap } from './commands.mjs';
import { createProgress, syncOwnedCustomEmojiLibrary } from './response-ui.mjs';

const DL_MAP={
  cobalt:'facebook',facebook:'facebook',
  instagram:'instagram',igs:'instagram','sᴄᴇᴀᴜ_ɪɢ_ᴄᴀʀʀᴇ':'instagram',
  pinterest:'pinterest',song:'song',tiktok:'tiktok',tomp3:'tomp3',video:'video',
  download:'download',dl:'download',snapchat:'snapchat',snap:'snapchat',snapdl:'snapchat',
  capcut:'capcut',capcutdl:'capcut',twitter:'twitter',x:'twitter',xdl:'twitter',
  reddit:'reddit',soundcloud:'soundcloud',scdl:'soundcloud',vimeo:'vimeo',tumblr:'tumblr',
  'ᴄᴀɴᴛɪǫᴜᴇ':'lyrics',apksearch:'apk'
};
const STICKER_MAP={sceau:'sticker',sticker:'sticker',reflet:'sticker',effet:'sticker'};
const GROUP_ALIAS={
  accueil:'welcome',inscription:'setwelcome',motsadieu:'setgoodbye',sentence:'warn',
  silence:'mutechat',parole:'unmutechat',debannissement:'unban',bannir:'ban',
  purification:'clean',meteo:'weather','sᴍᴀʟʟᴄᴀᴘs':'smallcaps','ғᴀɴᴄʏ':'fancy',
  algebre:'calc'
};
const SAFE_UNSUPPORTED=new Set([
  'execute','runeval','darkfile','save','crash','mise_a_jour','renaissance','reload','visa',
  'tostatus','tovv','antiwalink','antistatusmention','rejet_appels','autorecording'
]);

const TRUTHS=[
  'Quelle vérité gardes-tu le plus souvent pour toi ?',
  'Quelle habitude voudrais-tu vraiment changer ?',
  'Quel est ton plus gros regret récent ?',
  'Quelle personne te connaît le mieux ?',
  'Quel compliment t’a le plus marqué ?'
];
const DARES=[
  'Envoie un compliment sincère à la dernière personne qui t’a écrit.',
  'Écris une phrase entière sans utiliser la lettre « e ».',
  'Change ta bio pendant dix minutes avec une phrase choisie par le groupe.',
  'Fais une déclaration dramatique comme dans un anime.',
  'Envoie le dernier meme enregistré sur ton téléphone.'
];
const JOKES=[
  'Pourquoi les développeurs confondent Halloween et Noël ? Parce que OCT 31 = DEC 25.',
  'Mon code fonctionne. Je ne le touche plus : c’est désormais un site historique.',
  'Le Wi-Fi et moi, c’est sérieux : dès qu’il part, je ressens le manque.',
  'J’ai demandé une pause au serveur. Il m’a répondu 503.'
];
const COMPLIMENTS=[
  'Tu as le genre d’énergie qui améliore une conversation.',
  'Ton style a quelque chose de vraiment reconnaissable.',
  'Tu rends les choses compliquées plus intéressantes.',
  'Ta présence se remarque sans avoir besoin de forcer.'
];
const PICKUPS=[
  'Tu es une mise à jour ? Parce que depuis que tu es là, tout semble mieux fonctionner.',
  'Même mon mode économie d’énergie ferait une exception pour toi.',
  'Tu dois être un bug rare : impossible de t’ignorer.'
];

const pick=a=>a[Math.floor(Math.random()*a.length)];
const clean=s=>String(s??'').trim();

const MENU_EMOJI_KEYS=new Set([
  'GENERAL','ACCOUNT','AI','DOWNLOAD','GROUP','SHIELD','TOOLS','MEDIA','STICKER',
  'GAMES','SEARCH','ANIME','PREMIUM','OWNER','NEXTECH','NEWS','DARK','BACK','STYLE'
]);
function menuEmojiSettingKey(value,settings){
  let raw=clean(value).toUpperCase().replace(/^NEXAI_EMOJI_/,'').replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  if(raw==='CURRENT'||raw==='CURRENT_STYLE')raw='STYLE_'+Math.max(1,Math.min(31,Number(settings?.style)||1));
  if(raw==='PROTECTION')raw='SHIELD';
  if(raw==='STICKERS')raw='STICKER';
  if(raw==='FUN'||raw==='GAME')raw='GAMES';
  if(/^STYLE_?(?:[1-9]|[12][0-9]|3[01])$/.test(raw)){
    const n=Number(raw.replace(/^STYLE_?/,''));
    raw='STYLE_'+n;
  }else if(!MENU_EMOJI_KEYS.has(raw)){
    return '';
  }
  return 'NEXAI_EMOJI_'+raw;
}
function customEmojiDocumentId(message){
  for(const entity of message?.entities||[]){
    const id=entity?.documentId??entity?.document_id;
    const type=String(entity?.className||entity?.constructor?.name||'');
    if(id!=null&&(/CustomEmoji/i.test(type)||String(entity?._||'').includes('customEmoji')))return String(id);
  }
  return '';
}
const html=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

function replyId(message){
  return Number(message?.replyTo?.replyToMsgId||message?.replyToMsgId||0);
}
async function repliedMessage(client,peer,message){
  const id=replyId(message);
  if(!id)return null;
  try{
    const rows=await client.getMessages(peer,{ids:[id]});
    return Array.isArray(rows)?rows[0]:rows;
  }catch{return null}
}
function mediaTtlSeconds(source){
  const media=source?.media||source;
  return Number(
    media?.ttlSeconds ??
    media?.ttl_seconds ??
    source?.ttlPeriod ??
    source?.ttl_period ??
    source?.ttlSeconds ??
    source?.ttl_seconds ??
    0
  );
}
function sourceBelongsToConnectedAccount(source,account){
  if(source?.out===true)return true;
  const ids=new Set([
    account?.telegramUserId,
    account?.connectedTelegramUserId,
    account?.sessionTelegramUserId
  ].filter(v=>v!==undefined&&v!==null&&String(v)!=='').map(v=>String(v)));
  const sender=String(source?.senderId||source?.fromId?.userId||'');
  return Boolean(sender&&ids.has(sender));
}
function recoveredMediaName(source){
  if(source?.media instanceof Api.MessageMediaPhoto)return 'vv-photo.jpg';
  const doc=source?.media?.document;
  const attrs=Array.isArray(doc?.attributes)?doc.attributes:[];
  const fileName=attrs.find(a=>/DocumentAttributeFilename/i.test(String(a?.className||a?.constructor?.name||'')))?.fileName;
  if(fileName)return String(fileName);
  const mime=String(doc?.mimeType||'');
  if(mime.startsWith('video/'))return 'vv-video.mp4';
  if(mime.startsWith('audio/'))return 'vv-audio.ogg';
  return 'vv-media.bin';
}
async function recoverOwnViewOnce(client,peer,commandMessage,account,afterSend=null){
  const source=await repliedMessage(client,peer,commandMessage);
  if(!source?.media)throw new Error('Réponds à ton média vue unique avec /Vv.');
  if(mediaTtlSeconds(source)<=0)throw new Error('Le média répondu n’est pas éphémère/vue unique.');
  if(!sourceBelongsToConnectedAccount(source,account)){
    throw new Error('VV ne récupère que les médias éphémères envoyés par le compte connecté.');
  }
  const buffer=await client.downloadMedia(source,{});
  if(!buffer||!buffer.length){
    throw new Error('Telegram ne fournit plus les octets de ce média à cette session.');
  }
  return sendTelegramMedia(client,peer,buffer,{
    fileName:recoveredMediaName(source),
    caption:'VV · média récupéré',
    mimeType:String(source?.media?.document?.mimeType||''),
    kind:'auto',
    afterSend
  });
}

async function targetEntity(client,peer,message,args,{optional=false}={}){
  const reply=await repliedMessage(client,peer,message);
  if(reply?.senderId){
    try{return await client.getInputEntity(reply.senderId)}catch{}
  }
  const raw=clean(args?.[0]);
  if(raw){
    try{return await client.getInputEntity(raw.startsWith('@')?raw:raw)}catch{}
  }
  if(optional)return null;
  throw new Error('Réponds au message de la personne ou indique @username / ID.');
}
async function currentChat(client,peer){
  try{return await client.getEntity(peer)}catch{return null}
}
async function participants(client,peer,limit=null){
  try{
    const params={};
    if(Number.isFinite(Number(limit))&&Number(limit)>0){
      params.limit=Math.max(1,Math.min(10000,Number(limit)));
    }
    const rows=await client.getParticipants(peer,params);
    const seen=new Set();
    return (rows||[]).filter(p=>{
      const id=String(p?.id||'');
      if(!id||seen.has(id))return false;
      seen.add(id);
      return true;
    });
  }catch{return []}
}
function isAdminParticipant(p){
  const kind=String(p?.participant?.className||p?.participant?.constructor?.name||'');
  return /Creator|Admin/i.test(kind)||Boolean(p?.participant?.adminRights||p?.adminRights);
}
function displayName(p){
  return clean([p?.firstName,p?.lastName].filter(Boolean).join(' '))||p?.username||String(p?.id||'Utilisateur');
}
async function inputMentionEntity(client,offset,text,user){
  const entity=await client.getInputEntity(user);
  return new Api.InputMessageEntityMentionName({
    offset,
    length:Buffer.from(String(text),'utf16le').length/2,
    userId:getInputUser(entity)
  });
}
async function buildMentionEntities(client,text,people,{hidden=false}={}){
  const entities=[];
  let message=String(text||'');
  for(const p of people){
    if(hidden){
      const marker='\u2063';
      const offset=Buffer.from(message,'utf16le').length/2;
      message+=marker;
      entities.push(await inputMentionEntity(client,offset,marker,p));
    }else{
      message+='• ';
      const name=displayName(p);
      const offset=Buffer.from(message,'utf16le').length/2;
      message+=name+'\n';
      entities.push(await inputMentionEntity(client,offset,name,p));
    }
  }
  return {message,entities};
}
async function sendMentionList(client,peer,people,title){
  const list=(people||[]).filter(p=>p?.id);
  if(!list.length)return client.sendMessage(peer,{message:'Aucun membre trouvé.'});
  const chunks=[];
  for(let i=0;i<list.length;i+=50)chunks.push(list.slice(i,i+50));
  for(let index=0;index<chunks.length;index++){
    const intro=String(title||'Mention générale : tout le monde est invité à lire ce message.').trim();
    const heading=intro+(chunks.length>1?'\nPartie '+(index+1)+'/'+chunks.length:'')+'\n\n';
    const built=await buildMentionEntities(client,heading,chunks[index]);
    await client.sendMessage(peer,{message:built.message.trimEnd(),formattingEntities:built.entities});
  }
}
const HIDDEN_TAG_BATCH=50;
function hiddenTagChunks(people){
  const list=[];
  const seen=new Set();
  for(const p of people||[]){
    const id=String(p?.id||'');
    if(!id||seen.has(id))continue;
    seen.add(id);
    list.push(p);
  }
  const chunks=[];
  for(let i=0;i<list.length;i+=HIDDEN_TAG_BATCH)chunks.push(list.slice(i,i+HIDDEN_TAG_BATCH));
  return chunks;
}
async function sendHiddenMentions(client,peer,people,title){
  const chunks=hiddenTagChunks(people);
  if(!chunks.length)return client.sendMessage(peer,{message:'Aucun membre trouvé.'});
  const visible=String(title||'Tout le monde est invité à lire ce message.').trim();
  for(let i=0;i<chunks.length;i++){
    const base=i===0?visible:'\u2063';
    const built=await buildMentionEntities(client,base,chunks[i],{hidden:true});
    await client.sendMessage(peer,{message:built.message,formattingEntities:built.entities});
  }
}
async function sendHiddenTaggedCopy(client,peer,people,source){
  const chunks=hiddenTagChunks(people);
  if(!chunks.length)return client.sendMessage(peer,{message:'Aucun membre trouvé.'});
  const visible=String(source?.message??source?.text??'');
  const sourceEntities=Array.isArray(source?.entities)?source.entities:[];
  const first=await buildMentionEntities(client,visible,chunks[0],{hidden:true});
  if(source?.media){
    const buffer=await client.downloadMedia(source).catch(()=>null);
    if(!buffer?.length)throw new Error('Impossible de recopier le média répondu.');
    await sendTelegramMedia(client,peer,Buffer.from(buffer),{
      fileName:recoveredMediaName(source),
      caption:first.message,
      mimeType:String(source?.media?.document?.mimeType||''),
      kind:'auto',
      formattingEntities:[...sourceEntities,...first.entities],
      signature:false
    });
  }else{
    await client.sendMessage(peer,{
      message:first.message,
      formattingEntities:[...sourceEntities,...first.entities]
    });
  }
  for(let i=1;i<chunks.length;i++){
    const built=await buildMentionEntities(client,'\u2063',chunks[i],{hidden:true});
    await client.sendMessage(peer,{message:built.message,formattingEntities:built.entities});
  }
}
async function deleteCommandMessage(client,peer,message){
  const id=Number(message?.id||0);
  if(!id)return false;
  try{
    await client.deleteMessages(peer,[id],{revoke:true});
    return true;
  }catch{return false}
}
async function sendSingleMention(client,peer,user,text){
  const name=displayName(user);
  let message=String(text||'Je te mentionne ici.').trim();
  if(message)message+='\n';
  const offset=Buffer.from(message,'utf16le').length/2;
  message+=name;
  const entity=await inputMentionEntity(client,offset,name,user);
  return client.sendMessage(peer,{message,formattingEntities:[entity]});
}
function parseToggle(v,current=false){
  const s=clean(v).toLowerCase();
  if(['on','1','true','yes','oui','enable','activer'].includes(s))return true;
  if(['off','0','false','no','non','disable','desactiver','désactiver'].includes(s))return false;
  return !current;
}
function safeCalc(expr){
  const value=clean(expr);
  if(!value||value.length>160||!/^[0-9+\-*/().%\s]+$/.test(value))throw new Error('Expression invalide.');
  const n=Function('"use strict";return ('+value+')')();
  if(typeof n!=='number'||!Number.isFinite(n))throw new Error('Résultat invalide.');
  return n;
}
function password(length=20){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_=+';
  const n=Math.max(8,Math.min(128,Number(length)||20));
  const b=crypto.randomBytes(n);
  return Array.from(b,(x,i)=>chars[x%chars.length]).join('');
}
async function fetchText(url,options={},timeout=12000){
  const r=await fetch(url,{...options,signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.text();
}
async function fetchJson(url,options={},timeout=12000){
  const r=await fetch(url,{...options,signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
}
async function sendRemoteFile(client,peer,url,{caption='',name,afterSend=null}={}){
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Téléchargement impossible ('+r.status+').');
  const buf=Buffer.from(await r.arrayBuffer());
  return sendTelegramMedia(client,peer,buf,{
    fileName:name||'media',
    caption,
    mimeType:r.headers.get('content-type')||'',
    kind:'auto',
    afterSend
  });
}
function xmlEscape(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&apos;'}[c]))}
function pdfEscape(s){return String(s).replace(/[^\x20-\x7E]/g,'?').replace(/([\\()])/g,'\\$1')}
function simplePdf(text){
  const lines=String(text||'').replace(/\r/g,'').split('\n').flatMap(line=>{
    const out=[];let rest=line;while(rest.length>88){out.push(rest.slice(0,88));rest=rest.slice(88)}out.push(rest);return out;
  }).slice(0,55);
  const stream=['BT','/F1 11 Tf','48 790 Td','14 TL',...lines.map((l,i)=>(i?'T* ':'')+'('+pdfEscape(l)+') Tj'),'ET'].join('\n');
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf='%PDF-1.4\n',offsets=[0];
  objects.forEach((o,i)=>{offsets[i+1]=Buffer.byteLength(pdf);pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n'});
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
  for(let i=1;i<=objects.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  pdf+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  return Buffer.from(pdf);
}
async function uploadCatbox(buffer,filename='file.bin'){
  const form=new FormData();form.append('reqtype','fileupload');form.append('fileToUpload',new Blob([buffer]),filename);
  const r=await fetch('https://catbox.moe/user/api.php',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('Catbox HTTP '+r.status);
  const u=(await r.text()).trim();if(!/^https?:\/\//i.test(u))throw new Error('Upload refusé');return u;
}
function groupPolicy(settings,chatId){
  const all=settings.groupPolicies&&typeof settings.groupPolicies==='object'?settings.groupPolicies:{};
  return {all,policy:all[String(chatId)]||{}};
}
async function patchGroupPolicy(accountId,chatId,patch){
  const settings=await settingsFor(accountId);
  const {all,policy}=groupPolicy(settings,chatId);
  all[String(chatId)]={...policy,...patch};
  await patchSettings(accountId,{groupPolicies:all});
  return all[String(chatId)];
}
async function setListSetting(accountId,key,value,remove=false){
  const s=await settingsFor(accountId);
  const arr=Array.isArray(s[key])?[...s[key]]:[];
  const v=String(value);
  const next=remove?arr.filter(x=>String(x)!==v):[...new Set([...arr,v])];
  await patchSettings(accountId,{[key]:next});
  return next;
}
async function doModeration(client,peer,message,name,args){
  const targetPeer=await targetEntity(client,peer,message,args);
  const target=getInputUser(targetPeer);
  const channel=getInputChannel(await client.getInputEntity(peer));
  if(name==='promote'||name==='selfadmin'){
    await client.invoke(new Api.channels.EditAdmin({
      channel,userId:target,
      adminRights:new Api.ChatAdminRights({
        changeInfo:true,deleteMessages:true,banUsers:true,inviteUsers:true,pinMessages:true,manageCall:true
      }),
      rank:'NexAi'
    }));
    return 'Administrateur ajouté.';
  }
  if(name==='demote'){
    await client.invoke(new Api.channels.EditAdmin({
      channel,userId:target,
      adminRights:new Api.ChatAdminRights({}),
      rank:''
    }));
    return 'Administrateur retiré.';
  }
  if(name==='ban'){
    await client.invoke(new Api.channels.EditBanned({
      channel,participant:target,
      bannedRights:new Api.ChatBannedRights({untilDate:0,viewMessages:true})
    }));
    return 'Utilisateur banni.';
  }
  if(name==='unban'){
    await client.invoke(new Api.channels.EditBanned({
      channel,participant:target,
      bannedRights:new Api.ChatBannedRights({untilDate:0})
    }));
    return 'Utilisateur débanni.';
  }
  if(name==='kick'){
    await client.invoke(new Api.channels.EditBanned({
      channel,participant:target,
      bannedRights:new Api.ChatBannedRights({untilDate:Math.floor(Date.now()/1000)+60,viewMessages:true})
    }));
    await client.invoke(new Api.channels.EditBanned({
      channel,participant:target,
      bannedRights:new Api.ChatBannedRights({untilDate:0})
    })).catch(()=>{});
    return 'Utilisateur retiré.';
  }
  if(name==='mute'){
    const seconds=Math.max(60,Math.min(30*86400,Number(args?.[1])||3600));
    await client.invoke(new Api.channels.EditBanned({
      channel,participant:target,
      bannedRights:new Api.ChatBannedRights({untilDate:Math.floor(Date.now()/1000)+seconds,sendMessages:true})
    }));
    return 'Utilisateur réduit au silence.';
  }
  if(name==='unmute'){
    await client.invoke(new Api.channels.EditBanned({
      channel,participant:target,
      bannedRights:new Api.ChatBannedRights({untilDate:0})
    }));
    return 'Utilisateur peut de nouveau parler.';
  }
  return '';
}

export async function handleCompatCommand({runtime,event,name,args,cmd,sendText,sendInline}){
  const progressFor=async label=>{
    try{return await createProgress(runtime.client,event.message.peerId,label)}catch{return null}
  };
  const {client,account}=runtime;
  const peer=event.message.peerId;
  const reply=text=>sendText(client,peer,String(text??''));
  const mediaCta=()=>reply('');
  const requestedName=name;
  if(cmd?.engine==='group'&&cmd?.sourceCommand)name=cmd.sourceCommand;
  name=GROUP_ALIAS[name]||name;
  const argText=args.join(' ').trim();

  if(AUDIO_LAB_COMMANDS.has(name)){
    return handleAudioLabCommand({runtime,event,name,args,sendText});
  }

  if(DL_MAP[name]&&canHandleDownloadCommand(DL_MAP[name])){
    await handleDownloadCommand({client,peer,name:DL_MAP[name],args,event,reply});
    return true;
  }
  if(STICKER_MAP[name]&&canHandleStickerCommand(STICKER_MAP[name])){
    await handleStickerCommand({runtime,event,name:STICKER_MAP[name],args,reply});
    return true;
  }
  if(['oracle','ai','code','deepseek'].includes(name)){
    if(!argText){await sendText(client,peer,'Écris ta demande après la commande.');return true}
    const mode=name==='oracle'?'ai':name;
    const prefix=mode==='code'?'Aide-moi avec ce code ou cette tâche de programmation : ':mode==='deepseek'?'Raisonne soigneusement sur ceci : ':'';
    await handleAiCommand({runtime,event,name:canHandleAiCommand(mode)?mode:'ai',args:[prefix+argText],reply});
    return true;
  }

  if(name==='allmenu'||name==='grimoire'){await sendInline(client,peer,'menu');return true}
  if(name==='dashboard'||name==='settings'||name==='stats'||name==='premium'){
    const s=await settingsFor(account.telegramUserId);
    if(name==='premium'){
      await sendText(client,peer,'Telegram Premium · compte connecté\nStatut : '+(account.premium?'ACTIF':'NON ACTIF')+'\nLes fonctions de cette catégorie dépendent de Telegram Premium. L’abonnement payant NexAi n’est pas encore activé dans cette phase.');
      return true;
    }
    if(name==='dashboard'||name==='settings'){
      await sendText(client,peer,'NexAi · '+toSmallCaps(name)+'\nCompte : '+(account.username?'@'+account.username:account.firstName||account.telegramUserId)+'\nPréfixe : '+(s.prefix||'.')+'\nMode : '+(s.accessMode==='public'?'PUBLIC':'PRIVÉ')+'\nLangue : '+(s.language||'fr')+'\nStyle : '+(s.style||1)+'\nAuto-join : '+(s.autoJoin?.enabled?'ON':'OFF')+'\nAuto-react : '+(s.autoReact?.enabled?'ON':'OFF'));
      return true;
    }
    await sendText(client,peer,'NexAi · stats\nCompte : '+(account.username?'@'+account.username:account.telegramUserId)+'\nTelegram ID : '+account.telegramUserId+'\nTelegram Premium : '+(account.premium?'oui':'non'));
    return true;
  }
  if(name==='stylelist'){await sendInline(client,peer,'styles');return true}
  if(name==='ping')return false;
  if(name==='help'){
    const query=clean(args[0]).replace(/^\//,'').toLowerCase();
    if(!query){
      await sendText(client,peer,'Utilise /Menu pour parcourir les catégories. Pour les alias : /Help <commande>, par exemple /Help Clonepack.');
      return true;
    }
    const registry=commandMap();
    const found=registry.get(query);
    if(!found){
      await sendText(client,peer,'Commande inconnue : /'+query);
      return true;
    }
    const canonical=found.aliasFor||found.name;
    const base=registry.get(canonical)||found;
    const aliases=[...registry.values()]
      .filter(x=>x.hidden===true&&x.aliasFor===canonical)
      .map(x=>'/'+x.name)
      .sort((a,b)=>a.length-b.length||a.localeCompare(b))
      .slice(0,24);
    await sendText(client,peer,[
      '/'+canonical,
      base.description||'Commande NexAi',
      'Catégorie : '+String(base.category||'MAIN'),
      aliases.length?'Alias : '+aliases.join(' · '):'Alias : aucun'
    ].join('\n'));
    return true;
  }
  if(name==='support'){await sendText(client,peer,'Support : https://t.me/tresor20001');return true}
  if(name==='repo'){await sendText(client,peer,'Nextech : https://github.com/Nexus-tech-01');return true}

  if(name==='vv'){
    const progress=await progressFor('Récupération du média');
    try{
      if(progress)await progress.step('Média éphémère · récupération…');
      await recoverOwnViewOnce(client,peer,event.message,account,mediaCta);
      try{await client.deleteMessages(peer,[event.message.id],{revoke:true})}catch{}
      if(progress)await progress.done('Média récupéré');
    }catch(e){
      if(progress)await progress.fail('VV · '+String(e?.message||e).slice(0,180));
      else await sendText(client,peer,'VV · '+String(e?.message||e));
    }
    return true;
  }

  if(name==='fliptext'){await sendText(client,peer,(argText||'NexAi').split('').reverse().join(''));return true}
  if(name==='genpass'){await sendText(client,peer,password(args[0]));return true}
  if(name==='smallcaps'||name==='fancy'){await sendText(client,peer,toSmallCaps(argText||'NexAi'));return true}
  if(name==='calc'){try{await sendText(client,peer,String(safeCalc(argText)))}catch(e){await sendText(client,peer,'Calcul : '+e.message)}return true}

  if(name==='tinyurl'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : /Tinyurl https://...');return true}
    try{await sendText(client,peer,await fetchText('https://tinyurl.com/api-create.php?url='+encodeURIComponent(argText)))}catch(e){await sendText(client,peer,'TinyURL indisponible : '+e.message)}
    return true;
  }
  if(name==='translate'||name==='traduction'){
    if(!argText){await sendText(client,peer,'Usage : /Translate [langue] texte');return true}
    let target='fr',text=argText;
    if(/^[a-z]{2,3}$/i.test(args[0])&&args.length>1){target=args[0].toLowerCase();text=args.slice(1).join(' ')}
    try{
      const j=await fetchJson('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(text));
      await sendText(client,peer,(j?.[0]||[]).map(x=>x?.[0]||'').join('')||'Traduction indisponible.');
    }catch(e){await sendText(client,peer,'Traduction indisponible : '+e.message)}
    return true;
  }
  if(name==='weather'){
    const place=argText||'Cotonou';
    try{
      const j=await fetchJson('https://wttr.in/'+encodeURIComponent(place)+'?format=j1');
      const c=j?.current_condition?.[0]||{},a=j?.nearest_area?.[0]||{};
      const label=a.areaName?.[0]?.value||place;
      await sendText(client,peer,label+' · '+(c.temp_C??'?')+'°C · '+(c.weatherDesc?.[0]?.value||'')+'\nHumidité : '+(c.humidity??'?')+'% · Vent : '+(c.windspeedKmph??'?')+' km/h');
    }catch(e){await sendText(client,peer,'Météo indisponible : '+e.message)}
    return true;
  }
  if(name==='define'){
    const word=args[0];
    if(!word){await sendText(client,peer,'Usage : /Define mot');return true}
    try{
      const j=await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(word));
      const e=Array.isArray(j)?j[0]:null;
      const defs=(e?.meanings||[]).flatMap(m=>(m.definitions||[]).slice(0,2).map(d=>'• '+d.definition)).slice(0,5);
      await sendText(client,peer,(e?.word||word)+'\n\n'+(defs.join('\n')||'Aucune définition trouvée.'));
    }catch{await sendText(client,peer,'Aucune définition trouvée pour « '+word+' ».')}
    return true;
  }
  if(name==='animeinfo'||name==='anime'){
    if(!argText){await sendText(client,peer,'Usage : /Animeinfo titre');return true}
    try{
      const j=await fetchJson('https://api.jikan.moe/v4/anime?q='+encodeURIComponent(argText)+'&limit=1');
      const a=j?.data?.[0];
      if(!a){await sendText(client,peer,'Anime introuvable.');return true}
      const cap=[a.title,a.title_english,a.type,a.episodes?String(a.episodes)+' épisodes':'',a.score?'Score '+a.score:'',html(a.synopsis||'').slice(0,900)].filter(Boolean).join('\n');
      const image=a.images?.jpg?.large_image_url||a.images?.jpg?.image_url;
      if(image)await sendRemoteFile(client,peer,image,{caption:cap,name:'anime.jpg'});else await sendText(client,peer,cap);
    }catch(e){await sendText(client,peer,'Recherche anime indisponible : '+e.message)}
    return true;
  }
  if(name==='waifu'){
    try{
      const j=await fetchJson('https://api.waifu.pics/sfw/waifu');
      if(!j?.url)throw new Error('no image');
      await sendRemoteFile(client,peer,j.url,{caption:'NexAi · Waifu',name:'waifu.jpg'});
    }catch(e){await sendText(client,peer,'Image anime indisponible : '+e.message)}
    return true;
  }
  if(name==='qr'){
    if(!argText){await sendText(client,peer,'Usage : /Qr texte ou URL');return true}
    const u='https://api.qrserver.com/v1/create-qr-code/?size=512x512&data='+encodeURIComponent(argText);
    try{await sendRemoteFile(client,peer,u,{caption:'NexAi · QR',name:'qr.png'})}catch(e){await sendText(client,peer,'QR indisponible : '+e.message)}
    return true;
  }
  if(name==='tts'){
    if(!argText){await sendText(client,peer,'Usage : /Tts texte');return true}
    const text=argText.slice(0,180),lang=(await settingsFor(account.telegramUserId)).language||'fr';
    const u='https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl='+encodeURIComponent(lang)+'&q='+encodeURIComponent(text);
    try{await sendRemoteFile(client,peer,u,{caption:'NexAi · TTS',name:'tts.mp3'})}catch(e){await sendText(client,peer,'TTS indisponible : '+e.message)}
    return true;
  }
  if(name==='ssweb'||name==='sswebpc'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : /'+name+' https://...');return true}
    const width=name==='sswebpc'?'1440':'390';
    const u='https://image.thum.io/get/width/'+width+'/crop/900/noanimate/'+argText;
    try{await sendRemoteFile(client,peer,u,{caption:'NexAi · Screenshot',name:'screenshot.png'})}catch(e){await sendText(client,peer,'Capture indisponible : '+e.message)}
    return true;
  }
  if(name==='browse'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : /Browse https://...');return true}
    try{
      const t=await fetchText(argText,{headers:{'user-agent':'Mozilla/5.0'}},10000);
      const title=html(t.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
      const desc=html(t.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]||'');
      await sendText(client,peer,[title||argText,desc].filter(Boolean).join('\n\n').slice(0,3500));
    }catch(e){await sendText(client,peer,'Navigation impossible : '+e.message)}
    return true;
  }
  if(name==='downloadinfo'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : /Downloadinfo URL');return true}
    try{
      const r=await fetch(argText,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(10000)});
      await sendText(client,peer,'URL : '+r.url+'\nType : '+(r.headers.get('content-type')||'?')+'\nTaille : '+(r.headers.get('content-length')||'?')+' octets\nHTTP : '+r.status);
    }catch(e){await sendText(client,peer,'Inspection impossible : '+e.message)}
    return true;
  }
  if(name==='imdb'){
    if(!argText){await sendText(client,peer,'Usage : /Imdb titre');return true}
    try{
      const j=await fetchJson('https://api.tvmaze.com/search/shows?q='+encodeURIComponent(argText));
      const s=j?.[0]?.show;
      if(!s){await sendText(client,peer,'Titre introuvable.');return true}
      const cap=[s.name,s.premiered?'Première : '+s.premiered:'',s.rating?.average?'Note : '+s.rating.average:'',html(s.summary||'').slice(0,900),s.url].filter(Boolean).join('\n');
      if(s.image?.original)await sendRemoteFile(client,peer,s.image.original,{caption:cap,name:'show.jpg'});else await sendText(client,peer,cap);
    }catch(e){await sendText(client,peer,'Recherche indisponible : '+e.message)}
    return true;
  }
  if(name==='gsmarena'){
    if(!argText){await sendText(client,peer,'Usage : /Gsmarena téléphone');return true}
    try{
      const t=await fetchText('https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName='+encodeURIComponent(argText),{headers:{'user-agent':'Mozilla/5.0'}},10000);
      const names=[...t.matchAll(/<span>([^<]{2,80})<\/span>/g)].map(m=>html(m[1])).filter(Boolean).slice(0,10);
      await sendText(client,peer,names.length?'Résultats GSMArena\n\n'+names.map(x=>'• '+x).join('\n'):'Aucun appareil trouvé.');
    }catch(e){await sendText(client,peer,'GSMArena indisponible : '+e.message)}
    return true;
  }

  if(['aveu','epreuve','bouffon','charme','louange','malediction','piege','fakehack','jugement_d','destin','fresque','quete_fresque'].includes(name)){
    let text='';
    if(name==='aveu')text=pick(TRUTHS);
    else if(name==='epreuve')text=pick(DARES);
    else if(name==='bouffon')text=pick(JOKES);
    else if(name==='charme')text=pick(PICKUPS);
    else if(name==='louange')text=pick(COMPLIMENTS);
    else if(name==='destin')text='Compatibilité : '+(crypto.randomInt(41,101))+'% · '+(argText||'destin mystère');
    else if(name==='jugement_d')text='Jugement NexAi : '+crypto.randomInt(1,11)+'/10 · '+(argText||'aucune cible');
    else if(name==='malediction')text='Malédiction légère : pendant 10 minutes, chaque typo compte double.';
    else if(name==='piege')text='Piège : qu’est-ce qui devient plus mouillé à mesure qu’il sèche ? Réponse : une serviette.';
    else if(name==='fakehack')text='[SIMULATION]\nConnexion… OK\nAnalyse… OK\nAccès fictif… 100%\nAucune action réelle n’a été effectuée.';
    else text='Mode '+name+' : utilise les commandes de jeux NexAi.';
    await sendText(client,peer,text);
    return true;
  }

  if(['promote','demote','kick','ban','unban','mute','unmute','selfadmin'].includes(name)){
    try{await sendText(client,peer,await doModeration(client,peer,event.message,name,args))}catch(e){await sendText(client,peer,'Action impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='tag'){
    try{
      const reply=await repliedMessage(client,peer,event.message);
      let user,text;
      if(reply?.senderId){
        user=await client.getEntity(reply.senderId);
        text=argText||'Je te mentionne ici.';
      }else{
        const target=clean(args[0]);
        if(!target){await sendText(client,peer,'Usage : réponds à un membre avec /Tag [message], ou .tag @username [message].');return true}
        const ref=/^\d+$/.test(target)?BigInt(target):target;
        user=await client.getEntity(ref);
        text=args.slice(1).join(' ').trim()||'Je te mentionne ici.';
      }
      await sendSingleMention(client,peer,user,text);
    }catch(e){
      console.error('[NexAccount tag]',String(e?.errorMessage||e?.message||e));
      await sendText(client,peer,'Tag impossible : '+String(e.errorMessage||e.message||e));
    }
    return true;
  }
  if(name==='tagall'||name==='hidetag'||name==='mediatag'||name==='tagadmin'){
    const ps=await participants(client,peer,name==='hidetag'?null:1000);
    const list=name==='tagadmin'?ps.filter(isAdminParticipant):ps;
    if(name==='hidetag'){
      const source=await repliedMessage(client,peer,event.message);
      if(source)await sendHiddenTaggedCopy(client,peer,list,source);
      else await sendHiddenMentions(client,peer,list,argText||'Tout le monde est invité à lire ce message.');
      await deleteCommandMessage(client,peer,event.message);
      return true;
    }
    if(name==='mediatag'){
      const source=await repliedMessage(client,peer,event.message);
      if(source?.media){
        try{
          const buffer=await client.downloadMedia(source);
          if(buffer?.length){
            const visible=argText||'Tout le monde est invité à voir ce média.';
            const built=await buildMentionEntities(client,visible,list.slice(0,60),{hidden:true});
            await sendTelegramMedia(client,peer,Buffer.from(buffer),{
              fileName:recoveredMediaName(source),
              caption:built.message,
              mimeType:String(source?.media?.document?.mimeType||''),
              kind:'auto',
              formattingEntities:built.entities,
              afterSend:mediaCta
            });
            return true;
          }
        }catch{}
      }
      await sendHiddenMentions(client,peer,list,argText||'NexAi · Media tag');
      return true;
    }
    await sendMentionList(client,peer,list,argText||'Mention générale : tout le monde est invité à lire ce message.');
    return true;
  }
  if(name==='delete'){
    const id=replyId(event.message);
    if(!id){await sendText(client,peer,'Réponds au message à supprimer.');return true}
    try{await client.deleteMessages(peer,[id],{revoke:true})}catch(e){await sendText(client,peer,'Suppression impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='clean'){
    const n=Math.max(1,Math.min(100,Number(args[0])||20));
    try{
      const msgs=await client.getMessages(peer,{limit:n});
      const ids=msgs.filter(m=>m?.id).map(m=>m.id);
      if(ids.length)await client.deleteMessages(peer,ids,{revoke:true});
      await sendText(client,peer,ids.length+' message(s) traités.');
    }catch(e){await sendText(client,peer,'Nettoyage impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='grouplink'){
    try{
      const input=await client.getInputEntity(peer);
      const r=await client.invoke(new Api.messages.ExportChatInvite({peer:input,legacyRevokePermanent:false,expireDate:0,usageLimit:0}));
      await sendText(client,peer,r?.link||'Lien créé.');
    }catch(e){await sendText(client,peer,'Lien indisponible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='groupname'){
    const c=await currentChat(client,peer);
    await sendText(client,peer,c?.title||c?.username||'Chat');
    return true;
  }
  if(name==='add'){
    if(!args[0]){await sendText(client,peer,'Usage : /Add @username');return true}
    try{
      const channel=getInputChannel(await client.getInputEntity(peer)),user=getInputUser(await client.getInputEntity(args[0]));
      await client.invoke(new Api.channels.InviteToChannel({channel,users:[user]}));
      await sendText(client,peer,'Invitation envoyée.');
    }catch(e){await sendText(client,peer,'Ajout impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='approve'||name==='approveall'){
    try{
      const input=await client.getInputEntity(peer);
      if(name==='approveall')await client.invoke(new Api.messages.HideAllChatJoinRequests({peer:input,approved:true}));
      else{
        const user=getInputUser(await targetEntity(client,peer,event.message,args));
        await client.invoke(new Api.messages.HideChatJoinRequest({peer:input,userId:user,approved:true}));
      }
      await sendText(client,peer,'Demande(s) approuvée(s).');
    }catch(e){await sendText(client,peer,'Approbation impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='mutechat'||name==='unmutechat'||name==='darkmood'||name==='gc'){
    try{
      const input=await client.getInputEntity(peer);
      const muted=name==='mutechat'||(name==='darkmood'&&String(args[0]||'').toLowerCase()!=='off');
      await client.invoke(new Api.messages.EditChatDefaultBannedRights({
        peer:input,
        bannedRights:new Api.ChatBannedRights({untilDate:0,sendMessages:muted})
      }));
      await sendText(client,peer,muted?'Groupe fermé en écriture.':'Groupe ouvert en écriture.');
    }catch(e){await sendText(client,peer,'Réglage impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='warn'||name==='resetwarn'){
    try{
      const target=await targetEntity(client,peer,event.message,args);
      const tid=String(target?.userId||target?.channelId||target?.chatId||args[0]||'');
      const settings=await settingsFor(account.telegramUserId);
      const warnings={...(settings.warnings||{})};
      const chat=String(event.chatId||peer?.channelId||peer?.chatId||'global');
      warnings[chat]={...(warnings[chat]||{})};
      if(name==='resetwarn')warnings[chat][tid]=0;else warnings[chat][tid]=Number(warnings[chat][tid]||0)+1;
      await patchSettings(account.telegramUserId,{warnings});
      await sendText(client,peer,name==='resetwarn'?'Avertissements réinitialisés.':'Avertissement enregistré · total : '+warnings[chat][tid]+'.');
    }catch(e){await sendText(client,peer,'Warn impossible : '+e.message)}
    return true;
  }

  if(['antilink','antispam','antiraid','antibadword','antitag','antigroupmention','welcome','goodbye','setwelcome','setgoodbye','autosticker','aimoderator','modlog'].includes(name)){
    const chat=String(event.chatId||peer?.channelId||peer?.chatId||'global');
    const key=name==='setwelcome'?'welcomeText':name==='setgoodbye'?'goodbyeText':name;
    const current=(await settingsFor(account.telegramUserId)).groupPolicies?.[chat]?.[key];
    const value=(name==='setwelcome'||name==='setgoodbye')?argText:parseToggle(args[0],current===true);
    const p=await patchGroupPolicy(account.telegramUserId,chat,{[key]:value});
    await sendText(client,peer,toSmallCaps(key)+' : '+(typeof p[key]==='boolean'?(p[key]?'ON':'OFF'):String(p[key]||'configuré')));
    return true;
  }

  if(name==='mode'||name==='accessmode'||name==='botmode'){
    const s=await settingsFor(account.telegramUserId);
    const current=s.accessMode==='public'?'public':'private';
    const value=clean(args[0]).toLowerCase();
    if(!value){
      await sendText(client,peer,'Mode d’accès : '+current.toUpperCase()+'\nUsage : /Mode private | .mode public');
      return true;
    }
    if(!['private','privé','prive','public'].includes(value)){
      await sendText(client,peer,'Usage : /Mode private | .mode public');
      return true;
    }
    const accessMode=value==='public'?'public':'private';
    await patchSettings(account.telegramUserId,{accessMode});
    await sendText(client,peer,accessMode==='public'
      ? 'Mode PUBLIC activé : les autres utilisateurs peuvent lancer les commandes non sensibles. Les commandes compte/propriétaire restent privées et les commandes admin exigent que l’auteur soit admin du groupe.'
      : 'Mode PRIVÉ activé : seul le compte connecté peut lancer les commandes.');
    return true;
  }

  if(name==='prefix'||name==='signe_commande'){
    const v=clean(args[0]);
    if(!v){const s=await settingsFor(account.telegramUserId);await sendText(client,peer,'Préfixe : '+(s.prefix||'.'));return true}
    if(v.length>3||/\s/.test(v)){await sendText(client,peer,'Préfixe invalide.');return true}
    await patchSettings(account.telegramUserId,{prefix:v});await sendText(client,peer,'Préfixe changé : '+v);return true;
  }
  if(name==='language'){
    const v=clean(args[0]).toLowerCase();
    if(!['fr','en'].includes(v)){await sendText(client,peer,'Usage : /Language fr|en');return true}
    await patchSettings(account.telegramUserId,{language:v});await sendText(client,peer,'Langue : '+v.toUpperCase());return true;
  }
  if(name==='reflexe_systeme'){
    const s=await settingsFor(account.telegramUserId),cur=s.autoReact?.enabled===true;
    const enabled=parseToggle(args[0],cur);
    await patchSettings(account.telegramUserId,{autoReact:{...(s.autoReact||{}),enabled}});
    await sendText(client,peer,'Auto-react : '+(enabled?'ON':'OFF'));return true;
  }
  if(name==='sessions'){
    const live=await listConnectedAccounts();
    const settings=await settingsFor(account.telegramUserId);
    await sendText(client,peer,sessionsText(live,{
      viewerTelegramUserId:account.telegramUserId,
      owner:isOwnerId(account.telegramUserId),
      language:settings.language||account.preferredLanguage||'fr'
    }));
    return true;
  }
  if(name==='pair'){
    await sendText(client,peer,'Pour ajouter ou reconnecter un compte : ouvre @NexAi01_bot et utilise /pair. Le numéro, le code Telegram et la 2FA se saisissent uniquement sur la page sécurisée, jamais dans un chat Telegram.');return true;
  }
  if(name==='botstatus'){
    const s=await settingsFor(account.telegramUserId);
    await sendText(client,peer,'NexAi · actif\nCompte : '+(account.username?'@'+account.username:account.telegramUserId)+'\nPréfixe : '+(s.prefix||'.')+'\nMode : '+(s.accessMode==='public'?'PUBLIC':'PRIVÉ')+'\nAuto-react : '+(s.autoReact?.enabled?'ON':'OFF'));return true;
  }
  if(name==='customreact'){
    const values=args.filter(Boolean).slice(0,12);
    const s=await settingsFor(account.telegramUserId);
    if(!values.length){await sendText(client,peer,'Réactions auto : '+((s.autoReact?.reactions||['🔥','❤️','👍']).join(' ')));return true}
    await patchSettings(account.telegramUserId,{autoReact:{...(s.autoReact||{}),reactions:values,enabled:true}});
    await sendText(client,peer,'Réactions auto : '+values.join(' '));return true;
  }
  if(name==='emoji_status'||name==='premiumemoji'){
    if(!account.premium){await sendText(client,peer,'Cette commande nécessite Telegram Premium sur le compte connecté.');return true}
    const raw=String(args[0]||'').trim();
    try{
      if(!raw||raw==='off'||raw==='clear'){
        await client.invoke(new Api.account.UpdateEmojiStatus({emojiStatus:new Api.EmojiStatusEmpty()}));
        await sendText(client,peer,'Statut emoji supprimé.');
      }else{
        const id=BigInt(raw);
        await client.invoke(new Api.account.UpdateEmojiStatus({emojiStatus:new Api.EmojiStatus({documentId:id})}));
        await sendText(client,peer,'Statut emoji appliqué.');
      }
    }catch(e){await sendText(client,peer,'Emoji status impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='effect'){
    const id=String(args[0]||'').trim();
    await patchSettings(account.telegramUserId,{messageEffectId:id||null});
    await sendText(client,peer,id?'Effet de message préféré enregistré : '+id:'Effet de message préféré désactivé.');return true;
  }
  if(name==='block'||name==='unblock'){
    try{
      const id=await targetEntity(client,peer,event.message,args);
      await client.invoke(name==='block'?new Api.contacts.Block({id}):new Api.contacts.Unblock({id}));
      await sendText(client,peer,name==='block'?'Utilisateur bloqué.':'Utilisateur débloqué.');
    }catch(e){await sendText(client,peer,'Action impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='setsudo'||name==='delsudo'||name==='setvip'||name==='delvip'){
    if(!isOwnerId(account.telegramUserId)){return true}
    const raw=clean(args[0]);
    if(!raw){await sendText(client,peer,'Indique un ID Telegram.');return true}
    const key=name.includes('sudo')?'sudoIds':'vipIds';
    const remove=name.startsWith('del');
    const list=await setListSetting(account.telegramUserId,key,raw,remove);
    await sendText(client,peer,(remove?'Retiré de ':'Ajouté à ')+key+' · '+list.length+' entrée(s).');return true;
  }
  if(name==='presence'||name==='autotyping'){
    const s=await settingsFor(account.telegramUserId),cur=s[name]?.enabled===true;
    const enabled=parseToggle(args[0],cur);
    await patchSettings(account.telegramUserId,{[name]:{enabled}});
    if(name==='presence'){
      if(typeof runtime.setPresenceEnabled==='function')await runtime.setPresenceEnabled(enabled);
      else if(enabled)await client.invoke(new Api.account.UpdateStatus({offline:false})).catch(()=>{});
    }
    await sendText(client,peer,name==='presence'
      ?'Présence persistante : '+(enabled?'ON · NexAi maintiendra périodiquement la session en ligne.':'OFF')
      :toSmallCaps(name)+' : '+(enabled?'ON':'OFF'));return true;
  }

  if(name==='getname'||name==='getabout'||name==='getpp'||name==='inspecter'){
    try{
      const target=await targetEntity(client,peer,event.message,args,{optional:true})||await client.getInputEntity(peer);
      const entity=await client.getEntity(target);
      if(name==='getpp'){
        const b=await client.downloadProfilePhoto(entity,{isBig:true});
        if(b)await sendTelegramMedia(client,peer,b,{fileName:'profile.jpg',caption:'NexAi · Profile',mimeType:'image/jpeg',kind:'image',afterSend:mediaCta});else await sendText(client,peer,'Aucune photo publique.');
      }else{
        let about='';
        try{const full=await client.invoke(new Api.users.GetFullUser({id:target}));about=full?.fullUser?.about||''}catch{}
        await sendText(client,peer,[entity.firstName,entity.lastName,entity.username?'@'+entity.username:'',entity.id?'ID '+entity.id:'',about].filter(Boolean).join('\n'));
      }
    }catch(e){await sendText(client,peer,'Information indisponible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='groupstats'||(cmd?.engine==='group'&&name==='stats')){
    const ps=await participants(client,peer,10000);
    const admins=ps.filter(isAdminParticipant).length;
    await sendText(client,peer,'Membres : '+ps.length+'\nAdmins détectés : '+admins);return true;
  }

  if(cmd?.engine==='group'){
    const chat=String(event.chatId||peer?.channelId||peer?.chatId||'global');
    const s=await settingsFor(account.telegramUserId);
    const {policy}=groupPolicy(s,chat);
    if(name==='admins'){
      const ps=await participants(client,peer,500);const admins=ps.filter(isAdminParticipant);
      await sendMentionList(client,peer,admins,'NexAi · Admins');return true;
    }
    if(['approval','joinapproval','autoapprove','captcha','raidmode','logs','nightmode'].includes(name)){
      const enabled=parseToggle(args[0],policy[name]===true);await patchGroupPolicy(account.telegramUserId,chat,{[name]:enabled});
      await sendText(client,peer,toSmallCaps(name)+' : '+(enabled?'ON':'OFF'));return true;
    }
    if(name==='approvepending'){
      try{const input=await client.getInputEntity(peer);await client.invoke(new Api.messages.HideAllChatJoinRequests({peer:input,approved:true}));await sendText(client,peer,'Demandes en attente approuvées.')}catch(e){await sendText(client,peer,'Approbation impossible : '+String(e.errorMessage||e.message||e))}return true;
    }
    if(name==='backup'){
      const c=await currentChat(client,peer);const ps=await participants(client,peer,500);
      const snapshot={createdAt:new Date().toISOString(),chatId:chat,title:c?.title||'',username:c?.username||'',memberCount:ps.length,policy};
      const backups={...(s.groupBackups||{}),[chat]:snapshot};await patchSettings(account.telegramUserId,{groupBackups:backups});
      await sendTelegramMedia(client,peer,Buffer.from(JSON.stringify(snapshot,null,2)),{fileName:'nexai-group-backup.json',caption:'NexAi · Backup',mimeType:'application/json',kind:'document',afterSend:mediaCta});return true;
    }
    if(name==='restore'){
      const snap=s.groupBackups?.[chat];if(!snap){await sendText(client,peer,'Aucune sauvegarde NexAi pour ce groupe.');return true}
      await patchGroupPolicy(account.telegramUserId,chat,snap.policy||{});await sendText(client,peer,'Configuration NexAi restaurée.');return true;
    }
    if(name==='copyconfig'){
      const target=clean(args[0]);if(!target){await sendText(client,peer,'Usage : /Copyconfig <chatId source>');return true}
      const src=s.groupPolicies?.[target];if(!src){await sendText(client,peer,'Configuration source introuvable.');return true}
      await patchGroupPolicy(account.telegramUserId,chat,src);await sendText(client,peer,'Configuration copiée.');return true;
    }
    if(name==='blacklist'||name==='whitelist'){
      const target=await targetEntity(client,peer,event.message,args).catch(()=>null);if(!target){await sendText(client,peer,'Réponds à un membre ou indique @username.');return true}
      const id=String(target.userId||target.channelId||target.chatId||args[0]);
      const key=name==='blacklist'?'blacklist':'whitelist';const arr=Array.isArray(policy[key])?[...policy[key]]:[];const remove=String(args[1]||'').toLowerCase()==='off';
      const next=remove?arr.filter(x=>String(x)!==id):[...new Set([...arr,id])];await patchGroupPolicy(account.telegramUserId,chat,{[key]:next});
      await sendText(client,peer,toSmallCaps(key)+' : '+next.length+' entrée(s).');return true;
    }
    if(name==='broadcast'){
      if(!argText){await sendText(client,peer,'Usage : /Broadcast message');return true}await sendText(client,peer,argText);return true;
    }
    if(name==='cancel'){await sendText(client,peer,'Aucun flux NexAi actif à annuler dans ce chat.');return true}
    if(name==='clearwarns'){
      const warnings={...(s.warnings||{})};warnings[chat]={};await patchSettings(account.telegramUserId,{warnings});await sendText(client,peer,'Avertissements du groupe réinitialisés.');return true;
    }
    if(['config','status','permissions'].includes(name)){
      const c=await currentChat(client,peer);let extra='';
      if(name==='permissions')extra='\nLes actions utilisent les permissions réelles du compte Telegram connecté.';
      await sendText(client,peer,'NexAi · '+name+'\nChat : '+(c?.title||c?.username||chat)+'\nID : '+chat+'\nAnti-link : '+(policy.antilink?'ON':'OFF')+'\nAnti-spam : '+(policy.antispam?'ON':'OFF')+'\nAnti-tag : '+(policy.antitag?'ON':'OFF')+'\nAnti-mention massive : '+(policy.antigroupmention?'ON':'OFF')+'\nFiltre de mots : '+(policy.antibadword?'ON':'OFF')+'\nWelcome : '+(policy.welcome?'ON':'OFF')+extra);return true;
    }
    if(name==='id'){await sendText(client,peer,'Chat ID : '+chat+'\nCompte : '+account.telegramUserId);return true}
    if(name==='kickall'){
      if(String(args[0]||'').toLowerCase()!=='confirm'){await sendText(client,peer,'Action destructive. Utilise .kickall confirm pour retirer les membres non-admins.');return true}
      const ps=await participants(client,peer,500);let done=0;for(const p of ps){if(p.bot||p.participant?.adminRights||p.adminRights||String(p.id)===String(account.telegramUserId))continue;try{await doModeration(client,peer,event.message,'kick',[''+p.id]);done++}catch{}}
      await sendText(client,peer,done+' membre(s) retiré(s).');return true;
    }
    if(name==='purge'){return handleCompatCommand({runtime,event,name:'clean',args,cmd:{},sendText,sendInline})}
    if(name==='slowmode'){
      const seconds=Math.max(0,Math.min(21600,Number(args[0])||0));try{const input=getInputChannel(await client.getInputEntity(peer));await client.invoke(new Api.channels.ToggleSlowMode({channel:input,seconds}));await sendText(client,peer,'Slow mode : '+seconds+' s')}catch(e){await sendText(client,peer,'Slow mode impossible : '+String(e.errorMessage||e.message||e))}return true;
    }
    if(name==='rules'||name==='setrules'||name==='notes'){
      if(name==='setrules'||(name==='notes'&&argText)){const key=name==='notes'?'notes':'rules';await patchGroupPolicy(account.telegramUserId,chat,{[key]:argText});await sendText(client,peer,toSmallCaps(key)+' enregistré.');return true}
      await sendText(client,peer,name==='notes'?(policy.notes||'Aucune note.'):(policy.rules||'Aucune règle enregistrée.'));return true;
    }
    if(name==='setcommand'){
      const first=clean(args[0]).toLowerCase();const body=args.slice(1).join(' ').trim();if(!first||!body){await sendText(client,peer,'Usage : /Setcommand nom réponse');return true}
      const custom={...(policy.customCommands||{}),[first]:body};await patchGroupPolicy(account.telegramUserId,chat,{customCommands:custom});await sendText(client,peer,'Commande .'+first+' enregistrée.');return true;
    }
    if(name==='warnings'){
      const w=s.warnings?.[chat]||{};const rows=Object.entries(w).filter(([,n])=>Number(n)>0).map(([id,n])=>id+' : '+n);
      await sendText(client,peer,'Warnings\n'+(rows.join('\n')||'Aucun avertissement.'));return true;
    }
    if(name==='risk'){
      let score=0;
      if(!policy.antilink)score+=20;
      if(!policy.antispam)score+=20;
      if(!policy.antitag)score+=20;
      if(!policy.antigroupmention)score+=20;
      if(!policy.antibadword)score+=20;
      await sendText(client,peer,'Indice de risque configuration : '+score+'/100\nCe score reflète uniquement les protections réellement appliquées aux messages par cette version de NexAi.');return true;
    }
    if(name==='privacy'){await sendText(client,peer,'NexAi utilise uniquement les données Telegram nécessaires aux fonctions activées. Les sessions NexAccount sont chiffrées au repos.');return true}
    if(name==='report'||name==='appeal'){
      const reply=await repliedMessage(client,peer,event.message);const subject=reply?('message #'+reply.id):(argText||'signalement');
      await sendText(client,peer,(name==='report'?'Signalement':'Appel')+' enregistré pour '+subject+'.');return true;
    }
    if(name==='template'||name==='topicpolicy'||name==='schedule'){
      await patchGroupPolicy(account.telegramUserId,chat,{[name]:argText||true});await sendText(client,peer,toSmallCaps(name)+' enregistré.');return true;
    }
    if(name==='leaderboard'||name==='rep'){
      await sendText(client,peer,'Classement NexAi : les jeux et la réputation sont gérés directement par NexAi.');return true;
    }
    if(name==='transferowner'){
      await sendText(client,peer,'Le transfert de propriété Telegram exige une confirmation 2FA sensible et n’est jamais exécuté automatiquement depuis une commande texte.');return true;
    }
  }

  if(name==='tourl'||name==='pixupload'){
    const source=await repliedMessage(client,peer,event.message);
    if(!source?.media){await sendText(client,peer,'Réponds à un média.');return true}
    const progress=await progressFor('Upload média');
    try{
      if(progress)await progress.step('Upload média · téléchargement Telegram…');
      const buffer=await client.downloadMedia(source);
      if(!buffer)throw new Error('média vide');
      if(progress)await progress.step('Upload média · envoi vers l’hébergeur…');
      const url=await uploadCatbox(Buffer.from(buffer),'nexai-'+Date.now()+'.bin');
      await sendText(client,peer,url);
      if(progress)await progress.done('Upload média terminé');
    }catch(e){
      if(progress)await progress.fail('Upload impossible · '+String(e?.message||e).slice(0,180));
      else await sendText(client,peer,'Upload impossible : '+e.message);
    }
    return true;
  }
  if(name==='vcf'){
    const values=args.filter(Boolean);
    if(!values.length){await sendText(client,peer,'Usage : /Vcf +229... +33...');return true}
    const cards=values.map((v,i)=>'BEGIN:VCARD\nVERSION:3.0\nFN:Contact '+(i+1)+'\nTEL;TYPE=CELL:'+v+'\nEND:VCARD').join('\n');
    await sendTelegramMedia(client,peer,Buffer.from(cards),{fileName:'contacts.vcf',caption:'NexAi · VCF',mimeType:'text/vcard',kind:'document',afterSend:mediaCta});return true;
  }
  if(name==='filtervcf'){
    await sendText(client,peer,'Réponds à un fichier .vcf avec les critères à conserver. Cette commande est reconnue ; le moteur Telegram ne modifie jamais silencieusement un carnet de contacts.');return true;
  }
  if(name==='texttopdf'){
    if(!argText){await sendText(client,peer,'Usage : /Texttopdf ton texte');return true}
    try{await sendTelegramMedia(client,peer,simplePdf(argText),{fileName:'nexai-text.pdf',caption:'NexAi · PDF',mimeType:'application/pdf',kind:'document',afterSend:mediaCta})}catch(e){await sendText(client,peer,'PDF impossible : '+e.message)}
    return true;
  }
  if(name==='toimage'){
    if(!argText){await sendText(client,peer,'Usage : /Toimage ton texte');return true}
    const lines=argText.match(/.{1,44}(?:\s|$)/g)||[argText];
    const tspans=lines.slice(0,12).map((l,i)=>'<tspan x="60" dy="'+(i?54:0)+'">'+xmlEscape(l.trim())+'</tspan>').join('');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><rect width="1080" height="1080" rx="64" fill="#17130d"/><text x="60" y="130" fill="#ffe39a" font-family="sans-serif" font-size="42" font-weight="700">'+tspans+'</text><text x="60" y="1010" fill="#aa9162" font-family="sans-serif" font-size="24">NexAi · Nextech</text></svg>';
    await sendTelegramMedia(client,peer,Buffer.from(svg),{fileName:'nexai-text.svg',caption:'NexAi · Image SVG',mimeType:'image/svg+xml',kind:'document',afterSend:mediaCta});return true;
  }
  if(name==='crop'||name==='resize'){
    const source=await repliedMessage(client,peer,event.message);
    if(!source?.media){await sendText(client,peer,'Réponds à une image avec /'+name+(name==='resize'?' 800x800':''));return true}
    const progress=await progressFor(name==='crop'?'Recadrage image':'Redimensionnement image');
    try{
      if(progress)await progress.step('Image · téléchargement Telegram…');
      const buffer=await client.downloadMedia(source);if(!buffer)throw new Error('média vide');
      if(progress)await progress.step('Image · préparation…');
      const src=await uploadCatbox(Buffer.from(buffer),'image.jpg');
      let width=800,height=800;
      if(name==='resize'){
        const m=String(args[0]||'').match(/^(\d{2,4})x(\d{2,4})$/i);if(m){width=Math.min(2000,Number(m[1]));height=Math.min(2000,Number(m[2]))}
      }
      const mode=name==='crop'?'fit=cover&a=attention&':'fit=contain&';
      const u='https://images.weserv.nl/?url='+encodeURIComponent(src)+'&w='+width+'&h='+height+'&'+mode+'output=jpg';
      if(progress)await progress.step('Image · récupération du résultat…');
      await sendRemoteFile(client,peer,u,{caption:'NexAi · '+name,name:name+'.jpg',afterSend:mediaCta});
      if(progress)await progress.done('Traitement image terminé');
    }catch(e){
      if(progress)await progress.fail('Traitement image impossible · '+String(e?.message||e).slice(0,180));
      else await sendText(client,peer,'Traitement image impossible : '+e.message);
    }
    return true;
  }
  if(name==='analyzesound'){
    const reply=await repliedMessage(client,peer,event.message);
    if(!reply?.media){await sendText(client,peer,'Réponds à un audio ou une vidéo.');return true}
    const d=reply.document||reply.media?.document;const attrs=d?.attributes||[];
    const audio=attrs.find(a=>a?.duration!=null);const size=Number(d?.size||0);
    await sendText(client,peer,'Média : '+(d?.mimeType||'inconnu')+'\nDurée : '+(audio?.duration??'?')+' s\nTaille : '+(size?Math.round(size/1024)+' Ko':'?'));return true;
  }
  if(name==='pausequeue'){await sendText(client,peer,'La file média NexAi n’a pas de lecture locale active dans ce chat.');return true}
  if(name==='emojimix'){
    const a=args[0]||'',b=args[1]||'';if(!a||!b){await sendText(client,peer,'Usage : /Emojimix 😀 😎');return true}
    await sendText(client,peer,a+'  ×  '+b+'  →  '+a+b);return true;
  }
  if(name==='menuemoji'){
    const settings=await settingsFor(account.telegramUserId);
    const action=clean(args[0]).toLowerCase();
    const current={...(settings.customEmojiIds||{})};

    if(action==='sync'){
      const source=String(cfg.creatorUsername||'tresor20001').replace(/^@/,'').toLowerCase();
      const username=String(account.username||'').replace(/^@/,'').toLowerCase();
      if(username!==source){
        await sendText(client,peer,'La bibliothèque globale se synchronise depuis @'+source+'. Lance cette commande depuis ce compte source.');
        return true;
      }
      try{
        const result=await syncOwnedCustomEmojiLibrary(client,account,{sourceUsername:source});
        await sendText(client,peer,'Bibliothèque emojis synchronisée depuis @'+source+' · '+result.count+' emojis · '+result.animated+' animés · '+result.sets+' packs.');
      }catch(error){
        await sendText(client,peer,'Synchronisation de la bibliothèque impossible : '+String(error?.message||error).slice(0,220));
      }
      return true;
    }

    if(action==='library'){
      const source=String(cfg.creatorUsername||'tresor20001').replace(/^@/,'').toLowerCase();
      const stats=await customEmojiLibraryStats(source);
      await sendText(client,peer,'Bibliothèque emojis @'+source+' · '+stats.count+' emojis enregistrés · '+stats.animated+' animés.');
      return true;
    }

    if(!action||action==='list'){
      const configured=Object.keys(current).sort();
      await sendText(client,peer,[
        'NexAi · emojis du menu · session '+(account.username?'@'+account.username:account.firstName||account.telegramUserId),
        configured.length?('Configurés : '+configured.map(k=>k.replace(/^NEXAI_EMOJI_/,'')).join(', ')):'Configurés : aucun',
        '',
        'Réponds à un message contenant un emoji personnalisé avec :',
        '/Menuemoji current',
        '/Menuemoji anime',
        '/Menuemoji download',
        '/Menuemoji style_7',
        '/Menuemoji library',
        '/Menuemoji sync · depuis @'+String(cfg.creatorUsername||'tresor20001').replace(/^@/,''),
        '',
        'Pour retirer : /Menuemoji reset <clé> · ou /Menuemoji reset all'
      ].join('\n'));
      return true;
    }

    if(action==='reset'){
      const rawKey=clean(args[1]);
      if(!rawKey||rawKey.toLowerCase()==='all'){
        await patchSettings(account.telegramUserId,{customEmojiIds:{}});
        await sendText(client,peer,'Emojis personnalisés du menu réinitialisés pour cette session.');
        return true;
      }
      const key=menuEmojiSettingKey(rawKey,settings);
      if(!key){await sendText(client,peer,'Clé emoji inconnue. Utilise /Menuemoji list.');return true}
      delete current[key];
      await patchSettings(account.telegramUserId,{customEmojiIds:current});
      await sendText(client,peer,'Emoji retiré : '+key.replace(/^NEXAI_EMOJI_/,''));
      return true;
    }

    const key=menuEmojiSettingKey(args[0],settings);
    if(!key){await sendText(client,peer,'Clé emoji inconnue. Utilise /Menuemoji list.');return true}
    const reply=await repliedMessage(client,peer,event.message);
    const directId=clean(args[1]);
    const id=customEmojiDocumentId(reply)||(/^\d{5,}$/.test(directId)?directId:'');
    if(!id){
      await sendText(client,peer,'Réponds à un message contenant le custom emoji Telegram à utiliser, puis relance /Menuemoji '+clean(args[0])+'.');
      return true;
    }
    current[key]=id;
    await patchSettings(account.telegramUserId,{customEmojiIds:current});
    await sendText(client,peer,'Emoji du menu enregistré pour cette session : '+key.replace(/^NEXAI_EMOJI_/,'')+' · ID '+id);
    return true;
  }

  if(name==='device'){
    await sendText(client,peer,'NexAccount · '+(account.username?'@'+account.username:account.firstName||account.telegramUserId)+'\nTelegram ID : '+account.telegramUserId+'\nSession : active\nTelegram Premium : '+(account.premium?'oui':'non'));return true;
  }



  if(name==='dark'){
    const settings=await settingsFor(account.telegramUserId);
    const current=settings.nlpMode?.enabled===true;
    const enabled=parseToggle(args[0],current);
    await patchSettings(account.telegramUserId,{nlpMode:{...(settings.nlpMode||{}),enabled}});
    await sendText(client,peer,'NexAi · mode IA naturel : '+(enabled?'ON':'OFF'));
    return true;
  }

  if(name==='mutedark'){
    const settings=await settingsFor(account.telegramUserId);
    const chat=String(event.chatId||peer?.channelId||peer?.chatId||peer?.userId||'global');
    const {policy}=groupPolicy(settings,chat);
    const action=clean(args[0]).toLowerCase();
    if(!action){
      const until=Number(policy.nexaiMuteUntil||0);
      const active=policy.nexaiMuted===true&&(until===0||until>Date.now());
      await sendText(client,peer,'NexAi auto-features : '+(active?'MUTED':'ACTIVE')+(until>Date.now()?' · '+Math.ceil((until-Date.now())/60000)+' min restantes':''));
      return true;
    }
    const enabled=!['off','0','false','unmute','wake','reveil','réveil'].includes(action);
    const minutes=enabled?Math.max(0,Math.min(10080,Number(args[1])||0)):0;
    const until=enabled&&minutes?Date.now()+minutes*60000:0;
    await patchGroupPolicy(account.telegramUserId,chat,{nexaiMuted:enabled,nexaiMuteUntil:until});
    await sendText(client,peer,'NexAi auto-features : '+(enabled?'MUTED'+(minutes?' · '+minutes+' min':''):'ACTIVE'));
    return true;
  }

  if(name==='reponseauto'){
    const settings=await settingsFor(account.telegramUserId);
    const sub=clean(args[0]).toLowerCase();
    if(sub==='status'){
      const a=settings.autoReply||{};
      await sendText(client,peer,'Auto-réponse : '+(a.enabled?'ON':'OFF')+(a.url?'\nMédia : configuré':'')+'\nDélai : '+Number(a.delayMs||0)/1000+' s');
      return true;
    }
    if(sub==='off'||sub==='reset'){
      await patchSettings(account.telegramUserId,{autoReply:{enabled:false}});
      await sendText(client,peer,'Auto-réponse désactivée.');
      return true;
    }
    const reply=await repliedMessage(client,peer,event.message);
    if(!reply?.media){
      await sendText(client,peer,'Réponds à une image, un audio ou une vidéo avec /Reponseauto [délai_secondes].');
      return true;
    }
    try{
      const buffer=await client.downloadMedia(reply);
      if(!buffer?.length)throw new Error('média vide');
      if(buffer.length>20*1024*1024)throw new Error('média > 20 Mo');
      const mime=String(reply?.document?.mimeType||reply?.media?.document?.mimeType||'application/octet-stream');
      const ext=mime.includes('video')?'mp4':mime.includes('audio')?'mp3':mime.includes('image')?'jpg':'bin';
      const url=await uploadCatbox(Buffer.from(buffer),'nexai-autoreply-'+Date.now()+'.'+ext);
      const delayMs=Math.max(0,Math.min(30,Number(args[0])||0))*1000;
      await patchSettings(account.telegramUserId,{autoReply:{enabled:true,url,mime,delayMs,setAt:Date.now()}});
      await sendText(client,peer,'Auto-réponse média activée pour les mentions du compte.');
    }catch(e){await sendText(client,peer,'Configuration auto-réponse impossible : '+String(e.message||e))}
    return true;
  }

  if(name==='infos_canal'){
    const raw=clean(args[0]);
    try{
      let target=peer;
      if(raw){
        const username=raw.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'').replace(/^@/,'').split(/[/?#]/)[0];
        if(!username||/^\+/.test(username)){
          await sendText(client,peer,'Pour un canal privé, rejoins-le d’abord avec /Join puis relance .infos_canal.');
          return true;
        }
        target=await client.getInputEntity('@'+username);
      }
      const entity=await client.getEntity(target);
      await sendText(client,peer,[
        'NexAi · infos canal',
        entity?.title||entity?.firstName||'Telegram',
        entity?.username?'@'+entity.username:'',
        entity?.id?'ID : '+entity.id:'',
        entity?.participantsCount!=null?'Membres/abonnés : '+entity.participantsCount:''
      ].filter(Boolean).join('\n'));
    }catch(e){await sendText(client,peer,'Canal introuvable : '+String(e.errorMessage||e.message||e))}
    return true;
  }

  if(name==='erreur'){
    const id=replyId(event.message);
    if(!id){await sendText(client,peer,'Réponds au message à supprimer.');return true}
    try{await client.deleteMessages(peer,[id],{revoke:true})}
    catch(e){await sendText(client,peer,'Suppression impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }

  if(name==='cta_url'){
    await sendText(client,peer,'Nextech : '+cfg.nextechUrl);
    return true;
  }

  if(name==='apparence_systeme'){
    const value=argText.slice(0,64);
    if(!value){
      const settings=await settingsFor(account.telegramUserId);
      await sendText(client,peer,'Nom NexAi du menu : '+(settings.botDisplayName||'NEXAI'));
      return true;
    }
    await patchSettings(account.telegramUserId,{botDisplayName:value});
    await sendText(client,peer,'Nom du menu mis à jour : '+value);
    return true;
  }

  if(name==='illustration_grimoire'){
    const reply=await repliedMessage(client,peer,event.message);
    if(!reply?.media){await sendText(client,peer,'Réponds à une image avec /Menuimage.');return true}
    try{
      const buffer=await client.downloadMedia(reply);
      if(!buffer?.length)throw new Error('image vide');
      if(buffer.length>10*1024*1024)throw new Error('image > 10 Mo');
      const uploaded=await uploadCatbox(Buffer.from(buffer),'nexai-menu-'+Date.now()+'.jpg');
      // InlineQueryResultPhoto requires JPEG. Normalize the user's artwork to a
      // bounded JPEG URL, then bind it to the currently active style so a later
      // style switch cannot keep showing the old illustration.
      const url='https://images.weserv.nl/?url='+encodeURIComponent(uploaded)+'&w=1280&output=jpg&q=90';
      const settings=await settingsFor(account.telegramUserId);
      const style=Math.max(1,Number(settings.style)||1);
      await patchSettings(account.telegramUserId,{menuImageUrl:url,menuImageStyle:style});
      await sendText(client,peer,'Illustration du menu NexAi mise à jour pour le style '+style+'.');
    }catch(e){await sendText(client,peer,'Image du menu impossible : '+String(e.message||e))}
    return true;
  }

  if(name==='sceau_canal'){
    const value=clean(args[0]);
    if(!value){
      const settings=await settingsFor(account.telegramUserId);
      await sendText(client,peer,'Canal lié : '+(settings.relayChannel||cfg.nextechUrl));
      return true;
    }
    await patchSettings(account.telegramUserId,{relayChannel:value});
    await sendText(client,peer,'Canal lié à NexAi : '+value);
    return true;
  }

  if(name==='eveil'){
    const seconds=Math.max(0,Math.floor((Date.now()-new Date(runtime.startedAt||Date.now()).getTime())/1000));
    const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),sec=seconds%60;
    await sendText(client,peer,'NexAi actif depuis '+h+'h '+m+'m '+sec+'s.');
    return true;
  }

  if(name==='adoration'){
    const query=argText||'christian worship';
    try{await handleDownloadCommand({client,peer,name:'song',args:[query],event})}
    catch(e){await sendText(client,peer,'Recherche musicale indisponible : '+String(e.message||e))}
    return true;
  }

  if(name==='arcanes'){
    return handleCompatCommand({runtime,event,name:'inspecter',args,cmd:{},sendText,sendInline});
  }

  if(name==='boutique'){
    await sendText(client,peer,[
      'Nextech · projets',
      cfg.nextechUrl,
      'NexNews : '+cfg.nexnewsUrl,
      'GitHub : https://github.com/Nexus-tech-01'
    ].join('\n'));
    return true;
  }

  if(name==='rang'){
    const settings=await settingsFor(account.telegramUserId);
    await sendText(client,peer,'Rang NexAi\nCompte : '+(account.username?'@'+account.username:account.firstName||account.telegramUserId)+'\nTelegram Premium : '+(account.premium?'oui':'non')+'\nStyle : '+(settings.style||1));
    return true;
  }

  if(name==='sanctuaire'){
    const c=await currentChat(client,peer);
    const ps=await participants(client,peer,500);
    const admins=ps.filter(p=>p.participant?.adminRights||p.adminRights||p.participant?.constructor?.name?.includes('Admin')).length;
    await sendText(client,peer,[
      'NexAi · sanctuaire',
      c?.title||c?.username||'Chat Telegram',
      c?.username?'@'+c.username:'',
      'ID : '+String(c?.id||event.chatId||''),
      'Membres chargés : '+ps.length,
      'Admins : '+admins
    ].filter(Boolean).join('\n'));
    return true;
  }

  if(SAFE_UNSUPPORTED.has(name)){
    const note=['execute','runeval','darkfile','save','crash','mise_a_jour','renaissance','reload'].includes(name)
      ? 'Cette commande d’administration serveur passe obligatoirement par NexControl et n’exécute pas de code arbitraire depuis Telegram.'
      : 'Cette commande provenait d’une capacité WhatsApp. NexAi la garde comme alias de compatibilité, sans simuler une fonction Telegram inexistante.';
    await sendText(client,peer,note);
    return true;
  }

  if(cmd?.dipper){
    const downloadName=DL_MAP[name]||name;
    if((cmd.sourceCategory==='download_tools'||cmd.sourceCategory==='social_media_download')&&canHandleDownloadCommand(downloadName)){
      await handleDownloadCommand({client,peer,name:downloadName,args,event});return true;
    }
    if(cmd.sourceCategory==='games_entertainment'&&canHandleGameCommand(name)){
      await handleGameCommand({runtime,event,name,args});return true;
    }
    await sendText(client,peer,'Commande legacy '+name+' reconnue, mais aucune route locale NexAi n’est activée pour elle.');
    return true;
  }

  return false;
}