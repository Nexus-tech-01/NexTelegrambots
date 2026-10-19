/**
 * Targeted native WhatsApp Channel Status sender.
 *
 * Protocol independently implemented against the existing pinned Baileys
 * 7.0.0-rc14 socket, informed by the MIT-licensed public implementation:
 * https://github.com/rabbitxmd/baileys/blob/main/lib/Utils/newsletter-status.js
 *
 * IMPORTANT: Channels statuses are distinct from regular newsletter posts.
 * Do not downgrade a failed native story into a normal channel post.
 */
import { createReadStream } from 'node:fs';
import https from 'node:https';
import {
  generateWAMessage,
  encodeNewsletterMessage,
  proto
} from '@whiskeysockets/baileys';

const CHANNEL_MEDIA_PATH={
  image:'/newsletter/newsletter-image',
  video:'/newsletter/newsletter-video'
};

const ENCODING_TIMEOUT_MS=30_000;
const STATUS_ACK_TIMEOUT_MS=20_000;
const isChannel=jid=>/^\d+@newsletter$/.test(String(jid||''));
const safeBase64=s=>encodeURIComponent(String(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));

export function buildChannelStatusNode({jid,messageId,message,mediaType=null,mediaHandle=null,encoder=encodeNewsletterMessage}){
  if(!isChannel(jid))throw new Error('Destination story : identifiant de chaîne invalide.');
  if(!messageId || !message)throw new Error('Story WhatsApp incomplète.');
  if(mediaType && !CHANNEL_MEDIA_PATH[mediaType])throw new Error('Type de média incompatible avec les stories de chaîne.');
  if(mediaType && !mediaHandle)throw new Error('WhatsApp n’a pas retourné le handle natif du média. Publication annulée.');
  const attrs={to:jid,id:messageId,type:mediaType?'media':'text'};
  if(mediaType)attrs.media_id=String(mediaHandle);
  return {
    tag:'status',
    attrs,
    content:[{
      tag:'plaintext',
      attrs:mediaType?{mediatype:mediaType}:{},
      content:encoder(message)
    }]
  };
}

export function validateChannelStatusAck(node,{jid,messageId}){
  if(!node || node.tag!=='ack')throw new Error('WhatsApp n’a pas confirmé le statut de chaîne.');
  const a=node.attrs||{};
  if(a.class && a.class!=='status')throw new Error('WhatsApp a répondu avec un ACK non lié aux stories.');
  if(a.id && a.id!==messageId)throw new Error('WhatsApp a accusé réception d’une autre publication.');
  if(a.from && a.from!==jid)throw new Error('WhatsApp a répondu pour une autre chaîne.');
  if(a.error || a.application_error){
    throw new Error('Story refusée par WhatsApp (code '+String(a.error||a.application_error)+'). Vérifie les droits et la disponibilité des statuts sur cette chaîne.');
  }
  return {id:messageId,serverId:a.server_id||null,ack:true};
}

// This upload is deliberately scoped to newsletter media only; the main
// Baileys media uploader and all pre-existing publications remain untouched.
async function postRawNewsletterMedia(url,filePath,signal){
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{
      method:'POST',
      headers:{'Content-Type':'application/octet-stream',Origin:'https://web.whatsapp.com'},
      signal
    },res=>{
      const chunks=[];let len=0;
      res.on('data',chunk=>{
        len+=chunk.length;
        if(len>512*1024){req.destroy(new Error('Réponse média WhatsApp trop volumineuse.'));return;}
        chunks.push(chunk);
      });
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300)
          return reject(new Error('Téléversement story refusé (HTTP '+res.statusCode+').'));
        try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}
        catch{reject(new Error('Réponse de téléchargement story invalide.'))}
      });
    });
    req.on('error',reject);
    const stream=createReadStream(filePath);
    stream.on('error',e=>req.destroy(e));
    stream.pipe(req);
    signal?.addEventListener?.('abort',()=>{stream.destroy();req.destroy(signal.reason||new Error('Upload annulé'))},{once:true});
  });
}

