import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getAttributes } from 'teleproto/Utils.js';
import { brandedText } from './response-ui.mjs';

const MIME_BY_EXT={
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif',
  '.bmp':'image/bmp','.avif':'image/avif','.heic':'image/heic','.heif':'image/heif',
  '.mp4':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska','.mov':'video/quicktime','.avi':'video/x-msvideo',
  '.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.oga':'audio/ogg','.opus':'audio/ogg',
  '.wav':'audio/wav','.flac':'audio/flac',
  '.pdf':'application/pdf','.json':'application/json','.zip':'application/zip','.apk':'application/vnd.android.package-archive',
  '.vcf':'text/vcard','.svg':'image/svg+xml'
};
const EXT_BY_MIME={
  'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','image/bmp':'.bmp',
  'image/avif':'.avif','image/heic':'.heic','image/heif':'.heif',
  'video/mp4':'.mp4','video/webm':'.webm','video/x-matroska':'.mkv','video/quicktime':'.mov','video/x-msvideo':'.avi',
  'audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac','audio/ogg':'.ogg','audio/wav':'.wav','audio/flac':'.flac',
  'application/pdf':'.pdf','application/zip':'.zip','application/vnd.android.package-archive':'.apk',
  'application/json':'.json','text/vcard':'.vcf','image/svg+xml':'.svg'
};
const MEDIA_KINDS=new Set(['image','video','audio']);
const FFMPEG=String(process.env.FFMPEG_PATH||'ffmpeg');
const FFPROBE=String(process.env.FFPROBE_PATH||'ffprobe');

function runFfmpeg(args,timeout=120000){
  return new Promise((resolve,reject)=>{
    execFile(FFMPEG,['-hide_banner','-loglevel','error','-y',...args],{
      timeout,
      maxBuffer:8*1024*1024
    },(error,stdout,stderr)=>{
      if(error)return reject(new Error(String(stderr||error.message||error).trim().slice(0,1200)));
      resolve({stdout,stderr});
    });
  });
}

function probeVideoFile(filePath){
  return new Promise((resolve,reject)=>{
    execFile(FFPROBE,[
      '-v','error',
      '-select_streams','v:0',
      '-show_entries','stream=width,height:format=duration',
      '-of','json',
      filePath
    ],{timeout:20000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
      if(error)return reject(new Error(String(stderr||error.message||error).trim().slice(0,900)));
      try{
        const parsed=JSON.parse(String(stdout||'{}'));
        const stream=Array.isArray(parsed?.streams)?parsed.streams[0]:null;
        const width=Math.max(1,Number(stream?.width)||1);
        const height=Math.max(1,Number(stream?.height)||1);
        const duration=Math.max(1,Math.min(59,Number(parsed?.format?.duration)||1));
        resolve({width,height,duration});
      }catch(error){
        reject(new Error('ffprobe video-note invalide: '+String(error?.message||error)));
      }
    });
  });
}

async function normalizeVideoNoteFile(inputPath,outputPath){
  // Telegram clients reliably render round video notes only when the actual
  // encoded video is square. Do not lie in metadata about a 16:9 source:
  // crop it physically to a centered square and encode a canonical MP4.
  await runFfmpeg([
    '-i',inputPath,
    '-map','0:v:0',
    '-map','0:a?',
    '-t','59',
    '-vf','scale=640:640:force_original_aspect_ratio=increase,crop=640:640',
    '-r','30',
    '-c:v','libx264',
    '-preset','veryfast',
    '-crf','23',
    '-pix_fmt','yuv420p',
    '-c:a','aac',
    '-b:a','96k',
    '-ac','1',
    '-movflags','+faststart',
    outputPath
  ]);
  const meta=await probeVideoFile(outputPath);
  if(meta.width!==meta.height)throw new Error('video-note normalisée non carrée');
  return {filePath:outputPath,...meta};
}

