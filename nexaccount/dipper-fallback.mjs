import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { sendTelegramMedia } from './media-send.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NexAi/1.0';
const MAX_MEDIA_BYTES=100*1024*1024;

function clean(value){return String(value??'').trim()}
function isHttp(value){return /^https?:\/\//i.test(clean(value))}
function youtubeUrl(value){return /(?:youtube\.com|youtu\.be)\//i.test(clean(value))}
function safeName(value,fallback='media.bin'){
  const out=String(value||fallback).replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').replace(/\s+/g,' ').trim();
  return (out||fallback).slice(0,120);
}
function extFromType(type,url=''){
  const t=String(type||'').toLowerCase();
  if(t.includes('audio'))return 'mp3';
  if(t.includes('video'))return 'mp4';
  if(t.includes('png'))return 'png';
  if(t.includes('webp'))return 'webp';
  if(t.includes('jpeg')||t.includes('jpg'))return 'jpg';
  const m=String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return m?.[1]?.toLowerCase()||'bin';
}
async function response(url,options={},timeout=30000){
  const r=await fetch(url,{
    ...options,
    headers:{'user-agent':UA,...(options.headers||{})},
    signal:AbortSignal.timeout(timeout)
  });
  if(!r.ok)throw new Error('HTTP '+r.status+' · '+new URL(url).hostname);
  return r;
}
async function json(url,options={},timeout=30000){
  return response(url,options,timeout).then(r=>r.json());
}
async function text(url,options={},timeout=30000){
  return response(url,options,timeout).then(r=>r.text());
}
async function postJson(url,body,headers={}){
  return json(url,{method:'POST',headers:{accept:'application/json','content-type':'application/json',...headers},body:JSON.stringify(body)},35000);
}
async function postForm(url,params,headers={}){
  const body=new URLSearchParams(params).toString();
  return response(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body},35000);
}
function firstUrl(value,predicate=()=>true){
  const seen=new Set();
  function walk(v){
    if(v==null)return '';
    if(typeof v==='string'){
      if(/^https?:\/\//i.test(v)&&predicate(v)&&!seen.has(v)){seen.add(v);return v}
      return '';
    }
    if(Array.isArray(v)){
      for(const x of v){const hit=walk(x);if(hit)return hit}
      return '';
    }
    if(typeof v==='object'){
      for(const [k,x] of Object.entries(v)){
        if(/thumb|avatar|cover|author|profile/i.test(k))continue;
        const hit=walk(x);if(hit)return hit;
      }
    }
    return '';
  }
  return walk(value);
}
function cobaltUrl(d){
  if(!d)return '';
  if((d.status==='tunnel'||d.status==='redirect')&&isHttp(d.url))return d.url;
  if(d.status==='picker'&&Array.isArray(d.picker)){
    const item=d.picker.find(x=>x?.type==='video')||d.picker.find(x=>x?.type==='audio')||d.picker[0];
    if(isHttp(item?.url))return item.url;
  }
  return isHttp(d.url)?d.url:'';
}
async function cascade(label,attempts){
  const errors=[];
  for(const [name,fn] of attempts){
    try{
      const value=await fn();
      if(value)return {...value,source:name};
      errors.push(name+': empty');
    }catch(e){errors.push(name+': '+String(e.message||e))}
  }
  throw new Error(label+' indisponible · '+errors.slice(-4).join(' | '));
}
async function sendRemote(client,peer,url,{caption='',fileName='media.bin',maxBytes=MAX_MEDIA_BYTES}={}){
  const r=await response(url,{headers:{accept:'*/*'}},120000);
  const declared=Number(r.headers.get('content-length')||0);
  if(declared&&declared>maxBytes)throw new Error('fichier trop volumineux ('+Math.round(declared/1024/1024)+' Mo)');
  const buf=Buffer.from(await r.arrayBuffer());
  if(!buf.length)throw new Error('média vide');
  if(buf.length>maxBytes)throw new Error('fichier trop volumineux ('+Math.round(buf.length/1024/1024)+' Mo)');
  const type=r.headers.get('content-type')||'';
  const ext=extFromType(type,url);
  const finalName=fileName.includes('.')?fileName:(fileName+'.'+ext);
  return sendTelegramMedia(client,peer,buf,{fileName:finalName,caption,mimeType:type,kind:'auto'});
}
async function resolveYoutube(input){
  const raw=clean(input);
  if(!raw)throw new Error('indique un titre ou un lien YouTube');
  if(youtubeUrl(raw))return {url:raw,title:'YouTube'};
  const html=await text(
    'https://www.youtube.com/results?search_query='+encodeURIComponent(raw),
    {headers:{accept:'text/html'}},
    20000
  );
  const id=html.match(/"videoId":"([A-Za-z0-9_-]{11})"/)?.[1];
  if(!id)throw new Error('aucun résultat YouTube');
  return {url:'https://www.youtube.com/watch?v='+id,title:raw};
}
async function youtubeAudio(input){
  const raw=clean(input);
  if(!raw)throw new Error('indique un titre ou un lien YouTube');

  let target=null;
  if(youtubeUrl(raw))target={url:raw,title:'YouTube'};
  else{
    try{target=await resolveYoutube(raw)}catch{}
  }

  const attempts=[];
  if(target?.url){
    const u=encodeURIComponent(target.url);
    attempts.push(
      ['EliteProTech',async()=>{
        const d=await json('https://eliteprotech-apis.zone.id/ytdown?url='+u+'&format=mp3');
        return d?.success&&d?.downloadURL?{url:d.downloadURL,title:d.title||target.title}:null;
      }],
      ['Okatsu',async()=>{
        const d=await json('https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url='+u);
        return d?.dl?{url:d.dl,title:d.title||target.title}:null;
      }]
    );
  }
  const result=await cascade('audio YouTube',attempts);
  return {...result,target:target||{title:raw,url:''}};
}
async function youtubeVideo(input){
  const target=await resolveYoutube(input);
  const u=encodeURIComponent(target.url);
  const result=await cascade('vidéo YouTube',[
    ['EliteProTech',async()=>{
      const d=await json('https://eliteprotech-apis.zone.id/ytdown?url='+u+'&format=mp4');
      return d?.success&&d?.downloadURL?{url:d.downloadURL,title:d.title||target.title}:null;
    }],
    ['Okatsu',async()=>{
      const d=await json('https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url='+u);
      return d?.result?.mp4?{url:d.result.mp4,title:d.result.title||target.title}:null;
    }]
  ]);
  return {...result,target};
}
async function tiktokMedia(client,peer,url){
  if(!/tiktok\.com\//i.test(url))throw new Error('lien TikTok invalide');
  return cascade('TikTok',[
    ['Siputzx',async()=>{
      const d=await json('https://api.siputzx.my.id/api/d/tiktok?url='+encodeURIComponent(url));
      const v=d?.data?.urls?.[0]||d?.data?.video_url||d?.data?.url||d?.data?.download_url;
      if(!isHttp(v))return null;
      const title=d?.data?.metadata?.title||'TikTok';
      await sendRemote(client,peer,v,{caption:'NexAi · Download\n'+title+'\nSource : Siputzx',fileName:'tiktok.mp4'});
      return {sent:true,title};
    }],
    ['TikWM',async()=>{
      const r=await postForm('https://www.tikwm.com/api/',{url,hd:'1'});
      const d=await r.json();
      const v=d?.data?.hdplay||d?.data?.play;
      if(!isHttp(v))return null;
      const title=d?.data?.title||'TikTok';
      await sendRemote(client,peer,v,{caption:'NexAi · Download\n'+title+'\nSource : TikWM',fileName:'tiktok.mp4'});
      return {sent:true,title};
    }],
    ['Cobalt',async()=>{
      const d=await postJson('https://api.cobalt.tools/',{url,downloadMode:'auto',videoQuality:'max',allowH265:false});
      const v=cobaltUrl(d);
      if(!v)return null;
      await sendRemote(client,peer,v,{caption:'NexAi · Download\nTikTok\nSource : Cobalt',fileName:'tiktok.mp4'});
      return {sent:true,title:'TikTok'};
    }]
  ]);
}
async function instagramMedia(url){
  if(!/instagram\.com\//i.test(url)&&!/instagr\.am\//i.test(url))throw new Error('lien Instagram invalide');
  return cascade('Instagram',[
    ['Siputzx',async()=>{
      const d=await json('https://api.siputzx.my.id/api/d/igdl?url='+encodeURIComponent(url));
      const arr=Array.isArray(d?.data)?d.data:Array.isArray(d?.result)?d.result:[];
      const urls=arr.map(x=>x?.url||x?.download_url||x).filter(isHttp);
      const generic=firstUrl(d,u=>!/thumbnail|profile/i.test(u));
      const all=[...new Set([...urls,generic].filter(Boolean))];
      return all.length?{urls:all,title:'Instagram'}:null;
    }],
    ['Cobalt',async()=>{
      const d=await postJson('https://api.cobalt.tools/',{url,downloadMode:'auto',videoQuality:'max'});
      if(d?.status==='picker'&&Array.isArray(d.picker)){
        const urls=d.picker.map(x=>x?.url).filter(isHttp);
        return urls.length?{urls,title:'Instagram'}:null;
      }
      const v=cobaltUrl(d);
      return v?{urls:[v],title:'Instagram'}:null;
    }]
  ]);
}
async function facebookMedia(url){
  if(!/(?:facebook\.com|fb\.watch)\//i.test(url))throw new Error('lien Facebook invalide');
  const cobaltHosts=['https://api.cobalt.tools/','https://cobalt.drgns.space/','https://cobalt.api.timelessnesses.me/'];
  const attempts=cobaltHosts.map(host=>['Cobalt '+new URL(host).hostname,async()=>{
    const d=await postJson(host,{url,downloadMode:'auto',videoQuality:'max'});
    const v=cobaltUrl(d);
    return v?{url:v,title:'Facebook'}:null;
  }]);
  attempts.push(['SaveFrom',async()=>{
    const d=await json('https://savefrom.net/api/convert?url='+encodeURIComponent(url)+'&lang=fr',{},35000);
    const v=firstUrl(d,u=>/\.mp4(?:[?#]|$)|video/i.test(u));
    return v?{url:v,title:d?.meta?.title||d?.title||'Facebook'}:null;
  }]);
  return cascade('Facebook',attempts);
}
async function pinterestMedia(url){
  if(!/(?:pinterest\.|pin\.it\/)/i.test(url))throw new Error('lien Pinterest invalide');
  const d=await json('https://api.nexray.web.id/downloader/pinterest?url='+encodeURIComponent(url),{},35000);
  if(!d?.status||!d?.result)throw new Error('Pinterest API sans résultat');
  const p=d.result;
  const media=p.video||p.image||p.url;
  if(!isHttp(media))throw new Error('aucun média Pinterest');
  return {url:media,title:p.title||'Pinterest',author:p.author||'',video:!!p.video,source:'Nexray'};
}
async function lyricsSearch(raw){
  const value=clean(raw);
  if(!value)throw new Error('usage : .lyrics artiste - titre');
  let artist='',title=value;
  if(value.includes(' - ')){const parts=value.split(' - ');artist=parts.shift().trim();title=parts.join(' - ').trim()}
  const attempts=[
    ['lyrics.ovh',async()=>{
      if(!artist)return null;
      const d=await json('https://api.lyrics.ovh/v1/'+encodeURIComponent(artist)+'/'+encodeURIComponent(title),{},12000);
      return d?.lyrics?{lyrics:String(d.lyrics).trim(),artist,title}:null;
    }],
    ['lrclib',async()=>{
      const qs=artist
        ?new URLSearchParams({artist_name:artist,track_name:title})
        :new URLSearchParams({q:value});
      const d=await json('https://lrclib.net/api/search?'+qs.toString(),{},12000);
      const item=Array.isArray(d)?d.find(x=>x?.plainLyrics):null;
      return item?.plainLyrics?{lyrics:String(item.plainLyrics).trim(),artist:item.artistName||artist,title:item.trackName||title,duration:item.duration}:null;
    }]
  ];
  return cascade('paroles',attempts);
}
function replyId(message){
  return Number(message?.replyTo?.replyToMsgId||message?.replyToMsgId||message?.replyTo?.msgId||0);
}
async function repliedOrCurrentMedia(client,peer,message){
  if(message?.media)return message;
  const id=replyId(message);
  if(!id)return null;
  const rows=await client.getMessages(peer,{ids:[id]});
  return Array.isArray(rows)?rows[0]:rows;
}
function runFfmpeg(args,timeout=120000){
  const bin=String(process.env.FFMPEG_PATH||'ffmpeg');
  return new Promise((resolve,reject)=>{
    execFile(bin,['-hide_banner','-loglevel','error','-y',...args],{timeout,maxBuffer:8*1024*1024},(err,stdout,stderr)=>{
      if(err)return reject(new Error(String(stderr||err.message||err).trim().slice(0,900)));
      resolve({stdout,stderr});
    });
  });
}

const YTDLP=String(process.env.YTDLP_PATH||'/opt/nex/tools/yt-dlp/yt-dlp');

function runYtDlp(args,timeout=180000){
  return new Promise((resolve,reject)=>{
    execFile(YTDLP,args,{
      timeout,
      maxBuffer:16*1024*1024,
      env:{...process.env,NO_COLOR:'1'}
    },(err,stdout,stderr)=>{
      if(err)return reject(new Error(String(stderr||stdout||err.message||err).trim().slice(-1800)));
      resolve({stdout:String(stdout||''),stderr:String(stderr||'')});
    });
  });
}

async function localYoutubeFile(input,mode='audio'){
  if(!fs.existsSync(YTDLP))throw new Error('yt-dlp local absent');
  const target=await resolveYoutube(input);
  const base='nexai-ytdlp-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const template=path.join(os.tmpdir(),base+'-%(id)s.%(ext)s');
  const common=[
    '--no-playlist','--no-progress','--quiet','--no-warnings',
    '--restrict-filenames','--max-filesize',String(MAX_MEDIA_BYTES),
    '--print','after_move:filepath','-o',template
  ];
  const args=mode==='video'
    ?[
      ...common,
      '-f','bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]',
      '--merge-output-format','mp4',
      target.url
    ]
    :[
      ...common,
      '-x','--audio-format','mp3','--audio-quality','5',
      target.url
    ];
  let file='';
  try{
    const out=await runYtDlp(args);
    const lines=out.stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    file=lines[lines.length-1]||'';
    if(!file||!fs.existsSync(file))throw new Error('yt-dlp n’a produit aucun fichier');
    const buffer=fs.readFileSync(file);
    if(!buffer.length)throw new Error('yt-dlp a produit un média vide');
    if(buffer.length>MAX_MEDIA_BYTES)throw new Error('fichier trop volumineux ('+Math.round(buffer.length/1024/1024)+' Mo)');
    return {
      buffer,
      title:target.title||'YouTube',
      fileName:mode==='video'?safeName(target.title||'video')+'.mp4':safeName(target.title||'audio')+'.mp3',
      mimeType:mode==='video'?'video/mp4':'audio/mpeg'
    };
  }finally{
    if(file)try{fs.unlinkSync(file)}catch{}
    try{
      for(const name of fs.readdirSync(os.tmpdir())){
        if(name.startsWith(base+'-'))try{fs.unlinkSync(path.join(os.tmpdir(),name))}catch{}
      }
    }catch{}
  }
}

async function sendLocalYoutube(client,peer,input,mode='audio'){
  const media=await localYoutubeFile(input,mode);
  await sendTelegramMedia(client,peer,media.buffer,{
    fileName:media.fileName,
    caption:'NexAi · Download\n'+media.title+'\nSource : yt-dlp local',
    mimeType:media.mimeType,
    kind:mode==='video'?'video':'audio'
  });
  return true;
}
async function localToMp3(client,peer,message){
  const source=await repliedOrCurrentMedia(client,peer,message);
  if(!source?.media)throw new Error('Réponds à un audio ou une vidéo, ou donne un lien/titre après .tomp3.');
  const buffer=Buffer.from(await client.downloadMedia(source));
  if(!buffer.length)throw new Error('média vide');
  if(buffer.length>MAX_MEDIA_BYTES)throw new Error('média trop volumineux');
  const base='nexai-mp3-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const input=path.join(os.tmpdir(),base+'.bin'),output=path.join(os.tmpdir(),base+'.mp3');
  fs.writeFileSync(input,buffer);
  try{
    await runFfmpeg(['-i',input,'-vn','-c:a','libmp3lame','-b:a','192k',output]);
    const out=fs.readFileSync(output);
    if(!out.length)throw new Error('conversion MP3 vide');
    await sendTelegramMedia(client,peer,out,{fileName:'nexai-audio.mp3',caption:'NexAi · conversion MP3 locale',mimeType:'audio/mpeg',kind:'audio'});
  }finally{
    try{fs.unlinkSync(input)}catch{}
    try{fs.unlinkSync(output)}catch{}
  }
  return true;
}

async function identifyAudio(client,peer,message){
  const source=await repliedOrCurrentMedia(client,peer,message);
  if(!source?.media)throw new Error('réponds à un audio ou une vidéo');
  const buffer=await client.downloadMedia(source);
  if(!buffer?.length)throw new Error('média vide');
  if(buffer.length>20*1024*1024)throw new Error('extrait supérieur à 20 Mo');
  const form=new FormData();
  form.append('file',new Blob([buffer]),'audio.ogg');
  form.append('return','apple_music,spotify');
  form.append('api_token','test');
  const r=await response('https://api.audd.io/',{method:'POST',body:form},30000);
  const d=await r.json();
  if(!d?.result)throw new Error('musique non identifiée');
  return d.result;
}
async function apkSearch(raw){
  const q=clean(raw);
  if(!q)throw new Error('indique le nom ou package Android');
  const search=await json('https://search.f-droid.org/api/search_apps?q='+encodeURIComponent(q),{},25000);
  const app=Array.isArray(search?.apps)?search.apps[0]:null;
  const pkg=app?.packageName||app?.package_name||(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(q)?q:'');
  if(!pkg)throw new Error('application F-Droid introuvable');
  const info=await json('https://f-droid.org/api/v1/packages/'+encodeURIComponent(pkg),{},25000);
  const packs=Array.isArray(info?.packages)?info.packages:[];
  const version=packs.find(x=>Number(x.versionCode)===Number(info.suggestedVersionCode))||packs[0];
  if(!version)throw new Error('aucune version APK publiée');
  return {
    url:'https://f-droid.org/repo/'+encodeURIComponent(pkg)+'_'+encodeURIComponent(version.versionCode)+'.apk',
    title:app?.name||info?.name||pkg,
    pkg,
    version:version.versionName||String(version.versionCode)
  };
}

export const DOWNLOAD_ENGINE_COMMANDS=new Set([
  'song','video','tiktok','instagram','facebook','pinterest','tomp3','lyrics','shazam','apk'
]);
export const DIPPER_FALLBACK_COMMANDS=DOWNLOAD_ENGINE_COMMANDS;

export function canHandleDownloadCommand(name){
  return DOWNLOAD_ENGINE_COMMANDS.has(String(name||'').toLowerCase());
}
export const canUseDipperFallback=canHandleDownloadCommand;

export async function executeDipperFallback({client,peer,name,args=[],event}){
  const command=String(name||'').toLowerCase();
  const input=args.join(' ').trim();

  if(command==='song'){
    try{return await sendLocalYoutube(client,peer,input,'audio')}
    catch(localError){
      console.warn('[NexAi download yt-dlp audio]',String(localError?.message||localError).slice(0,500));
    }
    const r=await youtubeAudio(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Download\n'+r.title+'\nSource : '+r.source,fileName:safeName(r.title||'audio')+'.mp3'});
    return true;
  }
  if(command==='video'){
    try{return await sendLocalYoutube(client,peer,input,'video')}
    catch(localError){
      console.warn('[NexAi download yt-dlp video]',String(localError?.message||localError).slice(0,500));
    }
    const r=await youtubeVideo(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Download\n'+r.title+'\nSource : '+r.source,fileName:safeName(r.title||'video')+'.mp4'});
    return true;
  }
  if(command==='tiktok'){
    await tiktokMedia(client,peer,input);
    return true;
  }
  if(command==='instagram'){
    const r=await instagramMedia(input);
    const urls=(r.urls||[]).slice(0,10);
    if(!urls.length)throw new Error('aucun média Instagram');
    for(let i=0;i<urls.length;i++){
      await sendRemote(client,peer,urls[i],{caption:i===0?'NexAi · Download\nInstagram · '+r.source:'',fileName:'instagram-'+(i+1)});
    }
    return true;
  }
  if(command==='facebook'){
    const r=await facebookMedia(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Download\nFacebook · '+r.source,fileName:'facebook.mp4'});
    return true;
  }
  if(command==='pinterest'){
    const r=await pinterestMedia(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Download\n'+r.title+(r.author?'\nAuteur : '+r.author:'')+'\nSource : '+r.source,fileName:'pinterest'});
    return true;
  }
  if(command==='tomp3'){
    if(input){
      try{return await sendLocalYoutube(client,peer,input,'audio')}
      catch(localError){
        console.warn('[NexAi download yt-dlp tomp3]',String(localError?.message||localError).slice(0,500));
      }
      const r=await youtubeAudio(input);
      await sendRemote(client,peer,r.url,{caption:'NexAi · Download\n'+r.title+'\nSource : '+r.source,fileName:safeName(r.title||'audio')+'.mp3'});
      return true;
    }
    return localToMp3(client,peer,event?.message);
  }
  if(command==='lyrics'){
    const r=await lyricsSearch(input);
    const body=String(r.lyrics||'');
    const clipped=body.length>3500?body.slice(0,3500)+'\n…':body;
    await client.sendMessage(peer,{message:[
      'NexAi · Download',
      r.artist?('Artiste : '+r.artist):'',
      'Titre : '+r.title,
      'Source : '+r.source,
      '',
      clipped
    ].filter(Boolean).join('\n')});
    return true;
  }
  if(command==='shazam'){
    const r=await identifyAudio(client,peer,event?.message);
    const links=[r.spotify?.external_urls?.spotify,r.apple_music?.url].filter(Boolean);
    await client.sendMessage(peer,{message:[
      'NexAi · Download',
      'Titre : '+(r.title||'?'),
      'Artiste : '+(r.artist||'?'),
      'Album : '+(r.album||'?'),
      r.release_date?('Date : '+r.release_date):'',
      'Source : AudD',
      ...links
    ].filter(Boolean).join('\n')});
    return true;
  }
  if(command==='apk'){
    const r=await apkSearch(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Download\n'+r.title+'\n'+r.pkg+' · '+r.version+'\nSource : F-Droid',fileName:safeName(r.pkg+'_'+r.version)+'.apk',maxBytes:MAX_MEDIA_BYTES});
    return true;
  }
  return false;
}

export const handleDownloadCommand=executeDipperFallback;
