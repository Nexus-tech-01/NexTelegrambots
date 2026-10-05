import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Bot, InlineKeyboard} from 'grammy';
import {db} from './store.mjs';
import {runtimeConnectionFor} from './runtime.mjs';
import {loadNexAnimeBotToken} from './nexanime-secrets.mjs';

const API=String(process.env.NEXANIME_FRANIME_API||'https://api.franime.fr').replace(/\/+$/,'');
const SITE=String(process.env.NEXANIME_FRANIME_SITE||'https://franime.fr').replace(/\/+$/,'');
const BOT_USERNAME=String(process.env.NEXANIME_BOT_USERNAME||'NexAnime01_bot').trim().replace(/^@/,'');
const TMP_ROOT=String(process.env.NEXANIME_DOWNLOAD_DIR||path.join(os.tmpdir(),'nexanime-bot-downloads'));
const BIN_ROOT=String(process.env.NEXANIME_BIN_DIR||path.join(os.tmpdir(),'nexanime-bot-bin'));
const MAX_DOWNLOADS=Math.max(1,Math.min(4,Number(process.env.NEXANIME_DOWNLOAD_CONCURRENCY||2)));
const CATALOG_TTL_MS=10*60_000;
const UPLOAD_TIMEOUT_MS=20*60_000;
const CACHE_VERSION='v2-valid-media';
const MIN_MEDIA_BYTES=Math.max(256*1024,Number(process.env.NEXANIME_MIN_MEDIA_BYTES||1024*1024));
const MIN_MEDIA_DURATION_SECONDS=Math.max(10,Number(process.env.NEXANIME_MIN_DURATION_SECONDS||45));
const SOURCE_TIMEOUT_MS=Math.max(90_000,Number(process.env.NEXANIME_SOURCE_TIMEOUT_MS||25*60_000));
const EPISODE_TIMEOUT_MS=Math.max(SOURCE_TIMEOUT_MS+60_000,Number(process.env.NEXANIME_EPISODE_TIMEOUT_MS||60*60_000));
const USER_AGENT='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const SITE_REFERER=SITE+'/anime/watch';
const VIDEO_PROVIDERS=[
  'sibnet.ru','sendvid.com','vidmoly','filemoon','streamtape','doodstream',
  'smoothpre','uqload','voe.sx','yourupload','vidoza','oneupload','ok.ru',
  'vk.com','vkvideo','dailymotion','youtube','playtube','mail.ru','embed4me',
  'minochinos','dingtezuni','bingezove','movearnpre','bysedikamoum',
  'weneverbeenfree','vmwesa.online','lpayer'
];
const WATCHER_FALLBACK_USERS=['tresor20001','tresor20009'];
const WATCHER_VIDEO_EXT_RE=/\.(?:mp4|mkv|avi|mov|webm|m4v|ts)$/i;


function nxaFiniteNumber(value){
  const n=Number(String(value??'').replace(/[^\d.+-]/g,''));
  return Number.isFinite(n)?n:0;
}
function nxaHumanBytes(bytes){
  let n=Number(bytes)||0;
  if(n<=0)return '—';
  const units=['B','KB','MB','GB','TB'];
  let i=0;
  while(n>=1024&&i<units.length-1){n/=1024;i++}
  const digits=n>=100||i===0?0:n>=10?1:2;
  return n.toFixed(digits)+' '+units[i];
}
function nxaProgressBar(percent,width=18){
  const p=Math.max(0,Math.min(100,Number(percent)||0));
  const done=Math.round(width*p/100);
  return '█'.repeat(done)+'░'.repeat(Math.max(0,width-done));
}
function nxaDownloadProgressText({host='source',attempt=1,percent=0,downloaded=0,total=0,speed='',eta=''}={}){
  const p=Math.max(0,Math.min(100,Number(percent)||0));
  const remaining=total>0?Math.max(0,total-downloaded):0;
  const rows=[
    '⬇️ Téléchargement en cours',
    '['+nxaProgressBar(p)+'] '+p.toFixed(p>=10?1:2)+'%',
    'Téléchargé : '+nxaHumanBytes(downloaded)+(total>0?' / '+nxaHumanBytes(total):''),
    'Restant : '+(total>0?nxaHumanBytes(remaining):'calcul…')
  ];
  if(speed&&speed!=='NA')rows.push('Vitesse : '+speed);
  if(eta&&eta!=='NA')rows.push('Temps restant : '+eta);
  return rows.join('\n');
}


let bot=null;
let polling=false;
let pollLoopPromise=null;
let catalogCache={at:0,items:[]};
let activeDownloads=0;
const pendingUploads=new Map();
const inflight=new Map();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>String(s??'').trim();
const esc=s=>clean(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));