function cleanMime(value){
  return String(value||'').split(';')[0].trim().toLowerCase();
}
function safeName(value='media'){
  const v=String(value||'media').replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').replace(/\s+/g,' ').trim();
  return (v||'media').slice(0,180);
}
function starts(buffer,bytes,offset=0){
  if(buffer.length<offset+bytes.length)return false;
  return bytes.every((b,i)=>buffer[offset+i]===b);
}
function kindFrom(mimeType,fileName){
  const mime=cleanMime(mimeType);
  if(mime.startsWith('image/')&&mime!=='image/svg+xml')return 'image';
  if(mime.startsWith('video/'))return 'video';
  if(mime.startsWith('audio/'))return 'audio';
  const ext=path.extname(String(fileName||'')).toLowerCase();
  const guessed=MIME_BY_EXT[ext]||'';
  if(guessed.startsWith('image/')&&guessed!=='image/svg+xml')return 'image';
  if(guessed.startsWith('video/'))return 'video';
  if(guessed.startsWith('audio/'))return 'audio';
  return 'document';
}
function textPrefix(buffer){
  return Buffer.from(buffer).subarray(0,2048).toString('utf8').replace(/^\uFEFF/,'').trim().toLowerCase();
}
function isLikelyTextError(buffer){
  const s=textPrefix(buffer);
  return s.startsWith('<!doctype html')||
    s.startsWith('<html')||
    s.startsWith('<?xml')||
    s.startsWith('#extm3u')||
    s.startsWith('access denied')||
    s.startsWith('forbidden')||
    s.startsWith('not found')||
    s.startsWith('error:')||
    s.startsWith('{"error"')||
    s.startsWith('{"message"')||
    s.startsWith('{"status"')||
    s.startsWith('{"code"')||
    s.startsWith('{"success":false')||
    s.startsWith('[');
}
function replaceExt(fileName,wantedExt){
  const current=path.extname(fileName);
  const stem=current?fileName.slice(0,-current.length):fileName;
  return (stem||'media')+wantedExt;
}
function bmffBrand(b){
  return b.length>=12&&b.toString('ascii',4,8)==='ftyp'?b.toString('ascii',8,12):'';
}

export function normalizeTransferPercent(...args){
  const values=args.map(value=>{
    try{return Number(value?.valueOf?.()??value)}catch{return NaN}
  }).filter(Number.isFinite);
  if(!values.length)return null;
  const first=values[0],second=values[1];
  let ratio;
  if(Number.isFinite(second)&&second>0)ratio=first/second;
  else if(first>=0&&first<=1)ratio=first;
  else if(first>=0&&first<=100)ratio=first/100;
  else return null;
  return Math.max(0,Math.min(100,Math.round(ratio*100)));
}

