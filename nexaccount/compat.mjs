import crypto from 'node:crypto';
import { Api } from 'teleproto';
import { cfg, isOwnerId } from './config.mjs';
import { listAccounts, patchSettings, settingsFor } from './store.mjs';
import { toSmallCaps } from './styles.mjs';
import { AUDIO_LAB_COMMANDS, handleAudioLabCommand } from './audio-lab.mjs';

const DL_MAP={
  cobalt:'facebook',facebook:'facebook',
  instagram:'instagram',igs:'instagram','sᴄᴇᴀᴜ_ɪɢ_ᴄᴀʀʀᴇ':'instagram',
  pinterest:'pinterest',song:'song',tiktok:'tiktok',tomp3:'tomp3',video:'video',
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
  'execute','runeval','darkfile','save','crash','mise_a_jour','renaissance','reload',
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
async function participants(client,peer,limit=200){
  try{return await client.getParticipants(peer,{limit})}catch{return []}
}
async function sendMentionList(client,peer,people,title){
  const lines=[title,''];
  const entities=[];
  let text='';
  for(const line of lines)text+=line+'\n';
  for(const p of people.slice(0,200)){
    const name=clean([p.firstName,p.lastName].filter(Boolean).join(' '))||p.username||String(p.id);
    const prefix='• ';
    text+=prefix;
    const offset=Buffer.from(text,'utf16le').length/2;
    text+=name+'\n';
    entities.push(new Api.MessageEntityMentionName({offset,length:Buffer.from(name,'utf16le').length/2,userId:p.id}));
  }
  return client.sendMessage(peer,{message:text.trim(),formattingEntities:entities});
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
async function sendRemoteFile(client,peer,url,{caption='',name}={}){
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Téléchargement impossible ('+r.status+').');
  const buf=Buffer.from(await r.arrayBuffer());
  return client.sendFile(peer,{file:buf,caption,fileName:name});
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
  const target=await targetEntity(client,peer,message,args);
  const channel=await client.getInputEntity(peer);
  if(name==='promote'||name==='selfadmin'){
    await client.invoke(new Api.channels.EditAdmin({
      channel,userId:target,
      adminRights:new Api.ChatAdminRights({
        changeInfo:true,deleteMessages:true,banUsers:true,inviteUsers:true,pinMessages:true,manageCall:true
      }),
      rank:'NexAI'
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

export async function handleCompatCommand({runtime,event,name,args,cmd,sendText,proxyCommand,sendInline}){
  const {client,account}=runtime;
  const peer=event.message.peerId;
  const requestedName=name;
  if(cmd?.sourceBot==='nexgroup'&&cmd?.sourceCommand)name=cmd.sourceCommand;
  name=GROUP_ALIAS[name]||name;
  const argText=args.join(' ').trim();

  if(AUDIO_LAB_COMMANDS.has(name)){
    return handleAudioLabCommand({runtime,event,name,args,sendText});
  }

  if(DL_MAP[name]){
    return proxyCommand(client,peer,{name:DL_MAP[name],proxy:'@TheNexDownloader_bot'},args),true;
  }
  if(STICKER_MAP[name]){
    return proxyCommand(client,peer,{name:STICKER_MAP[name],proxy:'@The_Nexus_techbot'},args),true;
  }
  if(['oracle','ai','code','deepseek'].includes(name)){
    if(!argText){await sendText(client,peer,'Écris ta demande après la commande.');return true}
    const prefix=name==='code'?'Aide-moi avec ce code ou cette tâche de programmation : ':name==='deepseek'?'Raisonne soigneusement sur ceci : ':'';
    await proxyCommand(client,peer,{name,proxy:'@Stacytg_bot',proxyMode:'chat'},[prefix+argText]);
    return true;
  }

  if(name==='allmenu'||name==='grimoire'){await sendInline(client,peer,'menu');return true}
  if(name==='dashboard'||name==='settings'||name==='stats'||name==='premium'){
    const s=await settingsFor(account.telegramUserId);
    if(name==='premium'){
      await sendText(client,peer,'NexAI Premium · 250 Stars/mois\nStatut : '+(account.premium?'Premium Telegram détecté':'Free')+'\nUn seul Premium pour les fonctions fusionnées NexDownloader, NexGroup, NexGame, NexStick et NexWhisper.');
      return true;
    }
    if(name==='dashboard'||name==='settings'){
      await sendText(client,peer,'NexAI · '+toSmallCaps(name)+'\nCompte : '+(account.username?'@'+account.username:account.firstName||account.telegramUserId)+'\nPréfixe : '+(s.prefix||'.')+'\nLangue : '+(s.language||'fr')+'\nStyle : '+(s.style||1)+'\nAuto-join : '+(s.autoJoin?.enabled?'ON':'OFF')+'\nAuto-react : '+(s.autoReact?.enabled?'ON':'OFF'));
      return true;
    }
    const accounts=await listAccounts();
    await sendText(client,peer,'NexAI · stats\nSessions NexAccount : '+accounts.length+'\nCompte courant : '+account.telegramUserId+'\nPremium : '+(account.premium?'oui':'non'));
    return true;
  }
  if(name==='stylelist'){await sendInline(client,peer,'styles');return true}
  if(name==='ping')return false;
  if(name==='help'){await sendText(client,peer,'Utilise .menu pour parcourir toutes les catégories et commandes.');return true}
  if(name==='support'){await sendText(client,peer,'Support : https://t.me/tresor20001');return true}
  if(name==='repo'){await sendText(client,peer,'Nextech : https://github.com/Nexus-tech-01');return true}

  if(name==='fliptext'){await sendText(client,peer,(argText||'NexAI').split('').reverse().join(''));return true}
  if(name==='genpass'){await sendText(client,peer,password(args[0]));return true}
  if(name==='smallcaps'||name==='fancy'){await sendText(client,peer,toSmallCaps(argText||'NexAI'));return true}
  if(name==='calc'){try{await sendText(client,peer,String(safeCalc(argText)))}catch(e){await sendText(client,peer,'Calcul : '+e.message)}return true}

  if(name==='tinyurl'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : .tinyurl https://...');return true}
    try{await sendText(client,peer,await fetchText('https://tinyurl.com/api-create.php?url='+encodeURIComponent(argText)))}catch(e){await sendText(client,peer,'TinyURL indisponible : '+e.message)}
    return true;
  }
  if(name==='translate'||name==='traduction'){
    if(!argText){await sendText(client,peer,'Usage : .translate [langue] texte');return true}
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
    if(!word){await sendText(client,peer,'Usage : .define mot');return true}
    try{
      const j=await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(word));
      const e=Array.isArray(j)?j[0]:null;
      const defs=(e?.meanings||[]).flatMap(m=>(m.definitions||[]).slice(0,2).map(d=>'• '+d.definition)).slice(0,5);
      await sendText(client,peer,(e?.word||word)+'\n\n'+(defs.join('\n')||'Aucune définition trouvée.'));
    }catch{await sendText(client,peer,'Aucune définition trouvée pour « '+word+' ».')}
    return true;
  }
  if(name==='animeinfo'||name==='anime'){
    if(!argText){await sendText(client,peer,'Usage : .animeinfo titre');return true}
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
      await sendRemoteFile(client,peer,j.url,{caption:'NexAI · Waifu',name:'waifu.jpg'});
    }catch(e){await sendText(client,peer,'Image anime indisponible : '+e.message)}
    return true;
  }
  if(name==='qr'){
    if(!argText){await sendText(client,peer,'Usage : .qr texte ou URL');return true}
    const u='https://api.qrserver.com/v1/create-qr-code/?size=512x512&data='+encodeURIComponent(argText);
    try{await sendRemoteFile(client,peer,u,{caption:'NexAI · QR',name:'qr.png'})}catch(e){await sendText(client,peer,'QR indisponible : '+e.message)}
    return true;
  }
  if(name==='tts'){
    if(!argText){await sendText(client,peer,'Usage : .tts texte');return true}
    const text=argText.slice(0,180),lang=(await settingsFor(account.telegramUserId)).language||'fr';
    const u='https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl='+encodeURIComponent(lang)+'&q='+encodeURIComponent(text);
    try{await sendRemoteFile(client,peer,u,{caption:'NexAI · TTS',name:'tts.mp3'})}catch(e){await sendText(client,peer,'TTS indisponible : '+e.message)}
    return true;
  }
  if(name==='ssweb'||name==='sswebpc'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : .'+name+' https://...');return true}
    const width=name==='sswebpc'?'1440':'390';
    const u='https://image.thum.io/get/width/'+width+'/crop/900/noanimate/'+argText;
    try{await sendRemoteFile(client,peer,u,{caption:'NexAI · Screenshot',name:'screenshot.png'})}catch(e){await sendText(client,peer,'Capture indisponible : '+e.message)}
    return true;
  }
  if(name==='browse'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : .browse https://...');return true}
    try{
      const t=await fetchText(argText,{headers:{'user-agent':'Mozilla/5.0'}},10000);
      const title=html(t.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
      const desc=html(t.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]||'');
      await sendText(client,peer,[title||argText,desc].filter(Boolean).join('\n\n').slice(0,3500));
    }catch(e){await sendText(client,peer,'Navigation impossible : '+e.message)}
    return true;
  }
  if(name==='downloadinfo'){
    if(!/^https?:\/\//i.test(argText)){await sendText(client,peer,'Usage : .downloadinfo URL');return true}
    try{
      const r=await fetch(argText,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(10000)});
      await sendText(client,peer,'URL : '+r.url+'\nType : '+(r.headers.get('content-type')||'?')+'\nTaille : '+(r.headers.get('content-length')||'?')+' octets\nHTTP : '+r.status);
    }catch(e){await sendText(client,peer,'Inspection impossible : '+e.message)}
    return true;
  }
  if(name==='imdb'){
    if(!argText){await sendText(client,peer,'Usage : .imdb titre');return true}
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
    if(!argText){await sendText(client,peer,'Usage : .gsmarena téléphone');return true}
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
    else if(name==='jugement_d')text='Jugement NexAI : '+crypto.randomInt(1,11)+'/10 · '+(argText||'aucune cible');
    else if(name==='malediction')text='Malédiction légère : pendant 10 minutes, chaque typo compte double.';
    else if(name==='piege')text='Piège : qu’est-ce qui devient plus mouillé à mesure qu’il sèche ? Réponse : une serviette.';
    else if(name==='fakehack')text='[SIMULATION]\nConnexion… OK\nAnalyse… OK\nAccès fictif… 100%\nAucune action réelle n’a été effectuée.';
    else text='Mode '+name+' : lance .game pour les jeux interactifs NexGame.';
    await sendText(client,peer,text);
    return true;
  }

  if(['promote','demote','kick','ban','unban','mute','unmute','selfadmin'].includes(name)){
    try{await sendText(client,peer,await doModeration(client,peer,event.message,name,args))}catch(e){await sendText(client,peer,'Action impossible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='tagall'||name==='hidetag'||name==='mediatag'||name==='tagadmin'){
    const ps=await participants(client,peer,200);
    const list=name==='tagadmin'?ps.filter(p=>p.participant?.adminRights||p.adminRights):ps;
    await sendMentionList(client,peer,list,argText||'NexAI · Mention');
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
    if(!args[0]){await sendText(client,peer,'Usage : .add @username');return true}
    try{
      const channel=await client.getInputEntity(peer),user=await client.getInputEntity(args[0]);
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
        const user=await targetEntity(client,peer,event.message,args);
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
      await sendText(client,peer,name==='resetwarn'?'Avertissements réinitialisés.':'Avertissement '+warnings[chat][tid]+'/3.');
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

  if(name==='prefix'||name==='signe_commande'){
    const v=clean(args[0]);
    if(!v){const s=await settingsFor(account.telegramUserId);await sendText(client,peer,'Préfixe : '+(s.prefix||'.'));return true}
    if(v.length>3||/\s/.test(v)){await sendText(client,peer,'Préfixe invalide.');return true}
    await patchSettings(account.telegramUserId,{prefix:v});await sendText(client,peer,'Préfixe changé : '+v);return true;
  }
  if(name==='language'){
    const v=clean(args[0]).toLowerCase();
    if(!['fr','en'].includes(v)){await sendText(client,peer,'Usage : .language fr|en');return true}
    await patchSettings(account.telegramUserId,{language:v});await sendText(client,peer,'Langue : '+v.toUpperCase());return true;
  }
  if(name==='reflexe_systeme'){
    const s=await settingsFor(account.telegramUserId),cur=s.autoReact?.enabled===true;
    const enabled=parseToggle(args[0],cur);
    await patchSettings(account.telegramUserId,{autoReact:{...(s.autoReact||{}),enabled}});
    await sendText(client,peer,'Auto-react : '+(enabled?'ON':'OFF'));return true;
  }
  if(name==='sessions'){
    const accounts=await listAccounts();
    const lines=accounts.map((a,i)=>(i+1)+'. '+(a.username?'@'+a.username:a.firstName||a.telegramUserId)+' · '+a.telegramUserId);
    await sendText(client,peer,'NexAccount sessions : '+accounts.length+'\n\n'+(lines.join('\n')||'Aucune autre session.'));return true;
  }
  if(name==='pair'){
    await sendText(client,peer,'Pour ajouter un compte : ouvre @NexAi01_bot et utilise /pair +numéro, ou NexAI Connect sur le site.');return true;
  }
  if(name==='botstatus'){
    const s=await settingsFor(account.telegramUserId);
    await sendText(client,peer,'NexAI · actif\nCompte : '+(account.username?'@'+account.username:account.telegramUserId)+'\nPréfixe : '+(s.prefix||'.')+'\nAuto-react : '+(s.autoReact?.enabled?'ON':'OFF'));return true;
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
    if(enabled&&name==='presence')await client.invoke(new Api.account.UpdateStatus({offline:false})).catch(()=>{});
    await sendText(client,peer,toSmallCaps(name)+' : '+(enabled?'ON':'OFF'));return true;
  }

  if(name==='getname'||name==='getabout'||name==='getpp'||name==='inspecter'){
    try{
      const target=await targetEntity(client,peer,event.message,args,{optional:true})||await client.getInputEntity(peer);
      const entity=await client.getEntity(target);
      if(name==='getpp'){
        const b=await client.downloadProfilePhoto(entity,{isBig:true});
        if(b)await client.sendFile(peer,{file:b,fileName:'profile.jpg',caption:'NexAI · Profile'});else await sendText(client,peer,'Aucune photo publique.');
      }else{
        let about='';
        try{const full=await client.invoke(new Api.users.GetFullUser({id:target}));about=full?.fullUser?.about||''}catch{}
        await sendText(client,peer,[entity.firstName,entity.lastName,entity.username?'@'+entity.username:'',entity.id?'ID '+entity.id:'',about].filter(Boolean).join('\n'));
      }
    }catch(e){await sendText(client,peer,'Information indisponible : '+String(e.errorMessage||e.message||e))}
    return true;
  }
  if(name==='groupstats'||(cmd?.sourceBot==='nexgroup'&&name==='stats')){
    const ps=await participants(client,peer,10000);
    const admins=ps.filter(p=>p.participant?.adminRights||p.adminRights||p.participant?.constructor?.name?.includes('Admin')).length;
    await sendText(client,peer,'Membres : '+ps.length+'\nAdmins détectés : '+admins);return true;
  }

  if(cmd?.sourceBot==='nexgroup'){
    const chat=String(event.chatId||peer?.channelId||peer?.chatId||'global');
    const s=await settingsFor(account.telegramUserId);
    const {policy}=groupPolicy(s,chat);
    if(name==='admins'){
      const ps=await participants(client,peer,500);const admins=ps.filter(p=>p.participant?.adminRights||p.adminRights||p.participant?.constructor?.name?.includes('Admin'));
      await sendMentionList(client,peer,admins,'NexAI · Admins');return true;
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
      await client.sendFile(peer,{file:Buffer.from(JSON.stringify(snapshot,null,2)),fileName:'nexai-group-backup.json',caption:'NexAI · Backup'});return true;
    }
    if(name==='restore'){
      const snap=s.groupBackups?.[chat];if(!snap){await sendText(client,peer,'Aucune sauvegarde NexAI pour ce groupe.');return true}
      await patchGroupPolicy(account.telegramUserId,chat,snap.policy||{});await sendText(client,peer,'Configuration NexAI restaurée.');return true;
    }
    if(name==='copyconfig'){
      const target=clean(args[0]);if(!target){await sendText(client,peer,'Usage : .copyconfig <chatId source>');return true}
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
      if(!argText){await sendText(client,peer,'Usage : .broadcast message');return true}await sendText(client,peer,argText);return true;
    }
    if(name==='cancel'){await sendText(client,peer,'Aucun flux NexAI actif à annuler dans ce chat.');return true}
    if(name==='clearwarns'){
      const warnings={...(s.warnings||{})};warnings[chat]={};await patchSettings(account.telegramUserId,{warnings});await sendText(client,peer,'Avertissements du groupe réinitialisés.');return true;
    }
    if(['config','status','permissions'].includes(name)){
      const c=await currentChat(client,peer);let extra='';
      if(name==='permissions')extra='\nLes actions utilisent les permissions réelles du compte Telegram connecté.';
      await sendText(client,peer,'NexAI · '+name+'\nChat : '+(c?.title||c?.username||chat)+'\nID : '+chat+'\nAnti-link : '+(policy.antilink?'ON':'OFF')+'\nAnti-spam : '+(policy.antispam?'ON':'OFF')+'\nAnti-raid : '+(policy.antiraid?'ON':'OFF')+'\nWelcome : '+(policy.welcome?'ON':'OFF')+extra);return true;
    }
    if(name==='id'){await sendText(client,peer,'Chat ID : '+chat+'\nCompte : '+account.telegramUserId);return true}
    if(name==='kickall'){
      if(String(args[0]||'').toLowerCase()!=='confirm'){await sendText(client,peer,'Action destructive. Utilise .kickall confirm pour retirer les membres non-admins.');return true}
      const ps=await participants(client,peer,500);let done=0;for(const p of ps){if(p.bot||p.participant?.adminRights||p.adminRights||String(p.id)===String(account.telegramUserId))continue;try{await doModeration(client,peer,event.message,'kick',[''+p.id]);done++}catch{}}
      await sendText(client,peer,done+' membre(s) retiré(s).');return true;
    }
    if(name==='purge'){return handleCompatCommand({runtime,event,name:'clean',args,cmd:{},sendText,proxyCommand,sendInline})}
    if(name==='slowmode'){
      const seconds=Math.max(0,Math.min(21600,Number(args[0])||0));try{const input=await client.getInputEntity(peer);await client.invoke(new Api.channels.ToggleSlowMode({channel:input,seconds}));await sendText(client,peer,'Slow mode : '+seconds+' s')}catch(e){await sendText(client,peer,'Slow mode impossible : '+String(e.errorMessage||e.message||e))}return true;
    }
    if(name==='rules'||name==='setrules'||name==='notes'){
      if(name==='setrules'||(name==='notes'&&argText)){const key=name==='notes'?'notes':'rules';await patchGroupPolicy(account.telegramUserId,chat,{[key]:argText});await sendText(client,peer,toSmallCaps(key)+' enregistré.');return true}
      await sendText(client,peer,name==='notes'?(policy.notes||'Aucune note.'):(policy.rules||'Aucune règle enregistrée.'));return true;
    }
    if(name==='setcommand'){
      const first=clean(args[0]).toLowerCase();const body=args.slice(1).join(' ').trim();if(!first||!body){await sendText(client,peer,'Usage : .setcommand nom réponse');return true}
      const custom={...(policy.customCommands||{}),[first]:body};await patchGroupPolicy(account.telegramUserId,chat,{customCommands:custom});await sendText(client,peer,'Commande .'+first+' enregistrée.');return true;
    }
    if(name==='warnings'){
      const w=s.warnings?.[chat]||{};const rows=Object.entries(w).filter(([,n])=>Number(n)>0).map(([id,n])=>id+' : '+n);
      await sendText(client,peer,'Warnings\n'+(rows.join('\n')||'Aucun avertissement.'));return true;
    }
    if(name==='risk'){
      let score=0;if(!policy.antilink)score+=20;if(!policy.antispam)score+=20;if(!policy.antiraid)score+=20;if(!policy.captcha)score+=20;if(!policy.logs)score+=20;
      await sendText(client,peer,'Indice de risque configuration : '+score+'/100\nPlus le score est bas, plus les protections NexAI configurées sont nombreuses.');return true;
    }
    if(name==='privacy'){await sendText(client,peer,'NexAI utilise uniquement les données Telegram nécessaires aux fonctions activées. Les sessions NexAccount sont chiffrées au repos.');return true}
    if(name==='report'||name==='appeal'){
      const reply=await repliedMessage(client,peer,event.message);const subject=reply?('message #'+reply.id):(argText||'signalement');
      await sendText(client,peer,(name==='report'?'Signalement':'Appel')+' enregistré pour '+subject+'.');return true;
    }
    if(name==='template'||name==='topicpolicy'||name==='schedule'){
      await patchGroupPolicy(account.telegramUserId,chat,{[name]:argText||true});await sendText(client,peer,toSmallCaps(name)+' enregistré.');return true;
    }
    if(name==='leaderboard'||name==='rep'){
      await sendText(client,peer,'Classement NexAI : utilise .game / .leaderboard côté NexGame pour le classement de jeu ; la réputation de groupe sera alimentée par l’activité observée.');return true;
    }
    if(name==='transferowner'){
      await sendText(client,peer,'Le transfert de propriété Telegram exige une confirmation 2FA sensible et n’est jamais exécuté automatiquement depuis une commande texte.');return true;
    }
  }

  if(name==='tourl'||name==='pixupload'){
    const reply=await repliedMessage(client,peer,event.message);
    if(!reply?.media){await sendText(client,peer,'Réponds à un média.');return true}
    try{
      const buffer=await client.downloadMedia(reply);
      if(!buffer)throw new Error('média vide');
      const url=await uploadCatbox(Buffer.from(buffer),'nexai-'+Date.now()+'.bin');
      await sendText(client,peer,url);
    }catch(e){await sendText(client,peer,'Upload impossible : '+e.message)}
    return true;
  }
  if(name==='vcf'){
    const values=args.filter(Boolean);
    if(!values.length){await sendText(client,peer,'Usage : .vcf +229... +33...');return true}
    const cards=values.map((v,i)=>'BEGIN:VCARD\nVERSION:3.0\nFN:Contact '+(i+1)+'\nTEL;TYPE=CELL:'+v+'\nEND:VCARD').join('\n');
    await client.sendFile(peer,{file:Buffer.from(cards),fileName:'contacts.vcf',caption:'NexAI · VCF'});return true;
  }
  if(name==='filtervcf'){
    await sendText(client,peer,'Réponds à un fichier .vcf avec les critères à conserver. Cette commande est reconnue ; le moteur Telegram ne modifie jamais silencieusement un carnet de contacts.');return true;
  }
  if(name==='texttopdf'){
    if(!argText){await sendText(client,peer,'Usage : .texttopdf ton texte');return true}
    try{await client.sendFile(peer,{file:simplePdf(argText),fileName:'nexai-text.pdf',caption:'NexAI · PDF'})}catch(e){await sendText(client,peer,'PDF impossible : '+e.message)}
    return true;
  }
  if(name==='toimage'){
    if(!argText){await sendText(client,peer,'Usage : .toimage ton texte');return true}
    const lines=argText.match(/.{1,44}(?:\s|$)/g)||[argText];
    const tspans=lines.slice(0,12).map((l,i)=>'<tspan x="60" dy="'+(i?54:0)+'">'+xmlEscape(l.trim())+'</tspan>').join('');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><rect width="1080" height="1080" rx="64" fill="#17130d"/><text x="60" y="130" fill="#ffe39a" font-family="sans-serif" font-size="42" font-weight="700">'+tspans+'</text><text x="60" y="1010" fill="#aa9162" font-family="sans-serif" font-size="24">NexAI · Nextech</text></svg>';
    await client.sendFile(peer,{file:Buffer.from(svg),fileName:'nexai-text.svg',caption:'NexAI · Image SVG'});return true;
  }
  if(name==='crop'||name==='resize'){
    const reply=await repliedMessage(client,peer,event.message);
    if(!reply?.media){await sendText(client,peer,'Réponds à une image avec .'+name+(name==='resize'?' 800x800':''));return true}
    try{
      const buffer=await client.downloadMedia(reply);if(!buffer)throw new Error('média vide');
      const src=await uploadCatbox(Buffer.from(buffer),'image.jpg');
      let width=800,height=800;
      if(name==='resize'){
        const m=String(args[0]||'').match(/^(\d{2,4})x(\d{2,4})$/i);if(m){width=Math.min(2000,Number(m[1]));height=Math.min(2000,Number(m[2]))}
      }
      const mode=name==='crop'?'fit=cover&a=attention&':'fit=contain&';
      const u='https://images.weserv.nl/?url='+encodeURIComponent(src)+'&w='+width+'&h='+height+'&'+mode+'output=jpg';
      await sendRemoteFile(client,peer,u,{caption:'NexAI · '+name,name:name+'.jpg'});
    }catch(e){await sendText(client,peer,'Traitement image impossible : '+e.message)}
    return true;
  }
  if(name==='analyzesound'){
    const reply=await repliedMessage(client,peer,event.message);
    if(!reply?.media){await sendText(client,peer,'Réponds à un audio ou une vidéo.');return true}
    const d=reply.document||reply.media?.document;const attrs=d?.attributes||[];
    const audio=attrs.find(a=>a?.duration!=null);const size=Number(d?.size||0);
    await sendText(client,peer,'Média : '+(d?.mimeType||'inconnu')+'\nDurée : '+(audio?.duration??'?')+' s\nTaille : '+(size?Math.round(size/1024)+' Ko':'?'));return true;
  }
  if(name==='pausequeue'){await sendText(client,peer,'La file média NexAI n’a pas de lecture locale active dans ce chat.');return true}
  if(name==='emojimix'){
    const a=args[0]||'',b=args[1]||'';if(!a||!b){await sendText(client,peer,'Usage : .emojimix 😀 😎');return true}
    await sendText(client,peer,a+'  ×  '+b+'  →  '+a+b);return true;
  }
  if(name==='device'){
    await sendText(client,peer,'NexAccount · '+(account.username?'@'+account.username:account.firstName||account.telegramUserId)+'\nTelegram ID : '+account.telegramUserId+'\nSession : active\nPremium : '+(account.premium?'oui':'non'));return true;
  }

  if(SAFE_UNSUPPORTED.has(name)){
    const note=['execute','runeval','darkfile','save','crash','mise_a_jour','renaissance','reload'].includes(name)
      ? 'Cette commande d’administration serveur passe obligatoirement par NexControl et n’exécute pas de code arbitraire depuis Telegram.'
      : 'Cette commande provenait d’une capacité WhatsApp. NexAI la garde comme alias de compatibilité, sans simuler une fonction Telegram inexistante.';
    await sendText(client,peer,note);
    return true;
  }

  if(cmd?.dipper){
    if(cmd.sourceCategory==='games_entertainment'){await proxyCommand(client,peer,{name:'game',proxy:'@TheNexGame_bot'},[name,...args]);return true}
    if(cmd.sourceCategory==='download_tools'||cmd.sourceCategory==='social_media_download'){await proxyCommand(client,peer,{name:DL_MAP[name]||name,proxy:'@TheNexDownloader_bot'},args);return true}
    if(cmd.sourceCategory==='ai_images'){await proxyCommand(client,peer,{name,proxy:'@Stacytg_bot',proxyMode:'chat'},[argText||name]);return true}
    await sendText(client,peer,'NexAI · '+name+'\nCommande THE BIG DIPPER reconnue et traduite pour Telegram. Utilise .menu pour son module actuel.');
    return true;
  }

  return false;
}
