import { Api } from 'teleproto';
import { Button } from 'teleproto/tl/custom/button.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './store.mjs';
import { sendTelegramMedia } from './media-send.mjs';
import { generateAiReply } from './ai-engine.mjs';

const ENABLED=String(process.env.NEXANIME_ENABLED||'true').toLowerCase()!=='false';
const REQUIRED_LISTENERS=['tresor20001','tresor20009','tresor20000'];
const LISTENERS=new Set([
  ...REQUIRED_LISTENERS,
  ...String(process.env.NEXANIME_LISTENER_USERNAMES||'')
    .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean)
]);
const DESTINATION=String(process.env.NEXCANAL__ANIME_DESTINATION||process.env.NEXANIME_DESTINATION||'theotaku_nexus').trim().replace(/^@/,'');
const NEXCANAL_STAGE_BOT=String(process.env.NEXANIME_NEXCANAL_BOT||'the_big_dipper_bot').trim().replace(/^@/,'');
const NEXCANAL_HANDOFF_COLLECTION='nexanime_nexcanal_handoffs';
// NexCanal is preferred, but it must never become a liveness dependency.
// If it cannot confirm quickly, NexAnime cancels that handoff and publishes
// through the healthy account runtime instead.
const NEXCANAL_HANDOFF_TIMEOUT_MS=25_000;
const DISCOVERY_MS=Math.max(15*60*1000,Number(process.env.NEXANIME_DISCOVERY_MS||6*60*60*1000));
// Publication cadence is a product invariant, not an environment override:
// - same anime: another publication opportunity every 30s (<= 1 min)
// - different anime: exactly 5 min from the previous series' last confirmed publication
// The active anime is drained first; only a genuinely unrunnable frontier may be parked.
const PUBLISH_MS=30_000;
const INTER_SERIES_MS=5*60_000;
const RESUME_AFTER_LONG_PAUSE_MS=30*60_000;
// A broken or incomplete series must never freeze the entire anime feed.
// It is parked temporarily, while episode order inside that series stays strict.
const GAP_RETRY_MS=5*60_000;
const ACTIVE_FRONTIER_GRACE_MS=5*60_000;
const FRONTIER_REFRESH_THROTTLE_MS=60_000;
const TRANSIENT_VARIANT_RETRY_MS=Math.max(PUBLISH_MS*2,90_000);
const PUBLISHER_LEASE_GRACE_MS=Math.max(INTER_SERIES_MS+60_000,Number(process.env.NEXANIME_PUBLISHER_LEASE_GRACE_MS||INTER_SERIES_MS+5*60*1000));
const POLL_MS=Math.max(30000,Number(process.env.NEXANIME_POLL_MS||60000));
const STALE_PUBLISH_MS=Math.max(2*60*1000,Number(process.env.NEXANIME_STALE_PUBLISH_MS||10*60*1000));
const SOURCE_SAMPLE_LIMIT=Math.min(80,Math.max(12,Number(process.env.NEXANIME_SOURCE_SAMPLE_LIMIT||40)));
const DIALOG_LIMIT=Math.min(250,Math.max(20,Number(process.env.NEXANIME_DIALOG_LIMIT||120)));
const BACKFILL_LIMIT=Math.min(5000,Math.max(50,Number(process.env.NEXANIME_BACKFILL_LIMIT||3000)));
const ACTIVE_SAMPLE_LIMIT=Math.min(120,Math.max(20,Number(process.env.NEXANIME_ACTIVE_SAMPLE_LIMIT||80)));
const MAX_ACTIVE_SERIES=Math.min(20,Math.max(1,Number(process.env.NEXANIME_MAX_ACTIVE_SERIES||8)));
const MAX_SELECTED_SOURCES=Math.min(25,Math.max(3,Number(process.env.NEXANIME_MAX_SELECTED_SOURCES||10)));
const MEDIA_POLICY_DEFAULT=String(process.env.NEXANIME_MEDIA_POLICY||'authorized_only').toLowerCase();
let MEDIA_POLICY_CACHE={value:MEDIA_POLICY_DEFAULT,expires:0};
const TMP_ROOT=process.env.NEXANIME_TMP_DIR||path.join(os.tmpdir(),'nexanime');
const WHATSAPP_BRIDGE=String(process.env.NEXANIME_WHATSAPP_BRIDGE||'http://127.0.0.1:18787/publish').trim();
const WHATSAPP_STAGE_ROOT=String(process.env.NEXANIME_WHATSAPP_STAGE_DIR||'/var/lib/nex/tmp/shared-whatsapp/nexanime').trim();
const WHATSAPP_STAGE_TTL_MS=Math.max(6*60*60_000,Number(process.env.NEXANIME_WHATSAPP_STAGE_TTL_MS||24*60*60_000));
const TMP_RETENTION_MS=Math.max(60*60*1000,Number(process.env.NEXANIME_TMP_RETENTION_MS||24*60*60*1000));
const TMP_CLEANUP_MS=Math.max(60*1000,Number(process.env.NEXANIME_TMP_CLEANUP_MS||15*60*1000));
const SOURCE_CACHE=new Map();
const SERIES_CACHE=new Map();
const SYNOPSIS_FR_CACHE=new Map();
const LIVE_ANIME_RUNTIMES=new Map();

function liveAnimeRuntimeId(runtime){
  return String(runtime?.account?.telegramUserId||'');
}
function registerLiveAnimeRuntime(runtime){
  const id=liveAnimeRuntimeId(runtime);
  if(id)LIVE_ANIME_RUNTIMES.set(id,runtime);
}
function unregisterLiveAnimeRuntime(runtime){
  const id=liveAnimeRuntimeId(runtime);
  if(id&&LIVE_ANIME_RUNTIMES.get(id)===runtime)LIVE_ANIME_RUNTIMES.delete(id);
}
function liveRuntimeCandidates(source,fallbackRuntime){
  const out=[],seen=new Set();
  const add=runtime=>{
    const id=liveAnimeRuntimeId(runtime);
    if(!id||seen.has(id)||runtime?.client?.connected!==true)return;
    seen.add(id);out.push(runtime);
  };
  const sourceId=String(source?.accountId||'');
  const sourceUsername=String(source?.accountUsername||'').replace(/^@/,'').toLowerCase();
  if(sourceId)add(LIVE_ANIME_RUNTIMES.get(sourceId));
  if(sourceUsername){
    for(const runtime of LIVE_ANIME_RUNTIMES.values()){
      if(String(runtime?.account?.username||'').replace(/^@/,'').toLowerCase()===sourceUsername)add(runtime);
    }
  }
  add(fallbackRuntime);
  for(const runtime of LIVE_ANIME_RUNTIMES.values())add(runtime);
  return out;
}
let ANI_CHAIN=Promise.resolve();
let ANI_LAST_AT=0;
let indexesReady=false;
let stalePublishingReconcileAt=0;

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
const SOURCE_BLOCK_RE=/\b(?:hentai\w*|porn\w*|adult\w*|nsfw\w*|xxx\w*|prono\w*|bet(?:ting)?\w*|casino\w*|1xbet\w*|melbet\w*|stake\w*|k[-_ ]?drama\w*|drama\w*|live[-_ ]?action\w*)\b/i;

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
  let m=text.match(/\bS(?:eason|aison)?\s*0*(\d{1,2})\s*[-_.•·:|/ ]*E(?:P(?:ISODE)?)?\s*[-_.•·:|/ ]*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:Number(m[1]),episode:Number(m[2])+(m[3]?Number('0.'+m[3]):0),token:m[0]};
  m=text.match(/\b(?:Season|Saison)\s*0*(\d{1,2})\s*(?:Episode|Épisode|Ep)\s*0*(\d{1,4})(?:\.(\d))?\b/i);
  if(m)return {season:Number(m[1]),episode:Number(m[2])+(m[3]?Number('0.'+m[3]):0),token:m[0]};
  // Several anime sources use the reversed form "E02 S2". Preserve the
  // season instead of silently defaulting the item to season 1.
  m=text.match(/\bE(?:P(?:ISODE)?)?\s*[-_.:# ]*0*(\d{1,4})(?:\.(\d))?\s*[-_.•·:|/ ]*S(?:eason|aison)?\s*0*(\d{1,2})\b/i);
  if(m)return {season:Number(m[3]),episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0),token:m[0]};
  m=text.match(/\b(?:Episode|Épisode|Ep)\s*0*(\d{1,4})(?:\.(\d))?\s*(?:Season|Saison)\s*0*(\d{1,2})\b/i);
  if(m)return {season:Number(m[3]),episode:Number(m[1])+(m[2]?Number('0.'+m[2]):0),token:m[0]};
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
function usableTitleCandidate(value=''){
  const t=String(value||'').trim();
  if(t.length<2||/^(episode|ep|e|vf|vostfr|vo)$/i.test(t))return false;
  // Numeric storage filenames such as "5423777.mp4" are Telegram/file IDs,
  // not series titles. Treating them as titles creates false caption/file conflicts.
  return /[a-z]/i.test(norm(t));
}
function strongTitleCandidate(value=''){
  const t=cleanSeriesTitle(value);
  if(!usableTitleCandidate(t))return false;
  const tokens=norm(t).split(' ').filter(Boolean);
  return tokens.length>=2 || norm(t).length>=5;
}
const TITLE_STOP_WORDS=new Set([
  'a','an','and','as','at','by','for','from','in','into','no','of','on','or','the','to','with',
  'de','des','du','en','et','la','le','les','un','une'
]);
function meaningfulTitleSimilarity(a,b){
  const aa=new Set(norm(a).split(' ').filter(x=>x.length>1&&!TITLE_STOP_WORDS.has(x)));
  const bb=new Set(norm(b).split(' ').filter(x=>x.length>1&&!TITLE_STOP_WORDS.has(x)));
  if(!aa.size||!bb.size)return 0;
  let hit=0; for(const x of aa)if(bb.has(x))hit++;
  return hit/Math.max(aa.size,bb.size);
}
function titlesClearlyConflict(a,b){
  const aa=cleanSeriesTitle(a),bb=cleanSeriesTitle(b);
  if(!strongTitleCandidate(aa)||!strongTitleCandidate(bb))return false;
  const an=norm(aa),bn=norm(bb);
  if(an===bn)return false;
  if(an.length>=5&&bn.length>=5&&(an.includes(bn)||bn.includes(an)))return false;
  if(prefixTokens(aa,bb).length>=2)return false;
  return meaningfulTitleSimilarity(aa,bb)<0.34;
}
function episodeEvidenceFromMessage(message){
  const captionEp=parseEpisode(String(message?.message||''));
  const fileEp=parseEpisode(filename(message));
  const conflict=Boolean(
    captionEp&&fileEp&&(
      Number(captionEp.episode)!==Number(fileEp.episode)||
      (captionEp.season!=null&&fileEp.season!=null&&Number(captionEp.season)!==Number(fileEp.season))
    )
  );
  const episode=captionEp||fileEp||null;
  const merged=episode?{
    ...episode,
    season:captionEp?.season??fileEp?.season??episode.season??null,
    episode:captionEp?.episode??fileEp?.episode??episode.episode
  }:null;
  return {captionEp,fileEp,conflict,episode:merged};
}
function titleEvidenceFromMessage(message,ep){
  const captionEp=parseEpisode(String(message?.message||''))||ep;
  const fileEp=parseEpisode(filename(message))||ep;
  const captionTitle=stripNoiseTitle(String(message?.message||''),captionEp?.token||'');
  const fileTitle=stripNoiseTitle(filename(message),fileEp?.token||'');
  const captionUsable=usableTitleCandidate(captionTitle);
  const fileUsable=usableTitleCandidate(fileTitle);
  return {
    captionTitle:captionUsable?captionTitle:'',
    fileTitle:fileUsable?fileTitle:'',
    conflict:captionUsable&&fileUsable&&titlesClearlyConflict(captionTitle,fileTitle)
  };
}
function titleFromMessage(message,ep){
  const evidence=titleEvidenceFromMessage(message,ep);
  if(evidence.captionTitle)return evidence.captionTitle;
  if(evidence.fileTitle)return evidence.fileTitle;
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
  const candidates=[];
  for(const message of messages){
    const c=classifyMessage(message,source);
    if(c.kind!=='episode')continue;
    const title=cleanSeriesTitle(c.title);
    if(title)candidates.push(title);
  }
  const clusters=[];
  for(const title of candidates){
    const base=title;
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
    const qTokens=q.split(' ').filter(Boolean).length;
    const aTokens=a.split(' ').filter(Boolean).length;
    if(q.length>=5&&a.length>=5&&(q.includes(a)||a.includes(q))&&(Math.min(qTokens,aTokens)>=2))best=Math.max(best,0.9);
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
  const gql='query($search:String){Media(search:$search,type:ANIME,isAdult:false){id isAdult format seasonYear episodes status genres description(asHtml:false) coverImage{extraLarge large} studios(isMain:true){nodes{name}} title{romaji english native} synonyms}}';
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
      const ok=media.isAdult!==true&&score>=0.58;
      result={
        key,query:cleaned,ok,temporary:false,score:Number(score.toFixed(3)),
        canonicalTitle:ok?(media.title?.english||media.title?.romaji||cleaned):'',
        anilistId:ok?Number(media.id):null,aliases:ok?aliases.slice(0,12):[],
        description:ok?String(media.description||'').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,'').trim():'',
        coverImage:ok?(media.coverImage?.extraLarge||media.coverImage?.large||''):'',
        genres:ok?(media.genres||[]).slice(0,8):[],
        episodes:ok?(media.episodes??null):null,
        format:ok?(media.format||''):'',
        status:ok?(media.status||''):'',
        studios:ok?(media.studios?.nodes||[]).map(x=>x?.name).filter(Boolean).slice(0,4):[],
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
async function animePresentationMetadata(title){
  const first=await verifyAnimeTitle(title);
  if(first.ok&&String(first.description||'').trim())return first;
  if(first.key){
    try{
      const d=await db();
      await d.collection('nexanime_series_cache').deleteOne({key:first.key});
      SERIES_CACHE.delete(first.key);
    }catch{}
  }
  return verifyAnimeTitle(title);
}
function cleanSynopsisDescription(value=''){
  return String(value||'')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/\\n/g,'\n')
    .replace(/\(\s*(?:source|sources?)\s*:\s*[^)]+\)/gi,'')
    .replace(/\[(?:source|sources?)\s*:[^\]]+\]/gi,'')
    .replace(/^(?:source|sources?)\s*:\s*.*$/gim,'')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .replace(/[ \t]{2,}/g,' ')
    .trim();
}
function synopsisLooksFrench(text=''){
  const s=' '+String(text||'').toLowerCase()+' ';
  const fr=(s.match(/\b(?:le|la|les|un|une|des|du|de|dans|avec|pour|mais|alors|sur|son|sa|ses|qui|que|est|sont|été|être|après|avant|lorsque|afin)\b/g)||[]).length;
  const en=(s.match(/\b(?:the|and|with|for|from|into|after|before|when|while|his|her|their|who|that|is|are|was|were|to)\b/g)||[]).length;
  return fr>=Math.max(3,en);
}
async function frenchSynopsis(meta,seriesKey=''){
  const raw=cleanSynopsisDescription(meta?.description||'');
  if(!raw)return '';
  if(synopsisLooksFrench(raw))return raw;
  const cacheKey=crypto.createHash('sha256').update(raw).digest('hex');
  if(SYNOPSIS_FR_CACHE.has(cacheKey))return SYNOPSIS_FR_CACHE.get(cacheKey);
  try{
    const result=await generateAiReply({
      accountId:'nexanime-system',
      peer:'synopsis:'+String(seriesKey||meta?.anilistId||meta?.canonicalTitle||'anime'),
      mode:'ai',
      language:'fr',
      prompt:[
        'Traduis ce synopsis d’anime en français naturel.',
        'Conserve fidèlement les noms propres et les faits.',
        'Ne rajoute aucun commentaire, aucune source, aucun crédit et aucun titre.',
        'Réponds uniquement avec le synopsis traduit.',
        '',
        raw
      ].join('\n')
    });
    const translated=cleanSynopsisDescription(result?.text||'');
    if(!translated||!synopsisLooksFrench(translated)){
      // Translation is presentation quality, never a publication liveness gate.
      // Keep the cleaned source synopsis so the anime can continue.
      SYNOPSIS_FR_CACHE.set(cacheKey,raw);
      return raw;
    }
    SYNOPSIS_FR_CACHE.set(cacheKey,translated);
    return translated;
  }catch{
    // AI/translation outages must not pause the anime feed.
    SYNOPSIS_FR_CACHE.set(cacheKey,raw);
    return raw;
  }
}
function frenchGenre(value=''){
  const map={
    'Adventure':'Aventure','Supernatural':'Surnaturel','Comedy':'Comédie',
    'Drama':'Drame','Fantasy':'Fantastique','Sci-Fi':'Science-fiction',
    'Slice of Life':'Tranche de vie','Mystery':'Mystère','Psychological':'Psychologique',
    'Sports':'Sport','Horror':'Horreur','Music':'Musique','Mecha':'Mecha',
    'Action':'Action','Romance':'Romance','Thriller':'Thriller'
  };
  return map[String(value||'').trim()]||String(value||'').trim();
}
async function presentationText(meta,seriesKey=''){
  const rows=[];
  if(meta?.genres?.length)rows.push('Genres : '+meta.genres.map(frenchGenre).join(' · '));
  if(meta?.studios?.length)rows.push('Studio : '+meta.studios.join(', '));
  if(meta?.episodes)rows.push('Épisodes : '+meta.episodes);
  if(meta?.format)rows.push('Format : '+meta.format);
  const description=await frenchSynopsis(meta,seriesKey);
  if(!description)return '';
  rows.push('Synopsis\n'+description);
  return rows.join('\n');
}

function resumePresentationKey(seriesKey,season,episode){
  return [String(seriesKey||''),'resume','s'+Number(season||1),'e'+Number(episode||0)].join('|');
}
async function resumePresentationText(meta,seriesKey,season,episode){
  const head='🔄 Reprise de l’anime\nLa publication reprend à Saison '+Number(season||1)+' · Épisode '+Number(episode||0);
  const synopsis=await presentationText(meta,seriesKey);
  return [head,synopsis].filter(Boolean).join('\n\n');
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
  return bestScore>=0.58?best:null;
}
async function verifiedSeriesAnchors(messages,source={}){
  const raw=deriveRawAnchors(messages,source);
  const out=[];
  for(const title of raw){
    const v=await verifyAnimeTitle(title);
    if(v.ok&&!out.some(x=>x.anilistId===v.anilistId)){
      out.push({raw:title,canonicalTitle:v.canonicalTitle,anilistId:v.anilistId,score:v.score});
    }
    await sleep(180);
  }
  return out.slice(0,MAX_ACTIVE_SERIES);
}
function sourceSeasonAliasKey(source={}){
  const channelId=String(source?.channelId||source?.id||'').trim();
  if(channelId)return 'id:'+channelId;
  const username=String(source?.username||source?.channelUsername||'').trim().replace(/^@/,'').toLowerCase();
  return username?'user:'+username:'';
}

function inferredSeasonAlias({candidateSeason,episode,direct,sequel,priorSeason}={}){
  const season=Number(candidateSeason||1),ep=Number(episode||0),prior=Number(priorSeason||0);
  if(season<=1||ep<=0||prior<=0||prior>=season||!direct?.ok)return null;
  if(sequel?.temporary===true)return null;
  if(sequel?.ok&&Number(sequel.anilistId||0)!==Number(direct.anilistId||0))return null;
  const episodeCount=Number(direct.episodes||0);
  if(episodeCount>0&&ep>episodeCount)return null;
  return prior;
}

async function existingSeasonAlias(source,anilistId,sourceSeason){
  const sourceKey=sourceSeasonAliasKey(source);
  const id=Number(anilistId||0),season=Number(sourceSeason||0);
  if(!sourceKey||!id||season<=1)return null;
  await ensureIndexes();
  const row=await (await db()).collection('nexanime_season_aliases').findOne({
    sourceKey,anilistId:id,sourceSeason:season,enabled:{$ne:false}
  });
  return Number(row?.canonicalSeason||0)>0?Number(row.canonicalSeason):null;
}