export async function uploadNativeChannelMedia(sock,filePath,options,{upload=postRawNewsletterMedia}={}){
  if(typeof sock?.refreshMediaConn!=='function')
    throw new Error('La connexion WhatsApp ne fournit pas la configuration des médias.');
  const type=String(options?.mediaType||'');
  if(!CHANNEL_MEDIA_PATH[type])throw new Error('Seules les images et vidéos sont acceptées.');
  if(!options?.fileEncSha256B64)throw new Error('Empreinte du média manquante.');
  const conn=await sock.refreshMediaConn(false);
  const hosts=(conn?.hosts||[]).map(h=>h.hostname).filter(h=>/^[A-Za-z0-9.-]+$/.test(h));
  if(!hosts.length || !conn?.auth)throw new Error('Aucun serveur média WhatsApp disponible.');
  const sha=safeBase64(options.fileEncSha256B64);
  const auth=encodeURIComponent(conn.auth);
  let lastError;
  for(const host of hosts.slice(0,5)){
    const url='https://'+host+CHANNEL_MEDIA_PATH[type]+'/'+sha+
      '?auth='+auth+'&token='+sha+'&server_thumb_gen=1';
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(new Error('Timeout du média story')),Math.min(120000,Number(options?.timeoutMs)||ENCODING_TIMEOUT_MS));
    try {
      const response=await upload(url,filePath,controller.signal);
      const handle=response?.fbid??response?.handle??response?.media_id;
      if(!handle || (!response?.url&&!response?.direct_path))throw new Error('Aucun identifiant de média natif fourni.');
      return {
        mediaUrl:response.url,
        directPath:response.direct_path,
        fbid:handle,
        handle,
        thumbnailDirectPath:response.thumbnail_info?.thumbnail_direct_path,
        thumbnailSha256:response.thumbnail_info?.thumbnail_sha256
      };
    }catch(e){lastError=e}finally{clearTimeout(timeout)}
  }
  throw new Error('Impossible de téléverser le média sur les serveurs des stories WhatsApp : '+String(lastError?.message||'échec'));
}

export async function sendNativeChannelStatus(sock,jid,content,{
  makeMessage=generateWAMessage,
  encode=encodeNewsletterMessage,
  uploader=uploadNativeChannelMedia
}={}){
  if(!isChannel(jid))throw new Error('Chaîne WhatsApp inconnue.');
  if(typeof sock?.sendNode!=='function'||typeof sock?.waitForMessage!=='function')
    throw new Error('Cette version de la connexion WhatsApp ne prend pas en charge les ACK des stories.');
  if(typeof sock?.refreshMediaConn!=='function'||typeof sock?.waUploadToServer!=='function')
    throw new Error('Transport natif des médias de chaîne non disponible.');
  const userId=sock?.authState?.creds?.me?.id||sock?.user?.id;
  if(!userId)throw new Error('Le compte WhatsApp doit être connecté.');
  const type=content?.image?'image':content?.video?'video':null;
  if(!type)throw new Error('Une story de chaîne nécessite une photo ou une vidéo.');
  const kind=proto?.StatusAttribution?.Type?.NEWSLETTER_STATUS;
  let mediaHandle;
  const upload=async(filePath,opts)=>{
    const result=await uploader(sock,filePath,opts);
    mediaHandle=result?.handle??result?.fbid;
    return result;
  };
  // generateWAMessage uses raw newsletter (not encrypted private chat) media
  // when the target is a @newsletter address.
  const msg=await makeMessage(jid,{
    ...content,
    ...(typeof kind==='number'?{
      contextInfo:{...content?.contextInfo,statusAttributions:[{type:kind}]}
    }:{}),
  },{
    userJid:userId,
    upload,
    logger:undefined
  });
  if(!msg?.message||!msg?.key?.id)throw new Error('Échec de l’encodage de la story.');
  const result=buildChannelStatusNode({
    jid,messageId:msg.key.id,message:msg.message,mediaType:type,mediaHandle,encoder:encode
  });
  // Register ACK listener before emitting the status stanza to avoid races.
  const pending=sock.waitForMessage(msg.key.id,STATUS_ACK_TIMEOUT_MS);
  await sock.sendNode(result);
  const ack=await pending;
  return validateChannelStatusAck(ack,{jid,messageId:msg.key.id});
}
