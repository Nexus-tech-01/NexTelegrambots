import {
  generateWAMessageFromContent,
  jidNormalizedUser,
  prepareWAMessageMedia
} from '@whiskeysockets/baileys';

// Channel statuses are not normal newsletter updates. Never substitute one for the other.
const CHANNEL_KEYS = Object.freeze({
  nextech: 'channelJid',
  otaku: 'otakuChannelJid',
  stickgood: 'stickGoodChannelJid'
});

const help = [
  '🎞️ NEXAI · STORIES WHATSAPP',
  '',
  '.story group | Texte — story du groupe actuel (admin uniquement)',
  '.story group — en répondant à une photo ou vidéo',
  '.story channel otaku | Légende — story du canal Otaku',
  '.story channel nextech | Légende',
  '.story channel stickgood | Légende',
  '.story status | Texte — statut du compte (owner seulement)',
  '.story targets — destinations disponibles',
  '.story help — cette aide',
  '',
  'Pour une image/vidéo : réponds au média avec la commande, ou écris la commande en légende.',
  'Une story de chaîne nécessite une image ou vidéo et une version du connecteur qui prend en charge Channel Status.',
  'Aucune publication classique ne remplace une story si la fonction est indisponible.'
].join('\n');

export function parseStoryRequest(value='') {
  const [raw, ...captionParts] = String(value).split('|');
  const pieces=raw.trim().split(/\s+/).filter(Boolean);
  const mode=(pieces.shift()||'help').toLowerCase();
  return {mode, argument:pieces.join(' '), caption:captionParts.join('|').trim()};
}

const normalized=j=>String(j||'').replace(/:\d+@/,'@');
const isGroupJid=j=>/^[\w.-]+@g\.us$/.test(String(j||''));
const isNewsletterJid=j=>/^\d+@newsletter$/.test(String(j||''));
function ensureOwner(message) {
  // A group administrator must never inherit ownership privileges over a
  // channel, a personal status, or a group selected from outside the chat.
  if(message?.key?.fromMe!==true) throw new Error('Commande réservée au propriétaire du compte WhatsApp.');
}
function memberIsAdmin(members, jidList) {
  const allowed=new Set(jidList.map(normalized).filter(Boolean));
  return members.some(p=>p?.admin && allowed.has(normalized(p.id)));
}
function groupActorIds(message,ownerId) {
  return [
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.key?.participantPn,
    message?.key?.senderPn,
    message?.key?.fromMe===true ? ownerId : ''
  ].filter(Boolean);
}
function storyContent(text,media) {
  if(!media) {
    if(!text) throw new Error('Ajoute un texte ou réponds à une photo/vidéo.');
    return {text};
  }
  if(!['image','video'].includes(media.type)) throw new Error('Stories : photos et vidéos uniquement pour le moment.');
  if(!Buffer.isBuffer(media.buffer)||!media.buffer.length) throw new Error('Média vide ou illisible.');
  const max=media.type==='image'?12*1024*1024:45*1024*1024;
  if(media.buffer.length>max) throw new Error('Média trop volumineux pour une story.');
  const key=media.type;
  return {[key]:media.buffer, mimetype:media.mimetype||(key==='image'?'image/jpeg':'video/mp4'), ...(text?{caption:text}:{})};
}

export async function sendGroupStory(sock,{groupJid,text='',media=null}) {
  if(!isGroupJid(groupJid)) throw new Error('Identifiant de groupe invalide.');
  if(typeof sock?.relayMessage!=='function' || typeof sock?.waUploadToServer!=='function')
    throw new Error('Cette session Baileys ne permet pas les stories de groupe.');
  const author=jidNormalizedUser(sock.user?.id);
  if(!author) throw new Error('Identité WhatsApp non disponible.');
  const contextInfo={
    forwardingScore:0,
    featureEligibilities:{canBeReshared:true,canReceiveMultiReact:true},
    isGroupStatus:true,
    statusAttributions:[{type:6,groupStatus:{authorJid:author}}]
  };
  let inner;
  if(media) {
    const content=storyContent(text,media);
    const prepared=await prepareWAMessageMedia(content,{upload:sock.waUploadToServer});
    const key=media.type+'Message';
    if(!prepared[key]) throw new Error('Encodage du média de story indisponible.');
    prepared[key].contextInfo={...(prepared[key].contextInfo||{}),...contextInfo};
    inner=prepared;
  } else {
    const content=storyContent(text,null);
    inner={extendedTextMessage:{
      text:content.text,
      font:1,
      backgroundArgb:0xff23313a,
      contextInfo
    }};
  }
  const generated=generateWAMessageFromContent(groupJid,{
    groupStatusMessageV2:{message:inner}
  },{userJid:author});
  if(!generated?.message || !generated?.key?.id) throw new Error('Impossible de construire la story de groupe.');
  await sock.relayMessage(groupJid,generated.message,{messageId:generated.key.id});
  return generated.key.id;
}

