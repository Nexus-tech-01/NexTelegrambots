import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './store.mjs';

const ENABLED=String(process.env.NEXANIME_ENABLED||'true').toLowerCase()!=='false';
const LISTENERS=new Set(
  String(process.env.NEXANIME_LISTENER_USERNAMES||'tresor20001,tresor20009')
    .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean)
);
const DESTINATION=String(process.env.NEXANIME_DESTINATION||'theotaku_nexus').trim().replace(/^@/,'');
const DISCOVERY_MS=Math.max(15*60*1000,Number(process.env.NEXANIME_DISCOVERY_MS||6*60*60*1000));
const PUBLISH_MS=Math.max(5000,Number(process.env.NEXANIME_PUBLISH_MS||15000));
const POLL_MS=Math.max(30000,Number(process.env.NEXANIME_POLL_MS||60000));
const SOURCE_SAMPLE_LIMIT=Math.min(80,Math.max(12,Number(process.env.NEXANIME_SOURCE_SAMPLE_LIMIT||40)));
const DIALOG_LIMIT=Math.min(250,Math.max(20,Number(process.env.NEXANIME_DIALOG_LIMIT||120)));
const BACKFILL_LIMIT=Math.min(3000,Math.max(50,Number(process.env.NEXANIME_BACKFILL_LIMIT||900)));
const ACTIVE_SAMPLE_LIMIT=Math.min(120,Math.max(20,Number(process.env.NEXANIME_ACTIVE_SAMPLE_LIMIT||80)));
const MAX_ACTIVE_SERIES=Math.min(20,Math.max(1,Number(process.env.NEXANIME_MAX_ACTIVE_SERIES||8)));
const MEDIA_POLICY=String(process.env.NEXANIME_MEDIA_POLICY||'authorized_only').toLowerCase();
const MEDIA_REUPLOAD=MEDIA_POLICY==='authorized' || MEDIA_POLICY==='allow' || MEDIA_POLICY==='allowed';
const TMP_ROOT=process.env.NEXANIME_TMP_DIR||path.join(os.tmpdir(),'nexanime');
const SOURCE_CACHE=new Map();
const SERIES_CACHE=new Map();
let ANI_CHAIN=Promise.resolve();
let ANI_LAST_AT=0;
let indexesReady=false;