function normalize(value){
  return clean(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function cleanSearchQuery(value){
  let q=normalize(value);
  q=q.replace(/\b(je|j|veux|voudrais|cherche|recherche|regarder|voir|telecharger|telecharge|download|anime|episode|svp|stp|please)\b/g,' ');
  return q.replace(/\s+/g,' ').trim()||normalize(value);
}

function titlesOf(anime){
  const titles=[];
  const obj=anime?.titles&&typeof anime.titles==='object'?anime.titles:{};
  for(const v of Object.values(obj))if(clean(v))titles.push(clean(v));
  if(clean(anime?.titleO))titles.push(clean(anime.titleO));
  if(clean(anime?.title))titles.push(clean(anime.title));
  return [...new Set(titles)];
}

function displayTitle(anime){
  const t=anime?.titles||{};
  return clean(t.fr_fr||t.en||t.en_us||anime?.titleO||anime?.title||('Anime '+anime?.id));
}

function posterOf(anime){
  const raw=clean(anime?.affiche||anime?.poster||anime?.image);
  if(!raw)return '';
  try{return new URL(raw,SITE+'/').href}catch{return ''}
}

function levenshtein(a,b){
  if(a===b)return 0;
  if(!a.length)return b.length;
  if(!b.length)return a.length;
  const prev=Array.from({length:b.length+1},(_,i)=>i);
  const cur=new Array(b.length+1);
  for(let i=1;i<=a.length;i++){
    cur[0]=i;
    for(let j=1;j<=b.length;j++){
      cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    }
    for(let j=0;j<=b.length;j++)prev[j]=cur[j];
  }
  return prev[b.length];
}

function titleScore(query,title){
  const q=normalize(query),t=normalize(title);
  if(!q||!t)return 0;
  if(q===t)return 1000;
  let score=0;
  if(t.startsWith(q))score+=500;
  else if(t.includes(q))score+=360;
  const qt=q.split(' ').filter(Boolean),tt=new Set(t.split(' '));
  const overlap=qt.filter(x=>tt.has(x)).length;
  score+=overlap*80;
  const dist=levenshtein(q,t);
  score+=Math.round(220*(1-dist/Math.max(q.length,t.length,1)));
  return score;
}

function franimeHeaders({json=false}={}){
  return {
    'user-agent':USER_AGENT,
    'accept':json?'application/json, text/plain, */*':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language':'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'referer':SITE_REFERER,
    'origin':SITE,
    'sec-fetch-dest':json?'empty':'document',
    'sec-fetch-mode':json?'cors':'navigate',
    'sec-fetch-site':json?'same-site':'same-origin',
    'upgrade-insecure-requests':'1'
  };
}

async function fetchJson(url){
  const r=await fetch(url,{headers:franimeHeaders({json:true}),signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw new Error('FRAnime HTTP '+r.status);
  return r.json();
}

async function catalog(){
  if(catalogCache.items.length&&Date.now()-catalogCache.at<CATALOG_TTL_MS)return catalogCache.items;
  const data=await fetchJson(API+'/api/animes/');
  const items=Array.isArray(data)?data:Array.isArray(data?.animes)?data.animes:Array.isArray(data?.data)?data.data:[];
  if(!items.length)throw new Error('Catalogue FRAnime vide');
  catalogCache={at:Date.now(),items};
  return items;
}

export async function animeById(id){
  return (await catalog()).find(a=>String(a?.id)===String(id))||null;
}

async function searchAnime(query,limit=6){
  const q=cleanSearchQuery(query);
  const list=await catalog();
  return list.map(anime=>{
    const names=titlesOf(anime);
    const score=Math.max(0,...names.map(x=>titleScore(q,x)));
    return {anime,score};
  }).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.anime);
}

function seasonCount(anime){return Array.isArray(anime?.saisons)?anime.saisons.length:0}
function episodeCount(anime,s){return Array.isArray(anime?.saisons?.[s]?.episodes)?anime.saisons[s].episodes.length:0}

function resultKeyboard(items){
  const kb=new InlineKeyboard();
  items.forEach((a,i)=>{
    kb.text((i+1)+' · '+displayTitle(a).slice(0,42),'a:'+a.id);
    kb.row();
  });
  return kb;
}

async function sendSearchResults(ctx,query){
  const items=await searchAnime(query);
  if(!items.length)return ctx.reply('Aucun anime trouvé. Essaie avec un autre titre.');
  const best=items[0];
  const text='<b>Résultats pour :</b> '+esc(query)+'\n\nChoisis l’anime que tu veux :';
  const poster=posterOf(best);
  if(poster){
    try{return await ctx.replyWithPhoto(poster,{caption:text,parse_mode:'HTML',reply_markup:resultKeyboard(items)})}catch{}
  }
  return ctx.reply(text,{parse_mode:'HTML',reply_markup:resultKeyboard(items)});
}

function languageKeyboard(id){
  return new InlineKeyboard().text('🇫🇷 VF','l:'+id+':vf').text('🌐 VOSTFR','l:'+id+':vo').row().text('◀️ Retour','r:search');
}

function seasonsKeyboard(anime,lang){
  const kb=new InlineKeyboard();
  const n=seasonCount(anime);
  for(let i=0;i<n;i++){
    kb.text('S'+(i+1),'s:'+anime.id+':'+lang+':'+i);
    if((i+1)%4===0)kb.row();
  }
  kb.row().text('◀️ Langue','a:'+anime.id);
  return kb;
}

function episodesKeyboard(anime,lang,s,page=0){
  const total=episodeCount(anime,s);
  const per=20;
  const pages=Math.max(1,Math.ceil(total/per));
  page=clamp(page,0,pages-1);
  const start=page*per,end=Math.min(total,start+per);
  const kb=new InlineKeyboard();
  for(let i=start;i<end;i++){
    kb.text('E'+String(i+1).padStart(2,'0'),'e:'+anime.id+':'+lang+':'+s+':'+i);
    if((i-start+1)%5===0)kb.row();
  }
  kb.row();
  if(page>0)kb.text('◀️','p:'+anime.id+':'+lang+':'+s+':'+(page-1));
  kb.text((page+1)+'/'+pages,'noop');
  if(page<pages-1)kb.text('▶️','p:'+anime.id+':'+lang+':'+s+':'+(page+1));
  kb.row().text('◀️ Saisons','l:'+anime.id+':'+lang);
  return kb;
}

function qualityKeyboard(id,lang,s,e){
  return new InlineKeyboard()
    .text('360p','q:'+id+':'+lang+':'+s+':'+e+':360')
    .text('480p','q:'+id+':'+lang+':'+s+':'+e+':480')
    .text('720p','q:'+id+':'+lang+':'+s+':'+e+':720')
    .row().text('◀️ Épisodes','s:'+id+':'+lang+':'+s);
}

function cacheKey(id,lang,s,e,q){return [CACHE_VERSION,id,lang,s,e,q].join(':')}

async function cacheGet(key){
  try{
    const d=await db();
    return await d.collection('nexanime_bot_cache').findOne({_id:key},{projection:{fileId:1,kind:1,title:1,size:1}});
  }catch{return null}
}

async function cachePut(key,value){
  try{
    const d=await db();
    await d.collection('nexanime_bot_cache').updateOne(
      {_id:key},
      {$set:{...value,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},
      {upsert:true}
    );
  }catch(error){console.warn('[NexAnime cache]',String(error?.message||error).slice(0,240))}
}

async function run(cmd,args,{timeout=15*60_000,cwd=undefined,onStdout=null,onStderr=null}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});
    let out='',err='',done=false;
    const finishError=e=>{
      if(done)return;
      done=true;
      clearTimeout(kill);
      reject(e);
    };
    const kill=setTimeout(()=>{
      if(done)return;
      try{child.kill('SIGKILL')}catch{}
      finishError(new Error('timeout '+cmd));
    },timeout);
    child.stdout.on('data',d=>{
      const s=String(d);
      out+=s;
      if(out.length>2_000_000)out=out.slice(-2_000_000);
      try{onStdout?.(s)}catch{}
    });
    child.stderr.on('data',d=>{
      const s=String(d);
      err+=s;
      if(err.length>2_000_000)err=err.slice(-2_000_000);
      try{onStderr?.(s)}catch{}
    });
    child.once('error',finishError);
    child.once('close',code=>{
      if(done)return;
      done=true;
      clearTimeout(kill);
      if(code===0)resolve({stdout:out,stderr:err});
      else reject(new Error((err||out||cmd+' exited '+code).slice(-2500)));
    });
  });
}

async function ensureYtDlp(){
  const env=clean(process.env.NEXANIME_YTDLP_BIN);
  if(env&&fs.existsSync(env))return env;
  await fsp.mkdir(BIN_ROOT,{recursive:true});
  const local=path.join(BIN_ROOT,'yt-dlp');
  if(fs.existsSync(local))return local;
  const tmp=local+'.tmp-'+process.pid;
  const binaryUrl=process.arch==='arm64'
    ? 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux_aarch64'
    : 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux';
  const r=await fetch(binaryUrl,{
    headers:{'user-agent':'NexAnime/1.0'},signal:AbortSignal.timeout(60000)
  });
  if(!r.ok)throw new Error('yt-dlp download HTTP '+r.status);
  await fsp.writeFile(tmp,Buffer.from(await r.arrayBuffer()),{mode:0o755});
  await fsp.rename(tmp,local);
  return local;
}

async function clearDownloadWorkdir(work){
  let names=[];
  try{names=await fsp.readdir(work)}catch{return}
  await Promise.all(names.map(name=>fsp.rm(path.join(work,name),{recursive:true,force:true}).catch(()=>{})));
}

async function selectDownloadedFile(work,printedPath=''){
  const printed=clean(printedPath);
  if(printed&&fs.existsSync(printed)){
    try{
      const st=await fsp.stat(printed);
      if(st.isFile())return printed;
    }catch{}
  }
  const names=await fsp.readdir(work).catch(()=>[]);
  const rows=[];
  for(const name of names){
    const file=path.join(work,name);
    try{
      const st=await fsp.stat(file);
      if(!st.isFile())continue;
      if(/\.(?:part|ytdl|json|vtt|srt|ass|jpg|jpeg|png|webp|gif)$/i.test(name))continue;
      rows.push({file,size:st.size});
    }catch{}
  }
  rows.sort((a,b)=>b.size-a.size);
  return rows[0]?.file||'';
}

async function validateEpisodeMedia(file){
  let stat;
  try{stat=await fsp.stat(file)}catch{return {ok:false,reason:'missing-file'}}
  if(!stat.isFile())return {ok:false,reason:'not-a-file'};
  if(stat.size<MIN_MEDIA_BYTES)return {ok:false,reason:'too-small',size:stat.size};

  try{
    const probe=await run('ffprobe',[
      '-v','error',
      '-show_entries','format=duration,size:stream=codec_type,codec_name,width,height',
      '-of','json',
      file
    ],{timeout:30000});
    const meta=JSON.parse(probe.stdout||'{}');
    const streams=Array.isArray(meta?.streams)?meta.streams:[];
    const videoStream=streams.find(x=>x?.codec_type==='video'&&Number(x?.width||0)>=160&&Number(x?.height||0)>=90);
    const hasVideo=Boolean(videoStream);
    const hasAudio=streams.some(x=>x?.codec_type==='audio');
    const duration=Number(meta?.format?.duration||0);
    if(!hasVideo)return {ok:false,reason:'no-video',size:stat.size,duration};
    // Telegram labels short silent MP4 placeholders as GIFs. A real anime
    // episode must carry an audio stream.
    if(!hasAudio)return {ok:false,reason:'no-audio-placeholder',size:stat.size,duration};
    if(Number.isFinite(duration)&&duration>0&&duration<MIN_MEDIA_DURATION_SECONDS){
      return {ok:false,reason:'too-short',size:stat.size,duration};
    }
    return {
      ok:true,size:stat.size,duration,hasVideo,hasAudio,
      width:Number(videoStream?.width||0),height:Number(videoStream?.height||0)
    };
  }catch(error){
    const message=String(error?.message||error);
    // If ffprobe is not installed, fall back to a conservative size/type
    // check instead of accepting tiny host placeholders.
    if(/ENOENT|spawn ffprobe/i.test(message)){
      if(stat.size<5*1024*1024)return {ok:false,reason:'probe-missing-small-file',size:stat.size};
      if(/\.(?:gif|webp|png|jpe?g|html?)$/i.test(file))return {ok:false,reason:'probe-missing-nonvideo',size:stat.size};
      return {ok:true,size:stat.size,duration:null,probeFallback:true};
    }
    return {ok:false,reason:'invalid-media',size:stat.size};
  }
}