async function rememberSeasonAlias(source,anilistId,sourceSeason,canonicalSeason,{evidenceEpisode=0}={}){
  const sourceKey=sourceSeasonAliasKey(source);
  const id=Number(anilistId||0),from=Number(sourceSeason||0),to=Number(canonicalSeason||0);
  if(!sourceKey||!id||from<=1||to<=0||to>=from)return false;
  await ensureIndexes();
  const now=new Date();
  await (await db()).collection('nexanime_season_aliases').updateOne(
    {sourceKey,anilistId:id,sourceSeason:from},
    {$set:{
      sourceKey,anilistId:id,sourceSeason:from,canonicalSeason:to,
      evidenceEpisode:Number(evidenceEpisode||0),enabled:true,updatedAt:now
    },$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
  return true;
}

async function canonicalizeCandidate(c,source={}){
  if(!c||!['episode','presentation'].includes(c.kind))return c;
  const q=cleanSeriesTitle(c.title);
  const direct=await verifyAnimeTitle(q);
  if(direct.ok){
    let normalized={...c,title:direct.canonicalTitle,anilistId:direct.anilistId,verifiedAnime:true};
    const sourceSeason=Number(c.season??1);
    if(c.kind==='episode'&&sourceSeason>1&&Number(c.episode)>0){
      const knownAlias=await existingSeasonAlias(source,direct.anilistId,sourceSeason);
      if(knownAlias){
        return {...normalized,season:knownAlias,sourceSeason,seasonAliasApplied:true};
      }

      const sequel=await verifyAnimeTitle(q+' Season '+sourceSeason);
      if(sequel?.ok&&Number(sequel.anilistId||0)!==Number(direct.anilistId||0)){
        return {...c,title:sequel.canonicalTitle,anilistId:sequel.anilistId,verifiedAnime:true};
      }

      if(sequel?.temporary!==true){
        const d=await db();
        const prior=await d.collection('nexanime_publications').findOne(
          {
            seriesKey:norm(direct.canonicalTitle),kind:'episode',
            season:{$lt:sourceSeason},episode:Number(c.episode),
            purgedAt:{$exists:false}
          },
          {sort:{season:-1},projection:{season:1}}
        );
        const target=inferredSeasonAlias({
          candidateSeason:sourceSeason,episode:Number(c.episode),direct,sequel,
          priorSeason:Number(prior?.season||0)
        });
        if(target){
          await rememberSeasonAlias(source,direct.anilistId,sourceSeason,target,{evidenceEpisode:Number(c.episode)});
          return {...normalized,season:target,sourceSeason,seasonAliasApplied:true};
        }
      }
    }
    return normalized;
  }
  const anchors=Array.isArray(source.seriesAnchors)?source.seriesAnchors:[];
  const anchor=bestAnchor(q,anchors);
  if(anchor){
    return {...c,title:anchor.canonicalTitle,anilistId:anchor.anilistId,verifiedAnime:true};
  }
  return {...c,verifiedAnime:false,verificationTemporary:direct.temporary===true};
}
function episodeIdentityCompatible(item,candidate,verified=null){
  if(!item||!candidate||candidate.kind!=='episode')return false;
  if(Number(item.episode)!==Number(candidate.episode))return false;
  if(item.season!=null&&candidate.season!=null&&Number(item.season)!==Number(candidate.season))return false;

  const itemId=Number(item.anilistId||0);
  const verifiedId=Number(verified?.anilistId||0);
  if(itemId&&verified?.ok&&verifiedId)return itemId===verifiedId;

  const expected=cleanSeriesTitle(item.title||'');
  const observed=cleanSeriesTitle(verified?.ok?(verified.canonicalTitle||candidate.title):candidate.title);
  if(!expected||!observed)return false;
  const en=norm(expected),on=norm(observed);
  if(en===on)return true;
  if(en.length>=5&&on.length>=5&&(en.includes(on)||on.includes(en)))return true;
  return titleSimilarity(expected,observed)>=0.62;
}
async function validateResolvedEpisodeIdentity(item,resolved){
  if(item?.synthetic===true||item?.kind!=='episode')return true;
  const sourceMeta={
    username:resolved?.entity?.username||resolved?.source?.channelUsername||'',
    title:resolved?.entity?.title||resolved?.source?.channelTitle||''
  };
  const candidate=classifyMessage(resolved?.message,sourceMeta);
  if(candidate?.kind!=='episode'){
    const error=new Error('source_identity_mismatch: source message is not a verified episode');
    error.code='SOURCE_IDENTITY_MISMATCH';
    throw error;
  }
  const verified=await verifyAnimeTitle(candidate.title);
  let normalizedCandidate=candidate;
  if(verified?.ok&&Number(candidate.season||1)>1){
    const alias=await existingSeasonAlias(
      {
        channelId:String(resolved?.source?.channelId||resolved?.entity?.id||''),
        username:resolved?.source?.channelUsername||resolved?.entity?.username||''
      },
      verified.anilistId,
      Number(candidate.season)
    );
    if(alias)normalizedCandidate={...candidate,season:alias};
  }
  if(!episodeIdentityCompatible(item,normalizedCandidate,verified)){
    const error=new Error(
      'source_identity_mismatch: expected '+String(item.title||'?')+
      ' S'+String(item.season??1)+'E'+String(item.episode??'?')+
      ', observed '+String(candidate.title||'?')+
      ' S'+String(candidate.season??1)+'E'+String(candidate.episode??'?')
    );
    error.code='SOURCE_IDENTITY_MISMATCH';
    throw error;
  }
  return true;
}

function releaseKey(c){
  const title=norm(c.title);
  return [title,'s'+(c.season??1),'e'+c.episode,(c.language||'UNK').toUpperCase(),(c.quality||'AUTO').toLowerCase()].join('|');
}
function presentationKey(c){
  return [norm(c.title),'presentation','s'+(c.season??0),'e'+(c.episode??0)].join('|');
}
function htmlEscape(value=''){
  return String(value).replace(/[&<>"']/g,ch=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[ch]);
}
function quotedCaption(c){
  return '<blockquote>'+htmlEscape(standardizedCaption(c))+'</blockquote>';
}

function standardizedCaption(c){
  if(c.kind==='presentation'||c.kind==='resume_presentation'){
    return clip([c.title,c.cleanedCaption].filter(Boolean).join('\n\n'),1024);
  }
  return clip([
    c.title,
    'Season '+(c.season??1)+' · Episode '+c.episode,
    [c.language,c.quality].filter(Boolean).join(' · '),
    '@'+DESTINATION
  ].filter(Boolean).join('\n'),1024);
}
function hasPreviousEpisodeNav(message){
  const text=String(message?.message||'');
  if(/\b(?:episode|épisode)\s+(?:précédent|precedent|previous)\b/i.test(text))return true;
  for(const row of message?.replyMarkup?.rows||[]){
    for(const button of row?.buttons||[]){
      const label=String(button?.text||'');
      if(/\b(?:episode|épisode)\s+(?:précédent|precedent|previous)\b/i.test(label))return true;
    }
  }
  return false;
}

function classifyMessage(message,source={}){
  const raw=signalText(message);
  const text=String(message?.message||'');
  const blocked=hasBlocked(raw);
  if(blocked)return {kind:'blocked',reason:'adult_betting_or_spam'};
  const episodeEvidence=episodeEvidenceFromMessage(message);
  const ep=episodeEvidence.episode||parseEpisode(raw);
  const mk=mediaKind(message);
  const lang=detectLanguage(raw),quality=detectQuality(raw);
  const titleEvidence=titleEvidenceFromMessage(message,ep);
  const title=titleFromMessage(message,ep);
  const obviousNonEpisode=NON_EPISODE_RE.test(raw);
  if(ep && (titleEvidence.conflict||episodeEvidence.conflict) && !obviousNonEpisode && (mk==='video'||mk==='document')){
    return {
      kind:'conflict',
      reason:titleEvidence.conflict?'caption_filename_title_conflict':'caption_filename_episode_conflict',
      title,season:ep.season??1,episode:ep.episode,language:lang,quality,
      mediaKind:mk,originalFilename:filename(message),confidence:0
    };
  }
  if(ep && title && !obviousNonEpisode && (mk==='video'||mk==='document')){
    const cleanedCaption=cleanCaption(text,source);
    const season=ep.season??1;
    return {
      kind:'episode',title,season,episode:ep.episode,language:lang,quality,
      sourcePreviousNav:hasPreviousEpisodeNav(message),
      mediaKind:mk,originalFilename:filename(message),
      cleanedFilename:safeFilename(title,season,ep.episode,lang,quality,filename(message)),
      cleanedCaption,confidence:0.92
    };
  }
  // Episode-numbered images are source context only. They are not episodes and
  // must never become public "episode cards" in Otaku Nexus.
  if(message?.photo && ep && !obviousNonEpisode){
    return {kind:'ignore',reason:'episode_image_card_context_only'};
  }
  if(message?.photo && text.trim() && PRESENTATION_RE.test(text) && !looksPromotional(text)){
    const presentTitle=stripNoiseTitle(text.split(/\r?\n/)[0]||'','');
    if(presentTitle.length>=2){
      return {
        kind:'presentation',title:presentTitle,season:null,episode:null,language:lang,quality,
        sourcePreviousNav:false,
        mediaKind:'photo',originalFilename:'',cleanedFilename:'',
        cleanedCaption:cleanCaption(text,source),confidence:0.82
      };
    }
  }
  return {kind:'ignore',reason:obviousNonEpisode?'non_episode_anime_content':'not_anime_release'};
}

async function cleanupTmpFiles(maxAgeMs=TMP_RETENTION_MS){
  await fs.mkdir(TMP_ROOT,{recursive:true});
  const now=Date.now();
  for(const name of await fs.readdir(TMP_ROOT).catch(()=>[])){
    const p=path.join(TMP_ROOT,name);
    try{
      const st=await fs.stat(p);
      if(st.isFile()&&now-st.mtimeMs>maxAgeMs)await fs.rm(p,{force:true});
    }catch{}
  }
}
function retainedTmpPath(prefix,item,ext='.bin'){
  const key=String(item?.dedupeKey||item?._id||item?.sourceMessageId||'media');
  const tag=crypto.createHash('sha256').update(key).digest('hex').slice(0,24);
  return path.join(TMP_ROOT,`${prefix}-${tag}${ext}`);
}
async function retainedMediaFile(client,message,target){
  // The target may live outside TMP_ROOT (notably the WhatsApp shared stage).
  // Always create the actual parent before teleproto opens its WriteStream;
  // otherwise an ENOENT is emitted on the stream and can terminate NexAccount.
  await fs.mkdir(path.dirname(target),{recursive:true});
  try{
    const existing=await fs.stat(target);
    if(existing.isFile()&&existing.size>0){
      const now=new Date();
      await fs.utimes(target,now,now).catch(()=>{});
      return target;
    }
  }catch{}
  const partial=target+`.part-${process.pid}-${Date.now()}`;
  try{
    const out=await client.downloadMedia(message.media,{outputFile:partial,workers:1});
    const file=typeof out==='string'&&out?out:partial;
    const st=await fs.stat(file);
    if(!st.isFile()||st.size<=0)throw new Error('anime_media_download_empty');
    if(file!==target){
      await fs.rm(target,{force:true}).catch(()=>{});
      await fs.rename(file,target);
    }
    return target;
  }catch(error){
    await fs.rm(partial,{force:true}).catch(()=>{});
    throw error;
  }
}
async function removeTmpFile(file){
  if(file)await fs.rm(file,{force:true}).catch(()=>{});
}

function whatsappCaption(caption=''){
  const buttons=[];
  const seen=new Set();
  const add=(text,url)=>{
    const u=String(url||'').trim();
    if(!/^https?:\/\//i.test(u)||seen.has(u))return;
    seen.add(u);buttons.push({text:String(text||'Ouvrir').replace(/<[^>]+>/g,' ').trim().slice(0,64)||'Ouvrir',url:u});
  };
  let plain=String(caption||'').replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(m,url,label)=>{add(label,url);return String(label).replace(/<[^>]+>/g,' ')+'\n'+url;});
  plain=plain.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ');
  plain=plain.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  plain=plain.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return {text:plain,buttons:buttons.slice(0,12)};
}
async function cleanupWhatsAppStage(){
  await fs.mkdir(WHATSAPP_STAGE_ROOT,{recursive:true});
  const cutoff=Date.now()-WHATSAPP_STAGE_TTL_MS;
  for(const name of await fs.readdir(WHATSAPP_STAGE_ROOT).catch(()=>[])){
    const file=path.join(WHATSAPP_STAGE_ROOT,name);
    try{const st=await fs.stat(file);if(st.isFile()&&st.mtimeMs<cutoff)await fs.rm(file,{force:true});}catch{}
  }
}
async function stageAnimeForWhatsApp(runtime,item,resolved){
  const message=resolved?.message;
  if(item?.synthetic===true&&item?.imageUrl){
    return [{type:'photo',url:String(item.imageUrl),fileName:'anime-presentation.jpg',mimetype:'image/jpeg',position:0}];
  }
  if(!message?.media)return [];
  // Do not swallow stage-directory failures. Let the caller handle them
  // as a mirror failure instead of attempting a download into a missing path.
  await cleanupWhatsAppStage();
  const original=item?.cleanedFilename||item?.originalFilename||filename(message)||('anime-'+String(item?._id||Date.now()));
  const type=message?.photo?'photo':item?.mediaKind==='video'?'video':item?.mediaKind==='document'?'document':mediaKind(message);
  let ext=path.extname(original);
  if(!ext)ext=type==='photo'?'.jpg':type==='video'?'.mp4':'.bin';
  const key=crypto.createHash('sha256').update(String(item?.dedupeKey||item?._id||Date.now())).digest('hex').slice(0,24);
  const safeBase=String(original).replace(/[^A-Za-z0-9._ -]+/g,'_').slice(-120).replace(/\.[^.]+$/,'')||'anime';
  const target=path.join(WHATSAPP_STAGE_ROOT,key+'-'+safeBase+ext);
  const file=await retainedMediaFile(runtime.client,message,target);
  await fs.chmod(file,0o640).catch(()=>{});
  const mimetype=message?.photo?'image/jpeg':String(message?.document?.mimeType||'application/octet-stream');
  return [{type,localPath:file,fileName:path.basename(file),mimetype,position:0}];
}
async function mirrorPublishedAnimeToWhatsApp(runtime,item,resolved,sent){
  const sourceMessageId=Number(sent?.messageId||sent?.id||0);
  if(!sourceMessageId)return {skipped:true,reason:'missing_destination_message_id'};
  const caption=await publicationCaption(item);
  const formatted=whatsappCaption(caption);
  let mediaItems=[];
  try{mediaItems=await stageAnimeForWhatsApp(runtime,item,resolved);}
  catch(error){
    console.warn('[NexAnime/WhatsApp] media stage failed',String(item?.dedupeKey||''),String(error?.message||error).slice(0,260));
    if(item?.kind==='episode')return {queued:false,error:String(error?.message||error)};
  }
  const payload={
    id:'nexanime:'+String(item?.dedupeKey||sourceMessageId),
    source:DESTINATION.toLowerCase(),
    sourceMessageId,
    text:formatted.text,
    mediaItems,
    buttons:formatted.buttons,
    createdAt:new Date().toISOString()
  };
  let lastError=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await fetch(WHATSAPP_BRIDGE,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(payload),
        signal:AbortSignal.timeout(30_000)
      });
      const out=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(String(out?.error||('WhatsApp bridge HTTP '+response.status)));
      console.log('[NexAnime/WhatsApp] queued',String(item?.dedupeKey||''),'message #'+sourceMessageId,out?.duplicate?'duplicate':'ok');
      return {queued:true,...out};
    }catch(error){
      lastError=error;
      if(attempt<3)await sleep(1500*attempt);
    }
  }
  console.warn('[NexAnime/WhatsApp] enqueue failed',String(item?.dedupeKey||''),String(lastError?.message||lastError).slice(0,260));
  return {queued:false,error:String(lastError?.message||lastError)};
}

async function currentMediaPolicy(){
  if(MEDIA_POLICY_CACHE.expires>Date.now())return MEDIA_POLICY_CACHE.value;
  try{
    const d=await db();
    const row=await d.collection('nexanime_config').findOne({_id:'global'});
    const value=String(row?.mediaPolicy||MEDIA_POLICY_DEFAULT).toLowerCase();
    MEDIA_POLICY_CACHE={value,expires:Date.now()+30_000};
    return value;
  }catch{
    return MEDIA_POLICY_DEFAULT;
  }
}
async function mediaReuploadAllowed(){
  const p=await currentMediaPolicy();
  return p==='authorized'||p==='allow'||p==='allowed';
}
async function recoverAwaitingRightsIfAuthorized(d){
  if(!(await mediaReuploadAllowed()))return 0;
  const now=new Date();
  const result=await d.collection('nexanime_queue').updateMany(
    {kind:'episode',status:'awaiting_rights'},
    {$set:{
      status:'queued',
      attempts:0,
      recoveredAt:now,
      recoveredReason:'media_policy_authorized',
      updatedAt:now
    },$unset:{
      lastError:'',claimAt:'',claimBy:'',retryAfter:'',lastTransientAt:''
    }}
  );
  return Number(result?.modifiedCount||0);
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
    d.collection('nexanime_series_cache').createIndex({key:1},{unique:true}),
    d.collection('nexanime_season_aliases').createIndex({sourceKey:1,anilistId:1,sourceSeason:1},{unique:true}),
    d.collection(NEXCANAL_HANDOFF_COLLECTION).createIndex({dedupeKey:1},{unique:true}),
    d.collection(NEXCANAL_HANDOFF_COLLECTION).createIndex({status:1,nextAttemptAt:1,createdAt:1})
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
    channelAccessHash:String(entity?.accessHash||''),
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
function sourceRank(row={}){
  const sample=Math.max(1,Number(row.sampleSize||1));
  const anime=Number(row.animeSignals||0);
  const blocked=Number(row.blockedSignals||0);
  const ratio=anime/sample;
  const blockedRatio=blocked/sample;
  return ratio*100 + Math.min(30,anime*1.2) - blockedRatio*90 - blocked*1.5;
}
function selectedSource(row){return acceptedSource(row)&&row?.selected===true}

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
    channelAccessHash:String(entity?.accessHash||''),
    messageId:Number(message?.id||0)
  };
  const dedupeKey=c.kind==='episode'?releaseKey(c):presentationKey(c);
  const priority=mode==='live'?1000:100;
  const seriesKey=norm(c.title);

  // Verified per-season limits are durable ingestion guards. They are only
  // populated after an external season identity/count has been verified.
  // This prevents a stale/misclassified source post (for example a bogus E17
  // on an 8-episode season) from recreating the same scheduler gap on rescan.
  if(c.kind==='episode'&&Number.isFinite(Number(c.episode))){
    const season=Number(c.season??1);
    const constraint=await d.collection('nexanime_series_constraints').findOne({
      seriesKey,season,enabled:{$ne:false}
    });
    const maxEpisode=Number(constraint?.maxEpisode||0);
    if(maxEpisode>0&&Number(c.episode)>maxEpisode){
      await d.collection('nexanime_queue').updateOne(
        {dedupeKey},
        {
          $setOnInsert:{
            dedupeKey,kind:c.kind,seriesKey,title:c.title,season,episode:c.episode,
            language:c.language||'',quality:c.quality||'',destination:'@'+DESTINATION,
            mode,createdAt:now,attempts:0
          },
          $set:{
            status:'rejected',
            rejectionReason:'episode_exceeds_verified_season_count',
            verifiedMaxEpisode:maxEpisode,
            updatedAt:now
          },
          $max:{priority},
          $addToSet:{sources:source},
          $unset:{claimAt:'',claimBy:'',lastError:'',quarantineReason:''}
        },
        {upsert:true}
      );
      runtime.animeIngest ??={};
      runtime.animeIngest.rejected=(runtime.animeIngest.rejected||0)+1;
      return dedupeKey;
    }
  }

  const payload={
    dedupeKey,status:'queued',kind:c.kind,seriesKey,title:c.title,anilistId:c.anilistId??null,ingestedAt:now,
    season:c.season??null,episode:c.episode??null,language:c.language||'',
    quality:c.quality||'',sourcePreviousNav:c.sourcePreviousNav===true,mediaKind:c.mediaKind||'text',
    cleanedCaption:c.cleanedCaption||'',cleanedFilename:c.cleanedFilename||'',
    originalFilename:c.originalFilename||'',confidence:c.confidence||0,
    destination:'@'+DESTINATION,mode
  };
  const queue=d.collection('nexanime_queue');
  // If discovery finds a genuinely new source for an item that was quarantined
  // only because its previous source failed identity validation, revive that item.
  // This lets a parked series heal itself without weakening episode validation.
  const recovered=await queue.updateOne(
    {
      dedupeKey,
      status:'quarantine',
      quarantineReason:'source_identity_mismatch',
      sources:{$not:{$elemMatch:{
        accountId:source.accountId,
        channelId:source.channelId,
        messageId:source.messageId
      }}}
    },
    {
      $set:{
        ...payload,status:'queued',attempts:0,
        recoveredAt:now,recoveredReason:'new_source_after_identity_mismatch',updatedAt:now
      },
      $max:{priority},
      $addToSet:{sources:source},
      $unset:{quarantineReason:'',lastError:'',claimAt:'',claimBy:''}
    }
  );
  if(Number(recovered.modifiedCount||0)>0 && c.kind==='episode'){
    await d.collection('nexanime_config').updateOne(
      {
        _id:'scheduler',
        blockedSeriesKey:seriesKey,
        'gapDetected.season':Number(c.season??1),
        'gapDetected.expectedEpisode':Number(c.episode)
      },
      {
        $set:{forcedNextSeriesKey:seriesKey,updatedAt:now},
        $unset:{
          blockedSeriesKey:'',blockedSeriesUntil:'',blockedSeriesReason:'',gapDetected:''
        }
      }
    ).catch(()=>{});
  }
  if(Number(recovered.modifiedCount||0)===0){
    await queue.updateOne(
      {dedupeKey},
      {
        $setOnInsert:{...payload,createdAt:now,attempts:0},
        $set:{updatedAt:now},
        $max:{priority},
        $addToSet:{sources:source}
      },
      {upsert:true}
    );
  }
  await queue.updateOne(
    {dedupeKey,status:'superseded'},
    {
      $set:{...payload,status:'queued',updatedAt:now},
      $unset:{supersededAt:'',claimAt:'',claimBy:'',lastError:'',quarantineReason:''},
      $addToSet:{sources:source}
    }
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
async function backfillSource(runtime,entity,knownAnchors=null){
  const accountId=String(runtime.account.telegramUserId);
  const anchors=Array.isArray(knownAnchors)?knownAnchors:await activeSeriesAnchors(runtime,entity);
  if(!anchors.length){
    console.log('[NexAnime] no verified anime series',accountId,String(entity?.username||entity?.id||''));
    return 0;
  }
  const source={channelId:String(entity?.id||''),username:entity?.username||'',title:entity?.title||'',seriesAnchors:anchors};
  const history=await runtime.client.getMessages(entity,{limit:BACKFILL_LIMIT});
  const found=[];
  for(const m of history){
    let c=classifyMessage(m,source);
    if(c.kind!=='episode'&&c.kind!=='presentation')continue;
    c=await canonicalizeCandidate(c,source);
    if(!c?.verifiedAnime)continue;
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


async function setDiscoveryState(runtime,discovering){
  try{
    const d=await db();
    const now=new Date();
    const patch={
      username:String(runtime.account.username||''),
      discovering:discovering===true,
      updatedAt:now
    };
    if(discovering===true)patch.lastDiscoveryStartedAt=now;
    else patch.lastDiscoveryCompletedAt=now;
    await d.collection('nexanime_listener_state').updateOne(
      {_id:String(runtime.account.telegramUserId)},
      {$set:patch},
      {upsert:true}
    );
  }catch{}
}
async function anyDiscoveryInProgress(){
  const d=await db();
  const rebuild=await d.collection('nexanime_config').findOne({_id:'rebuild'});
  if(rebuild?.mode!=='rebuild')return false;

  const active=await d.collection('nexanime_listener_state').findOne({
    discovering:true,
    updatedAt:{$gt:new Date(Date.now()-2*60*60*1000)}
  },{projection:{_id:1}});
  if(active)return true;

  const startedAt=new Date(rebuild.startedAt||0);
  const completed=await d.collection('nexanime_listener_state').find({
    username:{$in:[...LISTENERS]},
    lastDiscoveryCompletedAt:{$gte:startedAt}
  },{projection:{username:1}}).toArray();
  const doneUsers=new Set(completed.map(x=>String(x.username||'').toLowerCase()));
  for(const username of LISTENERS){
    if(!doneUsers.has(username))return true;
  }

  const fresh=await d.collection('nexanime_queue').findOne(
    {
      status:'queued',
      ingestedAt:{$gt:new Date(Date.now()-90_000)}
    },
    {projection:{_id:1}}
  );
  return !!fresh;
}

function isTransientAnimeDisconnect(error){
  const message=String(error?.errorMessage||error?.message||error||'');
  return /disconnected|cannot send requests while disconnected|not connected|connection closed|socket.*closed|dc \d+/i.test(message);
}
async function ensureAnimeClientReady(runtime){
  let lastError=null;
  for(let attempt=0;attempt<5;attempt++){
    try{
      if(!runtime.client?.connected)await runtime.client.connect();
      await runtime.client.getDialogs({limit:1});
      return true;
    }catch(error){
      lastError=error;
      if(attempt<4)await sleep(Math.min(5000,1000*(attempt+1)));
    }
  }
  throw lastError||new Error('anime_client_not_connected');
}
function scheduleDiscoveryRetry(runtime,delayMs=5000){
  runtime.animeIngest ??={};
  if(runtime.animeIngest.discoveryRetryTimer)return;
  runtime.animeIngest.discoveryRetryTimer=setTimeout(()=>{
    runtime.animeIngest.discoveryRetryTimer=null;
    discoverSources(runtime).catch(error=>console.error('[NexAnime discovery retry]',String(error?.message||error)));
  },delayMs);
  runtime.animeIngest.discoveryRetryTimer.unref?.();
}

async function discoverSources(runtime){
  if(!isListenerRuntime(runtime))return [];
  runtime.animeIngest ??={};
  if(runtime.animeIngest.discovering)return [];
  runtime.animeIngest.discovering=true;
  await setDiscoveryState(runtime,true);
  try{
    await ensureAnimeClientReady(runtime);
    const dialogs=await runtime.client.getDialogs({limit:DIALOG_LIMIT});
    const candidates=[];
    for(const dialog of dialogs){
      const entity=dialog?.entity;
      if(!entity?.id||!entity?.broadcast)continue;
      if(String(entity?.username||'').toLowerCase()===DESTINATION.toLowerCase())continue;
      try{
        const row=await classifySource(runtime,entity);
        if(acceptedSource(row))candidates.push({row,entity,rank:sourceRank(row)});
        await sleep(80);
      }catch(e){
        if(isTransientAnimeDisconnect(e))throw e;
        console.warn('[NexAnime discover]',String(runtime.account.telegramUserId),String(entity?.username||entity?.id||''),String(e?.message||e).slice(0,220));
      }
    }

    candidates.sort((a,b)=>b.rank-a.rank||Number(b.row.animeSignals||0)-Number(a.row.animeSignals||0));

    // "Looks like episodes" is not enough. Before selecting a source, prove that
    // at least one of its recent series resolves to a real non-adult anime.
    const verified=[];
    const shortlist=candidates.slice(0,Math.min(candidates.length,MAX_SELECTED_SOURCES*3));
    for(const candidate of shortlist){
      try{
        const anchors=await activeSeriesAnchors(runtime,candidate.entity);
        if(!anchors.length)continue;
        verified.push({...candidate,anchors,rank:candidate.rank+Math.min(20,anchors.length*2)});
        if(verified.length>=MAX_SELECTED_SOURCES)break;
      }catch(e){
        if(isTransientAnimeDisconnect(e))throw e;
        console.warn('[NexAnime source-verify]',String(runtime.account.telegramUserId),String(candidate.entity?.username||candidate.entity?.id||''),String(e?.message||e).slice(0,220));
      }
    }
    verified.sort((a,b)=>b.rank-a.rank||Number(b.row.animeSignals||0)-Number(a.row.animeSignals||0));
    const selected=verified.slice(0,MAX_SELECTED_SOURCES);

    const d=await db();
    const accountId=String(runtime.account.telegramUserId);
    await d.collection('nexanime_sources').updateMany(
      {accountId},
      {$set:{selected:false,selectionUpdatedAt:new Date()}}
    );
    for(let i=0;i<selected.length;i++){
      const {row,entity,rank,anchors}=selected[i];
      await d.collection('nexanime_sources').updateOne(
        {accountId,channelId:String(row.channelId)},
        {$set:{
          selected:true,
          sourceRank:Number(rank.toFixed(3)),
          selectionPosition:i+1,
          selectionUpdatedAt:new Date(),
          verifiedAnimeSeries:anchors.length,
          seriesAnchors:anchors
        }}
      );
      const cacheKey=accountId+':'+String(row.channelId);
      const cached=SOURCE_CACHE.get(cacheKey);
      if(cached)SOURCE_CACHE.set(cacheKey,{...cached,selected:true,sourceRank:rank,selectionPosition:i+1,seriesAnchors:anchors,verifiedAnimeSeries:anchors.length});
      try{
        await backfillSource(runtime,entity,anchors);
      }catch(e){
        if(isTransientAnimeDisconnect(e))throw e;
        console.warn('[NexAnime backfill]',accountId,String(entity?.username||entity?.id||''),String(e?.message||e).slice(0,220));
      }
    }
    runtime.animeIngest.sources=selected.length;
    runtime.animeIngest.lastDiscoveryAt=new Date();
    return selected.map(x=>({...x.row,selected:true,sourceRank:x.rank,verifiedAnimeSeries:x.anchors.length}));
  }catch(error){
    if(isTransientAnimeDisconnect(error))scheduleDiscoveryRetry(runtime,5000);
    throw error;
  }finally{
    runtime.animeIngest.discovering=false;
    await setDiscoveryState(runtime,false);
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
      .find({accountId:String(runtime.account.telegramUserId),selected:true,classification:{$in:['anime','mixed']}})
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
export function isPublisherRuntime(runtime){
  if(!ENABLED)return false;
  return runtime?.nexCanalHandoffWorker===true || runtime?.animePublisher===true;
}

export async function handleAnimeIngestEvent(runtime,event){
  if(!isListenerRuntime(runtime)||runtime?.animeScanDisabled===true)return false;
  const message=event?.message;
  if(!message?.peerId?.channelId)return false;
  const entity=await entityForMessage(runtime.client,message);
  if(!entity?.broadcast)return false;
  if(String(entity?.username||'').toLowerCase()===DESTINATION.toLowerCase())return false;
  let source=await cachedSource(runtime.account.telegramUserId,entity);
  if(!source || source.classification==='candidate'){
    source=await classifySource(runtime,entity);
  }
  if(!selectedSource(source))return false;
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

async function resolveSource(runtime,item,{maxSources=Infinity}={}){
  const sources=Array.isArray(item.sources)?item.sources:[];
  const accountId=String(runtime.account.telegramUserId);
  const ordered=[
    ...sources.filter(s=>String(s.accountId)===accountId),
    ...sources.filter(s=>String(s.accountId)!==accountId)
  ].slice(0,maxSources);
  let lastIdentityError=null;
  for(const source of ordered){
    const sourceIdentity=norm([source?.channelTitle,source?.channelUsername].filter(Boolean).join(' '));
    if(SOURCE_BLOCK_RE.test(sourceIdentity)){
      const error=new Error('source_identity_mismatch: blocked non-anime/live-action source');
      error.code='SOURCE_IDENTITY_MISMATCH';
      lastIdentityError=error;
      continue;
    }
    for(const readerRuntime of liveRuntimeCandidates(source,runtime)){
      const client=readerRuntime.client;
      let entity=null;
      const username=String(source?.channelUsername||'').replace(/^@/,'');
      const channelId=String(source?.channelId||'').trim();
      const channelAccessHash=String(source?.channelAccessHash||source?.accessHash||'').trim();
      if(username){
        try{entity=await client.getEntity(username)}catch{}
      }
      if(!entity&&channelId&&channelAccessHash){
        try{
          entity=new Api.InputChannel({
            channelId:BigInt(channelId),
            accessHash:BigInt(channelAccessHash)
          });
        }catch{}
      }
      if(!entity&&channelId){
        try{entity=await client.getEntity(BigInt(channelId))}catch{}
      }
      if(!entity&&channelId){
        try{
          const dialogs=await client.getDialogs({limit:500});
          const match=(Array.isArray(dialogs)?dialogs:[]).find(row=>
            String(row?.entity?.id||row?.id||'')===channelId
          );
          entity=match?.entity||null;
        }catch{}
      }
      if(!entity)continue;
      try{
        const messages=await client.getMessages(entity,{ids:[Number(source.messageId)]});
        const message=Array.isArray(messages)?messages[0]:messages;
        if(!message)continue;
        const resolved={source,entity,message,runtime:readerRuntime};
        if(item?.synthetic!==true&&item?.kind==='episode'){
          try{
            await validateResolvedEpisodeIdentity(item,resolved);
          }catch(error){
            if(String(error?.code||'')==='SOURCE_IDENTITY_MISMATCH'){
              lastIdentityError=error;
              continue;
            }
            throw error;
          }
        }
        return resolved;
      }catch(error){
        if(String(error?.code||'')==='SOURCE_IDENTITY_MISMATCH'){
          lastIdentityError=error;
          continue;
        }
      }
    }
  }
  if(lastIdentityError)throw lastIdentityError;
  return null;
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

function targetMessageUrl(messageId){
  return 'https://t.me/'+DESTINATION+'/'+Number(messageId);
}
async function previousEpisodePublication(item){
  if(item?.episode==null)return null;
  const d=await db();
  return d.collection('nexanime_publications').findOne(
    {
      seriesKey:item.seriesKey,
      kind:'episode',
      $or:[
        {season:{$lt:Number(item.season??1)}},
        {season:Number(item.season??1),episode:{$lt:Number(item.episode)}}
      ],
      telegramMessageId:{$gt:0},
      purgedAt:{$exists:false}
    },
    {sort:{season:-1,episode:-1,publishedAt:-1}}
  );
}
function shouldShowPreviousLink(item){
  // Every published episode should link to the latest earlier episode when one
  // exists in Otaku Nexus. Backfill/resume items must not lose navigation.
  return item?.episode!=null;
}
async function publicationCaption(item){
  let body=standardizedCaption(item);
  if(shouldShowPreviousLink(item)){
    const previous=await previousEpisodePublication(item);
    if(previous?.telegramMessageId){
      body += '\n\n<a href="'+htmlEscape(targetMessageUrl(previous.telegramMessageId))+'">Épisode précédent</a>';
      return '<blockquote>'+htmlEscape(standardizedCaption(item))+'\n\n<a href="'+htmlEscape(targetMessageUrl(previous.telegramMessageId))+'">Épisode précédent</a></blockquote>';
    }
  }
  return '<blockquote>'+htmlEscape(body)+'</blockquote>';
}

async function publishSyntheticPresentation(runtime,item,destination){
  const caption=await publicationCaption(item);
  if(!item.imageUrl){
    return runtime.client.sendMessage(destination,{message:caption,parseMode:'html'});
  }
  const response=await fetch(String(item.imageUrl),{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('presentation_image_http_'+response.status);
  const data=Buffer.from(await response.arrayBuffer());
  if(data.length>10*1024*1024)throw new Error('presentation_image_too_large');
  return sendTelegramMedia(runtime.client,destination,data,{
    fileName:'anime-presentation',
    mimeType:response.headers.get('content-type')||'',
    kind:'image',
    caption,
    parseMode:'html',
    workers:1
  });
}

async function publishPresentation(runtime,item,resolved,destination){
  const message=resolved.message;
  const caption=await publicationCaption(item);
  if(message?.photo){
    const tmp=path.join(TMP_ROOT,'presentation-'+crypto.randomUUID()+'.jpg');
    await fs.mkdir(TMP_ROOT,{recursive:true});
    try{
      const out=await transferRuntime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
      const file=typeof out==='string'?out:tmp;
      return await runtime.client.sendFile(destination,{file,caption,parseMode:'html',workers:1});
    }finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
  }
  return runtime.client.sendMessage(destination,{message:caption,parseMode:'html'});
}
async function publishEpisode(runtime,item,resolved,destination){
  if(!(await mediaReuploadAllowed())){
    const err=new Error('media_reupload_requires_authorized_policy');
    err.code='MEDIA_POLICY';
    throw err;
  }
  const message=resolved.message;
  if(!message?.media)throw new Error('source_media_missing');
  const caption=await publicationCaption(item);

  // Fast path: reuse Telegram's existing media reference. This avoids downloading
  // full anime episodes to the server and prevents disk-quota crashes.
  try{
    return await runtime.client.sendFile(destination,{
      file:message.media,
      caption,
      parseMode:'html',
      forceDocument:item.mediaKind==='document',
      supportsStreaming:item.mediaKind==='video'
    });
  }catch(directError){
    const size=Number(message?.document?.size||0);
    // Only fall back to a local re-upload for small files. Large files must never
    // fill the server disk; they are retried/quarantined instead.
    if(size>25*1024*1024){
      const err=new Error('telegram_direct_copy_failed: '+String(directError?.message||directError));
      err.code='DIRECT_COPY';
      throw err;
    }
  }

  const finalName=item.cleanedFilename||safeFilename(item.title,item.season,item.episode,item.language,item.quality,filename(message));
  const ext=path.extname(finalName)||'.bin';
  const tmp=retainedTmpPath('episode-direct',item,ext);
  const thumb=await destinationThumb(runtime,destination);
  const file=await retainedMediaFile(runtime.client,message,tmp);
  const data=await fs.readFile(file);
  const sent=await sendTelegramMedia(runtime.client,destination,data,{
    fileName:finalName,
    mimeType:String(message?.document?.mimeType||''),
    kind:item.mediaKind==='document'?'document':'auto',
    caption,
    parseMode:'html',
    workers:1,
    thumb
  });
  await removeTmpFile(file);
  return sent;
}
async function markPublication(item,sent,runtime){
  const d=await db(),now=new Date();
  const accountFallback=String(sent?.via||'')==='account-fallback';
  await d.collection('nexanime_publications').updateOne(
    {dedupeKey:item.dedupeKey},
    {$setOnInsert:{
      dedupeKey:item.dedupeKey,seriesKey:item.seriesKey,kind:item.kind,title:item.title,season:item.season,episode:item.episode,
      language:item.language||'',quality:item.quality||'',mode:item.mode||'',destination:'@'+DESTINATION,createdAt:now
    },$set:{
      publishedAt:now,
      publisherRole:accountFallback?'account-fallback':'nexcanal-bot',
      ...(accountFallback?{
        publisherAccountId:String(runtime.account.telegramUserId),
        publisherUsername:String(runtime.account.username||'')
      }:{
        publisherBotUsername:NEXCANAL_STAGE_BOT,
        stagingAccountId:String(runtime.account.telegramUserId),
        stagingAccountUsername:String(runtime.account.username||'')
      }),
      telegramMessageId:Number(sent?.id||sent?.messageId||0)
    },$unset:{
      purgedAt:'',purgedBy:'',purgeError:'',
      ...(accountFallback?{publisherBotUsername:'',stagingAccountId:'',stagingAccountUsername:''}:{publisherAccountId:'',publisherUsername:''})
    }},
    {upsert:true}
  );
  await d.collection('nexanime_queue').updateOne(
    {_id:item._id},
    {$set:{status:'published',publishedAt:now,updatedAt:now},$unset:{claimAt:'',claimBy:'',retryAfter:'',lastTransientAt:''}}
  );
  if(item.kind==='episode'&&item.episode!=null){
    await d.collection('nexanime_config').updateOne(
      {_id:'scheduler'},
      {
        $set:{
          activeSeriesKey:String(item.seriesKey),
          activeSeriesStartedAt:now,
          lastPublishedSeriesKey:String(item.seriesKey),
          lastPublishedSeason:Number(item.season??1),
          lastPublishedEpisode:Number(item.episode),
          lastPublishedAt:now,
          updatedAt:now
        },
        $unset:{
          frontierHoldSeriesKey:'',frontierHoldSince:'',frontierHoldUntil:'',
          frontierRefreshSeriesKey:'',frontierRefreshRequestedAt:'',
          plannedSeriesKey:'',plannedAt:'',plannedSummary:'',cooldownUntil:''
        }
      },
      {upsert:true}
    ).catch(()=>{});
    await d.collection('nexanime_queue').updateMany(
      {
        _id:{$ne:item._id},
        seriesKey:item.seriesKey,
        kind:'episode',
        season:item.season??1,
        episode:item.episode,
        status:{$nin:['published','superseded']}
      },
      {$set:{
        status:'superseded',
        supersededAt:now,
        supersededReason:'episode_already_published',
        preferredDedupeKey:item.dedupeKey,
        updatedAt:now
      },$unset:{claimAt:'',claimBy:'',lastError:'',quarantineReason:''}}
    );
  }
}
function isTransientPublishError(error){
  const code=String(error?.code||'');
  const message=String(error?.message||error||'');
  return code==='SOURCE_UNAVAILABLE'||message==='source_message_unavailable_for_runtime';
}

const IN_PROGRESS_TRANSIENT_PARK_ATTEMPTS=12;
function shouldParkTransientEpisode(item,error,attempts,inProgress=false){
  const minimumAttempts=inProgress===true?IN_PROGRESS_TRANSIENT_PARK_ATTEMPTS:3;
  return Boolean(
    isTransientPublishError(error)&&
    item?.kind==='episode'&&
    String(item?.seriesKey||'')&&
    Number(attempts)>=minimumAttempts
  );
}

async function releaseClaim(item,error){
  const d=await db(),now=new Date();
  const attempts=Number(item.attempts||0)+1;
  const mediaPolicy=String(error?.code||'')==='MEDIA_POLICY';
  const identityMismatch=String(error?.code||'')==='SOURCE_IDENTITY_MISMATCH';
  const transient=isTransientPublishError(error);
  await d.collection('nexanime_queue').updateOne(
    {_id:item._id},
    {$set:{
      status:identityMismatch?'quarantine':(mediaPolicy?'awaiting_rights':'queued'),
      ...(identityMismatch?{quarantineReason:'source_identity_mismatch'}:{}),
      ...(transient?{
        retryAfter:new Date(now.getTime()+TRANSIENT_VARIANT_RETRY_MS),
        lastTransientAt:now
      }:{}),
      lastError:String(error?.message||error).slice(0,500),
      updatedAt:now
    },$inc:{attempts:1},$unset:{
      claimAt:'',claimBy:'',
      ...(!transient?{retryAfter:'',lastTransientAt:''}:{})
    }}
  );
  // A temporarily unreachable source must never quarantine the missing episode:
  // doing so creates a permanent gap deadlock (E(N) quarantined while E(N+1)
  // is blocked by the strict ordering gate). Keep it queued so newly discovered
  // alternate sources can be attached and retried safely.
  if(attempts>=5&&!mediaPolicy&&!identityMismatch&&!transient){
    await d.collection('nexanime_queue').updateOne({_id:item._id},{$set:{status:'quarantine',quarantineReason:'publish_failures',updatedAt:now}});
  }

  // Repeated source failures may park a series temporarily so one dead source
  // cannot block the whole feed. An in-progress series gets a much larger retry
  // budget so alternate copies can recover continuity, but it must not own the
  // global publisher forever when every source for the frontier episode is dead.
  let inProgress=false;
  if(transient&&item?.kind==='episode'&&String(item?.seriesKey||'')){
    inProgress=!!(await d.collection('nexanime_publications').findOne(
      {seriesKey:item.seriesKey,kind:'episode',purgedAt:{$exists:false}},
      {projection:{_id:1}}
    ));
  }
  if(shouldParkTransientEpisode(item,error,attempts,inProgress)){
    const cooldownUntil=await interSeriesDeadline(d,item.seriesKey,now);
    await d.collection('nexanime_config').updateOne(
      {_id:'scheduler',activeSeriesKey:item.seriesKey},
      {
        $set:{
          blockedSeriesKey:item.seriesKey,
          blockedSeriesUntil:new Date(now.getTime()+GAP_RETRY_MS),
          blockedSeriesReason:'source_unavailable_after_retries',
          cooldownUntil,
          gapDetected:{
            seriesKey:item.seriesKey,
            season:Number(item.season??1),
            expectedEpisode:item.episode==null?null:Number(item.episode),
            blockedEpisode:item.episode==null?null:Number(item.episode),
            detectedAt:now
          },
          updatedAt:now
        },
        $unset:{
          activeSeriesKey:'',activeSeriesStartedAt:'',
          plannedSeriesKey:'',plannedAt:'',plannedSummary:''
        }
      }
    );
  }
}

async function acquireGlobalPublishLock(runtime){
  await ensureIndexes();
  const d=await db();
  const owner=String(runtime.account.telegramUserId);
  const now=new Date();
  try{
    const row=await d.collection('nexanime_locks').findOneAndUpdate(
      {
        _id:'publisher',
        $or:[
          {expiresAt:{$exists:false}},
          {expiresAt:{$lte:now}},
          {owner}
        ]
      },
      {$set:{owner,expiresAt:new Date(Date.now()+120_000),updatedAt:now}},
      {upsert:true,returnDocument:'after'}
    );
    const doc=row?.value||row;
    return doc?.owner===owner;
  }catch(error){
    if(Number(error?.code)===11000)return false;
    throw error;
  }
}
async function releaseGlobalPublishLock(runtime){
  const d=await db();
  await d.collection('nexanime_locks').updateOne(
    {_id:'publisher',owner:String(runtime.account.telegramUserId)},
    {$set:{expiresAt:new Date(Date.now()+PUBLISHER_LEASE_GRACE_MS),updatedAt:new Date()}}
  ).catch(()=>{});
}
async function queuedSeriesCandidates(d,{excludeSeriesKeys=[]}={}){
  const excluded=[...new Set((excludeSeriesKeys||[]).map(String).filter(Boolean))];
  return d.collection('nexanime_queue').aggregate([
    {$match:{status:'queued',seriesKey:{$type:'string'}}},
    {$group:{
      _id:'$seriesKey',
      firstCreated:{$min:'$createdAt'},
      hasPresentation:{$max:{$cond:[{$eq:['$kind','presentation']},1,0]}},
      episodeCount:{$sum:{$cond:[{$eq:['$kind','episode']},1,0]}}
    }},
    {$match:{
      episodeCount:{$gt:0},
      ...(excluded.length?{_id:{$nin:excluded}}:{})
    }},
    {$sort:{hasPresentation:-1,firstCreated:1,_id:1}},
    {$limit:500}
  ]).toArray();
}
async function seriesHasRunnableFrontier(d,seriesKey){
  const first=await d.collection('nexanime_queue').findOne(
    {seriesKey,status:'queued',kind:'episode',episode:{$ne:null}},
    {sort:{season:1,episode:1,createdAt:1},projection:{season:1,episode:1}}
  );
  if(!first)return false;
  const season=Number(first.season??1);
  const episode=Number(first.episode);
  if(!Number.isFinite(episode))return false;
  if(episode<=1)return true;
  const previous=await d.collection('nexanime_publications').findOne(
    {seriesKey,kind:'episode',season,episode:episode-1,purgedAt:{$exists:false}},
    {projection:{_id:1}}
  );
  return !!previous;
}
async function nextRunnableSeriesKey(d,{excludeSeriesKeys=[]}={}){
  const candidates=await queuedSeriesCandidates(d,{excludeSeriesKeys});
  for(const candidate of candidates){
    if(await seriesHasRunnableFrontier(d,candidate._id))return candidate._id;
  }
  return '';
}
async function latestIncompletePublishedSeries(d,{excludeSeriesKeys=[]}={}){
  const excluded=new Set((excludeSeriesKeys||[]).map(String).filter(Boolean));
  const recent=await d.collection('nexanime_publications').find(
    {kind:'episode',purgedAt:{$exists:false},seriesKey:{$type:'string'}},
    {projection:{seriesKey:1,publishedAt:1}}
  ).sort({publishedAt:-1,_id:-1}).limit(80).toArray();
  const seen=new Set();
  for(const row of recent){
    const key=String(row?.seriesKey||'');
    if(!key||seen.has(key)||excluded.has(key))continue;
    seen.add(key);
    const remaining=await d.collection('nexanime_queue').countDocuments({
      seriesKey:key,kind:'episode',status:{$in:['queued','publishing']}
    });
    if(remaining>0&&await seriesHasRunnableFrontier(d,key))return key;
  }
  return '';
}

async function latestPublishedEpisode(d){
  return d.collection('nexanime_publications').findOne(
    {
      kind:'episode',
      purgedAt:{$exists:false},
      seriesKey:{$type:'string'},
      telegramMessageId:{$gt:0}
    },
    {
      sort:{publishedAt:-1,_id:-1},
      projection:{seriesKey:1,title:1,season:1,episode:1,publishedAt:1,telegramMessageId:1}
    }
  );
}

async function seriesConfirmedComplete(d,seriesKey){
  const last=await d.collection('nexanime_publications').findOne(
    {seriesKey,kind:'episode',purgedAt:{$exists:false}},
    {sort:{season:-1,episode:-1,publishedAt:-1,_id:-1},projection:{title:1,season:1,episode:1,publishedAt:1}}
  );
  if(!last?.title||!Number.isFinite(Number(last.episode))){
    return {confirmed:false,reason:'no_published_episode'};
  }
  const meta=await verifyAnimeTitle(last.title);
  const total=Number(meta?.episodes||0);
  const status=String(meta?.status||'').toUpperCase();
  const confirmed=Boolean(meta?.ok&&status==='FINISHED'&&total>0&&Number(last.episode)>=total);
  return {
    confirmed,
    reason:confirmed?'anilist_finished_and_last_episode_reached':'completion_not_confirmed',
    season:Number(last.season??1),
    episode:Number(last.episode),
    totalEpisodes:total||null,
    status:status||null,
    anilistId:Number(meta?.anilistId||0)||null
  };
}

async function restoreLastPublishedSeriesOwnership(d,scheduler,current,{requestedExclusions=[],persistedBlockedKeys=[],blockedSeriesKey='',blockActive=false,now=new Date()}={}){
  const last=await latestPublishedEpisode(d);
  const key=String(last?.seriesKey||'');
  if(!key)return current;
  const excluded=requestedExclusions.includes(key);
  const blocked=persistedBlockedKeys.includes(key)||(blockActive&&key===blockedSeriesKey);
  const completionConfirmed=String(current?.lastCompletedSeriesKey||'')===key&&current?.lastSeriesCompletionConfirmed===true;
  if(excluded||blocked||completionConfirmed||String(current?.activeSeriesKey||'')===key)return current;

  await scheduler.updateOne(
    {_id:'scheduler'},
    {
      $set:{
        activeSeriesKey:key,
        activeSeriesStartedAt:now,
        continuityResumeReason:'last_public_episode_owns_continuity',
        continuityResumedAt:now,
        lastPublishedSeriesKey:key,
        lastPublishedEpisode:Number(last?.episode??0)||null,
        lastPublishedSeason:Number(last?.season??1),
        updatedAt:now
      },
      $unset:{
        plannedSeriesKey:'',plannedAt:'',plannedSummary:'',cooldownUntil:'',
        frontierHoldSeriesKey:'',frontierHoldSince:'',frontierHoldUntil:'',
        frontierRefreshRequestedAt:''
      }
    },
    {upsert:true}
  );
  console.log('[NexAnime scheduler] restored last published anime ownership',key,'S'+Number(last?.season??1)+'E'+Number(last?.episode??0));
  return {
    ...(current||{}),
    activeSeriesKey:key,
    activeSeriesStartedAt:now,
    continuityResumeReason:'last_public_episode_owns_continuity',
    continuityResumedAt:now
  };
}

async function requestFrontierRefresh(runtime,d,seriesKey){
  if(!runtime||!isListenerRuntime(runtime))return false;
  const scheduler=d.collection('nexanime_config');
  const now=new Date();
  const state=await scheduler.findOne({_id:'scheduler'},{projection:{frontierRefreshSeriesKey:1,frontierRefreshRequestedAt:1}});
  const lastAt=state?.frontierRefreshRequestedAt?new Date(state.frontierRefreshRequestedAt).getTime():0;
  if(String(state?.frontierRefreshSeriesKey||'')===String(seriesKey)&&Date.now()-lastAt<FRONTIER_REFRESH_THROTTLE_MS)return false;
  await scheduler.updateOne(
    {_id:'scheduler'},
    {$set:{frontierRefreshSeriesKey:String(seriesKey),frontierRefreshRequestedAt:now,updatedAt:now}},
    {upsert:true}
  );
  queueMicrotask(()=>{
    pollAnimeSources(runtime)
      .then(count=>console.log('[NexAnime scheduler] frontier refresh',seriesKey,'new items',Number(count||0)))
      .catch(error=>console.warn('[NexAnime scheduler] frontier refresh failed',seriesKey,String(error?.message||error).slice(0,220)));
  });
  return true;
}

async function preparePlannedSeries(d,seriesKey){
  if(!seriesKey)return;
  await ensureGeneralPresentation(d,seriesKey).catch(()=>{});
  await ensureResumePresentation(d,seriesKey).catch(()=>{});
  const summary=await d.collection('nexanime_queue').aggregate([
    {$match:{seriesKey,status:'queued'}},
    {$group:{
      _id:null,
      episodes:{$sum:{$cond:[{$eq:['$kind','episode']},1,0]}},
      presentations:{$sum:{$cond:[{$eq:['$kind','presentation']},1,0]}},
      firstSeason:{$min:'$season'},
      firstEpisode:{$min:'$episode'},
      lastSeason:{$max:'$season'},
      lastEpisode:{$max:'$episode'}
    }}
  ]).toArray();
  await d.collection('nexanime_config').updateOne(
    {_id:'scheduler'},
    {$set:{plannedSeriesKey:seriesKey,plannedSummary:summary?.[0]||null,plannedAt:new Date(),updatedAt:new Date()}},
    {upsert:true}
  );
}
function interSeriesDeadlineFrom(lastPublishedAt,fallbackNow=Date.now()){
  const publishedMs=lastPublishedAt?new Date(lastPublishedAt).getTime():NaN;
  const fallbackMs=fallbackNow instanceof Date?fallbackNow.getTime():Number(fallbackNow);
  const baseMs=Number.isFinite(publishedMs)?publishedMs:(Number.isFinite(fallbackMs)?fallbackMs:Date.now());
  return new Date(baseMs+INTER_SERIES_MS);
}
async function interSeriesDeadline(d,seriesKey,now=new Date()){
  const last=await d.collection('nexanime_publications').findOne(
    {seriesKey,purgedAt:{$exists:false}},
    {sort:{publishedAt:-1,_id:-1},projection:{publishedAt:1}}
  );
  return interSeriesDeadlineFrom(last?.publishedAt,now);
}
function obsoleteLivenessBlockReason(reason=''){
  return /(?:presentation_translation_unavailable|resume_synopsis_unavailable)/i.test(String(reason||''));
}
async function chooseActiveSeries(d,{excludeSeriesKeys=[]}={}){
  const scheduler=d.collection('nexanime_config');
  const now=new Date();
  const requestedExclusions=[...new Set((excludeSeriesKeys||[]).map(String).filter(Boolean))];
  let current=await scheduler.findOne({_id:'scheduler'});
  const rawBlockedEntries=Array.isArray(current?.blockedSeriesEntries)?current.blockedSeriesEntries:[];
  const blockedSeriesEntries=rawBlockedEntries.filter(row=>{
    const key=String(row?.seriesKey||'');
    const until=row?.until?new Date(row.until):null;
    return Boolean(
      key&&until&&Number.isFinite(until.getTime())&&until>now&&
      !obsoleteLivenessBlockReason(row?.reason)
    );
  });
  const persistedBlockedKeys=[...new Set(blockedSeriesEntries.map(row=>String(row.seriesKey)))];
  if(blockedSeriesEntries.length!==rawBlockedEntries.length){
    await scheduler.updateOne({_id:'scheduler'},{$set:{blockedSeriesEntries,updatedAt:now}});
    current={...(current||{}),blockedSeriesEntries};
  }
  let blockedSeriesKey=String(current?.blockedSeriesKey||'');
  let blockedSeriesUntil=current?.blockedSeriesUntil?new Date(current.blockedSeriesUntil):null;
  let blockActive=Boolean(
    blockedSeriesKey&&blockedSeriesUntil&&
    Number.isFinite(blockedSeriesUntil.getTime())&&blockedSeriesUntil>now&&
    !obsoleteLivenessBlockReason(current?.blockedSeriesReason)
  );

  // Expired blocks are retried automatically. While a block is active, never
  // let that series keep ownership of the global publisher.
  if(blockedSeriesKey&&!blockActive){
    await scheduler.updateOne(
      {_id:'scheduler'},
      {$unset:{blockedSeriesKey:'',blockedSeriesUntil:'',blockedSeriesReason:''},$set:{updatedAt:now}}
    );
    current=await scheduler.findOne({_id:'scheduler'});
    blockedSeriesKey='';
    blockedSeriesUntil=null;
  }else if(blockActive&&current?.activeSeriesKey===blockedSeriesKey){
    const clearForced=String(current?.forcedNextSeriesKey||'')===blockedSeriesKey;
    await scheduler.updateOne(
      {_id:'scheduler'},
      {$unset:{
        activeSeriesKey:'',activeSeriesStartedAt:'',
        ...(clearForced?{forcedNextSeriesKey:'',skipCooldownForForcedNext:''}:{})
      },$set:{updatedAt:now}}
    );
    current={
      ...(current||{}),
      activeSeriesKey:'',activeSeriesStartedAt:null,
      ...(clearForced?{forcedNextSeriesKey:''}:{})
    };
  }

  current=await restoreLastPublishedSeriesOwnership(d,scheduler,current,{
    requestedExclusions,
    persistedBlockedKeys,
    blockedSeriesKey,
    blockActive,
    now
  });

  if(!current?.activeSeriesKey){
    const resumeKey=await latestIncompletePublishedSeries(d,{
      excludeSeriesKeys:[...new Set([
        ...requestedExclusions,
        ...persistedBlockedKeys,
        ...(blockActive?[blockedSeriesKey]:[])
      ])]
    });
    if(resumeKey){
      await scheduler.updateOne(
        {_id:'scheduler'},
        {
          $set:{
            activeSeriesKey:resumeKey,
            activeSeriesStartedAt:now,
            continuityResumeReason:'latest_incomplete_published_series',
            continuityResumedAt:now,
            updatedAt:now
          },
          $unset:{plannedSeriesKey:'',plannedAt:'',plannedSummary:'',cooldownUntil:''}
        },
        {upsert:true}
      );
      current={...(current||{}),activeSeriesKey:resumeKey,activeSeriesStartedAt:now};
      console.log('[NexAnime scheduler] resuming latest incomplete anime',resumeKey);
    }
  }

  if(current?.activeSeriesKey){
    const remaining=await d.collection('nexanime_queue').countDocuments({
      seriesKey:current.activeSeriesKey,
      kind:'episode',
      status:{$in:['queued','publishing']}
    });
    // Finish the anime in progress before selecting a new series.
    // Do not let normal candidate exclusions steal ownership while work remains.
    if(remaining>0)return current.activeSeriesKey;

    const finishingSeriesKey=finishingSeriesKey;
    let completionConfirmed=false;
    const completion=await seriesConfirmedComplete(d,finishingSeriesKey);
    if(completion.confirmed){
      await scheduler.updateOne(
        {_id:'scheduler'},
        {
          $set:{
            lastCompletedSeriesKey:finishingSeriesKey,
            lastSeriesCompletedAt:now,
            lastSeriesCompletionConfirmed:true,
            lastSeriesCompletionEvidence:completion,
            updatedAt:now
          },
          $unset:{
            frontierHoldSeriesKey:'',frontierHoldSince:'',frontierHoldUntil:'',
            frontierRefreshSeriesKey:'',frontierRefreshRequestedAt:''
          }
        },
        {upsert:true}
      );
      current={
        ...(current||{}),
        lastCompletedSeriesKey:finishingSeriesKey,
        lastSeriesCompletionConfirmed:true
      };
      completionConfirmed=true;
      console.log('[NexAnime scheduler] confirmed series complete',finishingSeriesKey,JSON.stringify(completion));
    }else{
      const holdSeries=String(current?.frontierHoldSeriesKey||'');
      const rawSince=current?.frontierHoldSince?new Date(current.frontierHoldSince):null;
      const validSince=rawSince&&Number.isFinite(rawSince.getTime())?rawSince:null;
      const since=holdSeries===finishingSeriesKey&&validSince?validSince:now;
      const until=new Date(since.getTime()+ACTIVE_FRONTIER_GRACE_MS);

      if(holdSeries!==finishingSeriesKey||!validSince){
        await scheduler.updateOne(
          {_id:'scheduler'},
          {
            $set:{
              frontierHoldSeriesKey:finishingSeriesKey,
              frontierHoldSince:since,
              frontierHoldUntil:until,
              frontierHoldReason:'awaiting_next_episode_discovery',
              updatedAt:now
            }
          },
          {upsert:true}
        );
        current={
          ...(current||{}),
          frontierHoldSeriesKey:finishingSeriesKey,
          frontierHoldSince:since,
          frontierHoldUntil:until
        };
      }

      if(until>now){
        return current.activeSeriesKey;
      }

      const blockedUntil=new Date(now.getTime()+GAP_RETRY_MS);
      const snapshot=await scheduler.findOne({_id:'scheduler'},{projection:{blockedSeriesEntries:1}});
      const entries=(Array.isArray(snapshot?.blockedSeriesEntries)?snapshot.blockedSeriesEntries:[])
        .filter(row=>{
          const key=String(row?.seriesKey||'');
          const exp=row?.until?new Date(row.until):null;
          return key&&key!==finishingSeriesKey&&exp&&Number.isFinite(exp.getTime())&&exp>now;
        })
        .concat([{
          seriesKey:finishingSeriesKey,
          until:blockedUntil,
          reason:'frontier_not_discovered_after_grace',
          blockedAt:now
        }])
        .slice(-100);

      await scheduler.updateOne(
        {_id:'scheduler'},
        {
          $set:{
            blockedSeriesKey:finishingSeriesKey,
            blockedSeriesUntil:blockedUntil,
            blockedSeriesReason:'frontier_not_discovered_after_grace',
            blockedSeriesEntries:entries,
            lastSeriesExitReason:'frontier_not_discovered_after_grace',
            lastSeriesExitedAt:now,
            updatedAt:now
          },
          $unset:{
            activeSeriesKey:'',activeSeriesStartedAt:'',
            frontierHoldSeriesKey:'',frontierHoldSince:'',frontierHoldUntil:'',
            frontierRefreshSeriesKey:'',frontierRefreshRequestedAt:''
          }
        },
        {upsert:true}
      );
      console.warn('[NexAnime scheduler] parked unfinished anime after frontier grace',finishingSeriesKey);
      current={...(current||{}),activeSeriesKey:'',activeSeriesStartedAt:null};
      blockedSeriesKey=finishingSeriesKey;
      blockedSeriesUntil=blockedUntil;
      blockActive=true;
      if(!persistedBlockedKeys.includes(finishingSeriesKey))persistedBlockedKeys.push(finishingSeriesKey);
    }

    let next='';
    const forcedNext=String(current?.forcedNextSeriesKey||'');
    if(forcedNext&&!requestedExclusions.includes(forcedNext)&&!persistedBlockedKeys.includes(forcedNext)&&(!blockActive||forcedNext!==blockedSeriesKey)){
      const forcedExists=await d.collection('nexanime_queue').countDocuments({
        seriesKey:forcedNext,status:'queued',kind:'episode'
      });
      if(forcedExists>0)next=forcedNext;
    }
    if(!next){
      next=await nextRunnableSeriesKey(d,{excludeSeriesKeys:[...new Set([...requestedExclusions,...persistedBlockedKeys,...(blockActive?[blockedSeriesKey]:[])])]});
    }
    if(next){
      // Cross-series spacing is never bypassed, including legacy forced-next requests.
      // Anchor it to the last confirmed public post so timer polling adds no extra delay.
      const cooldownUntil=await interSeriesDeadline(d,finishingSeriesKey,now);
      await scheduler.updateOne(
        {_id:'scheduler'},
        {$set:{
          ...(completionConfirmed?{
            lastCompletedSeriesKey:finishingSeriesKey,
            lastSeriesCompletedAt:now
          }:{
            lastSeriesExitReason:'switched_after_unavailable_frontier',
            lastSeriesExitedAt:now
          }),
          plannedSeriesKey:next,
          cooldownUntil,
          updatedAt:now
        },$unset:{
          activeSeriesKey:'',activeSeriesStartedAt:'',
          forcedNextSeriesKey:'',skipCooldownForForcedNext:''
        }},
        {upsert:true}
      );
      await preparePlannedSeries(d,next);
      return '';
    }

    await scheduler.updateOne(
      {_id:'scheduler'},
      {$set:{
         ...(completionConfirmed?{
           lastCompletedSeriesKey:finishingSeriesKey,
           lastSeriesCompletedAt:now
         }:{
           lastSeriesExitReason:'no_runnable_series_after_frontier',
           lastSeriesExitedAt:now
         }),
         updatedAt:now
       },
       $unset:{
         activeSeriesKey:'',activeSeriesStartedAt:'',plannedSeriesKey:'',plannedAt:'',
         plannedSummary:'',cooldownUntil:'',forcedNextSeriesKey:'',skipCooldownForForcedNext:''
       }},
      {upsert:true}
    );
  }

  const state=await scheduler.findOne({_id:'scheduler'});
  const stateBlockedKey=String(state?.blockedSeriesKey||blockedSeriesKey||'');
  const stateBlockedUntil=state?.blockedSeriesUntil?new Date(state.blockedSeriesUntil):blockedSeriesUntil;
  const stateBlockActive=Boolean(
    stateBlockedKey&&stateBlockedUntil&&
    Number.isFinite(stateBlockedUntil.getTime())&&stateBlockedUntil>now
  );
  const cooldownUntil=state?.cooldownUntil?new Date(state.cooldownUntil):null;
  if(cooldownUntil&&cooldownUntil>now){
    if(state?.plannedSeriesKey)await preparePlannedSeries(d,state.plannedSeriesKey);
    return '';
  }

  let next=state?.plannedSeriesKey||'';
  if(next){
    if(requestedExclusions.includes(String(next))||persistedBlockedKeys.includes(String(next))||(stateBlockActive&&next===stateBlockedKey)){
      next='';
    }else{
      const exists=await d.collection('nexanime_queue').countDocuments({seriesKey:next,status:'queued',kind:'episode'});
      if(!exists)next='';
    }
  }
  if(!next){
    next=await nextRunnableSeriesKey(d,{excludeSeriesKeys:[...new Set([...requestedExclusions,...persistedBlockedKeys,...(stateBlockActive?[stateBlockedKey]:[])])]});
  }

  if(!next){
    await scheduler.updateOne(
      {_id:'rebuild',mode:'rebuild'},
      {$set:{mode:'live',completedAt:now,updatedAt:now}}
    ).catch(()=>{});
    return '';
  }

  await preparePlannedSeries(d,next);
  await scheduler.updateOne(
    {_id:'scheduler'},
    {$set:{activeSeriesKey:next,activeSeriesStartedAt:now,updatedAt:now},
     $unset:{plannedSeriesKey:'',plannedAt:'',plannedSummary:'',cooldownUntil:''}},
    {upsert:true}
  );
  return next;
}
async function claimExactItem(d,item,accountId,{allowAny=false}={}){
  if(!item)return null;
  const owns=allowAny || item.synthetic===true || (item.sources||[]).some(x=>String(x.accountId)===String(accountId));
  if(!owns)return null;
  return d.collection('nexanime_queue').findOneAndUpdate(
    {_id:item._id,status:'queued'},
    {$set:{
      status:'publishing',
      claimAt:new Date(),
      claimBy:allowAny?('nexcanal:'+String(accountId)):String(accountId),
      updatedAt:new Date()
    }},
    {returnDocument:'after'}
  );
}

function queuedPresentationNeedsRepair(item){
  return Boolean(
    item&&
    item.status==='queued'&&
    item.synthetic!==true&&
    (
      Number(item.attempts||0)>0||
      Boolean(item.retryAfter)||
      String(item.lastError||'').trim()
    )
  );
}
async function ensureGeneralPresentation(d,seriesKey){
  const queue=d.collection('nexanime_queue');
  const existingQueue=await queue.findOne({
    seriesKey,kind:'presentation',
    $or:[{episode:null},{episode:{$exists:false}}],
    status:{$in:['queued','publishing']}
  },{
    projection:{
      _id:1,dedupeKey:1,status:1,synthetic:1,mode:1,
      attempts:1,retryAfter:1,lastError:1
    }
  });

  const existingPublished=await d.collection('nexanime_publications').findOne({
    seriesKey,kind:'presentation',
    $or:[{episode:null},{episode:{$exists:false}}],
    purgedAt:{$exists:false}
  },{projection:{_id:1}});
  if(existingPublished){
    // Never let a stale queued synopsis outrank an already-published synopsis
    // after a restart or source rescan.
    if(existingQueue){
      await queue.updateOne(
        {_id:existingQueue._id,status:{$in:['queued','publishing']}},
        {$set:{
          status:'superseded',
          supersededAt:new Date(),
          supersededReason:'presentation_already_published',
          updatedAt:new Date()
        },$unset:{claimAt:'',claimBy:'',retryAfter:'',lastTransientAt:''}}
      );
    }
    return;
  }

  // A clean queued synopsis may still be published from its source. If a source
  // synopsis has already failed, recycle it into the synthetic synopsis path
  // instead of retrying the same dead Telegram message forever.
  if(existingQueue&&!queuedPresentationNeedsRepair(existingQueue))return;

  const episode=await queue.findOne(
    {seriesKey,kind:'episode',status:'queued'},
    {sort:{season:1,episode:1,createdAt:1}}
  );
  if(!episode?.title)return;
  const meta=await animePresentationMetadata(episode.title);
  if(!meta?.ok||!String(meta.description||'').trim())return;
  const now=new Date();
  const presentation={
    kind:'presentation',
    title:meta.canonicalTitle||episode.title,
    anilistId:meta.anilistId||episode.anilistId||null,
    season:null,episode:null,language:'',quality:'',
    cleanedCaption:await presentationText(meta,seriesKey)
  };
  if(!presentation.cleanedCaption)return;
  const dedupeKey=presentationKey(presentation);
  const existingAny=await queue.findOne({dedupeKey});
  const target=existingAny||existingQueue;

  const payload={
    dedupeKey,status:'queued',kind:'presentation',seriesKey,
    title:presentation.title,anilistId:presentation.anilistId,season:null,episode:null,
    language:'',quality:'',mediaKind:'photo',cleanedCaption:presentation.cleanedCaption,
    cleanedFilename:'',originalFilename:'',confidence:1,
    destination:'@'+DESTINATION,mode:'synthetic',synthetic:true,
    imageUrl:meta.coverImage||'',attempts:0,ingestedAt:new Date(0),
    repairedPresentation:true,repairedPresentationAt:now,updatedAt:now
  };

  if(target){
    if(target.status==='published')return;
    if(existingAny&&existingQueue&&String(existingAny._id)!==String(existingQueue._id)){
      await queue.updateOne(
        {_id:existingQueue._id},
        {$set:{
          status:'superseded',
          supersededAt:now,
          supersededReason:'presentation_replaced_by_synthetic',
          updatedAt:now
        },$unset:{claimAt:'',claimBy:'',retryAfter:'',lastTransientAt:''}}
      );
    }
    await queue.updateOne(
      {_id:target._id},
      {$set:payload,$unset:{
        claimAt:'',claimBy:'',lastError:'',quarantineReason:'',
        supersededAt:'',supersededReason:'',recoveredAt:'',recoveredReason:'',
        retryAfter:'',lastTransientAt:''
      }}
    );
    return;
  }

  await queue.insertOne({...payload,createdAt:now});
}

async function ensureResumePresentation(d,seriesKey){
  // Resume synopsis cards are deliberately disabled.
  // A series gets exactly one general synopsis before Episode 1. If publication
  // pauses or another anime runs in between, we continue directly with the next
  // verified episode instead of posting another synopsis that may be left alone.
  const queue=d.collection('nexanime_queue');
  const now=new Date();
  await queue.updateMany(
    {
      seriesKey,
      kind:'resume_presentation',
      status:{$in:['queued','publishing']}
    },
    {
      $set:{
        status:'superseded',
        supersededAt:now,
        supersededReason:'resume_synopsis_disabled',
        updatedAt:now
      },
      $unset:{claimAt:'',claimBy:'',retryAfter:'',lastTransientAt:'',lastError:''}
    }
  );
  return {required:false,ready:true,disabled:true};
}
async function ensureLiveEpisodePresentation(){
  // Kept as a compatibility shim for older callers. Per-episode presentation
  // cards are intentionally disabled: one series synopsis is enough.
  return null;
}

function episodeVariantScore(item){
  const language=String(item?.language||'UNK').toUpperCase();
  const quality=String(item?.quality||'auto').toLowerCase();
  const languageScore={VF:40,MULTI:30,VOSTFR:20,UNK:10}[language]||5;
  const qualityScore=/2160|4k/.test(quality)?6:/1080/.test(quality)?5:/720/.test(quality)?4:quality==='auto'?3:/480/.test(quality)?2:/360/.test(quality)?1:0;
  return languageScore+qualityScore;
}

async function reconcileStalePublishing(){
  const nowMs=Date.now();
  if(nowMs-stalePublishingReconcileAt<30_000)return 0;
  stalePublishingReconcileAt=nowMs;
  const d=await db(),now=new Date(),cutoff=new Date(nowMs-STALE_PUBLISH_MS);
  const queue=d.collection('nexanime_queue');
  const publications=d.collection('nexanime_publications');
  const handoffs=d.collection(NEXCANAL_HANDOFF_COLLECTION);
  const stale=await queue.find({
    status:'publishing',
    $or:[{claimAt:{$lte:cutoff}},{claimAt:{$exists:false}}]
  }).limit(100).toArray();
  let repaired=0;

  for(const item of stale){
    const existingPublication=await publications.findOne({
      dedupeKey:item.dedupeKey,
      purgedAt:{$exists:false}
    });
    if(existingPublication){
      await queue.updateOne(
        {_id:item._id,status:'publishing'},
        {$set:{status:'published',publishedAt:existingPublication.publishedAt||now,updatedAt:now,deduplicated:true,recoveredFromStaleClaim:true},$unset:{claimAt:'',claimBy:'',lastError:''}}
      );
      repaired++;
      continue;
    }

    const handoff=await handoffs.findOne({dedupeKey:item.dedupeKey});
    if(handoff?.status==='done'&&Number(handoff?.resultMessageId)>0){
      await publications.updateOne(
        {dedupeKey:item.dedupeKey},
        {$setOnInsert:{
          dedupeKey:item.dedupeKey,seriesKey:item.seriesKey,kind:item.kind,title:item.title,
          season:item.season,episode:item.episode,language:item.language||'',quality:item.quality||'',
          mode:item.mode||'',destination:'@'+DESTINATION,createdAt:now
        },$set:{
          publishedAt:handoff.updatedAt||now,publisherRole:'nexcanal-bot',
          publisherBotUsername:NEXCANAL_STAGE_BOT,
          stagingAccountId:String(handoff.fromChatId||item.claimBy||''),
          telegramMessageId:Number(handoff.resultMessageId),
          recoveredFromHandoff:true
        },$unset:{purgedAt:'',purgedBy:'',purgeError:''}},
        {upsert:true}
      );
      await queue.updateOne(
        {_id:item._id,status:'publishing'},
        {$set:{status:'published',publishedAt:handoff.updatedAt||now,updatedAt:now,recoveredFromHandoff:true},$unset:{claimAt:'',claimBy:'',lastError:''}}
      );
      repaired++;
      continue;
    }

    const handoffUpdated=handoff?.updatedAt?new Date(handoff.updatedAt):null;
    if(handoff&&['pending','processing'].includes(handoff.status)&&handoffUpdated&&handoffUpdated>cutoff){
      continue;
    }
    if(handoff&&['pending','processing'].includes(handoff.status)){
      await handoffs.updateOne(
        {_id:handoff._id,status:handoff.status},
        {$set:{status:'failed',lastError:'stale_handoff_recovered',updatedAt:now,nextAttemptAt:now}}
      );
    }
    await queue.updateOne(
      {_id:item._id,status:'publishing'},
      {$set:{status:'queued',updatedAt:now,recoveredFromStaleClaim:true},$unset:{claimAt:'',claimBy:''}}
    );
    repaired++;
  }
  return repaired;
}

async function suppressAlreadyPublishedEpisode(d,seriesKey,season,episode){
  const published=await d.collection('nexanime_publications').findOne({
    seriesKey,kind:'episode',season,episode,purgedAt:{$exists:false}
  },{projection:{_id:1,telegramMessageId:1}});
  if(!published)return false;
  await d.collection('nexanime_queue').updateMany(
    {seriesKey,season,episode,status:'queued',kind:{$in:['episode','presentation']}},
    {$set:{status:'superseded',supersededAt:new Date(),supersededReason:'episode_already_published',updatedAt:new Date()}}
  );
  return true;
}

function episodeVariantRetryReady(item,now=Date.now()){
  const nowMs=now instanceof Date?now.getTime():Number(now);
  const retryAt=item?.retryAfter?new Date(item.retryAfter).getTime():0;
  return !Number.isFinite(retryAt)||retryAt<=nowMs;
}
async function preferredEpisodeVariant(d,seriesKey,season,episode){
  const variants=await d.collection('nexanime_queue').find(
    {seriesKey,status:'queued',kind:'episode',season,episode}
  ).limit(50).toArray();
  if(!variants.length)return null;
  const ready=variants.filter(item=>episodeVariantRetryReady(item));
  if(!ready.length)return null;
  ready.sort((a,b)=>episodeVariantScore(b)-episodeVariantScore(a)||new Date(a.createdAt||0)-new Date(b.createdAt||0));
  // A transiently broken preferred copy is temporarily skipped, allowing another
  // validated variant of the SAME episode to continue the active anime.
  return ready[0];
}

async function preflightSeriesBeforeSynopsis(runtime,d,seriesKey){
  const publications=d.collection('nexanime_publications');
  const queue=d.collection('nexanime_queue');
  const publishedPresentation=await publications.findOne(
    {
      seriesKey,kind:'presentation',
      $or:[{episode:null},{episode:{$exists:false}}],
      telegramMessageId:{$gt:0},
      purgedAt:{$exists:false}
    },
    {projection:{_id:1}}
  );

  // Always preflight the NEXT unpublished episode, even when this anime
  // already has a synopsis in the channel. Previously the published synopsis
  // short-circuited this function, allowing a resume card to go out before we
  // knew that the following episode could actually be fetched.
  const candidates=await queue.find(
    {seriesKey,status:'queued',kind:'episode',episode:{$ne:null}}
  ).sort({season:1,episode:1,createdAt:1}).limit(50).toArray();

  let first=null;
  for(const candidate of candidates){
    const already=await publications.findOne({
      seriesKey,kind:'episode',
      season:Number(candidate.season??1),
      episode:Number(candidate.episode),
      purgedAt:{$exists:false}
    },{projection:{_id:1}});
    if(!already){first=candidate;break}
  }
  if(!first)return {ok:false,reason:'no_unpublished_episode_available'};

  const season=Number(first.season??1);
  const episode=Number(first.episode);
  const initialPresentationNeeded=!publishedPresentation;

  if(initialPresentationNeeded&&(!Number.isFinite(episode)||episode!==1)){
    return {
      ok:false,reason:'first_episode_missing',season,
      expectedEpisode:1,
      blockedEpisode:Number.isFinite(episode)?episode:null
    };
  }

  // For an anime already in progress, never resume at E(N) if E(N-1) is
  // neither public nor queued. This check happens before any presentation.
  if(!initialPresentationNeeded&&Number.isInteger(episode)&&episode>1){
    const previousEpisode=episode-1;
    const previousPublished=await publications.findOne({
      seriesKey,kind:'episode',season,episode:previousEpisode,purgedAt:{$exists:false}
    },{projection:{_id:1}});
    const previousQueued=previousPublished?null:await queue.findOne({
      seriesKey,kind:'episode',season,episode:previousEpisode,
      status:{$in:['queued','publishing']}
    },{projection:{_id:1}});
    if(!previousPublished&&!previousQueued){
      return {
        ok:false,reason:'missing_previous_episode',
        season,expectedEpisode:previousEpisode,blockedEpisode:episode
      };
    }
  }

  if(!(await mediaReuploadAllowed())){
    return {
      ok:false,
      reason:'media_reupload_not_authorized',
      season,
      expectedEpisode:episode,
      blockedEpisode:episode,
      lastError:'media_reupload_requires_authorized_policy'
    };
  }

  // A brand-new anime may get its one general synopsis only if both its
  // metadata and Episode 1 are genuinely ready.
  if(initialPresentationNeeded){
    const queuedPresentation=await queue.findOne({
      seriesKey,kind:'presentation',
      $or:[{episode:null},{episode:{$exists:false}}],
      status:{$in:['queued','publishing']}
    },{projection:{_id:1}});
    if(!queuedPresentation){
      const meta=await animePresentationMetadata(first.title);
      if(!meta?.ok||!String(meta.description||'').trim()){
        return {
          ok:false,
          reason:'presentation_metadata_unavailable',
          season,expectedEpisode:episode,blockedEpisode:episode,
          lastError:'presentation_metadata_unavailable'
        };
      }
      const localizedPresentation=await presentationText(meta,seriesKey);
      if(!localizedPresentation){
        return {
          ok:false,
          reason:'presentation_translation_unavailable',
          season,expectedEpisode:episode,blockedEpisode:episode,
          lastError:'presentation_translation_unavailable'
        };
      }
    }
  }

  const variants=await queue.find(
    {seriesKey,status:'queued',kind:'episode',season,episode}
  ).limit(4).toArray();
  variants.sort((a,b)=>episodeVariantScore(b)-episodeVariantScore(a)||new Date(a.createdAt||0)-new Date(b.createdAt||0));

  let lastError='';
  let sawTransient=false;
  const preflightDeadline=Date.now()+25_000;
  for(const item of variants){
    if(Date.now()>=preflightDeadline){
      sawTransient=true;
      lastError='preflight_time_budget_exceeded';
      break;
    }
    try{
      const resolved=await resolveSource(runtime,item,{maxSources:3});
      if(resolved){
        return {
          ok:true,season,episode,dedupeKey:item.dedupeKey,
          alreadyPresented:Boolean(publishedPresentation)
        };
      }
      sawTransient=true;
    }catch(error){
      const message=String(error?.message||error).slice(0,500);
      lastError=message;
      if(String(error?.code||'')==='SOURCE_IDENTITY_MISMATCH'){
        await queue.updateOne(
          {_id:item._id,status:'queued'},
          {
            $set:{
              status:'quarantine',
              quarantineReason:'source_identity_mismatch',
              lastError:message,
              preflightRejectedAt:new Date(),
              updatedAt:new Date()
            },
            $inc:{attempts:1},
            $unset:{claimAt:'',claimBy:''}
          }
        );
        continue;
      }
      sawTransient=true;
    }
  }

  const prefix=initialPresentationNeeded?'first_episode':'next_episode';
  return {
    ok:false,
    reason:sawTransient?(prefix+'_unreachable'):(prefix+'_invalid'),
    season,expectedEpisode:episode,blockedEpisode:episode,lastError
  };
}
async function parkSeriesBeforeSynopsis(d,seriesKey,probe={}){
  const now=new Date();
  const scheduler=d.collection('nexanime_config');
  const blockedUntil=new Date(now.getTime()+GAP_RETRY_MS);
  const snapshot=await scheduler.findOne({_id:'scheduler'},{projection:{blockedSeriesEntries:1}});
  const blockedSeriesEntries=(Array.isArray(snapshot?.blockedSeriesEntries)?snapshot.blockedSeriesEntries:[])
    .filter(row=>{
      const key=String(row?.seriesKey||'');
      const until=row?.until?new Date(row.until):null;
      return key&&key!==seriesKey&&until&&Number.isFinite(until.getTime())&&until>now;
    })
    .concat([{
      seriesKey,
      until:blockedUntil,
      reason:'preflight_'+String(probe.reason||'unrunnable'),
      blockedAt:now
    }])
    .slice(-100);
  await scheduler.updateOne(
    {_id:'scheduler'},
    {
      $set:{
        blockedSeriesKey:seriesKey,
        blockedSeriesUntil:blockedUntil,
        blockedSeriesReason:'preflight_'+String(probe.reason||'unrunnable'),
        blockedSeriesEntries,
        gapDetected:{
          seriesKey,
          season:Number(probe.season??1),
          expectedEpisode:Number(probe.expectedEpisode??1),
          blockedEpisode:probe.blockedEpisode==null?null:Number(probe.blockedEpisode),
          detectedAt:now
        },
        updatedAt:now
      },
      $unset:{
        activeSeriesKey:'',activeSeriesStartedAt:'',
        plannedSeriesKey:'',plannedAt:'',plannedSummary:''
      }
    },
    {upsert:true}
  );
  console.warn('[NexAnime scheduler] skipped synopsis for unrunnable series',seriesKey,String(probe.reason||'unknown'));
}

async function choosePreflightReadySeries(runtime,d){
  const excluded=[];
  const maxAttempts=60; // keep scanning past polluted/incomplete series instead of silencing the feed
  for(let attempt=0;attempt<maxAttempts;attempt++){
    const seriesKey=await chooseActiveSeries(d,{excludeSeriesKeys:excluded});
    if(!seriesKey)return '';
    const preflight=await preflightSeriesBeforeSynopsis(runtime,d,seriesKey);
    if(preflight.ok){
      await d.collection('nexanime_config').updateOne(
        {_id:'scheduler',frontierHoldSeriesKey:seriesKey},
        {$unset:{
          frontierHoldSeriesKey:'',frontierHoldSince:'',frontierHoldUntil:'',
          frontierRefreshSeriesKey:'',frontierRefreshRequestedAt:''
        },$set:{updatedAt:new Date()}}
      ).catch(()=>{});
      return seriesKey;
    }
    if(preflight.reason==='no_unpublished_episode_available'){
      const hold=await d.collection('nexanime_config').findOne(
        {_id:'scheduler',activeSeriesKey:seriesKey,frontierHoldSeriesKey:seriesKey},
        {projection:{frontierHoldUntil:1}}
      );
      const holdUntil=hold?.frontierHoldUntil?new Date(hold.frontierHoldUntil):null;
      if(holdUntil&&Number.isFinite(holdUntil.getTime())&&holdUntil>new Date()){
        await requestFrontierRefresh(runtime,d,seriesKey);
        console.log('[NexAnime scheduler] holding active anime for frontier discovery',seriesKey,holdUntil.toISOString());
        return '';
      }
    }
    await parkSeriesBeforeSynopsis(d,seriesKey,preflight);
    excluded.push(seriesKey);
  }
  console.warn('[NexAnime scheduler] preflight scan exhausted',excluded.join(','));
  return '';
}

async function claimNext(runtime){
  await ensureIndexes();
  await reconcileStalePublishing();
  const d=await db();
  await recoverAwaitingRightsIfAuthorized(d);
  const accountId=String(runtime.account.telegramUserId);
  const allowAny=isPublisherRuntime(runtime);
  // Skip every temporarily unrunnable series inside the same publish tick.
  // Keeping exclusions local to this scan prevents two dead first episodes
  // from alternating forever through the single legacy blockedSeriesKey slot.
  const seriesKey=await choosePreflightReadySeries(runtime,d);
  if(!seriesKey)return null;

  await ensureGeneralPresentation(d,seriesKey);
  const resumeState=await ensureResumePresentation(d,seriesKey);
  if(resumeState?.required===true&&resumeState?.ready!==true){
    await parkSeriesBeforeSynopsis(d,seriesKey,{
      reason:String(resumeState.reason||'resume_presentation_unavailable'),
      season:Number(resumeState.season??1),
      expectedEpisode:Number(resumeState.episode??1),
      blockedEpisode:Number(resumeState.episode??1)
    });
    return claimNext(runtime);
  }

  // Legacy/source "Episode N" poster cards are not episode media. Remove them
  // from the runnable queue so a restart can never resume publishing them.
  await d.collection('nexanime_queue').updateMany(
    {
      seriesKey,status:'queued',kind:'presentation',
      episode:{$ne:null}
    },
    {$set:{
      status:'superseded',
      supersededAt:new Date(),
      supersededReason:'episode_image_card_disabled',
      updatedAt:new Date()
    }}
  );

  // Resume synopsis cards are disabled. A series keeps its original synopsis
  // and continues directly with its next verified episode after any pause.

  // Exactly one initial general anime presentation/synopsis is allowed.
  const generalPresentation=await d.collection('nexanime_queue').findOne(
    {
      seriesKey,status:'queued',kind:'presentation',
      $or:[{episode:null},{episode:{$exists:false}}]
    },
    {sort:{createdAt:1}}
  );
  if(generalPresentation){
    return claimExactItem(d,generalPresentation,accountId,{allowAny});
  }

  const publishedGeneralPresentation=await d.collection('nexanime_publications').findOne({
    seriesKey,kind:'presentation',
    $or:[{episode:null},{episode:{$exists:false}}],
    telegramMessageId:{$gt:0},
    purgedAt:{$exists:false}
  },{projection:{_id:1,telegramMessageId:1}});
  if(!publishedGeneralPresentation){
    // Hard invariant: no episode is allowed out before the anime synopsis card.
    // But a synopsis that could not be materialized must never deadlock the
    // global publisher. Park this series briefly and continue with another
    // runnable anime in the same publish tick.
    const blockedEpisode=await d.collection('nexanime_queue').findOne(
      {seriesKey,kind:'episode',status:'queued',episode:{$ne:null}},
      {sort:{season:1,episode:1,createdAt:1},projection:{season:1,episode:1}}
    );
    await parkSeriesBeforeSynopsis(d,seriesKey,{
      reason:'presentation_not_materialized',
      season:Number(blockedEpisode?.season??1),
      expectedEpisode:Number(blockedEpisode?.episode??1),
      blockedEpisode:Number(blockedEpisode?.episode??1)
    });
    return claimNext(runtime);
  }

  // Only real episode media can be selected after the single general synopsis.
  const nextEpisode=await d.collection('nexanime_queue').findOne(
    {
      seriesKey,status:'queued',
      episode:{$ne:null},
      kind:'episode'
    },
    {sort:{season:1,episode:1,createdAt:1}}
  );
  if(!nextEpisode)return null;
  const season=nextEpisode.season??1;
  const episode=nextEpisode.episode;

  // Never jump over a missing integer episode inside a season. If episode N-1
  // is absent, hold this series and let source discovery/backfill fill the gap.
  // This prevents sequences such as 14 -> 16 or 1 -> 3 from reaching the channel.
  if(Number.isInteger(Number(episode))&&Number(episode)>1){
    const previousEpisode=Number(episode)-1;
    const previousPublished=await d.collection('nexanime_publications').findOne({
      seriesKey,kind:'episode',season,episode:previousEpisode,purgedAt:{$exists:false}
    },{projection:{_id:1}});
    if(!previousPublished){
      const now=new Date();
      const previousRunnable=await d.collection('nexanime_queue').countDocuments({
        seriesKey,kind:'episode',season,episode:previousEpisode,
        status:{$in:['queued','publishing']}
      });
      const gapDetected={
        seriesKey,season,expectedEpisode:previousEpisode,blockedEpisode:Number(episode),
        detectedAt:now
      };
      if(previousRunnable===0){
        const lastGlobal=await d.collection('nexanime_publications').findOne(
          {purgedAt:{$exists:false}},
          {sort:{publishedAt:-1,_id:-1},projection:{publishedAt:1}}
        );
        const lastPublishedMs=lastGlobal?.publishedAt?new Date(lastGlobal.publishedAt).getTime():NaN;
        const cooldownUntil=Number.isFinite(lastPublishedMs)
          ?new Date(lastPublishedMs+INTER_SERIES_MS)
          :now;
        const blockedUntil=new Date(now.getTime()+GAP_RETRY_MS);
        const scheduler=d.collection('nexanime_config');
        const snapshot=await scheduler.findOne({_id:'scheduler'},{projection:{blockedSeriesEntries:1}});
        const blockedSeriesEntries=(Array.isArray(snapshot?.blockedSeriesEntries)?snapshot.blockedSeriesEntries:[])
          .filter(row=>{
            const key=String(row?.seriesKey||'');
            const until=row?.until?new Date(row.until):null;
            return key&&key!==seriesKey&&until&&Number.isFinite(until.getTime())&&until>now;
          })
          .concat([{
            seriesKey,
            until:blockedUntil,
            reason:'missing_previous_episode_without_runnable_variant',
            blockedAt:now
          }])
          .slice(-100);
        await scheduler.updateOne(
          {_id:'scheduler'},
          {
            $set:{
              gapDetected,
              blockedSeriesKey:seriesKey,
              blockedSeriesUntil:blockedUntil,
              blockedSeriesReason:'missing_previous_episode_without_runnable_variant',
              blockedSeriesEntries,
              cooldownUntil,
              updatedAt:now
            },
            $unset:{
              activeSeriesKey:'',activeSeriesStartedAt:'',
              plannedSeriesKey:'',plannedAt:'',plannedSummary:''
            }
          },
          {upsert:true}
        );
        console.warn('[NexAnime scheduler] parked blocked series',seriesKey,'missing',season,previousEpisode,'and continuing with another runnable series');
        // Do not let one incomplete anime stall the whole feed. The blocked
        // series remains parked, while a new runnable series is selected in
        // this same publish tick as soon as the normal cross-series cooldown permits.
        return claimNext(runtime);
      }else{
        await d.collection('nexanime_config').updateOne(
          {_id:'scheduler'},
          {$set:{gapDetected,updatedAt:now}},
          {upsert:true}
        );
      }
      return null;
    }
  }
  await d.collection('nexanime_config').updateOne(
    {_id:'scheduler'},
    {
      $unset:{
        gapDetected:'',
        ...(String((await d.collection('nexanime_config').findOne({_id:'scheduler'}))?.blockedSeriesKey||'')===seriesKey
          ?{blockedSeriesKey:'',blockedSeriesUntil:'',blockedSeriesReason:''}
          :{})
      },
      $set:{updatedAt:new Date()}
    },
    {upsert:true}
  ).catch(()=>{});

  if(await suppressAlreadyPublishedEpisode(d,seriesKey,season,episode)){
    return claimNext(runtime);
  }

  // 3) Publish one best media variant per episode. Alternate sources,
  // languages and qualities are superseded so the channel never receives the
  // same episode multiple times.
  const media=await preferredEpisodeVariant(d,seriesKey,season,episode);
  if(media){
    return claimExactItem(d,media,accountId,{allowAny});
  }
  const noMediaNow=new Date();
  const noMediaUntil=new Date(noMediaNow.getTime()+TRANSIENT_VARIANT_RETRY_MS);
  const noMediaCooldown=await interSeriesDeadline(d,seriesKey,noMediaNow);
  const noMediaScheduler=d.collection('nexanime_config');
  const noMediaState=await noMediaScheduler.findOne({_id:'scheduler'},{projection:{blockedSeriesEntries:1}});
  const noMediaBlocks=(Array.isArray(noMediaState?.blockedSeriesEntries)?noMediaState.blockedSeriesEntries:[]).filter(row=>{const key=String(row?.seriesKey||'');const until=row?.until?new Date(row.until):null;return key&&key!==seriesKey&&until&&Number.isFinite(until.getTime())&&until>noMediaNow;}).concat([{seriesKey,until:noMediaUntil,reason:'no_ready_episode_variant',blockedAt:noMediaNow}]).slice(-100);
  await noMediaScheduler.updateOne({_id:'scheduler'},{$set:{blockedSeriesKey:seriesKey,blockedSeriesUntil:noMediaUntil,blockedSeriesReason:'no_ready_episode_variant',blockedSeriesEntries:noMediaBlocks,cooldownUntil:noMediaCooldown,updatedAt:noMediaNow},$unset:{activeSeriesKey:'',activeSeriesStartedAt:'',plannedSeriesKey:'',plannedAt:'',plannedSummary:'',forcedNextSeriesKey:'',skipCooldownForForcedNext:''}},{upsert:true});
  console.warn('[NexAnime scheduler] parked series with no ready episode variant',seriesKey,season,episode);
  return claimNext(runtime);
}
async function alreadyPublished(dedupeKey){
  const d=await db();
  return !!(await d.collection('nexanime_publications').findOne({dedupeKey,purgedAt:{$exists:false}},{projection:{_id:1}}));
}

async function nexCanalStageEntity(runtime){
  runtime.animeIngest ??={};
  if(runtime.animeIngest.nexCanalStageEntity)return runtime.animeIngest.nexCanalStageEntity;
  const entity=await runtime.client.getEntity(NEXCANAL_STAGE_BOT);
  runtime.animeIngest.nexCanalStageEntity=entity;
  return entity;
}
function nexCanalStageMarker(item){
  const key=crypto.createHash('sha256').update(String(item?.dedupeKey||item?._id||crypto.randomUUID())).digest('hex').slice(0,24);
  return '#NEXANIME_STAGE:'+key;
}
async function waitNexCanalHandoff(item){
  const d=await db(),c=d.collection(NEXCANAL_HANDOFF_COLLECTION);
  const until=Date.now()+NEXCANAL_HANDOFF_TIMEOUT_MS;
  while(Date.now()<until){
    const row=await c.findOne({dedupeKey:item.dedupeKey});
    if(row?.status==='done'&&Number(row?.resultMessageId)>0){
      return {id:Number(row.resultMessageId),messageId:Number(row.resultMessageId),via:'nexcanal'};
    }
    if(row?.status==='failed')throw new Error('nexcanal_handoff_failed: '+String(row?.lastError||'unknown'));
    await sleep(500);
  }
  throw new Error('nexcanal_handoff_timeout');
}
function isNexCanalCopyMissingError(error){
  const message=String(error?.message||error||'').toLowerCase();
  return message.includes('nexcanal_handoff_failed:')&&message.includes('message to copy not found');
}
function isNexCanalFallbackError(error){
  const message=String(error?.message||error||'').toLowerCase();
  return (
    isNexCanalCopyMissingError(error)||
    message.includes('nexcanal_handoff_timeout')||
    message.includes('nexcanal_handoff_failed:')
  );
}
async function cancelNexCanalHandoffForFallback(item,error){
  const d=await db();
  const c=d.collection(NEXCANAL_HANDOFF_COLLECTION);
  const existing=await c.findOne({dedupeKey:item.dedupeKey});
  if(existing?.status==='done'&&Number(existing?.resultMessageId)>0){
    return {
      done:true,
      result:{
        id:Number(existing.resultMessageId),
        messageId:Number(existing.resultMessageId),
        via:'nexcanal'
      }
    };
  }
  // Do not race a worker that has already started the Bot API copy. Give an
  // in-flight processing handoff one final short grace period first.
  if(existing?.status==='processing'){
    const until=Date.now()+8_000;
    while(Date.now()<until){
      await sleep(500);
      const row=await c.findOne({dedupeKey:item.dedupeKey});
      if(row?.status==='done'&&Number(row?.resultMessageId)>0){
        return {
          done:true,
          result:{
            id:Number(row.resultMessageId),
            messageId:Number(row.resultMessageId),
            via:'nexcanal'
          }
        };
      }
      if(row?.status!=='processing')break;
    }
  }
  const latest=await c.findOne({dedupeKey:item.dedupeKey});
  if(latest?.status==='done'&&Number(latest?.resultMessageId)>0){
    return {
      done:true,
      result:{
        id:Number(latest.resultMessageId),
        messageId:Number(latest.resultMessageId),
        via:'nexcanal'
      }
    };
  }
  await c.updateOne(
    {
      dedupeKey:item.dedupeKey,
      status:{$in:['staging','pending','processing','failed']}
    },
    {$set:{
      status:'cancelled',
      cancelledAt:new Date(),
      cancelReason:'account_fallback_after_handoff_failure',
      lastError:String(error?.message||error).slice(0,500),
      updatedAt:new Date()
    }}
  ).catch(()=>{});
  return {done:false,result:null};
}
async function prepareNexCanalCopyHandoff(runtime,item,{caption='',stageMarker=''}) {
  await ensureIndexes();
  const d=await db(),c=d.collection(NEXCANAL_HANDOFF_COLLECTION),now=new Date();
  const existing=await c.findOne({dedupeKey:item.dedupeKey});
  if(existing?.status==='done'&&Number(existing?.resultMessageId)>0){
    return {done:true,result:{id:Number(existing.resultMessageId),messageId:Number(existing.resultMessageId),via:'nexcanal'}};
  }
  await c.updateOne(
    {dedupeKey:item.dedupeKey},
    {
      $set:{
        status:'staging',
        type:'copy',
        fromChatId:String(runtime.account.telegramUserId),
        sourceMessageId:0,
        stageBotUsername:NEXCANAL_STAGE_BOT,
        stageMarker:String(stageMarker||''),
        destination:'@'+DESTINATION,
        caption:String(caption||''),
        parseMode:'HTML',
        itemId:String(item._id),
        seriesKey:item.seriesKey||'',
        stagePreparedAt:now,
        updatedAt:now,
        nextAttemptAt:now,
        lastError:null
      },
      $setOnInsert:{createdAt:now,attempts:0}
    },
    {upsert:true}
  );
  return {done:false,result:null};
}
async function enqueueNexCanalHandoff(runtime,item,{type,sourceMessageId=0,caption=''}) {
  await ensureIndexes();
  const d=await db(),c=d.collection(NEXCANAL_HANDOFF_COLLECTION),now=new Date();
  const existing=await c.findOne({dedupeKey:item.dedupeKey});
  if(existing?.status==='done'&&Number(existing?.resultMessageId)>0){
    return {id:Number(existing.resultMessageId),messageId:Number(existing.resultMessageId),via:'nexcanal'};
  }
  if(!existing||existing.status==='failed'||(String(type)==='text'&&existing.status==='staging')){
    await c.updateOne(
      {dedupeKey:item.dedupeKey},
      {
        $set:{
          status:'pending',type:String(type),fromChatId:String(runtime.account.telegramUserId),
          sourceMessageId:Number(sourceMessageId||0),destination:'@'+DESTINATION,
          caption:String(caption||''),parseMode:'HTML',itemId:String(item._id),
          seriesKey:item.seriesKey||'',updatedAt:now,nextAttemptAt:now,lastError:null
        },
        $setOnInsert:{createdAt:now,attempts:0}
      },
      {upsert:true}
    );
  }
  return waitNexCanalHandoff(item);
}
async function publishDirectAnimeFallback(runtime,item,resolved){
  const destination=await destinationEntity(runtime);
  let sent;
  if(item.synthetic===true)sent=await publishSyntheticPresentation(runtime,item,destination);
  else if(item.kind==='presentation')sent=await publishPresentation(runtime,item,resolved,destination);
  else sent=await publishEpisode(runtime,item,resolved,destination);
  const messageId=Number(sent?.id||sent?.messageId||0);
  if(!messageId)throw new Error('direct_anime_fallback_message_missing');
  return {id:messageId,messageId,via:'account-fallback'};
}
async function publishViaNexCanal(runtime,item,resolved){
  const caption=await publicationCaption(item);
  const transferRuntime=resolved?.runtime?.client?.connected===true?resolved.runtime:runtime;
  const stage=await nexCanalStageEntity(transferRuntime);
  const marker=nexCanalStageMarker(item);
  let staged=null;
  let retainedTmp='';

  // For copy handoffs the Bot API message id is not guaranteed to match the
  // MTProto id seen by the user session. Create the handoff *before* staging
  // the media so NexCanal can correlate the marker from its own incoming
  // update and store the correct Bot API message_id/from_chat_id.
  if(!(item.synthetic===true&&!item.imageUrl) && !(item.kind==='presentation'&&resolved?.message&&!resolved.message.photo)){
    const prepared=await prepareNexCanalCopyHandoff(transferRuntime,item,{caption,stageMarker:marker});
    if(prepared.done)return prepared.result;
  }

  try{
    if(item.synthetic===true){
      if(!item.imageUrl){
        return enqueueNexCanalHandoff(runtime,item,{type:'text',caption});
      }
      try{
        const response=await fetch(String(item.imageUrl),{signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('presentation_image_http_'+response.status);
        const data=Buffer.from(await response.arrayBuffer());
        if(data.length>10*1024*1024)throw new Error('presentation_image_too_large');
        staged=await sendTelegramMedia(transferRuntime.client,stage,data,{
          fileName:'anime-presentation',mimeType:response.headers.get('content-type')||'',
          kind:'image',caption:marker,workers:1
        });
      }catch(error){
        console.warn('[NexAnime presentation fallback]',String(item.title||item.seriesKey||'?'),String(error?.message||error).slice(0,240));
        return enqueueNexCanalHandoff(runtime,item,{type:'text',caption});
      }
    }else if(item.kind==='presentation'){
      const message=resolved?.message;
      if(!message?.photo){
        return enqueueNexCanalHandoff(runtime,item,{type:'text',caption});
      }
      try{
        staged=await transferRuntime.client.sendFile(stage,{file:message.media,caption:marker,workers:1});
      }catch(firstError){
        const tmp=path.join(TMP_ROOT,'presentation-stage-'+crypto.randomUUID()+'.jpg');
        await fs.mkdir(TMP_ROOT,{recursive:true});
        try{
          const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
          const file=typeof out==='string'?out:tmp;
          staged=await transferRuntime.client.sendFile(stage,{file,caption:marker,workers:1});
        }catch(secondError){
          console.warn('[NexAnime presentation fallback]',String(item.title||item.seriesKey||'?'),String(secondError?.message||firstError?.message||secondError).slice(0,240));
          return enqueueNexCanalHandoff(runtime,item,{type:'text',caption});
        }finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
      }
    }else{
      if(!(await mediaReuploadAllowed())){
        const err=new Error('media_reupload_requires_authorized_policy');err.code='MEDIA_POLICY';throw err;
      }
      const message=resolved?.message;
      if(!message?.media)throw new Error('source_media_missing');
      try{
        staged=await transferRuntime.client.sendFile(stage,{
          file:message.media,caption:marker,
          forceDocument:item.mediaKind==='document',
          supportsStreaming:item.mediaKind==='video'
        });
      }catch(directError){
        const size=Number(message?.document?.size||0);
        if(size>25*1024*1024){
          const err=new Error('telegram_stage_copy_failed: '+String(directError?.message||directError));
          err.code='DIRECT_COPY';throw err;
        }
        const finalName=item.cleanedFilename||safeFilename(item.title,item.season,item.episode,item.language,item.quality,filename(message));
        const ext=path.extname(finalName)||'.bin';
        retainedTmp=retainedTmpPath('episode-stage',item,ext);
        const file=await retainedMediaFile(transferRuntime.client,message,retainedTmp);
        const data=await fs.readFile(file);
        staged=await sendTelegramMedia(transferRuntime.client,stage,data,{
          fileName:finalName,mimeType:String(message?.document?.mimeType||''),
          kind:item.mediaKind==='document'?'document':'auto',
          caption:marker,workers:1
        });
      }
    }
    const stagedMtprotoMessageId=Number(staged?.id||staged?.messageId||0);
    if(!stagedMtprotoMessageId)throw new Error('nexcanal_stage_message_missing');
    // Never overwrite sourceMessageId here: NexCanal's update processor owns
    // that field and writes the Bot API id after matching stageMarker.
    await (await db()).collection(NEXCANAL_HANDOFF_COLLECTION).updateOne(
      {dedupeKey:item.dedupeKey,status:'staging'},
      {$set:{stagedMtprotoMessageId,stagedAt:new Date(),updatedAt:new Date()}}
    );
    const result=await waitNexCanalHandoff(item);
    // Public NexCanal handoff is confirmed: the local episode copy is now disposable.
    if(retainedTmp){
      await removeTmpFile(retainedTmp);
      retainedTmp='';
    }
    return result;
  }finally{
    const sourceMessageId=Number(staged?.id||staged?.messageId||0);
    if(sourceMessageId){
      try{await transferRuntime.client.deleteMessages(stage,[sourceMessageId],{revoke:true})}catch{}
    }
  }
}

async function purgePublishedEpisodeImageCards(runtime){
  if(runtime?.animeIngest?.episodeCardCleanupDone===true)return {deleted:0,failed:0,skipped:true};
  const d=await db();
  const publications=d.collection('nexanime_publications');
  const queue=d.collection('nexanime_queue');
  const rows=await publications.find({
    kind:'presentation',
    episode:{$ne:null},
    telegramMessageId:{$gt:0},
    purgedAt:{$exists:false}
  }).project({_id:1,telegramMessageId:1,seriesKey:1,season:1,episode:1}).sort({telegramMessageId:1}).toArray();

  let deleted=0,failed=0;
  if(rows.length){
    const destination=await destinationEntity(runtime);
    for(let i=0;i<rows.length;i+=100){
      const chunk=rows.slice(i,i+100);
      const ids=chunk.map(x=>Number(x.telegramMessageId)).filter(Boolean);
      if(!ids.length)continue;
      try{
        await runtime.client.deleteMessages(destination,ids,{revoke:true});
        deleted+=ids.length;
        await publications.updateMany(
          {_id:{$in:chunk.map(x=>x._id)}},
          {$set:{
            purgedAt:new Date(),
            purgedBy:'episode_image_card_cleanup_v1',
            purgeReason:'episode_image_card_disabled'
          },$unset:{purgeError:'',purgeAttemptAt:''}}
        );
      }catch(error){
        failed+=ids.length;
        await publications.updateMany(
          {_id:{$in:chunk.map(x=>x._id)}},
          {$set:{
            purgeError:String(error?.message||error).slice(0,300),
            purgeAttemptAt:new Date()
          }}
        );
      }
      await sleep(150);
    }
  }

  await queue.updateMany(
    {
      kind:'presentation',
      episode:{$ne:null},
      status:{$in:['queued','publishing']}
    },
    {$set:{
      status:'superseded',
      supersededAt:new Date(),
      supersededReason:'episode_image_card_disabled',
      updatedAt:new Date()
    },$unset:{claimAt:'',claimBy:'',lastError:''}}
  );

  // Items quarantined by the old "first source wins" resolver deserve one
  // retry under the new multi-source resolver. A still-invalid variant will
  // immediately quarantine again and the next variant remains available.
  const recovered=await queue.updateMany(
    {
      kind:'episode',
      status:'quarantine',
      quarantineReason:'source_identity_mismatch',
      recoveredReason:{$ne:'multi_source_validation'}
    },
    {$set:{
      status:'queued',
      recoveredAt:new Date(),
      recoveredReason:'multi_source_validation',
      updatedAt:new Date()
    },$unset:{quarantineReason:'',lastError:'',claimAt:'',claimBy:''}}
  );

  const scheduler=d.collection('nexanime_config');
  const schedulerState=await scheduler.findOne({_id:'scheduler'});
  const repairSeries=String(schedulerState?.lastCompletedSeriesKey||'');
  let resumedSeries='';
  if(repairSeries){
    const repairPending=await queue.countDocuments({
      seriesKey:repairSeries,
      kind:'episode',
      status:'queued',
      recoveredReason:'multi_source_validation'
    });
    if(repairPending>0){
      const repairNow=new Date();
      const activeKey=String(schedulerState?.activeSeriesKey||'');
      const activeRemaining=activeKey?await queue.countDocuments({
        seriesKey:activeKey,kind:'episode',status:{$in:['queued','publishing']}
      }):0;
      if(activeKey&&activeKey!==repairSeries&&activeRemaining>0){
        // Recovery work must never interrupt the series currently being
        // published. Queue it behind the active series instead.
        await scheduler.updateOne(
          {_id:'scheduler'},
          {$set:{
            forcedNextSeriesKey:repairSeries,
            repairQueuedAt:repairNow,
            repairResumeReason:'recovered_identity_mismatch_queued',
            updatedAt:repairNow
          }},
          {upsert:true}
        );
      }else{
        resumedSeries=repairSeries;
        await scheduler.updateOne(
          {_id:'scheduler'},
          {$set:{
            activeSeriesKey:repairSeries,
            activeSeriesStartedAt:repairNow,
            repairResumeAt:repairNow,
            repairResumeReason:'recovered_identity_mismatch',
            updatedAt:repairNow
          },$unset:{
            plannedSeriesKey:'',
            plannedAt:'',
            plannedSummary:'',
            cooldownUntil:''
          }},
          {upsert:true}
        );
      }
    }
  }

  runtime.animeIngest ??={};
  runtime.animeIngest.episodeCardCleanupDone=failed===0;
  runtime.animeIngest.episodeCardCleanupAt=new Date();
  runtime.animeIngest.episodeCardCleanupDeleted=deleted;
  runtime.animeIngest.episodeCardCleanupFailed=failed;
  console.log('[NexAnime cleanup] episode image cards deleted='+deleted+' failed='+failed+' recoveredIdentity='+Number(recovered?.modifiedCount||0)+' resumedSeries='+(resumedSeries||'none'));
  return {deleted,failed,recoveredIdentity:Number(recovered?.modifiedCount||0),resumedSeries:resumedSeries||null,skipped:false};
}

async function publishOne(runtime){
  runtime.animeIngest ??={};
  runtime.animeIngest.lastPublishAttemptAt=new Date();
  if(!isPublisherRuntime(runtime)){
    runtime.animeIngest.lastPublishSkipReason='not_publisher';
    return false;
  }
  if(runtime.animeIngest?.publishing){
    runtime.animeIngest.lastPublishSkipReason='already_publishing';
    return false;
  }
  // Queue writes from discovery are idempotent and claimNext already enforces
  // synopsis + strict episode order. Long discovery scans must not pause publishing.
  const locked=await acquireGlobalPublishLock(runtime);
  if(!locked){
    runtime.animeIngest.lastPublishSkipReason='global_lock_busy';
    return false;
  }
  runtime.animeIngest.publishing=true;
  let item=null;
  try{
    item=await claimNext(runtime);
    if(!item){
      runtime.animeIngest.lastPublishSkipReason='no_claimable_item';
      return false;
    }
    if(await alreadyPublished(item.dedupeKey)){
      await (await db()).collection('nexanime_queue').updateOne({_id:item._id},{$set:{status:'published',updatedAt:new Date(),deduplicated:true}});
      return true;
    }
    let resolved=null;
    if(item.synthetic!==true){
      // resolveSource validates each candidate source for episode items and
      // falls through to the next source instead of failing on the first stale
      // or misidentified message.
      resolved=await resolveSource(runtime,item);
      if(!resolved){
        const error=new Error('source_message_unavailable_for_runtime');
        error.code='SOURCE_UNAVAILABLE';
        throw error;
      }
    }
    let sent;
    try{
      sent=await publishViaNexCanal(runtime,item,resolved);
    }catch(error){
      if(!isNexCanalFallbackError(error))throw error;
      const handoff=await cancelNexCanalHandoffForFallback(item,error);
      if(handoff.done){
        sent=handoff.result;
      }else{
        console.warn(
          '[NexAnime] NexCanal unavailable; using direct account fallback',
          item.dedupeKey,
          String(error?.message||error).slice(0,180)
        );
        sent=await publishDirectAnimeFallback(runtime,item,resolved);
      }
    }
    await markPublication(item,sent,runtime);
    await mirrorPublishedAnimeToWhatsApp(runtime,item,resolved,sent).catch(error=>console.warn('[NexAnime/WhatsApp]',String(error?.message||error).slice(0,300)));
    runtime.animeIngest.lastPublishedAt=new Date();
    runtime.animeIngest.lastPublishSkipReason='';
    runtime.animeIngest.lastPublishError='';
    runtime.animeIngest.published=(runtime.animeIngest.published||0)+1;
    console.log('[NexAnime] published',item.dedupeKey,'-> @'+DESTINATION);
    return true;
  }catch(e){
    if(e?.message!=='source_message_unavailable_for_runtime'){
      console.warn('[NexAnime publish]',String(runtime.account.telegramUserId),String(e?.message||e).slice(0,300));
    }
    runtime.animeIngest.lastPublishSkipReason='publish_error';
    runtime.animeIngest.lastPublishError=String(e?.message||e).slice(0,500);
    runtime.animeIngest.lastPublishErrorAt=new Date();
    if(item)await releaseClaim(item,e).catch(()=>{});
    return false;
  }finally{
    runtime.animeIngest.publishing=false;
    await releaseGlobalPublishLock(runtime);
  }
}

export async function startAnimeIngest(runtime){
  const listener=isListenerRuntime(runtime)&&runtime?.animeScanDisabled!==true;
  const publisher=isPublisherRuntime(runtime);
  if(!listener&&!publisher)return false;
  if(runtime?.animeIngest?.enabled===true){
    registerLiveAnimeRuntime(runtime);
    return true;
  }

  // A previous partial startup may have left timer handles behind. Clear them
  // before rebuilding the ingest loop so reconciliation never creates duplicates.
  await stopAnimeIngest(runtime).catch(()=>{});
  runtime.animeIngest={
    ...(runtime.animeIngest||{}),
    enabled:false,destination:'@'+DESTINATION,listener,publisher,mediaPolicy:await currentMediaPolicy()
  };
  registerLiveAnimeRuntime(runtime);

  try{
    await ensureIndexes();
    queueMicrotask(()=>cleanupTmpFiles().catch(()=>{}));
    runtime.animeIngest.cleanupTimer=setInterval(()=>cleanupTmpFiles().catch(()=>{}),TMP_CLEANUP_MS);
    runtime.animeIngest.cleanupTimer.unref?.();
    if(listener){
      queueMicrotask(()=>discoverSources(runtime).catch(e=>console.error('[NexAnime discovery]',String(e?.message||e))));
      runtime.animeIngest.discoveryTimer=setInterval(
        ()=>discoverSources(runtime).catch(e=>console.error('[NexAnime discovery]',String(e?.message||e))),
        DISCOVERY_MS
      );
      runtime.animeIngest.discoveryTimer.unref?.();
      runtime.animeIngest.pollTimer=setInterval(()=>pollAnimeSources(runtime).catch(()=>{}),POLL_MS);
      runtime.animeIngest.pollTimer.unref?.();
    }
    if(publisher){
      // Remove legacy per-episode poster cards that were already published before
      // this fix. Real episode media and the one general synopsis are untouched.
      await purgePublishedEpisodeImageCards(runtime);
      runtime.animeIngest.publishTimer=setInterval(()=>publishOne(runtime).catch(()=>{}),PUBLISH_MS);
      runtime.animeIngest.publishTimer.unref?.();
      queueMicrotask(()=>publishOne(runtime).catch(()=>{}));
    }
    runtime.animeIngest.enabled=true;
    runtime.animeIngest.lastStartedAt=new Date();
    runtime.animeIngest.lastStartError='';
    return true;
  }catch(error){
    runtime.animeIngest.lastStartError=String(error?.message||error).slice(0,500);
    runtime.animeIngest.lastStartFailedAt=new Date();
    await stopAnimeIngest(runtime).catch(()=>{});
    throw error;
  }
}
export async function animePublishNow(runtime){
  if(!isPublisherRuntime(runtime))throw new Error('anime_publisher_runtime_required');
  const published=await publishOne(runtime);
  const d=await db();
  const [scheduler,lock,lastPublication]=await Promise.all([
    d.collection('nexanime_config').findOne({_id:'scheduler'}),
    d.collection('nexanime_locks').findOne({_id:'publisher'}),
    d.collection('nexanime_publications').findOne(
      {purgedAt:{$exists:false}},
      {sort:{publishedAt:-1,_id:-1},projection:{seriesKey:1,kind:1,season:1,episode:1,publishedAt:1,telegramMessageId:1}}
    )
  ]);
  return {
    ok:true,published:Boolean(published),
    reason:String(runtime.animeIngest?.lastPublishSkipReason||''),
    error:String(runtime.animeIngest?.lastPublishError||''),
    anime:animeIngestStatus(runtime),
    scheduler:scheduler||null,
    publisherLock:lock||null,
    lastPublication:lastPublication||null
  };
}

export async function stopAnimeIngest(runtime){
  unregisterLiveAnimeRuntime(runtime);
  if(!runtime?.animeIngest)return;
  if(runtime.animeIngest.discoveryTimer)clearInterval(runtime.animeIngest.discoveryTimer);
  if(runtime.animeIngest.discoveryRetryTimer)clearTimeout(runtime.animeIngest.discoveryRetryTimer);
  if(runtime.animeIngest.publishTimer)clearInterval(runtime.animeIngest.publishTimer);
  if(runtime.animeIngest.pollTimer)clearInterval(runtime.animeIngest.pollTimer);
  if(runtime.animeIngest.cleanupTimer)clearInterval(runtime.animeIngest.cleanupTimer);
  runtime.animeIngest.discoveryTimer=null;
  runtime.animeIngest.discoveryRetryTimer=null;
  runtime.animeIngest.publishTimer=null;
  runtime.animeIngest.pollTimer=null;
  runtime.animeIngest.cleanupTimer=null;
  runtime.animeIngest.enabled=false;
}
export function animeIngestStatus(runtime){
  const a=runtime?.animeIngest||{};
  return {
    enabled:a.enabled===true,listener:a.listener===true,publisher:a.publisher===true,
    handoffWorker:a.publisher===true,publicPublisher:'@'+NEXCANAL_STAGE_BOT,destination:a.destination||'@'+DESTINATION,
    mediaPolicy:a.mediaPolicy||MEDIA_POLICY_DEFAULT,sources:a.sources||0,queued:a.queued||0,published:a.published||0,
    lastQueuedAt:a.lastQueuedAt||null,lastPublishedAt:a.lastPublishedAt||null,
    lastPublishAttemptAt:a.lastPublishAttemptAt||null,lastPublishSkipReason:a.lastPublishSkipReason||'',
    lastPublishErrorAt:a.lastPublishErrorAt||null,lastPublishError:a.lastPublishError||'',
    lastStartedAt:a.lastStartedAt||null,lastStartFailedAt:a.lastStartFailedAt||null,lastStartError:a.lastStartError||'',
    lastDiscoveryAt:a.lastDiscoveryAt||null,lastBackfillAt:a.lastBackfillAt||null,
    lastBackfillCount:a.lastBackfillCount||0,lastPollAt:a.lastPollAt||null,
    lastPollCount:a.lastPollCount||0,discovering:a.discovering===true,polling:a.polling===true,
    publishMs:PUBLISH_MS,interSeriesMs:INTER_SERIES_MS
  };
}

export const __test={
  parseEpisode,detectLanguage,detectQuality,stripNoiseTitle,cleanCaption,safeFilename,
  classifyMessage,sourceStats,titleSimilarity,releaseKey,presentationKey,
  cleanSeriesTitle,sourceTitleCandidate,deriveRawAnchors,commonPrefixTitle,verifyAnimeTitle,
  standardizedCaption,quotedCaption,titleFromMessage,titleEvidenceFromMessage,titlesClearlyConflict,
  episodeEvidenceFromMessage,meaningfulTitleSimilarity,bestAnchor,episodeVariantScore,episodeIdentityCompatible,
  isTransientPublishError,inferredSeasonAlias,shouldParkTransientEpisode,episodeVariantRetryReady,
  queuedPresentationNeedsRepair,isNexCanalCopyMissingError,isNexCanalFallbackError,interSeriesDeadlineFrom,
  timing:{publishMs:PUBLISH_MS,interSeriesMs:INTER_SERIES_MS,transientVariantRetryMs:TRANSIENT_VARIANT_RETRY_MS}
};



export async function animeBeginRebuild(runtime,{deadline=null}={}){
  if(!isListenerRuntime(runtime))throw new Error('anime_listener_runtime_required');
  await ensureIndexes();
  const d=await db();
  const destination=await destinationEntity(runtime);
  const now=new Date();
  const rebuildId=crypto.randomUUID();

  await d.collection('nexanime_config').updateOne(
    {_id:'rebuild'},
    {
      $set:{
        mode:'rebuild',
        rebuildId,
        startedAt:now,
        scanBarrier:true,
        deadline:deadline?new Date(deadline):null,
        publisherAccountId:String(runtime.account.telegramUserId),
        publisherUsername:String(runtime.account.username||''),
        updatedAt:now
      },
      $unset:{completedAt:''}
    },
    {upsert:true}
  );

  const pubs=await d.collection('nexanime_publications')
    .find({telegramMessageId:{$gt:0},purgedAt:{$exists:false}})
    .project({_id:1,telegramMessageId:1})
    .sort({telegramMessageId:1}).toArray();

  let deleted=0,failed=0;
  for(let i=0;i<pubs.length;i+=100){
    const chunk=pubs.slice(i,i+100);
    const ids=chunk.map(x=>Number(x.telegramMessageId)).filter(Boolean);
    if(!ids.length)continue;
    try{
      await runtime.client.deleteMessages(destination,ids,{revoke:true});
      deleted+=ids.length;
      await d.collection('nexanime_publications').updateMany(
        {_id:{$in:chunk.map(x=>x._id)}},
        {$set:{purgedAt:new Date(),purgedBy:rebuildId}}
      );
    }catch(error){
      failed+=ids.length;
      await d.collection('nexanime_publications').updateMany(
        {_id:{$in:chunk.map(x=>x._id)}},
        {$set:{purgeError:String(error?.message||error).slice(0,300),purgeAttemptAt:new Date()}}
      );
    }
    await sleep(250);
  }

  const superseded=await d.collection('nexanime_queue').updateMany(
    {status:{$ne:'superseded'}},
    {
      $set:{status:'superseded',supersededAt:new Date(),rebuildId,updatedAt:new Date()},
      $unset:{claimAt:'',claimBy:'',lastError:'',quarantineReason:''}
    }
  );
  await d.collection('nexanime_sources').updateMany(
    {},
    {
      $set:{lastSeenMessageId:0,needsReindex:true,selected:false,updatedAt:new Date()},
      $unset:{seriesAnchors:'',seriesVerifiedAt:'',verifiedAnimeSeries:'',lastPolledAt:'',sourceRank:'',selectionPosition:'',selectionUpdatedAt:''}
    }
  );
  await d.collection('nexanime_listener_state').updateMany({},{$set:{discovering:false,updatedAt:new Date()}});
  await d.collection('nexanime_locks').updateMany({},{$set:{expiresAt:new Date(0),updatedAt:new Date()}});
  await d.collection('nexanime_config').updateOne(
    {_id:'scheduler'},
    {$unset:{activeSeriesKey:'',activeSeriesStartedAt:''},$set:{updatedAt:new Date()}},
    {upsert:true}
  );

  runtime.animeIngest ??={};
  runtime.animeIngest.discoveryRequestedAt=new Date();
  queueMicrotask(()=>discoverSources(runtime).catch(e=>console.error('[NexAnime rebuild discovery]',String(e?.message||e))));
  return {
    ok:true,rebuildId,deleted,deleteFailed:failed,
    superseded:superseded.modifiedCount,
    destination:'@'+DESTINATION,
    deadline:deadline||null
  };
}

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
  const [schedulerState,rebuildState]=await Promise.all([
    d.collection('nexanime_config').findOne({_id:'scheduler'}),
    d.collection('nexanime_config').findOne({_id:'rebuild'})
  ]);
  return {
    ok:true,enabled:ENABLED,destination:'@'+DESTINATION,
    listeners:[...LISTENERS].map(x=>'@'+x),
    mediaPolicy:await currentMediaPolicy(),
    interSeriesMinutes:INTER_SERIES_MS/60000,
    scheduler:schedulerState||null,rebuild:rebuildState||null,
    sources,sourceList,queue,published,recent
  };
}

export async function animeDedupePublishedEpisodeVariants(runtime,{dryRun=true,maxGroups=500}={}){
  if(!runtime?.client)throw new Error('anime_runtime_required');
  await ensureIndexes();
  const d=await db(),now=new Date();
  const publications=d.collection('nexanime_publications');
  const groups=await publications.aggregate([
    {$match:{kind:'episode',purgedAt:{$exists:false},telegramMessageId:{$gt:0}}},
    {$group:{
      _id:{seriesKey:'$seriesKey',season:{$ifNull:['$season',1]},episode:'$episode'},
      count:{$sum:1}
    }},
    {$match:{count:{$gt:1}}},
    {$sort:{'_id.seriesKey':1,'_id.season':1,'_id.episode':1}},
    {$limit:Math.max(1,Math.min(5000,Number(maxGroups)||500))}
  ]).toArray();

  const plan=[];
  for(const group of groups){
    const rows=await publications.find({
      seriesKey:group._id.seriesKey,
      kind:'episode',
      season:group._id.season,
      episode:group._id.episode,
      purgedAt:{$exists:false},
      telegramMessageId:{$gt:0}
    }).toArray();
    rows.sort((a,b)=>
      episodeVariantScore(b)-episodeVariantScore(a)||
      new Date(a.publishedAt||a.createdAt||0)-new Date(b.publishedAt||b.createdAt||0)||
      Number(a.telegramMessageId||0)-Number(b.telegramMessageId||0)
    );
    if(rows.length>1)plan.push({identity:group._id,keep:rows[0],remove:rows.slice(1)});
  }

  const publicPlan=plan.map(x=>({
    identity:x.identity,
    keep:{
      id:String(x.keep._id),dedupeKey:x.keep.dedupeKey,
      telegramMessageId:Number(x.keep.telegramMessageId||0),
      language:x.keep.language||'',quality:x.keep.quality||'',
      score:episodeVariantScore(x.keep)
    },
    remove:x.remove.map(r=>({
      id:String(r._id),dedupeKey:r.dedupeKey,
      telegramMessageId:Number(r.telegramMessageId||0),
      language:r.language||'',quality:r.quality||'',
      score:episodeVariantScore(r)
    }))
  }));
  const plannedRemovals=publicPlan.reduce((n,x)=>n+x.remove.length,0);
  if(dryRun){
    return {ok:true,dryRun:true,groups:publicPlan.length,plannedRemovals,plan:publicPlan};
  }

  const destination=await destinationEntity(runtime);
  const audit=await d.collection('nexanime_maintenance').insertOne({
    kind:'episode-variant-dedupe',
    status:'running',
    createdAt:now,
    accountId:String(runtime.account?.telegramUserId||''),
    accountUsername:String(runtime.account?.username||''),
    destination:'@'+DESTINATION,
    groupCount:publicPlan.length,
    plannedRemovals,
    plan:publicPlan
  });

  let deleted=0,failed=0,marked=0;
  const failures=[];
  for(const group of plan){
    const ids=group.remove.map(x=>Number(x.telegramMessageId||0)).filter(Boolean);
    if(!ids.length)continue;
    try{
      await runtime.client.deleteMessages(destination,ids,{revoke:true});
      deleted+=ids.length;
      const result=await publications.updateMany(
        {_id:{$in:group.remove.map(x=>x._id)},purgedAt:{$exists:false}},
        {$set:{
          purgedAt:new Date(),
          purgedBy:'nexguard_episode_variant_dedupe_v1',
          purgeReason:'duplicate_episode_variant',
          canonicalTelegramMessageId:Number(group.keep.telegramMessageId||0),
          canonicalDedupeKey:String(group.keep.dedupeKey||''),
          supervisorCleanupAt:new Date()
        },$unset:{purgeError:'',purgeAttemptAt:''}}
      );
      marked+=Number(result.modifiedCount||0);
    }catch(error){
      failed+=ids.length;
      const message=String(error?.errorMessage||error?.message||error).slice(0,500);
      failures.push({identity:group.identity,messageIds:ids,error:message});
      await publications.updateMany(
        {_id:{$in:group.remove.map(x=>x._id)},purgedAt:{$exists:false}},
        {$set:{purgeError:message,purgeAttemptAt:new Date()}}
      );
    }
    await sleep(150);
  }

  const remaining=await publications.aggregate([
    {$match:{kind:'episode',purgedAt:{$exists:false},telegramMessageId:{$gt:0}}},
    {$group:{_id:{seriesKey:'$seriesKey',season:{$ifNull:['$season',1]},episode:'$episode'},count:{$sum:1}}},
    {$match:{count:{$gt:1}}},
    {$count:'n'}
  ]).toArray();
  const remainingDuplicateIdentities=Number(remaining?.[0]?.n||0);

  await d.collection('nexanime_maintenance').updateOne(
    {_id:audit.insertedId},
    {$set:{
      status:failed?'partial':'done',
      completedAt:new Date(),deleted,failed,marked,
      remainingDuplicateIdentities,
      failures:failures.slice(0,100)
    }}
  );

  return {
    ok:failed===0,dryRun:false,
    auditId:String(audit.insertedId),
    groups:publicPlan.length,plannedRemovals,
    deleted,failed,marked,remainingDuplicateIdentities,
    failures
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


export async function setAnimeMediaPolicy(policy='authorized_only'){
  const value=String(policy||'authorized_only').toLowerCase();
  if(!['authorized_only','authorized','allow','allowed'].includes(value)){
    throw new Error('invalid_anime_media_policy');
  }
  await ensureIndexes();
  const d=await db();
  await d.collection('nexanime_config').updateOne(
    {_id:'global'},
    {$set:{mediaPolicy:value,updatedAt:new Date()}},
    {upsert:true}
  );
  MEDIA_POLICY_CACHE={value,expires:Date.now()+30_000};
  for(const r of globalThis?.__nexanimeRuntimes||[]){
    if(r?.animeIngest)r.animeIngest.mediaPolicy=value;
  }
  return {ok:true,mediaPolicy:value};
}


export async function animeSupervisorAudit({repair=false,source='automation-supervisor'}={}){
  await ensureIndexes();
  const d=await db(),now=new Date();
  const incidents=[],repairs=[];
  const queue=d.collection('nexanime_queue');
  const publications=d.collection('nexanime_publications');
  const schedulerCollection=d.collection('nexanime_config');

  if(repair){
    const recovered=await reconcileStalePublishing();
    if(recovered)repairs.push({kind:'stale-publishing',repaired:recovered});
  }

  const scheduler=await schedulerCollection.findOne({_id:'scheduler'});
  const activeSeriesKey=String(scheduler?.activeSeriesKey||'');

  if(activeSeriesKey){
    const foreignPublishing=await queue.find({
      status:'publishing',
      seriesKey:{$ne:activeSeriesKey}
    }).project({_id:1,seriesKey:1,title:1,season:1,episode:1,claimAt:1,claimBy:1}).limit(100).toArray();

    if(foreignPublishing.length){
      incidents.push({
        kind:'concurrent-series',
        target:'anime-scheduler',
        severity:'critical',
        message:'Une autre série est en état publishing pendant la série active.',
        activeSeriesKey,
        items:foreignPublishing.map(x=>({id:String(x._id),seriesKey:x.seriesKey,title:x.title,season:x.season,episode:x.episode}))
      });
      if(repair){
        const ids=foreignPublishing.map(x=>x._id);
        const r=await queue.updateMany(
          {_id:{$in:ids},status:'publishing'},
          {$set:{status:'queued',updatedAt:now,supervisorRecoveredAt:now,supervisorRecoveredReason:'foreign_series_during_active_series'},$unset:{claimAt:'',claimBy:''}}
        );
        repairs.push({kind:'concurrent-series',requeued:Number(r.modifiedCount||0)});
      }
    }
  }

  const queuedEpisodes=await queue.find({
    status:{$in:['queued','publishing']},
    kind:'episode',
    seriesKey:{$type:'string'}
  }).project({_id:1,seriesKey:1,season:1,episode:1,status:1}).limit(2000).toArray();

  const publishedKeys=new Map();
  for(const item of queuedEpisodes){
    const key=[item.seriesKey,Number(item.season??1),Number(item.episode)].join('|');
    if(!publishedKeys.has(key)){
      publishedKeys.set(key,await publications.findOne({
        seriesKey:item.seriesKey,kind:'episode',season:item.season??1,episode:item.episode,purgedAt:{$exists:false}
      },{projection:{_id:1,telegramMessageId:1,publishedAt:1}}));
    }
    if(publishedKeys.get(key)){
      incidents.push({
        kind:'already-published-queued',
        target:item.seriesKey,
        severity:'warning',
        message:'Un épisode déjà publié est encore présent dans la file.',
        seriesKey:item.seriesKey,season:item.season??1,episode:item.episode,status:item.status
      });
      if(repair){
        await suppressAlreadyPublishedEpisode(d,item.seriesKey,item.season??1,item.episode);
      }
    }
  }
  if(repair){
    const repairedCount=incidents.filter(x=>x.kind==='already-published-queued').length;
    if(repairedCount)repairs.push({kind:'already-published-queued',suppressed:repairedCount});
  }

  const duplicatePublished=await publications.aggregate([
    {$match:{kind:'episode',purgedAt:{$exists:false},seriesKey:{$type:'string'}}},
    {$group:{
      _id:{seriesKey:'$seriesKey',season:{$ifNull:['$season',1]},episode:'$episode'},
      count:{$sum:1},
      rows:{$push:{dedupeKey:'$dedupeKey',telegramMessageId:'$telegramMessageId',language:'$language',quality:'$quality',publishedAt:'$publishedAt'}}
    }},
    {$match:{count:{$gt:1}}},
    {$sort:{count:-1}},
    {$limit:50}
  ]).toArray();
  for(const dup of duplicatePublished){
    incidents.push({
      kind:'published-duplicate',
      target:dup._id?.seriesKey||'anime',
      severity:'critical',
      message:'Le même épisode existe plusieurs fois dans les publications enregistrées.',
      seriesKey:dup._id?.seriesKey,season:dup._id?.season,episode:dup._id?.episode,count:dup.count,rows:dup.rows
    });
  }

  const seriesToCheck=new Set();
  if(activeSeriesKey)seriesToCheck.add(activeSeriesKey);
  const nextSeries=await queue.aggregate([
    {$match:{status:'queued',kind:'episode',seriesKey:{$type:'string'}}},
    {$group:{_id:'$seriesKey',first:{$min:'$createdAt'}}},
    {$sort:{first:1}},
    {$limit:12}
  ]).toArray();
  for(const row of nextSeries)if(row?._id)seriesToCheck.add(String(row._id));

  for(const seriesKey of seriesToCheck){
    const [queuedPresentation,publishedPresentation,episodeCount]=await Promise.all([
      queue.findOne({seriesKey,kind:'presentation',status:{$in:['queued','publishing']},$or:[{episode:null},{episode:{$exists:false}}]},{projection:{_id:1}}),
      publications.findOne({seriesKey,kind:'presentation',purgedAt:{$exists:false},$or:[{episode:null},{episode:{$exists:false}}]},{projection:{_id:1,publishedAt:1}}),
      queue.countDocuments({seriesKey,kind:'episode',status:{$in:['queued','publishing']}})
    ]);
    if(episodeCount>0&&!queuedPresentation&&!publishedPresentation){
      incidents.push({
        kind:'missing-synopsis',
        target:seriesKey,
        severity:'critical',
        message:'Des épisodes sont prêts mais aucun synopsis général n’est prêt ou publié.',
        seriesKey,episodeCount
      });
      if(repair){
        await ensureGeneralPresentation(d,seriesKey);
        const after=await queue.findOne({seriesKey,kind:'presentation',status:'queued',$or:[{episode:null},{episode:{$exists:false}}]},{projection:{_id:1}});
        repairs.push({kind:'missing-synopsis',seriesKey,created:Boolean(after)});
      }
    }
  }

  const orderRows=await publications.aggregate([
    {$match:{purgedAt:{$exists:false},seriesKey:{$type:'string'},kind:{$in:['presentation','episode']}}},
    {$sort:{publishedAt:1,_id:1}},
    {$group:{_id:'$seriesKey',rows:{$push:{kind:'$kind',season:'$season',episode:'$episode',publishedAt:'$publishedAt',telegramMessageId:'$telegramMessageId'}}}},
    {$limit:100}
  ]).toArray();

  for(const series of orderRows){
    const rows=series.rows||[];
    const firstEpisode=rows.find(x=>x.kind==='episode');
    const firstPresentation=rows.find(x=>x.kind==='presentation'&&(x.episode==null));
    if(firstEpisode&&(!firstPresentation||new Date(firstPresentation.publishedAt||0)>new Date(firstEpisode.publishedAt||0))){
      incidents.push({
        kind:'synopsis-order',
        target:String(series._id),
        severity:'critical',
        message:'Un épisode a été publié avant le synopsis général.',
        seriesKey:String(series._id),
        firstEpisode,
        firstPresentation:firstPresentation||null
      });
    }

    const lastBySeason=new Map();
    for(const row of rows.filter(x=>x.kind==='episode'&&Number.isFinite(Number(x.episode)))){
      const season=Number(row.season??1),episode=Number(row.episode);
      const last=lastBySeason.get(season);
      if(last!=null&&episode<last){
        incidents.push({
          kind:'episode-order',
          target:String(series._id),
          severity:'warning',
          message:'Ordre décroissant détecté dans l’historique de publication.',
          seriesKey:String(series._id),season,previousEpisode:last,episode
        });
        break;
      }
      lastBySeason.set(season,Math.max(last??-Infinity,episode));
    }
  }

  if(scheduler?.gapDetected){
    const gap={...scheduler.gapDetected};
    if(repair&&gap.seriesKey&&Number.isFinite(Number(gap.expectedEpisode))){
      const missing=await queue.findOne({
        seriesKey:String(gap.seriesKey),
        kind:'episode',
        season:Number(gap.season??1),
        episode:Number(gap.expectedEpisode),
        status:'quarantine',
        quarantineReason:'publish_failures'
      });
      if(missing){
        const retry=await queue.updateOne(
          {_id:missing._id,status:'quarantine',quarantineReason:'publish_failures'},
          {$set:{
            status:'queued',
            attempts:0,
            supervisorRecoveredAt:now,
            supervisorRecoveredReason:'episode_gap_retry',
            updatedAt:now
          },$unset:{
            quarantineReason:'',claimAt:'',claimBy:''
          }}
        );
        if(Number(retry.modifiedCount||0)>0){
          repairs.push({
            kind:'episode-gap',
            seriesKey:String(gap.seriesKey),
            season:Number(gap.season??1),
            episode:Number(gap.expectedEpisode),
            requeued:1
          });
          await schedulerCollection.updateOne(
            {_id:'scheduler'},
            {$unset:{gapDetected:''},$set:{updatedAt:now}}
          );
          gap.requeuedMissingEpisode=true;
        }
      }
    }
    incidents.push({
      kind:'episode-gap',
      target:String(gap.seriesKey||activeSeriesKey||'anime'),
      severity:gap.requeuedMissingEpisode?'warning':'critical',
      message:gap.requeuedMissingEpisode
        ?'L’épisode manquant en quarantaine a été remis dans la file sans sauter l’ordre.'
        :'La publication est volontairement bloquée car un épisode précédent manque.',
      ...gap
    });
  }

  const quarantineCount=await queue.countDocuments({status:'quarantine'});
  if(quarantineCount>0){
    incidents.push({
      kind:'quarantine',
      target:'anime-queue',
      severity:quarantineCount>=10?'critical':'warning',
      message:quarantineCount+' élément(s) sont en quarantaine.',
      count:quarantineCount
    });
  }

  await schedulerCollection.updateOne(
    {_id:'supervisor'},
    {$set:{
      lastAuditAt:now,
      source:String(source||'automation-supervisor'),
      repairEnabled:repair===true,
      incidentCount:incidents.length,
      repairCount:repairs.length,
      incidents:incidents.slice(0,100),
      repairs:repairs.slice(0,100),
      updatedAt:now
    }},
    {upsert:true}
  );

  return {
    ok:incidents.every(x=>x.severity!=='critical'),
    repaired:repair===true,
    activeSeriesKey:activeSeriesKey||null,
    incidents,
    repairs,
    quarantineCount,
    auditedAt:now
  };
}