const BLOCK_RE=[
  /\b(?:porn|porno|pornographie|xxx|nsfw|nudes?|naked|onlyfans|sex(?:e|ual)?|hentai|18\+|🔞)\b/i,
  /\b(?:1xbet|melbet|betwinner|betting|pari(?:s)? sportif|prono(?:s|stic|stics)?|pronostic(?:s)?|casino|aviator|stake\.com|jackpot)\b/i,
  /\b(?:forex|crypto(?:currency)?|bitcoin|binance|investment|investissement|trading signal|pump signal)\b/i,
  /\b(?:adult(?:e)?|rencontre(?:s)? chaude|escort|camgirl|sextape)\b/i
];
const PROMO_RE=[
  /\b(?:rejoins?|rejoignez|join|subscribe|abonne(?:z)?|abonnement|follow|suis[- ]nous|partage|share|boost)\b/i,
  /\b(?:notre canal|our channel|our group|notre groupe|contact admin|dm admin|promotion|publicit[ée]|sponsor)\b/i
];
const NON_EPISODE_RE=/\b(?:trailer|teaser|opening|ending|ost|amv|clip|preview|pv\b|scan(?:s)?|manga|manhwa|manhua|news|actualit[ée]|annonce|announcement|birthday|cosplay|wallpaper)\b/i;
const PRESENTATION_RE=/\b(?:synopsis|genre(?:s)?|studio|type\s*:|status|statut|episodes?\s*:|titre alternatif|alternative title|diffusion|aired|premiere)\b/i;
const VIDEO_EXT_RE=/\.(?:mp4|mkv|avi|mov|webm|m4v|ts)$/i;
const SOURCE_BLOCK_RE=/\b(?:hentai\w*|porn\w*|adult\w*|nsfw\w*|xxx\w*|prono\w*|bet(?:ting)?\w*|casino\w*|1xbet\w*|melbet\w*|stake\w*)\b/i;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeDecode=value=>{
  const s=String(value||'');
  try{return decodeURIComponent(s)}catch{return s.replace(/%20/gi,' ')}
};
const norm=s=>safeDecode(s)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/['’]/g,' ')
  .replace(/[^a-z0-9]+/g,' ').trim();
const clip=(s,n=1000)=>String(s||'').length>n?String(s).slice(0,n-1)+'…':String(s||'');
const pad=n=>String(Math.max(0,Number(n)||0)).padStart(2,'0');

function filename(message){
  for(const a of message?.document?.attributes||[]){
    if(a?.fileName)return String(a.fileName);
  }
  return '';
}
function mime(message){return String(message?.document?.mimeType||'').toLowerCase()}
function mediaKind(message){
  if(message?.photo)return 'photo';
  if(message?.document){
    const m=mime(message),f=filename(message);
    if(m.startsWith('video/')||VIDEO_EXT_RE.test(f))return 'video';
    return 'document';
  }
  return 'text';
}
function sourcePeerId(message){
  return String(message?.peerId?.channelId||'');
}
function hasBlocked(text=''){return BLOCK_RE.some(re=>re.test(String(text)))}
function looksPromotional(text=''){return PROMO_RE.some(re=>re.test(String(text)))}
function signalText(message){return [String(message?.message||''),filename(message)].filter(Boolean).join('\n')}

function parseEpisode(raw=''){
  const text=String(raw).replace(/_/g,' ');
  let m=text.match(/\bS(?:eason|aison)?\s*0*(\d{1,2})\s*[-_. ]*E(?:P(?:ISODE)?)?\s*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:Number(m[1]),episode:Number(m[2])+(m[3]?Number('0.'+m[3]):0),token:m[0]};
  m=text.match(/\b(?:Season|Saison)\s*0*(\d{1,2})\s*(?:Episode|Épisode|Ep)\s*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:Number(m[1]),episode:Number(m[2])+(m[3]?Number('0.'+m[3]):0),token:m[0]};
  m=text.match(/\b(?:Episode|Épisode|Ep)\s*[-_.:# ]*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:null,episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0),token:m[0]};
  m=text.match(/\bE\s*[-_. ]*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:null,episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0),token:m[0]};
  return null;
}
function detectLanguage(raw=''){
  const t=String(raw).replace(/[_-]+/g,' ').toUpperCase();
  if(/\bMULTI(?:[- ]?AUDIO)?\b/.test(t))return 'MULTI';
  if(/\bVOSTFR\b|\bSUB(?:BED)?\s*FR\b/.test(t))return 'VOSTFR';
  if(/\bVF\b|\bFRENCH(?:\s*DUB)?\b|\bDUB\s*FR\b/.test(t))return 'VF';
  if(/\bVOSTA\b|\bENG(?:LISH)?\s*SUB\b/.test(t))return 'EN-SUB';
  if(/\bENG(?:LISH)?\s*DUB\b|\bDUB\s*EN\b/.test(t))return 'EN-DUB';
  if(/\bVO\b|\bRAW\b|\bJAP(?:ANESE)?\b/.test(t))return 'VO';
  return '';
}
function detectQuality(raw=''){
  return String(raw).replace(/[_-]+/g,' ').match(/\b(2160p|1440p|1080p|720p|576p|540p|480p|360p)\b/i)?.[1]?.toLowerCase()||'';
}
function stripNoiseTitle(raw='',episodeToken=''){
  let s=safeDecode(String(raw||'').split(/\r?\n/).find(x=>x.trim())||String(raw||''));
  s=s.replace(/\.(?:mp4|mkv|avi|mov|webm|m4v|ts)$/i,'');
  s=s.replace(/_/g,' ');
  s=s.replace(/https?:\/\/\S+/gi,' ');
  s=s.replace(/(?:https?:\/\/)?t\.me\/\S+/gi,' ');
  s=s.replace(/@[A-Za-z0-9_]+/g,' ');
  s=s.replace(/\[[^\]]{0,80}\]/g,' ');
  if(episodeToken)s=s.replace(episodeToken,' ');
  s=s.replace(/\b(?:season|saison)\s*\d{1,2}\b/ig,' ');
  s=s.replace(/\bS\d{1,2}E\d{1,4}(?:\.\d)?\b/ig,' ');
  s=s.replace(/\bS\d{1,2}\b/ig,' ');
  s=s.replace(/\b(?:episode|épisode|ep|e)\s*[-_.:# ]*\d{1,4}(?:\.\d)?\b/ig,' ');
  s=s.replace(/\b(?:VF|VOSTFR|VO|MULTI|RAW|FRENCH(?: DUB)?|ENGLISH(?: DUB| SUB)?)\b/ig,' ');
  s=s.replace(/\b(?:2160p|1440p|1080p|720p|576p|540p|480p|360p|x264|x265|h\.?264|h\.?265|hevc|aac|webrip|web[- ]?dl|bluray|bdrip)\b/ig,' ');
  s=s.replace(/[_+.]+/g,' ').replace(/[–—-]{2,}/g,' ');
  s=s.replace(/\s+/g,' ').trim().replace(/^[\W_]+|[\W_]+$/g,'');
  return s.slice(0,140);
}
function titleFromMessage(message,ep){
  const f=filename(message);
  const candidates=[f,String(message?.message||'')].filter(Boolean);
  for(const raw of candidates){
    const t=stripNoiseTitle(raw,ep?.token||'');
    if(t.length>=2 && !/^(episode|ep|e|vf|vostfr|vo)$/i.test(t))return t;
  }
  return '';
}
function cleanCaption(text='',source={}){
  const sourceUser=String(source.username||'').replace(/^@/,'').toLowerCase();
  const sourceTitle=norm(source.title||'');
  const lines=String(text||'').split(/\r?\n/);
  const kept=[];
  for(const raw of lines){
    let line=raw.trim();
    if(!line){if(kept.at(-1)!=='')kept.push('');continue}
    const low=line.toLowerCase();
    if(/(?:https?:\/\/)?t\.me\//i.test(line))continue;
    if(/@[A-Za-z0-9_]+/.test(line))continue;
    if(sourceUser && low.includes('@'+sourceUser))continue;
    if(sourceTitle && sourceTitle.length>4 && norm(line).includes(sourceTitle) && looksPromotional(line))continue;
    if(looksPromotional(line))continue;
    if(hasBlocked(line))continue;
    line=line.replace(/https?:\/\/\S+/gi,'').replace(/\s{2,}/g,' ').trim();
    if(line)kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
function safeFilename(title,season,episode,language,quality,original=''){
  const ext=(String(original).match(/\.[A-Za-z0-9]{2,5}$/)?.[0]||'.mkv').toLowerCase();
  const safeTitle=String(title||'Anime')
    .replace(/@[A-Za-z0-9_]+/g,' ')
    .replace(/[\\/:*?"<>|]/g,' ')
    .replace(/\s+/g,' ').trim().slice(0,90)||'Anime';
  const s=season!=null?' - S'+pad(season):'';
  const e=episode!=null?'E'+(Number.isInteger(episode)?pad(episode):String(episode)):'';
  const lang=language?' - '+language:'';
  const q=quality?' - '+quality:'';
  return (safeTitle+s+e+lang+q+ext).replace(/\s{2,}/g,' ');
}
function titleSimilarity(a,b){
  const aa=new Set(norm(a).split(' ').filter(x=>x.length>1));
  const bb=new Set(norm(b).split(' ').filter(x=>x.length>1));
  if(!aa.size||!bb.size)return 0;
  let hit=0; for(const x of aa)if(bb.has(x))hit++;
  return hit/Math.max(aa.size,bb.size);
}

const GENERIC_SOURCE_WORDS=new Set([
  'anime','animes','manga','mangas','hebdo','hebdos','zone','officiel','official',
  'team','channel','canal','club','films','film','movies','movie','vf','vostfr','vo',
  'french','fr','hd','full','stream','streaming','otaku','new','nouveau','nouveaux'
]);

function cleanSeriesTitle(raw=''){
  let s=stripNoiseTitle(safeDecode(raw),'');
  s=s.replace(/\b(?:S\d{1,2}E\d{1,4}|S\d{1,2}|season\s*\d+|saison\s*\d+)\b/ig,' ');
  s=s.replace(/\b(?:cr|aac2?|web[- ]?dl|webrip|bluray|bdrip|x26[45]|hevc|av1|multi|raw)\b/ig,' ');
  s=s.replace(/\b[a-f0-9]{8,}\b/ig,' ');
  s=s.replace(/\b(?:part|cour)\s*\d+\b/ig,' ');
  return s.replace(/\s+/g,' ').replace(/^[\W_]+|[\W_]+$/g,'').trim().slice(0,150);
}
function sourceTitleCandidate(source={}){
  const s=cleanSeriesTitle(source.title||source.username||'');
  if(!s)return '';
  const meaningful=norm(s).split(' ').filter(x=>x.length>1&&!GENERIC_SOURCE_WORDS.has(x));
  if(meaningful.length<1)return '';
  if(meaningful.length===1 && meaningful[0].length<5)return '';
  return s;
}
function prefixTokens(a,b){
  const aa=String(a||'').split(/\s+/).filter(Boolean);
  const bb=String(b||'').split(/\s+/).filter(Boolean);
  const out=[];
  for(let i=0;i<Math.min(aa.length,bb.length);i++){
    if(norm(aa[i])!==norm(bb[i]))break;
    out.push(aa[i]);
  }
  return out;
}
function commonPrefixTitle(items=[]){
  if(!items.length)return '';
  let tokens=String(items[0]||'').split(/\s+/).filter(Boolean);
  for(const item of items.slice(1)){
    const other=String(item||'').split(/\s+/).filter(Boolean);
    let i=0;
    while(i<Math.min(tokens.length,other.length)&&norm(tokens[i])===norm(other[i]))i++;
    tokens=tokens.slice(0,i);
    if(tokens.length<2)break;
  }
  return cleanSeriesTitle(tokens.join(' '));
}
function deriveRawAnchors(messages=[],source={}){
  const sourceCandidate=sourceTitleCandidate(source);
  const candidates=[];
  for(const message of messages){
    const c=classifyMessage(message,source);
    if(c.kind!=='episode')continue;
    const title=cleanSeriesTitle(c.title);
    if(title)candidates.push(title);
  }
  const clusters=[];
  for(const title of candidates){
    let base=title;
    if(sourceCandidate){
      const sim=titleSimilarity(sourceCandidate,title);
      const a=norm(sourceCandidate),b=norm(title);
      if(sim>=0.32||b.includes(a)||a.includes(b))base=sourceCandidate;
    }
    let cluster=clusters.find(g=>{
      const sim=titleSimilarity(g.seed,base);
      return sim>=0.46||prefixTokens(g.seed,base).length>=2;
    });
    if(!cluster){cluster={seed:base,titles:[]};clusters.push(cluster)}
    cluster.titles.push(base);
  }
  const anchors=[];
  for(const cluster of clusters){
    const pref=commonPrefixTitle(cluster.titles);
    const raw=cleanSeriesTitle(pref.split(/\s+/).length>=2?pref:cluster.seed);
    if(!raw)continue;
    if(!anchors.some(x=>titleSimilarity(x,raw)>=0.82))anchors.push(raw);
    if(anchors.length>=MAX_ACTIVE_SERIES)break;
  }
  return anchors;
}
async function anilistRequest(payload){
  const run=ANI_CHAIN.then(async()=>{
    const wait=Math.max(0,850-(Date.now()-ANI_LAST_AT));
    if(wait)await sleep(wait);
    ANI_LAST_AT=Date.now();
    const response=await fetch('https://graphql.anilist.co',{
      method:'POST',
      headers:{'content-type':'application/json','accept':'application/json','user-agent':'NexAnime/1.0'},
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(12000)
    });
    if(response.status===404)return {data:{Media:null}};
    if(!response.ok)throw new Error('AniList HTTP '+response.status);
    return response.json();
  });
  ANI_CHAIN=run.catch(()=>{});
  return run;
}

function animeAliasScore(query,aliases=[]){
  const q=norm(query);
  let best=0;
  for(const alias of aliases){
    const a=norm(alias);
    if(!a)continue;
    if(q===a)return 1;
    if(q.length>=5&&a.length>=5&&(q.includes(a)||a.includes(q)))best=Math.max(best,0.9);
    best=Math.max(best,titleSimilarity(q,a));
  }
  return best;
}
async function verifyAnimeTitle(query){
  const cleaned=cleanSeriesTitle(query);
  const key=norm(cleaned);
  if(!key)return {ok:false,temporary:false,query:cleaned};
  const mem=SERIES_CACHE.get(key);
  if(mem&&mem.expires>Date.now())return mem.value;
  await ensureIndexes();
  const d=await db();
  const stored=await d.collection('nexanime_series_cache').findOne({key});
  const ttl=stored?.ok?30*86400_000:7*86400_000;
  if(stored?.checkedAt&&Date.now()-new Date(stored.checkedAt).getTime()<ttl){
    const value={...stored,_id:undefined};
    SERIES_CACHE.set(key,{value,expires:Date.now()+6*3600_000});
    return value;
  }
  const gql='query($search:String){Media(search:$search,type:ANIME,isAdult:false){id isAdult format seasonYear title{romaji english native} synonyms}}';
  let result;
  try{
    const body=await anilistRequest({query:gql,variables:{search:cleaned}});
    const media=body?.data?.Media;
    if(!media){
      result={key,query:cleaned,ok:false,temporary:false,checkedAt:new Date()};
    }else{
      const aliases=[
        media.title?.english,media.title?.romaji,media.title?.native,...(media.synonyms||[])
      ].filter(Boolean);
      const score=animeAliasScore(cleaned,aliases);
      const ok=media.isAdult!==true&&score>=0.43;
      result={
        key,query:cleaned,ok,temporary:false,score:Number(score.toFixed(3)),
        canonicalTitle:ok?(media.title?.english||media.title?.romaji||cleaned):'',
        anilistId:ok?Number(media.id):null,aliases:ok?aliases.slice(0,12):[],
        checkedAt:new Date()
      };
    }
    await d.collection('nexanime_series_cache').updateOne({key},{$set:result},{upsert:true});
  }catch(error){
    result={key,query:cleaned,ok:false,temporary:true,error:String(error?.message||error).slice(0,200),checkedAt:new Date()};
  }
  SERIES_CACHE.set(key,{value:result,expires:Date.now()+(result.temporary?10*60_000:6*3600_000)});
  return result;
}
function bestAnchor(title,anchors=[]){
  const q=cleanSeriesTitle(title);
  let best=null,bestScore=0;
  for(const a of anchors){
    const raw=a.raw||a.canonicalTitle||'';
    const score=Math.max(titleSimilarity(q,raw),titleSimilarity(q,a.canonicalTitle||''));
    const qn=norm(q),rn=norm(raw);
    const adjusted=(qn.length>=5&&rn.length>=5&&(qn.includes(rn)||rn.includes(qn)))?Math.max(score,0.9):score;
    if(adjusted>bestScore){bestScore=adjusted;best=a}
  }
  return bestScore>=0.38?best:null;
}
async function verifiedSeriesAnchors(messages,source={}){
  const raw=deriveRawAnchors(messages,source);
  const out=[];
  for(const title of raw){
    const v=await verifyAnimeTitle(title);
    if(v.ok)out.push({raw:title,canonicalTitle:v.canonicalTitle,anilistId:v.anilistId,score:v.score});
    await sleep(180);
  }
  return out;
}
async function canonicalizeCandidate(c,source={}){
  if(!c||!['episode','presentation'].includes(c.kind))return c;
  const anchors=Array.isArray(source.seriesAnchors)?source.seriesAnchors:[];
  let anchor=bestAnchor(c.title,anchors);
  if(!anchor){
    const sourceCandidate=sourceTitleCandidate(source);
    let q=cleanSeriesTitle(c.title);
    if(sourceCandidate){
      const sim=titleSimilarity(q,sourceCandidate),qn=norm(q),sn=norm(sourceCandidate);
      if(sim>=0.32||qn.includes(sn)||sn.includes(qn))q=sourceCandidate;
    }
    const v=await verifyAnimeTitle(q);
    if(!v.ok)return {...c,verifiedAnime:false,verificationTemporary:v.temporary===true};
    anchor={raw:q,canonicalTitle:v.canonicalTitle,anilistId:v.anilistId,score:v.score};
  }
  return {...c,title:anchor.canonicalTitle,anilistId:anchor.anilistId,verifiedAnime:true};
}

function releaseKey(c){
  const title=norm(c.title);
  return [title,'s'+(c.season??1),'e'+c.episode,(c.language||'UNK').toUpperCase()].join('|');
}
function presentationKey(c){return [norm(c.title),'presentation'].join('|')}
function standardizedCaption(c){
  if(c.kind==='presentation'){
    return clip([c.title,c.cleanedCaption].filter(Boolean).join('\n\n'),1024);
  }
  return clip([
    c.title,
    'Season '+(c.season??1)+' · Episode '+c.episode,
    [c.language,c.quality].filter(Boolean).join(' · '),
    '@'+DESTINATION
  ].filter(Boolean).join('\n'),1024);
}
function classifyMessage(message,source={}){
  const raw=signalText(message);
  const text=String(message?.message||'');
  const blocked=hasBlocked(raw);
  if(blocked)return {kind:'blocked',reason:'adult_betting_or_spam'};
  const ep=parseEpisode(raw);
  const mk=mediaKind(message);
  const lang=detectLanguage(raw),quality=detectQuality(raw);
  const title=titleFromMessage(message,ep);
  const obviousNonEpisode=NON_EPISODE_RE.test(raw);
  if(ep && title && !obviousNonEpisode && (mk==='video'||mk==='document')){
    const cleanedCaption=cleanCaption(text,source);
    const season=ep.season??1;
    return {
      kind:'episode',title,season,episode:ep.episode,language:lang,quality,
      mediaKind:mk,originalFilename:filename(message),
      cleanedFilename:safeFilename(title,season,ep.episode,lang,quality,filename(message)),
      cleanedCaption,confidence:0.92
    };
  }
  if(message?.photo && text.trim() && PRESENTATION_RE.test(text) && !looksPromotional(text)){
    const presentTitle=stripNoiseTitle(text.split(/\r?\n/)[0]||'');
    if(presentTitle.length>=2){
      return {
        kind:'presentation',title:presentTitle,season:null,episode:null,language:'',quality:'',
        mediaKind:'photo',originalFilename:'',cleanedFilename:'',
        cleanedCaption:cleanCaption(text,source),confidence:0.82
      };
    }
  }
  return {kind:'ignore',reason:obviousNonEpisode?'non_episode_anime_content':'not_anime_release'};
}

async function cleanupTmpFiles(){
  await fs.mkdir(TMP_ROOT,{recursive:true});
  const now=Date.now();
  for(const name of await fs.readdir(TMP_ROOT).catch(()=>[])){
    const p=path.join(TMP_ROOT,name);
    try{
      const st=await fs.stat(p);
      if(st.isFile()&&now-st.mtimeMs>6*60*60*1000)await fs.rm(p,{force:true});
    }catch{}
  }
}

async function ensureIndexes(){
  if(indexesReady)return;
  const d=await db();
  await Promise.all([
    d.collection('nexanime_sources').createIndex({accountId:1,channelId:1},{unique:true}),
    d.collection('nexanime_queue').createIndex({dedupeKey:1},{unique:true}),
    d.collection('nexanime_queue').createIndex({status:1,priority:-1,seriesKey:1,season:1,episode:1,createdAt:1}),
    d.collection('nexanime_publications').createIndex({dedupeKey:1},{unique:true}),
    d.collection('nexanime_quarantine').createIndex({createdAt:-1}),
    d.collection('nexanime_series_cache').createIndex({key:1},{unique:true})
  ]);
  indexesReady=true;
}
async function sourceDoc(accountId,channelId){await ensureIndexes(); return (await db()).collection('nexanime_sources').findOne({accountId:String(accountId),channelId:String(channelId)})}
async function saveSource(accountId,entity,stats){
  await ensureIndexes();
  const d=await db(),now=new Date();
  const channelId=String(entity?.id||'');
  const username=String(entity?.username||'');
  const title=String(entity?.title||username||channelId);
  const key=String(accountId)+':'+channelId;
  const doc={
    accountId:String(accountId),channelId,username,title,
    classification:stats.classification,animeSignals:stats.animeSignals,
    blockedSignals:stats.blockedSignals,sampleSize:stats.sampleSize,
    confidence:stats.confidence,updatedAt:now
  };
  await d.collection('nexanime_sources').updateOne(
    {accountId:String(accountId),channelId},
    {
      $set:doc,
      $setOnInsert:{createdAt:now},
      ...(Number(stats.latestMessageId||0)>0?{$max:{lastSeenMessageId:Number(stats.latestMessageId)}}:{})
    },
    {upsert:true}
  );
  SOURCE_CACHE.set(key,{...doc,expires:Date.now()+15*60*1000});
  return doc;
}
async function cachedSource(accountId,entity){
  const channelId=String(entity?.id||'');
  const key=String(accountId)+':'+channelId,hit=SOURCE_CACHE.get(key);
  if(hit&&hit.expires>Date.now())return hit;
  const row=await sourceDoc(accountId,channelId);
  if(row)SOURCE_CACHE.set(key,{...row,expires:Date.now()+15*60*1000});
  return row;
}
function sourceStats(messages,source={}){
  const sourceIdentity=norm([source?.title,source?.username].filter(Boolean).join(' '));
  if(SOURCE_BLOCK_RE.test(sourceIdentity)){
    return {classification:'blocked',animeSignals:0,blockedSignals:Math.max(1,(messages||[]).length),sampleSize:Math.max(1,(messages||[]).length),confidence:0.99};
  }
  let animeSignals=0,blockedSignals=0,presentations=0;
  for(const m of messages||[]){
    const c=classifyMessage(m,source);
    if(c.kind==='episode')animeSignals++;
    else if(c.kind==='presentation'){animeSignals++;presentations++}
    else if(c.kind==='blocked')blockedSignals++;
  }
  const sampleSize=Math.max(1,(messages||[]).length);
  const ratio=animeSignals/sampleSize;
  let classification='non_anime';
  if(animeSignals>=2 && ratio>=0.05)classification=blockedSignals>0||ratio<0.55?'mixed':'anime';
  else if(animeSignals>=1)classification='candidate';
  const confidence=Math.min(0.99,0.45+animeSignals*0.09+(presentations?0.04:0)-blockedSignals*0.01);
  return {classification,animeSignals,blockedSignals,sampleSize,confidence:Number(confidence.toFixed(2))};
}
function acceptedSource(row){return row?.classification==='anime'||row?.classification==='mixed'}

async function enqueueCandidate(runtime,entity,message,c,{mode='live'}={}){
  await ensureIndexes();
  const d=await db(),now=new Date();
  const accountId=String(runtime.account.telegramUserId);
  const source={
    accountId,
    accountUsername:String(runtime.account.username||'').toLowerCase(),
    channelId:String(entity?.id||sourcePeerId(message)),
    channelUsername:String(entity?.username||''),
    channelTitle:String(entity?.title||''),
    messageId:Number(message?.id||0)
  };
  const dedupeKey=c.kind==='episode'?releaseKey(c):presentationKey(c);
  const priority=mode==='live'?1000:100;
  const seriesKey=norm(c.title);
  const payload={
    dedupeKey,status:'queued',kind:c.kind,seriesKey,title:c.title,
    season:c.season??null,episode:c.episode??null,language:c.language||'',
    quality:c.quality||'',mediaKind:c.mediaKind||'text',
    cleanedCaption:c.cleanedCaption||'',cleanedFilename:c.cleanedFilename||'',
    originalFilename:c.originalFilename||'',confidence:c.confidence||0,
    destination:'@'+DESTINATION,mode
  };
  await d.collection('nexanime_queue').updateOne(
    {dedupeKey},
    {
      $setOnInsert:{...payload,createdAt:now,attempts:0},
      $set:{updatedAt:now},
      $max:{priority},
      $addToSet:{sources:source}
    },
    {upsert:true}
  );
  runtime.animeIngest ??={};
  runtime.animeIngest.queued=(runtime.animeIngest.queued||0)+1;
  runtime.animeIngest.lastQueuedAt=now;
  return dedupeKey;
}

async function entityForMessage(client,message){
  const peer=message?.peerId;
  if(!peer?.channelId)return null;
  try{return await client.getEntity(peer)}catch{return null}
}
async function classifySource(runtime,entity){
  const accountId=String(runtime.account.telegramUserId);
  const sample=await runtime.client.getMessages(entity,{limit:SOURCE_SAMPLE_LIMIT});
  const stats=sourceStats(sample,{username:entity?.username||'',title:entity?.title||''});
  stats.latestMessageId=Math.max(0,...(sample||[]).map(m=>Number(m?.id||0)));
  return saveSource(accountId,entity,stats);
}
async function activeSeriesAnchors(runtime,entity){
  const recent=await runtime.client.getMessages(entity,{limit:ACTIVE_SAMPLE_LIMIT});
  const source={username:entity?.username||'',title:entity?.title||''};
  const anchors=await verifiedSeriesAnchors(recent,source);
  await (await db()).collection('nexanime_sources').updateOne(
    {accountId:String(runtime.account.telegramUserId),channelId:String(entity?.id||'')},
    {$set:{seriesAnchors:anchors,verifiedAnimeSeries:anchors.length,seriesVerifiedAt:new Date()}}
  );
  const cacheKey=String(runtime.account.telegramUserId)+':'+String(entity?.id||'');
  const cached=SOURCE_CACHE.get(cacheKey);
  if(cached)SOURCE_CACHE.set(cacheKey,{...cached,seriesAnchors:anchors,verifiedAnimeSeries:anchors.length});
  return anchors;
}
async function backfillSource(runtime,entity){
  const accountId=String(runtime.account.telegramUserId);
  const anchors=await activeSeriesAnchors(runtime,entity);
  if(!anchors.length){
    console.log('[NexAnime] no verified anime series',accountId,String(entity?.username||entity?.id||''));
    return 0;
  }
  const source={username:entity?.username||'',title:entity?.title||'',seriesAnchors:anchors};
  const history=await runtime.client.getMessages(entity,{limit:BACKFILL_LIMIT});
  const found=[];
  for(const m of history){
    let c=classifyMessage(m,source);
    if(c.kind!=='episode'&&c.kind!=='presentation')continue;
    const anchor=bestAnchor(c.title,anchors);
    if(!anchor)continue;
    c={...c,title:anchor.canonicalTitle,anilistId:anchor.anilistId,verifiedAnime:true};
    found.push({m,c});
  }
  found.sort((a,b)=>{
    const sa=norm(a.c.title),sb=norm(b.c.title);
    if(sa!==sb)return sa.localeCompare(sb);
    if((a.c.season??0)!==(b.c.season??0))return (a.c.season??0)-(b.c.season??0);
    return (a.c.episode??-1)-(b.c.episode??-1);
  });
  let count=0;
  for(const {m,c} of found){
    await enqueueCandidate(runtime,entity,m,c,{mode:'backfill'});
    count++;
  }
  runtime.animeIngest ??={};
  runtime.animeIngest.lastBackfillAt=new Date();
  runtime.animeIngest.lastBackfillCount=count;
  console.log('[NexAnime] backfill',accountId,String(entity?.username||entity?.id||''),count,'item(s)');
  return count;
}

async function discoverSources(runtime){
  if(!isListenerRuntime(runtime))return [];
  runtime.animeIngest ??={};
  if(runtime.animeIngest.discovering)return [];
  runtime.animeIngest.discovering=true;
  try{
  const dialogs=await runtime.client.getDialogs({limit:DIALOG_LIMIT});
  const accepted=[];
  for(const dialog of dialogs){
    const entity=dialog?.entity;
    if(!entity?.id||!entity?.broadcast)continue;
    if(String(entity?.username||'').toLowerCase()===DESTINATION.toLowerCase())continue;
    try{
      const row=await classifySource(runtime,entity);
      if(acceptedSource(row)){
        accepted.push(row);
        await backfillSource(runtime,entity);
      }
      await sleep(120);
    }catch(e){
      console.warn('[NexAnime discover]',String(runtime.account.telegramUserId),String(entity?.username||entity?.id||''),String(e?.message||e).slice(0,220));
    }
  }
  runtime.animeIngest.sources=accepted.length;
  runtime.animeIngest.lastDiscoveryAt=new Date();
  return accepted;
  }finally{
    runtime.animeIngest.discovering=false;
  }
}


async function pollAnimeSources(runtime){
  if(!isListenerRuntime(runtime)||runtime.animeIngest?.polling)return 0;
  runtime.animeIngest ??={};
  runtime.animeIngest.polling=true;
  let processed=0;
  try{
    await ensureIndexes();
    if(!runtime.client?.connected){
      try{await runtime.client.connect()}catch{return 0}
    }
    const d=await db();
    const rows=await d.collection('nexanime_sources')
      .find({accountId:String(runtime.account.telegramUserId),classification:{$in:['anime','mixed']}})
      .sort({confidence:-1,updatedAt:-1})
      .limit(80).toArray();
    for(const row of rows){
      let entity;
      try{
        entity=await runtime.client.getEntity(row.username||BigInt(row.channelId));
      }catch{
        try{entity=await runtime.client.getEntity(BigInt(row.channelId))}catch{continue}
      }
      const last=Number(row.lastSeenMessageId||0);
      let fresh=[];
      try{fresh=await runtime.client.getMessages(entity,{limit:50,minId:last})}catch{continue}
      const list=(fresh||[]).filter(m=>Number(m?.id||0)>last).sort((a,b)=>Number(a.id)-Number(b.id));
      let newest=last;
      for(const message of list){
        newest=Math.max(newest,Number(message?.id||0));
        let c=classifyMessage(message,{username:entity?.username||'',title:entity?.title||''});
        if(c.kind==='blocked'||c.kind==='ignore')continue;
        if(c.confidence<0.70){
          await quarantine(runtime,entity,message,c,'low_confidence_poll');
          continue;
        }
        c=await canonicalizeCandidate(c,row);
        if(!c?.verifiedAnime){
          await quarantine(runtime,entity,message,c,'anime_not_verified_poll');
          continue;
        }
        await enqueueCandidate(runtime,entity,message,c,{mode:'live'});
        processed++;
      }
      if(newest>last){
        await d.collection('nexanime_sources').updateOne(
          {accountId:String(runtime.account.telegramUserId),channelId:String(row.channelId)},
          {$max:{lastSeenMessageId:newest},$set:{lastPolledAt:new Date()}}
        );
      }
      await sleep(80);
    }
    runtime.animeIngest.lastPollAt=new Date();
    runtime.animeIngest.lastPollCount=processed;
    return processed;
  }finally{
    runtime.animeIngest.polling=false;
  }
}

async function quarantine(runtime,entity,message,c,reason){
  await ensureIndexes();
  const d=await db();
  await d.collection('nexanime_quarantine').insertOne({
    accountId:String(runtime.account.telegramUserId),
    channelId:String(entity?.id||sourcePeerId(message)),
    channelUsername:String(entity?.username||''),
    messageId:Number(message?.id||0),
    reason,classification:c?.kind||'unknown',
    text:clip(String(message?.message||''),1200),
    filename:filename(message),
    createdAt:new Date()
  }).catch(e=>{if(Number(e?.code)!==11000)throw e});
}

export function isListenerRuntime(runtime){
  if(!ENABLED)return false;
  const username=String(runtime?.account?.username||'').replace(/^@/,'').toLowerCase();
  return LISTENERS.has(username);
}

export async function handleAnimeIngestEvent(runtime,event){
  if(!isListenerRuntime(runtime))return false;
  const message=event?.message;
  if(!message?.peerId?.channelId)return false;
  const entity=await entityForMessage(runtime.client,message);
  if(!entity?.broadcast)return false;
  if(String(entity?.username||'').toLowerCase()===DESTINATION.toLowerCase())return false;
  let source=await cachedSource(runtime.account.telegramUserId,entity);
  if(!source || source.classification==='candidate'){
    source=await classifySource(runtime,entity);
  }
  if(!acceptedSource(source))return false;
  let c=classifyMessage(message,{username:entity.username||'',title:entity.title||''});
  if(c.kind==='blocked')return true;
  if(c.kind==='ignore')return false;
  if(c.confidence<0.70){
    await quarantine(runtime,entity,message,c,'low_confidence');
    return true;
  }
  c=await canonicalizeCandidate(c,source);
  if(!c?.verifiedAnime){
    await quarantine(runtime,entity,message,c,'anime_not_verified');
    return true;
  }
  await enqueueCandidate(runtime,entity,message,c,{mode:'live'});
  return true;
}

async function resolveSource(runtime,item){
  const sources=Array.isArray(item.sources)?item.sources:[];
  const own=sources.find(s=>String(s.accountId)===String(runtime.account.telegramUserId));
  if(!own)return null;
  let entity=null;
  try{entity=await runtime.client.getEntity(own.channelUsername||BigInt(own.channelId))}catch{
    try{entity=await runtime.client.getEntity(BigInt(own.channelId))}catch{}
  }
  if(!entity)return null;
  const messages=await runtime.client.getMessages(entity,{ids:[Number(own.messageId)]});
  const message=Array.isArray(messages)?messages[0]:messages;
  return message?{source:own,entity,message}:null;
}
async function destinationEntity(runtime){
  return runtime.client.getEntity(DESTINATION);
}
async function destinationThumb(runtime,destination){
  runtime.animeIngest ??={};
  if(runtime.animeIngest.thumbPath){
    try{await fs.access(runtime.animeIngest.thumbPath);return runtime.animeIngest.thumbPath}catch{}
  }
  try{
    const b=await runtime.client.downloadProfilePhoto(destination,{isBig:true});
    if(!b)return null;
    await fs.mkdir(TMP_ROOT,{recursive:true});
    const p=path.join(TMP_ROOT,'theotaku-nexus-thumb.jpg');
    await fs.writeFile(p,Buffer.from(b));
    runtime.animeIngest.thumbPath=p;
    return p;
  }catch{return null}
}
async function publishPresentation(runtime,item,resolved,destination){
  const message=resolved.message;
  const caption=standardizedCaption(item);
  if(message?.photo){
    const tmp=path.join(TMP_ROOT,'presentation-'+crypto.randomUUID()+'.jpg');
    await fs.mkdir(TMP_ROOT,{recursive:true});
    try{
      const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
      const file=typeof out==='string'?out:tmp;
      return await runtime.client.sendFile(destination,{file,caption,workers:1});
    }finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
  }
  return runtime.client.sendMessage(destination,{message:caption});
}
async function publishEpisode(runtime,item,resolved,destination){
  if(!MEDIA_REUPLOAD){
    const err=new Error('media_reupload_requires_authorized_policy');
    err.code='MEDIA_POLICY';
    throw err;
  }
  const message=resolved.message;
  if(!message?.media)throw new Error('source_media_missing');
  await fs.mkdir(TMP_ROOT,{recursive:true});
  const finalName=item.cleanedFilename||safeFilename(item.title,item.season,item.episode,item.language,item.quality,filename(message));
  const ext=path.extname(finalName)||'.bin';
  const tmp=path.join(TMP_ROOT,'episode-'+crypto.randomUUID()+ext);
  const thumb=await destinationThumb(runtime,destination);
  try{
    const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
    const file=typeof out==='string'?out:tmp;
    const opts={file,caption:standardizedCaption(item),fileName:finalName,workers:1};
    if(thumb)opts.thumb=thumb;
    if(item.mediaKind==='document')opts.forceDocument=true;
    return await runtime.client.sendFile(destination,opts);
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
}
async function markPublication(item,sent,runtime){
  const d=await db(),now=new Date();
  await d.collection('nexanime_publications').updateOne(
    {dedupeKey:item.dedupeKey},
    {$setOnInsert:{
      dedupeKey:item.dedupeKey,title:item.title,season:item.season,episode:item.episode,
      language:item.language||'',destination:'@'+DESTINATION,createdAt:now
    },$set:{
      publishedAt:now,publisherAccountId:String(runtime.account.telegramUserId),
      publisherUsername:String(runtime.account.username||''),
      telegramMessageId:Number(sent?.id||sent?.messageId||0)
    }},
    {upsert:true}
  );
  await d.collection('nexanime_queue').updateOne(
    {_id:item._id},
    {$set:{status:'published',publishedAt:now,updatedAt:now},$unset:{claimAt:'',claimBy:''}}
  );
}
async function releaseClaim(item,error){
  const d=await db(),now=new Date();
  const attempts=Number(item.attempts||0)+1;
  const mediaPolicy=String(error?.code||'')==='MEDIA_POLICY';
  await d.collection('nexanime_queue').updateOne(
    {_id:item._id},
    {$set:{
      status:mediaPolicy?'awaiting_rights':'queued',
      lastError:String(error?.message||error).slice(0,500),
      updatedAt:now
    },$inc:{attempts:1},$unset:{claimAt:'',claimBy:''}}
  );
  if(attempts>=5&&!mediaPolicy){
    await d.collection('nexanime_queue').updateOne({_id:item._id},{$set:{status:'quarantine',quarantineReason:'publish_failures',updatedAt:now}});
  }
}
async function claimNext(runtime){
  await ensureIndexes();
  const d=await db(),now=new Date();
  const accountId=String(runtime.account.telegramUserId);
  return d.collection('nexanime_queue').findOneAndUpdate(
    {
      status:'queued',
      'sources.accountId':accountId,
      $or:[{claimAt:{$exists:false}},{claimAt:{$lt:new Date(Date.now()-10*60*1000)}}]
    },
    {$set:{status:'publishing',claimAt:now,claimBy:accountId,updatedAt:now}},
    {sort:{priority:-1,seriesKey:1,season:1,episode:1,createdAt:1},returnDocument:'after'}
  );
}
async function alreadyPublished(dedupeKey){
  const d=await db();
  return !!(await d.collection('nexanime_publications').findOne({dedupeKey},{projection:{_id:1}}));
}
async function publishOne(runtime){
  if(!isListenerRuntime(runtime)||runtime.animeIngest?.publishing)return false;
  runtime.animeIngest ??={};
  runtime.animeIngest.publishing=true;
  let item=null;
  try{
    item=await claimNext(runtime);
    if(!item)return false;
    if(await alreadyPublished(item.dedupeKey)){
      await (await db()).collection('nexanime_queue').updateOne({_id:item._id},{$set:{status:'published',updatedAt:new Date(),deduplicated:true}});
      return true;
    }
    const resolved=await resolveSource(runtime,item);
    if(!resolved)throw new Error('source_message_unavailable_for_runtime');
    const destination=await destinationEntity(runtime);
    let sent;
    if(item.kind==='presentation')sent=await publishPresentation(runtime,item,resolved,destination);
    else sent=await publishEpisode(runtime,item,resolved,destination);
    await markPublication(item,sent,runtime);
    runtime.animeIngest.lastPublishedAt=new Date();
    runtime.animeIngest.published=(runtime.animeIngest.published||0)+1;
    console.log('[NexAnime] published',item.dedupeKey,'-> @'+DESTINATION);
    return true;
  }catch(e){
    if(e?.message!=='source_message_unavailable_for_runtime'){
      console.warn('[NexAnime publish]',String(runtime.account.telegramUserId),String(e?.message||e).slice(0,300));
    }
    if(item)await releaseClaim(item,e).catch(()=>{});
    return false;
  }finally{
    runtime.animeIngest.publishing=false;
  }
}

export async function startAnimeIngest(runtime){
  if(!isListenerRuntime(runtime))return false;
  runtime.animeIngest={
    ...(runtime.animeIngest||{}),
    enabled:true,destination:'@'+DESTINATION,listener:true,mediaPolicy:MEDIA_POLICY
  };
  await ensureIndexes();
  queueMicrotask(()=>cleanupTmpFiles().catch(()=>{}));
  queueMicrotask(()=>discoverSources(runtime).catch(e=>console.error('[NexAnime discovery]',String(e?.message||e))));
  runtime.animeIngest.discoveryTimer=setInterval(
    ()=>discoverSources(runtime).catch(e=>console.error('[NexAnime discovery]',String(e?.message||e))),
    DISCOVERY_MS
  );
  runtime.animeIngest.discoveryTimer.unref?.();
  runtime.animeIngest.publishTimer=setInterval(()=>publishOne(runtime).catch(()=>{}),PUBLISH_MS);
  runtime.animeIngest.publishTimer.unref?.();
  runtime.animeIngest.pollTimer=setInterval(()=>pollAnimeSources(runtime).catch(()=>{}),POLL_MS);
  runtime.animeIngest.pollTimer.unref?.();
  return true;
}
export async function stopAnimeIngest(runtime){
  if(!runtime?.animeIngest)return;
  if(runtime.animeIngest.discoveryTimer)clearInterval(runtime.animeIngest.discoveryTimer);
  if(runtime.animeIngest.publishTimer)clearInterval(runtime.animeIngest.publishTimer);
  if(runtime.animeIngest.pollTimer)clearInterval(runtime.animeIngest.pollTimer);
  runtime.animeIngest.enabled=false;
}
export function animeIngestStatus(runtime){
  const a=runtime?.animeIngest||{};
  return {
    enabled:a.enabled===true,listener:a.listener===true,destination:a.destination||'@'+DESTINATION,
    mediaPolicy:a.mediaPolicy||MEDIA_POLICY,sources:a.sources||0,queued:a.queued||0,published:a.published||0,
    lastQueuedAt:a.lastQueuedAt||null,lastPublishedAt:a.lastPublishedAt||null,
    lastDiscoveryAt:a.lastDiscoveryAt||null,lastBackfillAt:a.lastBackfillAt||null,
    lastBackfillCount:a.lastBackfillCount||0,lastPollAt:a.lastPollAt||null,
    lastPollCount:a.lastPollCount||0,discovering:a.discovering===true,polling:a.polling===true
  };
}

export const __test={
  parseEpisode,detectLanguage,detectQuality,stripNoiseTitle,cleanCaption,safeFilename,
  classifyMessage,sourceStats,titleSimilarity,releaseKey,presentationKey,
  cleanSeriesTitle,sourceTitleCandidate,deriveRawAnchors,commonPrefixTitle,verifyAnimeTitle
};


export async function animeSystemStatus(){
  await ensureIndexes();
  const d=await db();
  const [sourceRows,queueRows,published,sourceList]=await Promise.all([
    d.collection('nexanime_sources').aggregate([
      {$group:{_id:'$classification',count:{$sum:1}}}
    ]).toArray(),
    d.collection('nexanime_queue').aggregate([
      {$group:{_id:'$status',count:{$sum:1}}}
    ]).toArray(),
    d.collection('nexanime_publications').countDocuments(),
    d.collection('nexanime_sources').find({},{
      projection:{accountId:0,_id:0}
    }).sort({confidence:-1,updatedAt:-1}).limit(25).toArray()
  ]);
  const sources=Object.fromEntries(sourceRows.map(x=>[x._id||'unknown',x.count]));
  const queue=Object.fromEntries(queueRows.map(x=>[x._id||'unknown',x.count]));
  const recent=await d.collection('nexanime_queue')
    .find({},{
      projection:{
        dedupeKey:1,status:1,kind:1,title:1,season:1,episode:1,language:1,quality:1,
        destination:1,mode:1,priority:1,lastError:1,updatedAt:1,createdAt:1
      }
    })
    .sort({updatedAt:-1}).limit(20).toArray();
  return {
    ok:true,enabled:ENABLED,destination:'@'+DESTINATION,
    listeners:[...LISTENERS].map(x=>'@'+x),
    mediaPolicy:MEDIA_POLICY,
    sources,sourceList,queue,published,recent
  };
}

export async function animeRetryQueue({includeQuarantine=true,includeFailures=true}={}){
  await ensureIndexes();
  const d=await db();
  const statuses=[];
  if(includeQuarantine)statuses.push('quarantine');
  if(includeFailures)statuses.push('publishing');
  if(!statuses.length)return {ok:true,matched:0,modified:0};
  const r=await d.collection('nexanime_queue').updateMany(
    {status:{$in:statuses}},
    {$set:{status:'queued',updatedAt:new Date()},$unset:{claimAt:'',claimBy:'',quarantineReason:''}}
  );
  return {ok:true,matched:r.matchedCount,modified:r.modifiedCount};
}

export async function animeDiscoverNow(runtime){
  runtime.animeIngest ??={};
  if(runtime.animeIngest.discovering){
    return {started:false,alreadyRunning:true};
  }
  runtime.animeIngest.discoveryRequestedAt=new Date();
  queueMicrotask(()=>discoverSources(runtime).catch(e=>console.error('[NexAnime discovery]',String(e?.message||e))));
  return {started:true,alreadyRunning:false};
}