async function ffmpegCandidateDownload(candidate,work,quality,{timeout=10*60_000,onProgress=null,attempt=1,host='source'}={}){
  const out=path.join(work,'episode-ffmpeg-'+attempt+'.mp4');
  const referer=clean(candidate?.referer)||SITE_REFERER;
  const headers='User-Agent: '+USER_AGENT+'\r\nReferer: '+referer+'\r\n';
  const emit=text=>{
    if(typeof onProgress!=='function')return;
    try{Promise.resolve(onProgress({stage:'ffmpeg-fallback',message:text,force:true})).catch(()=>{})}catch{}
  };
  emit('Fallback flux direct · '+host+' · tentative ffmpeg…');
  const base=[
    '-y','-hide_banner','-loglevel','error',
    '-headers',headers,'-i',String(candidate?.url||''),
    '-map','0:v:0','-map','0:a:0?'
  ];
  try{
    await run('ffmpeg',[
      ...base,'-c:v','copy','-c:a','aac','-b:a','128k','-movflags','+faststart',out
    ],{timeout});
    const check=await validateEpisodeMedia(out);
    if(check.ok)return out;
  }catch{}
  await fsp.rm(out,{force:true}).catch(()=>{});
  emit('Fallback flux direct · '+host+' · remux impossible, transcodage de secours…');
  try{
    await run('ffmpeg',[
      ...base,
      '-vf','scale=-2:'+Number(quality)+':force_original_aspect_ratio=decrease',
      '-c:v','libx264','-preset','veryfast','-crf','23',
      '-c:a','aac','-b:a','128k','-movflags','+faststart',out
    ],{timeout});
    const check=await validateEpisodeMedia(out);
    if(check.ok)return out;
  }catch{}
  await fsp.rm(out,{force:true}).catch(()=>{});
  return '';
}

async function normalizeWatcherQuality(file,work,quality,check,{onProgress=null}={}){
  const wanted=Number(quality)||0;
  const height=Number(check?.height||0);
  if(!wanted||!height)return file;
  if(height<wanted*0.72)return '';
  if(height<=wanted+32&&height>=wanted*0.80)return file;
  const out=path.join(work,'episode-'+wanted+'p.mp4');
  if(typeof onProgress==='function'){
    try{Promise.resolve(onProgress({
      stage:'normalize-quality',
      message:'Conversion de la vidéo vers '+wanted+'p…',
      force:true
    })).catch(()=>{})}catch{}
  }
  try{
    await run('ffmpeg',[
      '-y','-hide_banner','-loglevel','error','-i',file,
      '-map','0:v:0','-map','0:a:0?',
      '-vf','scale=-2:'+wanted+':force_original_aspect_ratio=decrease',
      '-c:v','libx264','-preset','veryfast','-crf','23',
      '-c:a','aac','-b:a','128k','-movflags','+faststart',out
    ],{timeout:30*60_000});
    const verified=await validateEpisodeMedia(out);
    if(verified.ok)return out;
  }catch{}
  await fsp.rm(out,{force:true}).catch(()=>{});
  return '';
}