export function sniffMedia(buffer){
  const b=Buffer.from(buffer||[]);
  if(starts(b,[0xff,0xd8,0xff]))return {mimeType:'image/jpeg',ext:'.jpg',kind:'image'};
  if(starts(b,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return {mimeType:'image/png',ext:'.png',kind:'image'};
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return {mimeType:'image/webp',ext:'.webp',kind:'image'};
  if(b.length>=6&&/^GIF8[79]a$/.test(b.toString('ascii',0,6)))return {mimeType:'image/gif',ext:'.gif',kind:'image'};
  if(starts(b,[0x42,0x4d]))return {mimeType:'image/bmp',ext:'.bmp',kind:'image'};

  const brand=bmffBrand(b);
  if(brand){
    const normalized=brand.toLowerCase();
    if(['m4a ','m4b ','m4p ','f4a '].includes(normalized))return {mimeType:'audio/mp4',ext:'.m4a',kind:'audio'};
    if(['avif','avis'].includes(normalized))return {mimeType:'image/avif',ext:'.avif',kind:'image'};
    if(['heic','heix','hevc','hevx'].includes(normalized))return {mimeType:'image/heic',ext:'.heic',kind:'image'};
    if(['mif1','msf1'].includes(normalized))return {mimeType:'image/heif',ext:'.heif',kind:'image'};
    if(normalized==='qt  ')return {mimeType:'video/quicktime',ext:'.mov',kind:'video'};
    return {mimeType:'video/mp4',ext:'.mp4',kind:'video'};
  }

  if(starts(b,[0x1a,0x45,0xdf,0xa3])){
    const head=b.subarray(0,512).toString('latin1').toLowerCase();
    if(head.includes('webm'))return {mimeType:'video/webm',ext:'.webm',kind:'video'};
    return {mimeType:'video/x-matroska',ext:'.mkv',kind:'video'};
  }
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='AVI ')return {mimeType:'video/x-msvideo',ext:'.avi',kind:'video'};

  if(b.length>=3&&b.toString('ascii',0,3)==='ID3')return {mimeType:'audio/mpeg',ext:'.mp3',kind:'audio'};
  if(b.length>=2&&b[0]===0xff&&(b[1]&0xf6)===0xf0)return {mimeType:'audio/aac',ext:'.aac',kind:'audio'};
  if(b.length>=2&&b[0]===0xff&&(b[1]&0xe0)===0xe0)return {mimeType:'audio/mpeg',ext:'.mp3',kind:'audio'};
  if(b.length>=4&&b.toString('ascii',0,4)==='OggS')return {mimeType:'audio/ogg',ext:'.ogg',kind:'audio'};
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE')return {mimeType:'audio/wav',ext:'.wav',kind:'audio'};
  if(b.length>=4&&b.toString('ascii',0,4)==='fLaC')return {mimeType:'audio/flac',ext:'.flac',kind:'audio'};

  if(b.length>=5&&b.toString('ascii',0,5)==='%PDF-')return {mimeType:'application/pdf',ext:'.pdf',kind:'document'};
  if(starts(b,[0x50,0x4b,0x03,0x04])||starts(b,[0x50,0x4b,0x05,0x06])||starts(b,[0x50,0x4b,0x07,0x08])){
    return {mimeType:'application/zip',ext:'.zip',kind:'document'};
  }
  return null;
}

export function prepareTelegramMedia(data,{fileName='media',mimeType='',kind='auto'}={}){
  const buffer=Buffer.from(data||[]);
  if(!buffer.length)throw new Error('média vide');

  const sniffed=sniffMedia(buffer);
  const declaredMime=cleanMime(mimeType);
  const name0=safeName(fileName);
  const declaredKind=kindFrom(declaredMime,name0);
  const requestedKind=kind==='auto'?declaredKind:String(kind||'auto');
  const expectsMedia=MEDIA_KINDS.has(requestedKind)||MEDIA_KINDS.has(declaredKind);

  if(expectsMedia&&isLikelyTextError(buffer)){
    throw new Error('la source a renvoyé une page/erreur/playlist au lieu du média');
  }

  // The bytes are the source of truth. A provider may claim octet-stream,
  // "video/mp4" or even use a .bin name while returning a different real file.
  let resolvedKind;
  if(kind==='document')resolvedKind='document';
  else if(sniffed?.kind)resolvedKind=sniffed.kind;
  else if(kind==='auto')resolvedKind=declaredKind;
  else resolvedKind=requestedKind;

  let mime=sniffed?.mimeType||declaredMime||MIME_BY_EXT[path.extname(name0).toLowerCase()]||'application/octet-stream';
  let name=name0;
  let ext=path.extname(name).toLowerCase();

  // ZIP-based application packages are intentionally preserved as .apk.
  const preserveApk=(ext==='.apk'||declaredMime==='application/vnd.android.package-archive')&&sniffed?.mimeType==='application/zip';
  const wanted=preserveApk?'.apk':(sniffed?.ext||EXT_BY_MIME[mime]||'');

  if(wanted&&ext!==wanted){
    name=replaceExt(name,wanted);
    ext=wanted;
  }else if(!ext&&wanted){
    name+=wanted;
    ext=wanted;
  }

  if(preserveApk)mime='application/vnd.android.package-archive';
  if(resolvedKind==='video'&&!mime.startsWith('video/'))mime=MIME_BY_EXT[ext]?.startsWith('video/')?MIME_BY_EXT[ext]:'video/mp4';
  if(resolvedKind==='audio'&&!mime.startsWith('audio/'))mime=MIME_BY_EXT[ext]?.startsWith('audio/')?MIME_BY_EXT[ext]:'audio/mpeg';
  if(resolvedKind==='image'&&!mime.startsWith('image/'))mime=MIME_BY_EXT[ext]?.startsWith('image/')?MIME_BY_EXT[ext]:'image/jpeg';

  // Never disguise an obvious non-media payload as a playable media file.
  if(MEDIA_KINDS.has(resolvedKind)&&!sniffed&&isLikelyTextError(buffer)){
    throw new Error('contenu reçu invalide pour un média '+resolvedKind);
  }

  return {buffer,fileName:name,mimeType:mime,kind:resolvedKind,sniffed};
}

export async function sendTelegramMedia(client,peer,data,{
  fileName='media',mimeType='',kind='auto',caption='',formattingEntities,
  voiceNote=false,videoNote=false,buttons,replyTo,silent,parseMode,workers,thumb,afterSend,onUploadProgress,signature=true
}={}){
  const media=prepareTelegramMedia(data,{fileName,mimeType,kind});
  const dir=path.join(
    os.tmpdir(),
    'nexai-media-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex')
  );
  await mkdir(dir,{recursive:true});
  const filePath=path.join(dir,media.fileName);
  await writeFile(filePath,media.buffer);

  try{
    const isVideoNote=videoNote===true&&media.kind==='video';
    let telegramFilePath=filePath;
    let telegramFileName=media.fileName;
    let telegramAttributes;
    let videoNoteMeta=null;
    if(isVideoNote){
      telegramFileName='nexai-video-note.mp4';
      videoNoteMeta=await normalizeVideoNoteFile(
        filePath,
        path.join(dir,telegramFileName)
      );
      telegramFilePath=videoNoteMeta.filePath;
    }
    if(isVideoNote){
      // Teleproto 1.229 adds a DocumentAttributeAudio(voice=true) whenever
      // videoNote=true. That can make Telegram normalize the upload as a
      // regular video. Build the video-note attributes ourselves instead:
      // keep the detected video metadata, force roundMessage, and do not add
      // the spurious voice-note audio attribute.
      const generated=getAttributes(telegramFilePath,{
        mimeType:'video/mp4',
        forceDocument:false,
        voiceNote:false,
        videoNote:false,
        supportsStreaming:true,
        thumb
      });
      telegramAttributes=(generated?.attrs||[]).filter(attr=>
        String(attr?.className||attr?.constructor?.name||'')!=='DocumentAttributeAudio'
      );
      const videoAttr=telegramAttributes.find(attr=>
        String(attr?.className||attr?.constructor?.name||'')==='DocumentAttributeVideo'
      );
      if(!videoAttr)throw new Error('attribut Telegram video-note introuvable');
      videoAttr.roundMessage=true;
      videoAttr.supportsStreaming=true;
      // Teleproto's metadata parser may return 1x1/0s on freshly-generated
      // MP4 files. Use ffprobe's real values instead so Telegram validates the
      // upload as a proper round video message rather than normalizing it back
      // into an ordinary video.
      videoAttr.w=Math.max(1,Number(videoNoteMeta?.width)||640);
      videoAttr.h=Math.max(1,Number(videoNoteMeta?.height)||640);
      videoAttr.duration=Math.max(1,Math.min(59,Number(videoNoteMeta?.duration)||1));
    }

    const branded=String(caption||'').length<=980?brandedText(caption||'',{signature}):{text:String(caption||'').slice(0,1024),entities:[]};
    const mergedEntities=[
      ...(Array.isArray(formattingEntities)?formattingEntities:[]),
      ...branded.entities
    ];
    const sent=await client.sendFile(peer,{
      file:telegramFilePath,
      fileName:telegramFileName,
      caption:branded.text,
      forceDocument:media.kind==='document',
      supportsStreaming:media.kind==='video'&&(media.mimeType==='video/mp4'||media.mimeType==='video/quicktime'),
      voiceNote:voiceNote===true&&media.kind==='audio',
      // Do not pass videoNote=true to Teleproto 1.229: its helper adds a
      // voice-note audio attribute. telegramAttributes already carries the
      // canonical DocumentAttributeVideo(roundMessage=true).
      videoNote:false,
      attributes:telegramAttributes,
      formattingEntities:mergedEntities,
      buttons,
      replyTo,
      silent,
      parseMode,
      workers,
      thumb,
      progressCallback:typeof onUploadProgress==='function'
        ?(...args)=>{
          const pct=normalizeTransferPercent(...args);
          if(pct!==null)Promise.resolve(onUploadProgress(pct)).catch(()=>{});
        }
        :undefined
    });
    if(typeof afterSend==='function'){
      try{await afterSend(sent,media)}catch(error){
        console.warn('[NexAi media CTA]',String(error?.message||error).slice(0,250));
      }
    }
    return sent;
  }finally{
    await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
