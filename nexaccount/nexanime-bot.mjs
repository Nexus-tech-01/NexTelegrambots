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
const USER_AGENT='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

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

async function fetchJson(url){
  const r=await fetch(url,{headers:{'user-agent':USER_AGENT,'referer':SITE+'/'},signal:AbortSignal.timeout(25000)});
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

function cacheKey(id,lang,s,e,q){return [id,lang,s,e,q].join(':')}

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

async function run(cmd,args,{timeout=15*60_000,cwd=undefined}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});
    let out='',err='',done=false;
    const kill=setTimeout(()=>{if(!done){child.kill('SIGKILL');reject(new Error('timeout '+cmd))}},timeout);
    child.stdout.on('data',d=>{out+=String(d);if(out.length>2_000_000)out=out.slice(-2_000_000)});
    child.stderr.on('data',d=>{err+=String(d);if(err.length>2_000_000)err=err.slice(-2_000_000)});
    child.once('error',e=>{done=true;clearTimeout(kill);reject(e)});
    child.once('close',code=>{
      if(done)return;done=true;clearTimeout(kill);
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

function viewerUrlScore(url){
  const u=String(url||'');
  let score=0;
  if(/\.(?:m3u8|mp4|mkv|webm)(?:$|[?#])/i.test(u))score+=20;
  if(/sibnet|sendvid|vidmoly|filemoon|smoothpre|vkvideo|(?:^|\.)vk\.com|dailymotion|youtube|yourupload|ok\.ru|playtube|mail\.ru|tomacloud|embed4me|dingtezuni|callistanise|minochinos/i.test(u))score+=10;
  if(/\/(?:embed|player|video|shell\.php)(?:[/?#]|$)/i.test(u))score+=4;
  if(/franime\.fr\/watch2/i.test(u))score-=30;
  if(/\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?)(?:$|[?#])/i.test(u))score-=20;
  return score;
}

function isFranimeWrapper(url){
  try{
    const u=new URL(url);
    return /(^|\.)franime\.fr$/i.test(u.hostname)&&/\/watch2\b/i.test(u.pathname);
  }catch{return false}
}

async function resolveFranimeWrapper(url){
  const r=await fetch(url,{
    redirect:'follow',
    headers:{
      'user-agent':USER_AGENT,
      'referer':SITE+'/',
      'accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    },
    signal:AbortSignal.timeout(25000)
  });
  if(!r.ok)throw new Error('Lecteur protégé HTTP '+r.status);
  const text=await r.text();
  const base=r.url||url;
  const found=collectUrls(text,new Set(),base);
  if(base&&base!==url)found.add(base);
  return [...found].filter(x=>/^https?:\/\//i.test(x)&&x!==url);
}

async function viewerCandidates(animeId,s,e,lang){
  const urls=new Set();
  const failures=[];
  for(let reader=0;reader<6;reader++){
    const endpoint=API+'/api/anime/'+encodeURIComponent(animeId)+'/'+s+'/'+e+'/'+encodeURIComponent(lang)+'/'+reader;
    try{
      const r=await fetch(endpoint,{headers:{'user-agent':USER_AGENT,'referer':SITE+'/'},signal:AbortSignal.timeout(25000)});
      if(!r.ok){failures.push(reader+':HTTP '+r.status);continue}
      const text=(await r.text()).trim();
      if(!text)continue;
      try{collectUrls(JSON.parse(text),urls)}catch{collectUrls(text,urls)}
      if(/^https?:\/\//i.test(text))urls.add(text);
    }catch(error){
      failures.push(reader+':'+String(error?.message||error).slice(0,120));
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

  if(!ranked.length){
    if([...urls].some(isFranimeWrapper)){
      throw new Error('Le lecteur FRAnime a été trouvé, mais sa source vidéo n’a pas pu être résolue. Essaie un autre lecteur ou réessaie dans quelques instants.');
    }
    if(failures.length)throw new Error('Aucun lecteur FRAnime disponible');
  }
  return [...new Set(ranked)];
}

export async function downloadEpisode(anime,lang,s,e,quality){
  await fsp.mkdir(TMP_ROOT,{recursive:true});
  const work=await fsp.mkdtemp(path.join(TMP_ROOT,'job-'));
  const outTpl=path.join(work,'episode.%(ext)s');
  const ytdlp=await ensureYtDlp();
  const urls=await viewerCandidates(anime.id,s,e,lang);
  if(!urls.length)throw new Error('Aucune source vidéo trouvée pour cet épisode');
  const fmt='bv*[height<='+quality+']+ba/b[height<='+quality+']/best[height<='+quality+']/best';
  let lastError=null;
  for(const url of urls.slice(0,10)){
    try{
      const r=await run(ytdlp,[
        '--no-playlist','--no-warnings','--retries','4','--fragment-retries','4',
        '--extractor-args','generic:impersonate',
        '--user-agent',USER_AGENT,'--referer',SITE+'/',
        '-f',fmt,'--merge-output-format','mp4','--print','after_move:filepath',
        '-o',outTpl,url
      ],{timeout:25*60_000,cwd:work});
      const file=String(r.stdout||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).at(-1);
      if(file&&fs.existsSync(file))return {file,work};
      const found=(await fsp.readdir(work)).map(x=>path.join(work,x)).find(x=>fs.statSync(x).isFile());
      if(found)return {file:found,work};
    }catch(error){lastError=error}
  }
  if(lastError){
    const message=String(lastError?.message||lastError);
    if(/403|Cloudflare|Forbidden/i.test(message)){
      throw new Error('Tous les lecteurs FRAnime disponibles sont temporairement bloqués ou indisponibles. Réessaie dans quelques instants.');
    }
    if(/Unsupported URL|franime\.fr\/watch2|[?&](?:z|d|e)=/i.test(message)){
      throw new Error('Le lecteur FRAnime a répondu, mais le lien vidéo protégé n’a pas pu être résolu. Le bot va utiliser un autre lecteur quand il est disponible.');
    }
    throw new Error('Le téléchargement de cet épisode a échoué sur tous les lecteurs disponibles.');
  }
  throw new Error('Téléchargement impossible pour cet épisode.');
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