function collectUrls(value,out=new Set(),base=SITE+'/'){
  if(typeof value==='string'){
    const s=value.trim();
    if(/^https?:\/\//i.test(s))out.add(s.replace(/\\u0026/g,'&').replace(/&amp;/g,'&'));
    for(const m of s.matchAll(/https?:\\?\/\\?\/[^"'<>\\s]+/g)){
      out.add(m[0].replace(/\\\//g,'/').replace(/\\u0026/g,'&').replace(/&amp;/g,'&'));
    }
    for(const m of s.matchAll(/(?:src|href)=[\"']([^\"']+)[\"']/gi)){
      try{out.add(new URL(m[1],base).href)}catch{}
    }
  }else if(Array.isArray(value))for(const x of value)collectUrls(x,out,base);
  else if(value&&typeof value==='object')for(const x of Object.values(value))collectUrls(x,out,base);
  return out;
}

function isKnownVideoProvider(url){
  const u=String(url||'').toLowerCase();
  return VIDEO_PROVIDERS.some(provider=>u.includes(provider));
}

function decodeWatchToken(value){
  try{
    const normalized=String(value||'').trim().replace(/-/g,'+').replace(/_/g,'/');
    const hex=Buffer.from(normalized,'base64').toString('utf8').trim();
    if(!hex||!/^[0-9a-f]+$/i.test(hex)||hex.length%2!==0)return '';
    const encrypted=Buffer.from(hex,'hex');
    for(let key=0;key<256;key++){
      const decoded=Buffer.allocUnsafe(encrypted.length);
      for(let i=0;i<encrypted.length;i++)decoded[i]=encrypted[i]^key;
      const text=decoded.toString('utf8');
      if(/^https?:\/\//i.test(text)){
        try{
          const u=new URL(text);
          if(/^https?:$/.test(u.protocol)&&u.hostname)return text;
        }catch{}
      }
    }
  }catch{}
  return '';
}

function decodeWatchUrls(url){
  const out=new Set();
  try{
    const u=new URL(url);
    const params=[...u.searchParams.entries()];
    // FRAnime may expose a decoy in b while real embeds live in other blobs.
    // Try every token and keep b last instead of stopping at the first decode.
    const ordered=[
      ...params.filter(([k])=>k!=='b'),
      ...params.filter(([k])=>k==='b')
    ];
    for(const [,value] of ordered){
      const decoded=decodeWatchToken(value);
      if(decoded)out.add(decoded);
    }
  }catch{}
  return [...out];
}

function viewerUrlScore(url){
  const u=String(url||'');
  let score=0;
  if(/\.(?:m3u8|mp4|mkv|webm)(?:$|[?#])/i.test(u))score+=30;
  if(isKnownVideoProvider(u))score+=20;
  if(/\/(?:embed|player|video|shell\.php)(?:[/?#]|$)/i.test(u))score+=6;
  if(/franime\.fr\/watch2/i.test(u))score-=40;
  if(/\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?)(?:$|[?#])/i.test(u))score-=30;
  return score;
}

function isFranimeWrapper(url){
  try{
    const u=new URL(url);
    return /(^|\.)franime\.fr$/i.test(u.hostname)&&/\/watch2\b/i.test(u.pathname);
  }catch{return false}
}

async function resolveFranimeWrapper(url){
  const resolved=new Set(decodeWatchUrls(url));
  let r=null;
  let finalUrl=url;
  try{
    r=await fetch(url,{
      redirect:'follow',
      headers:franimeHeaders(),
      signal:AbortSignal.timeout(25000)
    });
    finalUrl=r.url||url;
    for(const decoded of decodeWatchUrls(finalUrl))resolved.add(decoded);

    let text='';
    try{text=await r.text()}catch{}
    const found=collectUrls(text,new Set(),finalUrl);
    for(const candidate of found){
      if(isFranimeWrapper(candidate)){
        for(const decoded of decodeWatchUrls(candidate))resolved.add(decoded);
      }else if(/^https?:\/\//i.test(candidate)&&viewerUrlScore(candidate)>0){
        resolved.add(candidate);
      }
    }
  }catch(error){
    if(!resolved.size)throw error;
  }

  if(resolved.size)return [...resolved];

  // Cloudflare may answer 403 after redirect. We only reject after attempting
  // every token from the original and final URLs.
  if(r&&!r.ok)throw new Error('Lecteur FRAnime HTTP '+r.status);
  return [];
}

function providerRequestHeaders(referer=''){
  return {
    'user-agent':USER_AGENT,
    'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language':'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(referer?{'referer':referer}:{})
  };
}

function normalizeMediaCandidate(raw,base){
  const value=String(raw||'').trim()
    .replace(/\\u0026/g,'&')
    .replace(/\\\//g,'/')
    .replace(/&amp;/g,'&');
  if(!value)return '';
  try{return new URL(value,base).href}catch{return ''}
}

function extractMediaCandidatesFromHtml(html,base){
  const out=new Set();
  const text=String(html||'');
  const patterns=[
    /(?:file|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mpd|mp4|webm)(?:\?[^"']*)?)["']/gi,
    /<source[^>]+src=["']([^"']+\.(?:m3u8|mpd|mp4|webm)(?:\?[^"']*)?)["']/gi,
    /https?:\\?\/\\?\/[^"'<>\s]+\.(?:m3u8|mpd|mp4|webm)(?:\?[^"'<>\s]*)?/gi
  ];
  for(const pattern of patterns){
    for(const m of text.matchAll(pattern)){
      const raw=m[1]||m[0];
      const u=normalizeMediaCandidate(raw,base);
      if(u)out.add(u);
    }
  }
  return [...out];
}

function extractIframeCandidates(html,base){
  const out=new Set();
  for(const m of String(html||'').matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)){
    const u=normalizeMediaCandidate(m[1],base);
    if(u&&/^https?:\/\//i.test(u))out.add(u);
  }
  return [...out];
}

async function resolveSibnetDirect(embedUrl,html){
  const patterns=[
    /player\.src\(\[\{src:\s*['"]([^'"]+)['"]/,
    /['"]file['"]\s*:\s*['"](\/v\/[^'"]+)['"]/,
    /src:\s*['"](\/v\/[^'"]+)['"]/
  ];
  let p='';
  for(const pattern of patterns){
    const m=String(html||'').match(pattern);
    if(m){p=m[1];break}
  }
  if(!p)return '';
  const videoUrl=normalizeMediaCandidate(p,'https://video.sibnet.ru/');
  if(!videoUrl)return '';
  try{
    const r=await fetch(videoUrl,{
      headers:providerRequestHeaders(embedUrl),
      redirect:'manual',
      signal:AbortSignal.timeout(20000)
    });
    const loc=r.headers.get('location');
    if(loc)return normalizeMediaCandidate(loc,videoUrl);
    if(r.ok)return videoUrl;
  }catch{}
  return '';
}

async function httpExtractorCandidates(embedUrl,depth=0,seen=new Set()){
  if(depth>2||seen.has(embedUrl))return [];
  seen.add(embedUrl);

  if(/\.(?:m3u8|mpd|mp4|webm)(?:$|[?#])/i.test(embedUrl)){
    return [{url:embedUrl,referer:SITE_REFERER,via:'direct'}];
  }

  let r;
  try{
    r=await fetch(embedUrl,{
      headers:providerRequestHeaders(SITE_REFERER),
      redirect:'follow',
      signal:AbortSignal.timeout(25000)
    });
  }catch{return []}

  const finalUrl=r.url||embedUrl;
  let html='';
  try{html=await r.text()}catch{}
  const out=[];
  const direct=extractMediaCandidatesFromHtml(html,finalUrl);

  if(/sibnet/i.test(finalUrl)){
    const sib=await resolveSibnetDirect(finalUrl,html);
    if(sib)direct.unshift(sib);
  }

  for(const url of direct){
    out.push({url,referer:finalUrl,via:'http'});
  }

  for(const iframe of extractIframeCandidates(html,finalUrl).slice(0,4)){
    if(isFranimeWrapper(iframe))continue;
    const nested=await httpExtractorCandidates(iframe,depth+1,seen);
    for(const item of nested)out.push(item);
  }

  const dedup=[];
  const keys=new Set();
  for(const item of out){
    if(!item?.url||keys.has(item.url))continue;
    keys.add(item.url);
    dedup.push(item);
  }
  return dedup;
}

function findBrowserBinary(){
  const candidates=[
    clean(process.env.NEXANIME_BROWSER_BIN),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ].filter(Boolean);
  return candidates.find(x=>fs.existsSync(x))||'';
}

async function chromiumDevtoolsEndpoint(child,timeoutMs=10000){
  return new Promise((resolve,reject)=>{
    let buf='';
    const timer=setTimeout(()=>reject(new Error('browser-devtools-timeout')),timeoutMs);
    const done=value=>{clearTimeout(timer);resolve(value)};
    child.stderr.on('data',chunk=>{
      buf+=String(chunk);
      const m=buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if(m)done(m[1]);
      if(buf.length>120000)buf=buf.slice(-120000);
    });
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('browser-exited-'+code))});
  });
}

async function browserNetworkCandidates(targetUrl){
  const browser=findBrowserBinary();
  if(!browser||typeof WebSocket==='undefined')return [];
  const profile=await fsp.mkdtemp(path.join(os.tmpdir(),'nexanime-chrome-'));
  const child=spawn(browser,[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required','--remote-allow-origins=*','--remote-debugging-port=0',
    '--user-data-dir='+profile,'about:blank'
  ],{stdio:['ignore','ignore','pipe']});

  let browserWs='';
  try{
    browserWs=await chromiumDevtoolsEndpoint(child,12000);
    const port=new URL(browserWs).port;
    const created=await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(targetUrl),{
      method:'PUT',signal:AbortSignal.timeout(5000)
    });
    if(!created.ok)throw new Error('browser-target-http-'+created.status);
    const target=await created.json();
    const wsUrl=target.webSocketDebuggerUrl;
    if(!wsUrl)throw new Error('browser-target-ws-missing');

    const ws=new WebSocket(wsUrl);
    const pending=new Map();
    const media=new Set();
    let seq=0;
    const mediaLike=u=>/\.(?:m3u8|mpd|mp4|webm)(?:$|[?#])/i.test(String(u||''));

    const opened=new Promise((resolve,reject)=>{
      const t=setTimeout(()=>reject(new Error('browser-ws-timeout')),7000);
      ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});
      ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('browser-ws-error'))},{once:true});
    });
    await opened;

    ws.addEventListener('message',event=>{
      let msg;
      try{msg=JSON.parse(String(event.data||''))}catch{return}
      if(msg.id&&pending.has(msg.id)){
        const p=pending.get(msg.id);pending.delete(msg.id);
        if(msg.error)p.reject(new Error(msg.error.message||'cdp-error'));else p.resolve(msg.result||{});
        return;
      }
      const u=msg?.params?.request?.url||msg?.params?.response?.url||msg?.params?.documentURL||'';
      const mime=String(msg?.params?.response?.mimeType||'');
      const resourceType=String(msg?.params?.type||'');
      if(mediaLike(u)||/(?:mpegurl|dash\+xml|video\/|application\/octet-stream)/i.test(mime)||resourceType==='Media'){
        if(/^https?:\/\//i.test(u))media.add(u);
      }
    });

    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++seq;
      pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
      setTimeout(()=>{
        if(pending.has(id)){pending.delete(id);reject(new Error('cdp-timeout-'+method))}
      },7000);
    });

    await send('Network.enable');
    await send('Page.enable');
    await send('Network.setExtraHTTPHeaders',{headers:{Referer:SITE_REFERER}});
    await send('Emulation.setUserAgentOverride',{userAgent:USER_AGENT});
    await send('Page.navigate',{url:targetUrl});
    await sleep(16000);
    try{await send('Page.stopLoading')}catch{}
    try{ws.close()}catch{}

    return [...media].map(url=>({url,referer:targetUrl,via:'browser'}));
  }catch(error){
    console.warn('[NexAnime] browser extractor unavailable',String(error?.message||error).slice(0,220));
    return [];
  }finally{
    try{child.kill('SIGKILL')}catch{}
    await fsp.rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
}

async function expandedDownloadCandidates(url,{browserFallback=false}={}){
  const out=[];
  const http=await httpExtractorCandidates(url);
  for(const item of http)out.push(item);
  out.push({url,referer:SITE_REFERER,via:'embed'});
  if(browserFallback){
    const browser=await browserNetworkCandidates(url);
    for(const item of browser)out.unshift(item);
  }
  const seen=new Set();
  return out.filter(item=>item?.url&&!seen.has(item.url)&&(seen.add(item.url),true));
}

async function viewerCandidates(animeId,s,e,lang){
  const urls=new Set();
  const failures=[];
  let consecutiveMisses=0;
  for(let reader=0;reader<12;reader++){
    const endpoint=API+'/api/anime/'+encodeURIComponent(animeId)+'/'+s+'/'+e+'/'+encodeURIComponent(lang)+'/'+reader;
    try{
      const r=await fetch(endpoint,{headers:franimeHeaders({json:true}),signal:AbortSignal.timeout(25000)});
      if(!r.ok){
        failures.push(reader+':HTTP '+r.status);
        consecutiveMisses++;
        continue;
      }
      const text=(await r.text()).trim();
      if(!text){
        consecutiveMisses++;
        continue;
      }
      const before=urls.size;
      try{collectUrls(JSON.parse(text),urls)}catch{collectUrls(text,urls)}
      if(/^https?:\/\//i.test(text))urls.add(text);
      consecutiveMisses=urls.size>before?0:consecutiveMisses+1;
    }catch(error){
      failures.push(reader+':'+String(error?.message||error).slice(0,120));
      consecutiveMisses++;
    }
  }

  for(const wrapped of [...urls].filter(isFranimeWrapper)){
    try{
      const resolved=await resolveFranimeWrapper(wrapped);
      for(const candidate of resolved)urls.add(candidate);
    }catch(error){
      failures.push('watch2:'+String(error?.message||error).slice(0,120));
    }
  }

  const ranked=[...urls]
    .filter(x=>/^https?:\/\//i.test(x))
    .filter(x=>!isFranimeWrapper(x))
    .filter(x=>viewerUrlScore(x)>0)
    .sort((a,b)=>viewerUrlScore(b)-viewerUrlScore(a));

  const wrappers=[...urls].filter(isFranimeWrapper);
  if(!ranked.length&&!wrappers.length&&failures.length){
    throw new Error('Aucun lecteur FRAnime disponible');
  }
  return {
    urls:[...new Set(ranked)],
    wrappers:[...new Set(wrappers)]
  };
}

async function downloadEpisodeFromFranime(anime,lang,s,e,quality,{onProgress=null,preResolvedUrls=[]}={}){
  await fsp.mkdir(TMP_ROOT,{recursive:true});
  const work=await fsp.mkdtemp(path.join(TMP_ROOT,'job-'));
  const outTpl=path.join(work,'episode.%(ext)s');
  const ytdlp=await ensureYtDlp();
  const startedAt=Date.now();
  const deadline=startedAt+EPISODE_TIMEOUT_MS;
  let lastProgressAt=0;

  const emit=payload=>{
    if(typeof onProgress!=='function')return;
    const now=Date.now();
    if(payload?.force!==true&&now-lastProgressAt<8000)return;
    lastProgressAt=now;
    try{
      Promise.resolve(onProgress({...payload,elapsedMs:now-startedAt})).catch(()=>{});
    }catch{}
  };

  const remainingMs=()=>Math.max(0,deadline-Date.now());
  const ensureTime=()=>{
    if(remainingMs()<=0)throw new Error('episode-timeout');
  };

  const handedOff=[...new Set((Array.isArray(preResolvedUrls)?preResolvedUrls:[]).map(x=>String(x||'').trim()).filter(x=>/^https?:\/\//i.test(x)))];
  emit({stage:'resolve',message:handedOff.length?'Sources déjà reçues · recherche de lecteurs supplémentaires…':'Recherche des lecteurs FRAnime…',force:true});
  let fresh={urls:[],wrappers:[]};
  try{fresh=await viewerCandidates(anime.id,s,e,lang)}catch(error){
    if(!handedOff.length)throw error;
  }
  const urls=[...new Set([...handedOff,...(Array.isArray(fresh?.urls)?fresh.urls:[])])];
  const wrappers=[...new Set(Array.isArray(fresh?.wrappers)?fresh.wrappers:[])];
  if(!urls.length&&!wrappers.length)throw new Error('Aucune source vidéo trouvée pour cet épisode');

  emit({
    stage:'resolve',
    message:'Téléchargement prêt à démarrer…',
    force:true
  });

  const fmt='bv*[height<='+quality+']+ba/b[height<='+quality+']/best[height<='+quality+']/best';
  let lastError=null;
  let rejectedMedia=0;
  let timedOutSources=0;
  let sourceAttempt=0;
  const badHosts=new Set();

  const tryCandidate=async candidate=>{
    ensureTime();
    sourceAttempt++;
    await clearDownloadWorkdir(work);

    let host='source';
    try{host=new URL(candidate.url).hostname.replace(/^www\./,'')}catch{}
    if(badHosts.has(host)){
      emit({stage:'skip',message:'Une méthode a échoué · nouvelle tentative…',force:true});
      return '';
    }

    emit({
      stage:'download',
      message:'Préparation du téléchargement…',
      force:true
    });

    let progressBuffer='';
    const parseProgress=chunk=>{
      progressBuffer=(progressBuffer+String(chunk||'')).slice(-20000);
      const lines=progressBuffer.split(/\r?\n/);
      progressBuffer=lines.pop()||'';
      for(const line of lines){
        if(!line.includes('NXA_PROGRESS|'))continue;
        const parts=line.slice(line.indexOf('NXA_PROGRESS|')).split('|');
        const percent=nxaFiniteNumber(parts[1]);
        const downloaded=nxaFiniteNumber(parts[7]);
        const total=nxaFiniteNumber(parts[8])||nxaFiniteNumber(parts[9]);
        const speed=String(parts[5]||'').trim();
        const eta=String(parts[6]||'').trim();
        emit({
          stage:'download',
          message:nxaDownloadProgressText({
            host,attempt:sourceAttempt,percent,downloaded,total,speed,eta
          })
        });
      }
    };

    try{
      const timeout=Math.max(45_000,Math.min(SOURCE_TIMEOUT_MS,remainingMs()));
      const r=await run(ytdlp,[
        '--no-playlist','--no-warnings',
        '--socket-timeout','20',
        '--retries','2','--fragment-retries','2','--retry-sleep','2',
        '--concurrent-fragments','4',
        '--newline','--progress',
        '--progress-template','download:NXA_PROGRESS|%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
        '--extractor-args','generic:impersonate',
        '--user-agent',USER_AGENT,'--referer',candidate.referer||SITE_REFERER,
        '-f',fmt,'--merge-output-format','mp4','--print','after_move:filepath',
        '-o',outTpl,candidate.url
      ],{
        timeout,
        cwd:work,
        onStdout:parseProgress,
        onStderr:parseProgress
      });

      const printed=String(r.stdout||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).at(-1)||'';
      const file=await selectDownloadedFile(work,printed);
      if(!file)throw new Error('reader-produced-no-file');

      emit({stage:'validate',message:'Vérification de la vidéo…',force:true});
      const check=await validateEpisodeMedia(file);
      if(!check.ok){
        rejectedMedia++;
        if(['no-audio-placeholder','too-short','too-small','no-video'].includes(check.reason))badHosts.add(host);
        console.warn('[NexAnime] rejected '+candidate.via+' media',check.reason,'bytes='+String(check.size||0),'duration='+String(check.duration??'n/a'));
        emit({stage:'reject',message:'Vidéo invalide reçue · nouvelle tentative…',force:true});
        throw new Error('invalid-reader-media:'+check.reason);
      }

      console.log('[NexAnime] accepted '+candidate.via+' media','bytes='+check.size,'duration='+String(check.duration??'n/a'));
      emit({stage:'ready',message:'Épisode valide trouvé · préparation de l’envoi…',force:true});
      return file;
    }catch(error){
      lastError=error;
      const message=String(error?.message||error);
      if(/timeout yt-dlp|episode-timeout/i.test(message)){
        timedOutSources++;
        emit({stage:'timeout',message:'Téléchargement trop lent · changement de méthode…',force:true});
      }
      const directish=/\.(?:m3u8|mpd|mp4|webm|mkv)(?:$|[?#])/i.test(String(candidate?.url||''))||['http','browser','direct'].includes(String(candidate?.via||''));
      if(directish&&remainingMs()>45_000){
        const ff=await ffmpegCandidateDownload(candidate,work,quality,{
          timeout:Math.max(45_000,Math.min(20*60_000,remainingMs())),
          onProgress,attempt:sourceAttempt,host
        }).catch(()=> '');
        if(ff){
          const check=await validateEpisodeMedia(ff);
          if(check.ok){
            emit({stage:'ready',message:'Flux direct récupéré avec succès · préparation de l’envoi…',force:true});
            return ff;
          }
        }
      }
      await clearDownloadWorkdir(work);
      return '';
    }
  };

  // Cascade: direct HTTP media -> provider embed -> next provider.
  for(let i=0;i<Math.min(urls.length,16);i++){
    ensureTime();
    const url=urls[i];
    emit({stage:'extract',message:'Recherche de la meilleure méthode de téléchargement…',force:true});
    const candidates=await expandedDownloadCandidates(url);
    for(const candidate of candidates){
      ensureTime();
      const file=await tryCandidate(candidate);
      if(file)return {file,work};
    }
  }

  // Final fallback: run the player in headless Chromium and capture network media.
  const browserTargets=[...wrappers,...urls].slice(0,10);
  for(let i=0;i<browserTargets.length;i++){
    ensureTime();
    emit({stage:'browser',message:'Recherche avancée du flux vidéo…',force:true});
    const candidates=await browserNetworkCandidates(browserTargets[i]);
    if(!candidates.length){
      emit({stage:'browser',message:'Méthode indisponible · nouvelle tentative…',force:true});
      continue;
    }
    for(const candidate of candidates){
      ensureTime();
      const file=await tryCandidate(candidate);
      if(file)return {file,work};
    }
  }

  if(remainingMs()<=0){
    throw new Error('Le téléchargement a dépassé la limite de temps. Tous les lecteurs lents ont été abandonnés automatiquement.');
  }

  if(lastError){
    const message=String(lastError?.message||lastError);
    if(rejectedMedia>0||/invalid-reader-media/i.test(message)){
      throw new Error('Les lecteurs FRAnime ont répondu, mais les médias reçus étaient indisponibles ou invalides. Les faux épisodes ont été rejetés automatiquement.');
    }
    if(timedOutSources>0){
      throw new Error('Les lecteurs disponibles sont trop lents ou ne répondent plus. Le bot a abandonné les sources bloquées au lieu de rester figé.');
    }
    if(/403|Cloudflare|Forbidden/i.test(message)){
      throw new Error('Tous les lecteurs FRAnime disponibles sont temporairement bloqués ou indisponibles. Réessaie dans quelques instants.');
    }
    if(/Unsupported URL|franime\.fr\/watch2|[?&](?:z|d|e)=/i.test(message)){
      throw new Error('Le lecteur FRAnime a répondu, mais son flux vidéo n’a pas pu être extrait.');
    }
    throw new Error('Le téléchargement de cet épisode a échoué sur tous les lecteurs disponibles.');
  }
  throw new Error('Téléchargement impossible pour cet épisode.');
}


function watcherFilename(message){
  for(const attr of message?.document?.attributes||[]){
    if(attr?.fileName)return String(attr.fileName);
  }
  return '';
}

function watcherSignalText(message){
  return [String(message?.message||''),watcherFilename(message)].filter(Boolean).join('\n');
}

function watcherLooksLikeVideo(message){
  if(!message?.document)return false;
  const mime=String(message.document?.mimeType||'').toLowerCase();
  return mime.startsWith('video/')||WATCHER_VIDEO_EXT_RE.test(watcherFilename(message));
}

function watcherDetectLanguage(raw=''){
  const t=String(raw).replace(/[_-]+/g,' ').toUpperCase();
  if(/\bMULTI(?:[- ]?AUDIO)?\b/.test(t))return 'MULTI';
  if(/\bVOSTFR\b|\bSUB(?:BED)?\s*FR\b/.test(t))return 'VOSTFR';
  if(/\bVF\b|\bFRENCH(?:\s*DUB)?\b|\bDUB\s*FR\b/.test(t))return 'VF';
  if(/\bVOSTA\b|\bENG(?:LISH)?\s*SUB\b/.test(t))return 'EN-SUB';
  if(/\bENG(?:LISH)?\s*DUB\b|\bDUB\s*EN\b/.test(t))return 'EN-DUB';
  if(/\bVO\b|\bRAW\b|\bJAP(?:ANESE)?\b/.test(t))return 'VO';
  return '';
}

function watcherDetectQuality(raw=''){
  return String(raw).replace(/[_-]+/g,' ').match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase()||'';
}

function watcherParseEpisode(raw=''){
  const text=String(raw).replace(/_/g,' ');
  let m=text.match(/\bS(?:eason|aison)?\s*0*(\d{1,2})\s*[-_.•·:|/ ]*E(?:P(?:ISODE)?)?\s*[-_.•·:|/ ]*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:Number(m[1]),episode:Number(m[2])+(m[3]?Number('0.'+m[3]):0)};
  m=text.match(/\b(?:Season|Saison)\s*0*(\d{1,2})\s*(?:Episode|Épisode|Ep)\s*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:Number(m[1]),episode:Number(m[2])+(m[3]?Number('0.'+m[3]):0)};
  m=text.match(/\bE(?:P(?:ISODE)?)?\s*[-_.:# ]*0*(\d{1,4})(?:\.(\d))?\s*[-_.•·:|/ ]*S(?:eason|aison)?\s*0*(\d{1,2})\b/i);
  if(m)return {season:Number(m[3]),episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0)};
  m=text.match(/\b(?:Episode|Épisode|Ep)\s*[-_.:# ]*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:null,episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0)};
  m=text.match(/\bE\s*[-_. ]*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:null,episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0)};
  return null;
}

function watcherTitleNorm(value){
  return normalize(value)
    .replace(/\b\d+(?:st|nd|rd|th)?\s+(?:season|saison)\b/g,' ')
    .replace(/\b(?:season|saison|part|cour)\s*\d+\b/g,' ')
    .replace(/\bs\s*\d+\b/g,' ')
    .replace(/\b(?:episode|ep|e)\s*\d+(?:\s*\d+)?\b/g,' ')
    .replace(/\b(?:vf|vostfr|vo|multi|french|sub|dub)\b/g,' ')
    .replace(/\b(?:2160|1440|1080|720|576|540|480|360)p\b/g,' ')
    .replace(/\s+/g,' ').trim();
}

function watcherTitleScore(candidate,anime){
  const c=watcherTitleNorm(candidate);
  if(!c)return 0;
  let best=0;
  for(const aliasRaw of [...titlesOf(anime),displayTitle(anime)]){
    const a=watcherTitleNorm(aliasRaw);
    if(!a)continue;
    if(c===a)return 1;
    const ct=c.split(' ').filter(Boolean);
    const at=a.split(' ').filter(Boolean);
    if(c.length>=5&&a.length>=5&&(c.includes(a)||a.includes(c))&&Math.min(ct.length,at.length)>=2){
      best=Math.max(best,0.97);
      continue;
    }
    const cs=new Set(ct),as=new Set(at);
    let hit=0;
    for(const token of cs)if(as.has(token))hit++;
    const ratio=hit/Math.max(cs.size,as.size,1);
    best=Math.max(best,ratio);
  }
  return best;
}

function watcherQualityConsistent(targetQuality,rowQuality,signalQuality,meta){
  const wanted=String(targetQuality)+'p';
  const declared=String(signalQuality||rowQuality||'').toLowerCase();
  if(declared&&declared!==wanted)return false;
  const width=Number(meta?.width||0),height=Number(meta?.height||0);
  if(!width&&!height)return Boolean(declared===wanted);
  const q=Number(targetQuality);
  if(q===360)return width<=900&&height<=500;
  if(q===480)return width>=650&&width<=1120&&height>=300&&height<=650;
  if(q===720)return width>=1050||height>=560;
  return declared===wanted;
}

async function watcherEntity(client,source){
  const username=clean(source?.channelUsername).replace(/^@/,'');
  const channelId=clean(source?.channelId);
  if(username){
    try{return await client.getEntity(username)}catch{}
  }
  if(channelId){
    try{return await client.getEntity(BigInt(channelId))}catch{}
  }
  if(channelId){
    try{
      const dialogs=await client.getDialogs({limit:500});
      const match=(Array.isArray(dialogs)?dialogs:[]).find(row=>
        String(row?.entity?.id||row?.id||'')===channelId
      );
      if(match?.entity)return match.entity;
    }catch{}
  }
  return null;
}

async function downloadEpisodeFromTelegramWatchers(anime,lang,s,e,quality,{onProgress=null}={}){
  const wantedSeason=Number(s)+1;
  const wantedEpisode=Number(e)+1;
  const wantedLanguage=lang==='vf'?'VF':'VOSTFR';
  const wantedQuality=String(quality)+'p';
  const emit=payload=>{
    if(typeof onProgress!=='function')return;
    try{Promise.resolve(onProgress(payload)).catch(()=>{})}catch{}
  };

  emit({
    stage:'telegram-fallback',
    message:'Recherche d’une copie alternative de l’épisode…',
    force:true
  });

  const d=await db();

  const tryMessage=async({message,rt,accountUsername,source={},row=null}={})=>{
    if(!message||!watcherLooksLikeVideo(message)||!rt?.client)return null;
    const channelContext=[source?.channelTitle,source?.channelUsername].filter(Boolean).join(' ');
    const signal=[watcherSignalText(message),channelContext].filter(Boolean).join('\n');
    const score=Math.max(
      watcherTitleScore(signal,anime),
      watcherTitleScore(row?.title||row?.seriesKey||'',anime)
    );
    if(score<0.72)return null;

    const ep=watcherParseEpisode(signal);
    const rowEpisode=Number(row?.episode||0);
    const rowSeason=Number(row?.season||0);
    if(ep){
      if(Number(ep.episode)!==wantedEpisode)return null;
      if(ep.season!=null&&Number(ep.season)!==wantedSeason)return null;
    }else if(rowEpisode!==wantedEpisode){
      return null;
    }
    if(ep?.season==null&&row&&rowSeason!==wantedSeason)return null;
    if(ep?.season==null&&!row&& !new RegExp('\\b(?:s|season|saison)\\s*0*'+wantedSeason+'\\b','i').test(signal)){
      return null;
    }

    const signalLanguage=watcherDetectLanguage(signal);
    const rowLanguage=String(row?.language||'').toUpperCase();
    const provenLanguage=signalLanguage||rowLanguage;
    if(provenLanguage!==wantedLanguage)return null;

    const signalQuality=watcherDetectQuality(signal);
    const rowQuality=String(row?.quality||'').toLowerCase();
    const declared=signalQuality||rowQuality;
    if(declared){
      const declaredN=Number(declared.replace(/\D/g,''))||0;
      if(declaredN&&declaredN<Number(quality)*0.72)return null;
    }

    emit({
      stage:'telegram-fallback',
      message:'Épisode correspondant trouvé · téléchargement…',
      force:true
    });

    const work=await fsp.mkdtemp(path.join(TMP_ROOT,'watcher-'));
    let accepted=false;
    try{
      const original=watcherFilename(message);
      const ext=(path.extname(original)||'.mp4').toLowerCase();
      const target=path.join(work,'episode-source'+ext);
      const expectedTotal=Number(message?.document?.size||0);
      let lastProgressAt=0;
      const progressCallback=(current,total)=>{
        const now=Date.now();
        if(now-lastProgressAt<2500)return;
        lastProgressAt=now;
        const downloaded=Number(current||0);
        const full=Number(total||0)||expectedTotal;
        const percent=full>0?downloaded/full*100:0;
        emit({
          stage:'telegram-download',
          message:nxaDownloadProgressText({
            host:'Téléchargement',attempt:1,percent,
            downloaded,total:full,speed:'',eta:''
          })
        });
      };
      const downloaded=await rt.client.downloadMedia(message.media,{
        outputFile:target,workers:4,progressCallback
      });
      let file=typeof downloaded==='string'&&downloaded?downloaded:target;
      let check=await validateEpisodeMedia(file);
      if(!check.ok)return null;

      file=await normalizeWatcherQuality(file,work,quality,check,{onProgress});
      if(!file)return null;
      check=await validateEpisodeMedia(file);
      if(!check.ok)return null;

      const finalHeight=Number(check.height||0);
      if(finalHeight&&finalHeight<Number(quality)*0.72)return null;
      accepted=true;
      emit({
        stage:'ready',
        message:'Épisode vérifié · préparation de l’envoi…',
        force:true
      });
      return {
        file,work,
        source:'telegram-watchers',
        watcherAccount:'@'+accountUsername,
        watcherChannel:String(source?.channelUsername||source?.channelTitle||source?.channelId||''),
        titleScore:score
      };
    }catch(error){
      console.warn('[NexAnime watcher fallback]',accountUsername,String(error?.message||error).slice(0,260));
      return null;
    }finally{
      if(!accepted)await fsp.rm(work,{recursive:true,force:true}).catch(()=>{});
    }
  };

  // 1) Fast path: candidates already indexed by the watcher/ingest system.
  const rows=await d.collection('nexanime_queue').find({
    kind:'episode',
    season:wantedSeason,
    episode:wantedEpisode,
    status:{$nin:['rejected','superseded']},
    sources:{$elemMatch:{accountUsername:{$in:WATCHER_FALLBACK_USERS}}}
  }).sort({confidence:-1,updatedAt:-1,ingestedAt:-1}).limit(80).toArray();

  const candidates=rows
    .map(row=>({row,titleScore:watcherTitleScore(row?.title||row?.seriesKey||'',anime)}))
    .filter(x=>x.titleScore>=0.68)
    .sort((a,b)=>b.titleScore-a.titleScore||Number(b.row?.confidence||0)-Number(a.row?.confidence||0));

  for(const {row} of candidates){
    const sources=(Array.isArray(row?.sources)?row.sources:[])
      .filter(source=>WATCHER_FALLBACK_USERS.includes(String(source?.accountUsername||'').replace(/^@/,'').toLowerCase()));
    for(const source of sources){
      const accountUsername=String(source?.accountUsername||'').replace(/^@/,'').toLowerCase();
      const rt=runtimeConnectionFor(accountUsername);
      if(!rt?.client||rt?.client?.connected!==true)continue;
      const entity=await watcherEntity(rt.client,source);
      if(!entity)continue;
      let message=null;
      try{
        const messages=await rt.client.getMessages(entity,{ids:[Number(source.messageId)]});
        message=Array.isArray(messages)?messages[0]:messages;
      }catch{}
      const result=await tryMessage({message,rt,accountUsername,source,row});
      if(result)return result;
    }
  }

  // 2) Deep path: search the verified anime channels directly. This catches
  // episodes that the watcher parser/indexer missed.
  emit({
    stage:'telegram-search',
    message:'Recherche approfondie de l’épisode…',
    force:true
  });
  const aliases=[displayTitle(anime),...titlesOf(anime)].map(clean).filter(Boolean);
  const searchTerms=[...new Set(aliases)].sort((a,b)=>a.length-b.length).slice(0,4);

  for(const accountUsername of WATCHER_FALLBACK_USERS){
    const rt=runtimeConnectionFor(accountUsername);
    if(!rt?.client||rt?.client?.connected!==true||!rt?.account)continue;
    const accountId=String(rt.account.telegramUserId||'');
    if(!accountId)continue;
    let sourceRows=[];
    try{
      sourceRows=await d.collection('nexanime_sources').find({
        accountId,
        classification:{$in:['anime','mixed','candidate']}
      }).sort({selected:-1,confidence:-1,updatedAt:-1}).limit(120).toArray();
    }catch{}

    const ranked=sourceRows.map(row=>{
      const anchors=Array.isArray(row?.seriesAnchors)?row.seriesAnchors:[];
      const anchorScore=Math.max(0,...anchors.map(a=>Math.max(
        watcherTitleScore(a?.raw||'',anime),watcherTitleScore(a?.canonicalTitle||'',anime)
      )));
      return {row,anchorScore};
    }).sort((a,b)=>b.anchorScore-a.anchorScore||Number(b.row?.selected||0)-Number(a.row?.selected||0)||Number(b.row?.confidence||0)-Number(a.row?.confidence||0));

    const preferred=ranked.filter(x=>x.anchorScore>=0.65);
    const scan=(preferred.length?preferred:ranked.filter(x=>x.row?.selected===true||x.row?.classification==='anime')).slice(0,45);

    for(const {row} of scan){
      const source={
        channelUsername:String(row?.username||''),
        channelTitle:String(row?.title||''),
        channelId:String(row?.channelId||'')
      };
      const entity=await watcherEntity(rt.client,source);
      if(!entity)continue;
      for(const term of searchTerms){
        let messages=[];
        try{messages=await rt.client.getMessages(entity,{limit:80,search:term})}catch{continue}
        for(const message of messages||[]){
          const result=await tryMessage({message,rt,accountUsername,source,row:null});
          if(result)return result;
        }
      }
      await sleep(40);
    }
  }

  throw new Error('Aucun média Telegram exact et vérifié n’a été trouvé après recherche indexée et recherche directe');
}

export async function downloadEpisode(anime,lang,s,e,quality,options={}){
  let franimeError=null;
  try{
    return await downloadEpisodeFromFranime(anime,lang,s,e,quality,options);
  }catch(error){
    franimeError=error;
  }

  try{
    return await downloadEpisodeFromTelegramWatchers(anime,lang,s,e,quality,options);
  }catch(watcherError){
    const a=String(franimeError?.message||franimeError||'échec FRAnime').slice(0,360);
    const b=String(watcherError?.message||watcherError||'échec alternatif').slice(0,360);
    throw new Error('Téléchargement principal: '+a+' · Recherche alternative: '+b);
  }
}

export function uploaderRuntime(){
  for(const name of ['tresor20001','tresor20009','tresor20000','tresor_htn']){
    const rt=runtimeConnectionFor(name);
    if(rt?.client&&rt?.account)return rt;
  }
  return runtimeConnectionFor('');
}

async function uploadForFileId(file,title){
  const rt=uploaderRuntime();
  if(!rt?.client||!rt?.account)throw new Error('Aucun compte Telegram uploader n’est connecté');
  const claim=crypto.randomUUID();
  const marker='#NXA_CACHE:'+claim;
  const expected=String(rt.account.telegramUserId||'');
  const promise=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      pendingUploads.delete(claim);
      reject(new Error('Upload Telegram expiré'));
    },UPLOAD_TIMEOUT_MS);
    pendingUploads.set(claim,{resolve,reject,timer,expected});
  });
  try{
    await rt.client.sendFile('@'+BOT_USERNAME,{
      file,
      caption:marker+'\n'+clean(title).slice(0,700),
      workers:4
    });
  }catch(error){
    const pending=pendingUploads.get(claim);
    if(pending){clearTimeout(pending.timer);pendingUploads.delete(claim)}
    throw error;
  }
  return promise;
}

async function produceEpisode(anime,lang,s,e,quality){
  const key=cacheKey(anime.id,lang,s,e,quality);
  const cached=await cacheGet(key);
  if(cached?.fileId)return cached;
  if(inflight.has(key))return inflight.get(key);

  const task=(async()=>{
    while(activeDownloads>=MAX_DOWNLOADS)await sleep(900);
    activeDownloads++;
    let work='';
    try{
      const dl=await downloadEpisode(anime,lang,s,e,quality);
      work=dl.work;
      const stat=await fsp.stat(dl.file);
      const uploaded=await uploadForFileId(dl.file,displayTitle(anime)+' · S'+(s+1)+'E'+(e+1));
      const value={...uploaded,title:displayTitle(anime),size:stat.size};
      await cachePut(key,value);
      return value;
    }finally{
      activeDownloads=Math.max(0,activeDownloads-1);
      inflight.delete(key);
      if(work)await fsp.rm(work,{recursive:true,force:true}).catch(()=>{});
    }
  })();
  inflight.set(key,task);
  return task;
}

async function sendCached(chatId,item,caption){
  if(item.kind==='video'){
    try{return await bot.api.sendVideo(chatId,item.fileId,{caption,supports_streaming:true})}catch{}
  }
  return bot.api.sendDocument(chatId,item.fileId,{caption});
}

async function onUploadMessage(ctx){
  const caption=clean(ctx.message?.caption);
  const m=caption.match(/^#NXA_CACHE:([0-9a-f-]{20,})/i);
  if(!m)return false;
  const claim=m[1],pending=pendingUploads.get(claim);
  if(!pending)return true;
  if(pending.expected&&String(ctx.from?.id||'')!==pending.expected)return true;
  const video=ctx.message?.video;
  const doc=ctx.message?.document;
  const fileId=clean(video?.file_id||doc?.file_id);
  if(!fileId)return true;
  clearTimeout(pending.timer);
  pendingUploads.delete(claim);
  pending.resolve({fileId,kind:video?'video':'document'});
  await ctx.deleteMessage().catch(()=>{});
  return true;
}

function setupHandlers(target){
  target.command('start',async ctx=>{
    await ctx.reply(
      '🎬 <b>NexAnime</b>\n\nEnvoie simplement le nom d’un anime. Je chercherai sur FRAnime et je te proposerai les titres les plus proches.\n\nExemple : <code>Blue Lock</code>',
      {parse_mode:'HTML'}
    );
  });
  target.command('search',async ctx=>{
    const q=clean(ctx.match);
    if(!q)return ctx.reply('Utilise : /search nom de l’anime');
    try{await sendSearchResults(ctx,q)}catch(e){await ctx.reply('Recherche indisponible : '+String(e?.message||e).slice(0,250))}
  });
  target.on(['message:video','message:document'],onUploadMessage);
  target.on('message:text',async ctx=>{
    if(clean(ctx.message.text).startsWith('/'))return;
    try{await sendSearchResults(ctx,ctx.message.text)}catch(e){await ctx.reply('Recherche indisponible : '+String(e?.message||e).slice(0,250))}
  });

  target.callbackQuery('noop',ctx=>ctx.answerCallbackQuery());
  target.callbackQuery('r:search',async ctx=>{
    await ctx.answerCallbackQuery();
    await ctx.editMessageCaption?.({caption:'Envoie le nom de l’anime que tu recherches.'}).catch(()=>{});
    await ctx.editMessageText?.('Envoie le nom de l’anime que tu recherches.').catch(()=>{});
  });
  target.callbackQuery(/^a:(\d+)$/,async ctx=>{
    await ctx.answerCallbackQuery();
    const anime=await animeById(ctx.match[1]);
    if(!anime)return ctx.reply('Anime introuvable.');
    const text='<b>'+esc(displayTitle(anime))+'</b>\n'+seasonCount(anime)+' saison(s) disponible(s).\n\nChoisis la langue :';
    await ctx.editMessageCaption?.({caption:text,parse_mode:'HTML',reply_markup:languageKeyboard(anime.id)}).catch(()=>{});
    await ctx.editMessageText?.(text,{parse_mode:'HTML',reply_markup:languageKeyboard(anime.id)}).catch(()=>{});
  });
  target.callbackQuery(/^l:(\d+):(vf|vo)$/,async ctx=>{
    await ctx.answerCallbackQuery();
    const [,id,lang]=ctx.match;
    const anime=await animeById(id);
    if(!anime)return ctx.reply('Anime introuvable.');
    const text='<b>'+esc(displayTitle(anime))+'</b> · '+(lang==='vf'?'VF':'VOSTFR')+'\nChoisis une saison :';
    await ctx.editMessageCaption?.({caption:text,parse_mode:'HTML',reply_markup:seasonsKeyboard(anime,lang)}).catch(()=>{});
    await ctx.editMessageText?.(text,{parse_mode:'HTML',reply_markup:seasonsKeyboard(anime,lang)}).catch(()=>{});
  });
  target.callbackQuery(/^s:(\d+):(vf|vo):(\d+)$/,async ctx=>{
    await ctx.answerCallbackQuery();
    const [,id,lang,s0]=ctx.match,s=Number(s0);
    const anime=await animeById(id);
    if(!anime)return ctx.reply('Anime introuvable.');
    const text='<b>'+esc(displayTitle(anime))+'</b> · S'+(s+1)+' · '+(lang==='vf'?'VF':'VOSTFR')+'\nChoisis un épisode :';
    const kb=episodesKeyboard(anime,lang,s,0);
    await ctx.editMessageCaption?.({caption:text,parse_mode:'HTML',reply_markup:kb}).catch(()=>{});
    await ctx.editMessageText?.(text,{parse_mode:'HTML',reply_markup:kb}).catch(()=>{});
  });
  target.callbackQuery(/^p:(\d+):(vf|vo):(\d+):(\d+)$/,async ctx=>{
    await ctx.answerCallbackQuery();
    const [,id,lang,s0,p0]=ctx.match,s=Number(s0),p=Number(p0);
    const anime=await animeById(id);
    if(!anime)return;
    const kb=episodesKeyboard(anime,lang,s,p);
    await ctx.editMessageReplyMarkup({reply_markup:kb}).catch(()=>{});
  });
  target.callbackQuery(/^e:(\d+):(vf|vo):(\d+):(\d+)$/,async ctx=>{
    await ctx.answerCallbackQuery();
    const [,id,lang,s0,e0]=ctx.match,s=Number(s0),e=Number(e0);
    const anime=await animeById(id);
    if(!anime)return ctx.reply('Anime introuvable.');
    const text='<b>'+esc(displayTitle(anime))+'</b> · S'+(s+1)+'E'+(e+1)+'\nChoisis la qualité :';
    const kb=qualityKeyboard(id,lang,s,e);
    await ctx.editMessageCaption?.({caption:text,parse_mode:'HTML',reply_markup:kb}).catch(()=>{});
    await ctx.editMessageText?.(text,{parse_mode:'HTML',reply_markup:kb}).catch(()=>{});
  });
  target.callbackQuery(/^q:(\d+):(vf|vo):(\d+):(\d+):(360|480|720)$/,async ctx=>{
    await ctx.answerCallbackQuery({text:'Préparation de l’épisode…'});
    const [,id,lang,s0,e0,q]=ctx.match,s=Number(s0),e=Number(e0);
    const anime=await animeById(id);
    if(!anime)return ctx.reply('Anime introuvable.');
    const caption=displayTitle(anime)+' · S'+(s+1)+'E'+(e+1)+' · '+(lang==='vf'?'VF':'VOSTFR')+' · '+q+'p';
    const status=await ctx.reply('⏳ '+caption+'\nRecherche de la meilleure source…');
    try{
      const item=await produceEpisode(anime,lang,s,e,Number(q));
      await sendCached(ctx.chat.id,item,caption);
      await bot.api.deleteMessage(ctx.chat.id,status.message_id).catch(()=>{});
    }catch(error){
      await bot.api.editMessageText(ctx.chat.id,status.message_id,'❌ Impossible de récupérer cet épisode pour le moment.\n'+String(error?.message||error).slice(0,350)).catch(()=>{});
    }
  });
}

async function pollingLoop(){
  while(polling&&bot){
    try{
      await bot.start({drop_pending_updates:false});
    }catch(error){
      if(!polling)break;
      console.error('[NexAnime bot poller]',String(error?.description||error?.message||error).slice(0,500));
      await sleep(3500);
    }
  }
}

export async function startNexAnimeBot(){
  if(polling&&bot)return nexAnimeBotStatus();
  const token=await loadNexAnimeBotToken();
  if(!token){
    console.warn('[NexAnime bot] token not configured');
    return {ok:false,configured:false,running:false,username:BOT_USERNAME};
  }
  await fsp.mkdir(TMP_ROOT,{recursive:true}).catch(()=>{});
  bot=new Bot(token);
  setupHandlers(bot);
  polling=true;
  pollLoopPromise=pollingLoop();
  console.log('[NexAnime bot] @'+BOT_USERNAME+' polling enabled');
  return {ok:true,configured:true,running:true,username:BOT_USERNAME};
}

export async function stopNexAnimeBot(){
  polling=false;
  try{await bot?.stop()}catch{}
  bot=null;
  pollLoopPromise=null;
  for(const pending of pendingUploads.values()){
    clearTimeout(pending.timer);
    pending.reject?.(new Error('NexAnime bot stopped'));
  }
  pendingUploads.clear();
}

export function nexAnimeBotStatus(){
  return {
    ok:true,
    configured:Boolean(bot),
    running:Boolean(polling&&bot),
    username:BOT_USERNAME,
    activeDownloads,
    queuedOrInflight:inflight.size,
    pendingUploads:pendingUploads.size
  };
}
