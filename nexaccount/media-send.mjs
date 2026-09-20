import path from 'node:path';
import { CustomFile } from 'teleproto/client/uploads.js';

const MIME_BY_EXT={
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif',
  '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime',
  '.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.oga':'audio/ogg','.wav':'audio/wav','.flac':'audio/flac',
  '.pdf':'application/pdf','.json':'application/json','.zip':'application/zip','.apk':'application/vnd.android.package-archive',
  '.vcf':'text/vcard','.svg':'image/svg+xml'
};
const EXT_BY_MIME={
  'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif',
  'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov',
  'audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac','audio/ogg':'.ogg','audio/wav':'.wav','audio/flac':'.flac',
  'application/pdf':'.pdf','application/zip':'.zip','application/vnd.android.package-archive':'.apk',
  'application/json':'.json','text/vcard':'.vcf','image/svg+xml':'.svg'
};

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
export function sniffMedia(buffer){
  const b=Buffer.from(buffer||[]);
  if(starts(b,[0xff,0xd8,0xff]))return {mimeType:'image/jpeg',ext:'.jpg',kind:'image'};
  if(starts(b,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return {mimeType:'image/png',ext:'.png',kind:'image'};
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return {mimeType:'image/webp',ext:'.webp',kind:'image'};
  if(b.length>=6&&/^GIF8[79]a$/.test(b.toString('ascii',0,6)))return {mimeType:'image/gif',ext:'.gif',kind:'image'};
  if(b.length>=12&&b.toString('ascii',4,8)==='ftyp')return {mimeType:'video/mp4',ext:'.mp4',kind:'video'};
  if(starts(b,[0x1a,0x45,0xdf,0xa3]))return {mimeType:'video/webm',ext:'.webm',kind:'video'};
  if(b.length>=3&&b.toString('ascii',0,3)==='ID3')return {mimeType:'audio/mpeg',ext:'.mp3',kind:'audio'};
  if(b.length>=2&&b[0]===0xff&&(b[1]&0xe0)===0xe0)return {mimeType:'audio/mpeg',ext:'.mp3',kind:'audio'};
  if(b.length>=4&&b.toString('ascii',0,4)==='OggS')return {mimeType:'audio/ogg',ext:'.ogg',kind:'audio'};
  if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE')return {mimeType:'audio/wav',ext:'.wav',kind:'audio'};
  if(b.length>=4&&b.toString('ascii',0,4)==='fLaC')return {mimeType:'audio/flac',ext:'.flac',kind:'audio'};
  if(b.length>=5&&b.toString('ascii',0,5)==='%PDF-')return {mimeType:'application/pdf',ext:'.pdf',kind:'document'};
  if(starts(b,[0x50,0x4b,0x03,0x04])||starts(b,[0x50,0x4b,0x05,0x06])||starts(b,[0x50,0x4b,0x07,0x08]))return {mimeType:'application/zip',ext:'.zip',kind:'document'};
  return null;
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
function isHtmlOrJsonError(buffer){
  const s=Buffer.from(buffer).subarray(0,512).toString('utf8').trim().toLowerCase();
  return s.startsWith('<!doctype html')||s.startsWith('<html')||s.startsWith('{"error"')||s.startsWith('{"message"');
}
export function prepareTelegramMedia(data,{fileName='media',mimeType='',kind='auto'}={}){
  const buffer=Buffer.from(data||[]);
  if(!buffer.length)throw new Error('média vide');
  const sniffed=sniffMedia(buffer);
  let mime=cleanMime(mimeType);
  let resolvedKind=kind==='auto'?kindFrom(mime,fileName):String(kind);
  if(resolvedKind!=='document'&&isHtmlOrJsonError(buffer))throw new Error('la source a renvoyé une page/erreur au lieu du média');
  if(sniffed){
    if(resolvedKind==='auto'||resolvedKind==='document'&&['image','video','audio'].includes(sniffed.kind))resolvedKind=sniffed.kind;
    if(!mime||mime==='application/octet-stream'||resolvedKind!=='document')mime=sniffed.mimeType;
  }
  if(!mime){
    mime=MIME_BY_EXT[path.extname(String(fileName||'')).toLowerCase()]||sniffed?.mimeType||'application/octet-stream';
  }
  if(kind==='auto')resolvedKind=sniffed?.kind||kindFrom(mime,fileName);
  let name=safeName(fileName);
  let ext=path.extname(name).toLowerCase();
  const wanted=sniffed?.ext||EXT_BY_MIME[mime]||'';
  if((!ext||ext==='.bin'||ext==='.dat')&&wanted){
    name=(ext?name.slice(0,-ext.length):name)+wanted;
    ext=wanted;
  }
  if(resolvedKind==='video'&&!mime.startsWith('video/'))mime=MIME_BY_EXT[ext]?.startsWith('video/')?MIME_BY_EXT[ext]:'video/mp4';
  if(resolvedKind==='audio'&&!mime.startsWith('audio/'))mime=MIME_BY_EXT[ext]?.startsWith('audio/')?MIME_BY_EXT[ext]:'audio/mpeg';
  if(resolvedKind==='image'&&!mime.startsWith('image/'))mime=MIME_BY_EXT[ext]?.startsWith('image/')?MIME_BY_EXT[ext]:'image/jpeg';
  return {buffer,fileName:name,mimeType:mime,kind:resolvedKind,sniffed};
}

export async function sendTelegramMedia(client,peer,data,{
  fileName='media',mimeType='',kind='auto',caption='',formattingEntities,
  voiceNote=false,buttons,replyTo,silent
}={}){
  const media=prepareTelegramMedia(data,{fileName,mimeType,kind});
  const file=new CustomFile(media.fileName,media.buffer.length,'',media.buffer);
  return client.sendFile(peer,{
    file,
    caption,
    mimeType:media.mimeType,
    forceDocument:media.kind==='document',
    supportsStreaming:media.kind==='video',
    voiceNote:voiceNote===true&&media.mimeType==='audio/ogg',
    formattingEntities,
    buttons,
    replyTo,
    silent
  });
}