export async function runStoryCommand({sock,message,state,args='',readMedia,reply}) {
  const request=parseStoryRequest(args);
  const chat=String(message?.key?.remoteJid||'');
  const ownerId=normalized(sock.user?.id);
  const answer=t=>reply(message,t);
  const {mode,argument,caption}=request;

  if(mode==='help') return answer(help);
  if(mode==='targets'){
    const channels=Object.entries(CHANNEL_KEYS).map(([alias,key])=>
      alias+' : '+(isNewsletterJid(state?.[key])?'résolue':'non résolue')
    );
    const groupLine=isGroupJid(chat)?'Groupe actuel : '+chat:'Groupe : utilise la commande dans le groupe';
    return answer(['🎞️ STORIES · DESTINATIONS',...channels,groupLine].join('\n'));
  }
  if(!['group','channel','status'].includes(mode)) return answer(help);

  if(state?.status!=='connected') throw new Error('Connecte ton compte WhatsApp avant de publier une story.');

  if(mode==='channel'){
    ensureOwner(message);
    const alias=String(argument||'nextech').toLowerCase();
    const stateKey=CHANNEL_KEYS[alias];
    if(!stateKey) throw new Error('Chaîne inconnue. Choisis nextech, otaku ou stickgood.');
    const channelJid=state?.[stateKey];
    if(!isNewsletterJid(channelJid)) throw new Error('Cette chaîne WhatsApp n’est pas encore résolue.');
    // Native Channel Status launched in 2026, but the project's upstream
    // Baileys release lacks this method. Keep a strict capability gate.
    if(typeof sock.newsletterSendStatus!=='function')
      throw new Error('Story de chaîne indisponible avec cette version du connecteur. Aucun post classique envoyé.');
    const media=await readMedia(message);
    if(!media || !['image','video'].includes(media.type))
      throw new Error('Réponds à une image/vidéo pour la story de chaîne.');
    const content=storyContent(caption,media);
    const result=await sock.newsletterSendStatus(channelJid,content);
    if(!result) throw new Error('Story de chaîne non confirmée par le connecteur.');
    return answer('Story de chaîne transmise à WhatsApp · '+alias+'. Vérifie son affichage.');
  }

  if(mode==='status'){
    ensureOwner(message);
    const audience=String(process.env.NEXAI_STORY_AUDIENCE_JIDS||'').split(',')
      .map(x=>x.trim()).filter(x=>/^\d+@(s\.whatsapp\.net|lid)$/.test(x));
    if(!audience.length) throw new Error('Définis explicitement NEXAI_STORY_AUDIENCE_JIDS pour choisir les destinataires de ton statut.');
    const media=await readMedia(message);
    const content=storyContent(caption||argument,media);
    const result=await sock.sendMessage('status@broadcast',content,{
      statusJidList:[...new Set(audience)],
      broadcast:true
    });
    if(!result?.key?.id) throw new Error('Statut non confirmé par WhatsApp.');
    return answer('Statut envoyé aux destinataires configurés. Vérifie sa visibilité dans WhatsApp.');
  }

  let groupJid=chat;
  let text=caption||argument;
  if(!isGroupJid(chat)) {
    ensureOwner(message);
    const words=argument.trim().split(/\s+/);
    if(!isGroupJid(words[0])) throw new Error('Utilise .story group dans le groupe, ou .story group <jid@g.us> depuis ton compte.');
    groupJid=words[0];
    text=caption||words.slice(1).join(' ');
  }
  const meta=await sock.groupMetadata(groupJid);
  const participants=Array.isArray(meta?.participants)?meta.participants:[];
  if(!memberIsAdmin(participants,[ownerId,sock.user?.lid,sock.user?.id]))
    throw new Error('Le compte WhatsApp connecté doit être administrateur de ce groupe.');
  if(message?.key?.fromMe!==true && !memberIsAdmin(participants,groupActorIds(message,ownerId)))
    throw new Error('Seuls les administrateurs du groupe peuvent utiliser cette commande.');
  const media=await readMedia(message);
  const id=await sendGroupStory(sock,{groupJid,text,media});
  return answer('Story de groupe transmise à WhatsApp ('+id+'). Vérifie son affichage dans le groupe.');
}
