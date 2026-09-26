import { Button } from 'teleproto/tl/custom/button.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './store.mjs';
import { sendTelegramMedia } from './media-send.mjs';

const ENABLED=String(process.env.NEXANIME_ENABLED||'true').toLowerCase()!=='false';
const REQUIRED_LISTENERS=['tresor20001','tresor20009'];
const LISTENERS=new Set([
  ...REQUIRED_LISTENERS,
  ...String(process.env.NEXANIME_LISTENER_USERNAMES||'')
    .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean)
]);
const DESTINATION=String(process.env.NEXCANAL__ANIME_DESTINATION||process.env.NEXANIME_DESTINATION||'theotaku_nexus').trim().replace(/^@/,'');
const NEXCANAL_STAGE_BOT=String(process.env.NEXANIME_NEXCANAL_BOT||'the_big_dipper_bot').trim().replace(/^@/,'');
const NEXCANAL_HANDOFF_COLLECTION='nexanime_nexcanal_handoffs';
const NEXCANAL_HANDOFF_TIMEOUT_MS=Math.max(15_000,Number(process.env.NEXANIME_NEXCANAL_HANDOFF_TIMEOUT_MS||120_000));
const DISCOVERY_MS=Math.max(15*60*1000,Number(process.env.NEXANIME_DISCOVERY_MS||6*60*60*1000));
const PUBLISH_MS=Math.max(5000,Number(process.env.NEXANIME_PUBLISH_MS||15000));
const INTER_SERIES_MS=Math.max(60_000,Number(process.env.NEXANIME_INTER_SERIES_MS||15*60*1000));
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
const SOURCE_CACHE=new Map();
const SERIES_CACHE=new Map();
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
  return t.length>=2 && !/^(episode|ep|e|vf|vostfr|vo)$/i.test(t);
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
function presentationText(meta){
  const rows=[];
  if(meta?.genres?.length)rows.push('Genres : '+meta.genres.join(' · '));
  if(meta?.studios?.length)rows.push('Studio : '+meta.studios.join(', '));
  if(meta?.episodes)rows.push('Épisodes : '+meta.episodes);
  if(meta?.format)rows.push('Format : '+meta.format);
  const description=String(meta?.description||'').trim();
  if(description)rows.push('Synopsis\\n'+description);
  return rows.join('\\n');
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
async function canonicalizeCandidate(c,source={}){
  if(!c||!['episode','presentation'].includes(c.kind))return c;
  const q=cleanSeriesTitle(c.title);
  const direct=await verifyAnimeTitle(q);
  if(direct.ok){
    return {...c,title:direct.canonicalTitle,anilistId:direct.anilistId,verifiedAnime:true};
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
  if(!episodeIdentityCompatible(item,candidate,verified)){
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
    messageId:Number(message?.id||0)
  };
  const dedupeKey=c.kind==='episode'?releaseKey(c):presentationKey(c);
  const priority=mode==='live'?1000:100;
  const seriesKey=norm(c.title);
  const payload={
    dedupeKey,status:'queued',kind:c.kind,seriesKey,title:c.title,anilistId:c.anilistId??null,ingestedAt:now,
    season:c.season??null,episode:c.episode??null,language:c.language||'',
    quality:c.quality||'',sourcePreviousNav:c.sourcePreviousNav===true,mediaKind:c.mediaKind||'text',
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
  await d.collection('nexanime_queue').updateOne(
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
  const source={username:entity?.username||'',title:entity?.title||'',seriesAnchors:anchors};
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

async function discoverSources(runtime){
  if(!isListenerRuntime(runtime))return [];
  runtime.animeIngest ??={};
  if(runtime.animeIngest.discovering)return [];
  runtime.animeIngest.discovering=true;
  await setDiscoveryState(runtime,true);
  try{
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
        console.warn('[NexAnime backfill]',accountId,String(entity?.username||entity?.id||''),String(e?.message||e).slice(0,220));
      }
    }
    runtime.animeIngest.sources=selected.length;
    runtime.animeIngest.lastDiscoveryAt=new Date();
    return selected.map(x=>({...x.row,selected:true,sourceRank:x.rank,verifiedAnimeSeries:x.anchors.length}));
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

async function resolveSource(runtime,item){
  const sources=Array.isArray(item.sources)?item.sources:[];
  const accountId=String(runtime.account.telegramUserId);
  const ordered=[
    ...sources.filter(s=>String(s.accountId)===accountId),
    ...sources.filter(s=>String(s.accountId)!==accountId)
  ];
  let lastIdentityError=null;
  for(const source of ordered){
    const sourceIdentity=norm([source?.channelTitle,source?.channelUsername].filter(Boolean).join(' '));
    if(SOURCE_BLOCK_RE.test(sourceIdentity)){
      const error=new Error('source_identity_mismatch: blocked non-anime/live-action source');
      error.code='SOURCE_IDENTITY_MISMATCH';
      lastIdentityError=error;
      continue;
    }
    let entity=null;
    const username=String(source?.channelUsername||'').replace(/^@/,'');
    if(username){
      try{entity=await runtime.client.getEntity(username)}catch{}
    }
    if(!entity&&source?.channelId){
      try{entity=await runtime.client.getEntity(BigInt(source.channelId))}catch{}
    }
    if(!entity)continue;
    try{
      const messages=await runtime.client.getMessages(entity,{ids:[Number(source.messageId)]});
      const message=Array.isArray(messages)?messages[0]:messages;
      if(!message)continue;
      const resolved={source,entity,message};
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
  return item?.episode!=null && (
    item.mode==='live' ||
    item.sourcePreviousNav===true ||
    item.syntheticEpisodeCard===true
  );
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
      const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
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

  await fs.mkdir(TMP_ROOT,{recursive:true});
  const finalName=item.cleanedFilename||safeFilename(item.title,item.season,item.episode,item.language,item.quality,filename(message));
  const ext=path.extname(finalName)||'.bin';
  const tmp=path.join(TMP_ROOT,'episode-'+crypto.randomUUID()+ext);
  const thumb=await destinationThumb(runtime,destination);
  try{
    const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
    const file=typeof out==='string'?out:tmp;
    const data=await fs.readFile(file);
    return await sendTelegramMedia(runtime.client,destination,data,{
      fileName:finalName,
      mimeType:String(message?.document?.mimeType||''),
      kind:item.mediaKind==='document'?'document':'auto',
      caption,
      parseMode:'html',
      workers:1,
      thumb
    });
  }finally{
    await fs.rm(tmp,{force:true}).catch(()=>{});
  }
}
async function markPublication(item,sent,runtime){
  const d=await db(),now=new Date();
  await d.collection('nexanime_publications').updateOne(
    {dedupeKey:item.dedupeKey},
    {$setOnInsert:{
      dedupeKey:item.dedupeKey,seriesKey:item.seriesKey,kind:item.kind,title:item.title,season:item.season,episode:item.episode,
      language:item.language||'',quality:item.quality||'',mode:item.mode||'',destination:'@'+DESTINATION,createdAt:now
    },$set:{
      publishedAt:now,publisherRole:'nexcanal-bot',
      publisherBotUsername:NEXCANAL_STAGE_BOT,
      stagingAccountId:String(runtime.account.telegramUserId),
      stagingAccountUsername:String(runtime.account.username||''),
      telegramMessageId:Number(sent?.id||sent?.messageId||0)
    },$unset:{purgedAt:'',purgedBy:'',purgeError:''}},
    {upsert:true}
  );
  await d.collection('nexanime_queue').updateOne(
    {_id:item._id},
    {$set:{status:'published',publishedAt:now,updatedAt:now},$unset:{claimAt:'',claimBy:''}}
  );
  if(item.kind==='episode'&&item.episode!=null){
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
async function releaseClaim(item,error){
  const d=await db(),now=new Date();
  const attempts=Number(item.attempts||0)+1;
  const mediaPolicy=String(error?.code||'')==='MEDIA_POLICY';
  const identityMismatch=String(error?.code||'')==='SOURCE_IDENTITY_MISMATCH';
  await d.collection('nexanime_queue').updateOne(
    {_id:item._id},
    {$set:{
      status:identityMismatch?'quarantine':(mediaPolicy?'awaiting_rights':'queued'),
      ...(identityMismatch?{quarantineReason:'source_identity_mismatch'}:{}),
      lastError:String(error?.message||error).slice(0,500),
      updatedAt:now
    },$inc:{attempts:1},$unset:{claimAt:'',claimBy:''}}
  );
  if(attempts>=5&&!mediaPolicy&&!identityMismatch){
    await d.collection('nexanime_queue').updateOne({_id:item._id},{$set:{status:'quarantine',quarantineReason:'publish_failures',updatedAt:now}});
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
async function queuedSeriesCandidates(d){
  return d.collection('nexanime_queue').aggregate([
    {$match:{status:'queued',seriesKey:{$type:'string'}}},
    {$group:{
      _id:'$seriesKey',
      firstCreated:{$min:'$createdAt'},
      hasPresentation:{$max:{$cond:[{$eq:['$kind','presentation']},1,0]}},
      episodeCount:{$sum:{$cond:[{$eq:['$kind','episode']},1,0]}}
    }},
    {$match:{episodeCount:{$gt:0}}},
    {$sort:{hasPresentation:-1,firstCreated:1,_id:1}},
    {$limit:5}
  ]).toArray();
}
async function preparePlannedSeries(d,seriesKey){
  if(!seriesKey)return;
  await ensureGeneralPresentation(d,seriesKey).catch(()=>{});
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
async function chooseActiveSeries(d){
  const scheduler=d.collection('nexanime_config');
  const now=new Date();
  const current=await scheduler.findOne({_id:'scheduler'});

  if(current?.activeSeriesKey){
    const remaining=await d.collection('nexanime_queue').countDocuments({
      seriesKey:current.activeSeriesKey,
      status:{$in:['queued','publishing']}
    });
    if(remaining>0)return current.activeSeriesKey;

    const candidates=await queuedSeriesCandidates(d);
    const next=candidates?.[0]?._id||'';
    if(next){
      const cooldownUntil=new Date(Date.now()+INTER_SERIES_MS);
      await scheduler.updateOne(
        {_id:'scheduler'},
        {$set:{
          lastCompletedSeriesKey:current.activeSeriesKey,
          lastSeriesCompletedAt:now,
          plannedSeriesKey:next,
          cooldownUntil,
          updatedAt:now
        },$unset:{activeSeriesKey:'',activeSeriesStartedAt:''}},
        {upsert:true}
      );
      await preparePlannedSeries(d,next);
      return '';
    }

    await scheduler.updateOne(
      {_id:'scheduler'},
      {$set:{lastCompletedSeriesKey:current.activeSeriesKey,lastSeriesCompletedAt:now,updatedAt:now},
       $unset:{activeSeriesKey:'',activeSeriesStartedAt:'',plannedSeriesKey:'',plannedAt:'',plannedSummary:'',cooldownUntil:''}},
      {upsert:true}
    );
  }

  const state=await scheduler.findOne({_id:'scheduler'});
  const cooldownUntil=state?.cooldownUntil?new Date(state.cooldownUntil):null;
  if(cooldownUntil&&cooldownUntil>now){
    if(state?.plannedSeriesKey)await preparePlannedSeries(d,state.plannedSeriesKey);
    return '';
  }

  let next=state?.plannedSeriesKey||'';
  if(next){
    const exists=await d.collection('nexanime_queue').countDocuments({seriesKey:next,status:'queued',kind:'episode'});
    if(!exists)next='';
  }
  if(!next){
    const candidates=await queuedSeriesCandidates(d);
    next=candidates?.[0]?._id||'';
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

async function ensureGeneralPresentation(d,seriesKey){
  const queue=d.collection('nexanime_queue');
  const existingQueue=await queue.findOne({
    seriesKey,kind:'presentation',
    $or:[{episode:null},{episode:{$exists:false}}],
    status:{$in:['queued','publishing']}
  },{projection:{_id:1}});
  if(existingQueue)return;

  const existingPublished=await d.collection('nexanime_publications').findOne({
    seriesKey,kind:'presentation',
    $or:[{episode:null},{episode:{$exists:false}}],
    purgedAt:{$exists:false}
  },{projection:{_id:1}});
  if(existingPublished)return;

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
    cleanedCaption:presentationText(meta)
  };
  const dedupeKey=presentationKey(presentation);
  const existingAny=await queue.findOne({dedupeKey});

  const payload={
    dedupeKey,status:'queued',kind:'presentation',seriesKey,
    title:presentation.title,anilistId:presentation.anilistId,season:null,episode:null,
    language:'',quality:'',mediaKind:'photo',cleanedCaption:presentation.cleanedCaption,
    cleanedFilename:'',originalFilename:'',confidence:1,
    destination:'@'+DESTINATION,mode:'synthetic',synthetic:true,
    imageUrl:meta.coverImage||'',attempts:0,ingestedAt:new Date(0),
    repairedPresentation:true,repairedPresentationAt:now,updatedAt:now
  };

  if(existingAny){
    // A failed source synopsis with the same dedupe key must not permanently
    // block the series. Recycle it into a clean synthetic presentation.
    if(existingAny.status==='published')return;
    await queue.updateOne(
      {_id:existingAny._id},
      {$set:payload,$unset:{
        claimAt:'',claimBy:'',lastError:'',quarantineReason:'',
        supersededAt:'',supersededReason:'',recoveredAt:'',recoveredReason:''
      }}
    );
    return;
  }

  await queue.insertOne({...payload,createdAt:now});
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

async function preferredEpisodeVariant(d,seriesKey,season,episode){
  const variants=await d.collection('nexanime_queue').find(
    {seriesKey,status:'queued',kind:'episode',season,episode}
  ).limit(50).toArray();
  if(!variants.length)return null;
  variants.sort((a,b)=>episodeVariantScore(b)-episodeVariantScore(a)||new Date(a.createdAt||0)-new Date(b.createdAt||0));
  // Do not discard fallback variants before the preferred source has actually
  // been validated and published. If the first one is stale/wrong, it will be
  // quarantined and the next valid variant can be tried on the next cycle.
  return variants[0];
}

async function claimNext(runtime){
  await ensureIndexes();
  await reconcileStalePublishing();
  const d=await db();
  const accountId=String(runtime.account.telegramUserId);
  const allowAny=isPublisherRuntime(runtime);
  const seriesKey=await chooseActiveSeries(d);
  if(!seriesKey)return null;
  await ensureGeneralPresentation(d,seriesKey);

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

  // 1) Exactly one general anime presentation/synopsis is allowed.
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
    return null;
  }

  // 2) Only real episode media can be selected after the general synopsis.
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
  return null;
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
async function publishViaNexCanal(runtime,item,resolved){
  const caption=await publicationCaption(item);
  const stage=await nexCanalStageEntity(runtime);
  const marker=nexCanalStageMarker(item);
  let staged=null;

  // For copy handoffs the Bot API message id is not guaranteed to match the
  // MTProto id seen by the user session. Create the handoff *before* staging
  // the media so NexCanal can correlate the marker from its own incoming
  // update and store the correct Bot API message_id/from_chat_id.
  if(!(item.synthetic===true&&!item.imageUrl) && !(item.kind==='presentation'&&resolved?.message&&!resolved.message.photo)){
    const prepared=await prepareNexCanalCopyHandoff(runtime,item,{caption,stageMarker:marker});
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
        staged=await sendTelegramMedia(runtime.client,stage,data,{
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
        staged=await runtime.client.sendFile(stage,{file:message.media,caption:marker,workers:1});
      }catch(firstError){
        const tmp=path.join(TMP_ROOT,'presentation-stage-'+crypto.randomUUID()+'.jpg');
        await fs.mkdir(TMP_ROOT,{recursive:true});
        try{
          const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
          const file=typeof out==='string'?out:tmp;
          staged=await runtime.client.sendFile(stage,{file,caption:marker,workers:1});
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
        staged=await runtime.client.sendFile(stage,{
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
        await fs.mkdir(TMP_ROOT,{recursive:true});
        const finalName=item.cleanedFilename||safeFilename(item.title,item.season,item.episode,item.language,item.quality,filename(message));
        const ext=path.extname(finalName)||'.bin';
        const tmp=path.join(TMP_ROOT,'episode-stage-'+crypto.randomUUID()+ext);
        try{
          const out=await runtime.client.downloadMedia(message.media,{outputFile:tmp,workers:1});
          const file=typeof out==='string'?out:tmp;
          const data=await fs.readFile(file);
          staged=await sendTelegramMedia(runtime.client,stage,data,{
            fileName:finalName,mimeType:String(message?.document?.mimeType||''),
            kind:item.mediaKind==='document'?'document':'auto',
            caption:marker,workers:1
          });
        }finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
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
    return await waitNexCanalHandoff(item);
  }finally{
    const sourceMessageId=Number(staged?.id||staged?.messageId||0);
    if(sourceMessageId){
      try{await runtime.client.deleteMessages(stage,[sourceMessageId],{revoke:true})}catch{}
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
      quarantineReason:'source_identity_mismatch'
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
      resumedSeries=repairSeries;
      const repairNow=new Date();
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

  runtime.animeIngest ??={};
  runtime.animeIngest.episodeCardCleanupDone=failed===0;
  runtime.animeIngest.episodeCardCleanupAt=new Date();
  runtime.animeIngest.episodeCardCleanupDeleted=deleted;
  runtime.animeIngest.episodeCardCleanupFailed=failed;
  console.log('[NexAnime cleanup] episode image cards deleted='+deleted+' failed='+failed+' recoveredIdentity='+Number(recovered?.modifiedCount||0)+' resumedSeries='+(resumedSeries||'none'));
  return {deleted,failed,recoveredIdentity:Number(recovered?.modifiedCount||0),resumedSeries:resumedSeries||null,skipped:false};
}

async function publishOne(runtime){
  if(!isPublisherRuntime(runtime)||runtime.animeIngest?.publishing)return false;
  runtime.animeIngest ??={};
  if(await anyDiscoveryInProgress())return false;
  const locked=await acquireGlobalPublishLock(runtime);
  if(!locked)return false;
  runtime.animeIngest.publishing=true;
  let item=null;
  try{
    item=await claimNext(runtime);
    if(!item)return false;
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
      if(!resolved)throw new Error('source_message_unavailable_for_runtime');
    }
    const sent=await publishViaNexCanal(runtime,item,resolved);
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
    await releaseGlobalPublishLock(runtime);
  }
}

export async function startAnimeIngest(runtime){
  const listener=isListenerRuntime(runtime)&&runtime?.animeScanDisabled!==true;
  const publisher=isPublisherRuntime(runtime);
  if(!listener&&!publisher)return false;
  runtime.animeIngest={
    ...(runtime.animeIngest||{}),
    enabled:true,destination:'@'+DESTINATION,listener,publisher,mediaPolicy:await currentMediaPolicy()
  };
  await ensureIndexes();
  queueMicrotask(()=>cleanupTmpFiles().catch(()=>{}));
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
    enabled:a.enabled===true,listener:a.listener===true,publisher:a.publisher===true,
    handoffWorker:a.publisher===true,publicPublisher:'@'+NEXCANAL_STAGE_BOT,destination:a.destination||'@'+DESTINATION,
    mediaPolicy:a.mediaPolicy||MEDIA_POLICY_DEFAULT,sources:a.sources||0,queued:a.queued||0,published:a.published||0,
    lastQueuedAt:a.lastQueuedAt||null,lastPublishedAt:a.lastPublishedAt||null,
    lastDiscoveryAt:a.lastDiscoveryAt||null,lastBackfillAt:a.lastBackfillAt||null,
    lastBackfillCount:a.lastBackfillCount||0,lastPollAt:a.lastPollAt||null,
    lastPollCount:a.lastPollCount||0,discovering:a.discovering===true,polling:a.polling===true,
    interSeriesMs:INTER_SERIES_MS
  };
}

export const __test={
  parseEpisode,detectLanguage,detectQuality,stripNoiseTitle,cleanCaption,safeFilename,
  classifyMessage,sourceStats,titleSimilarity,releaseKey,presentationKey,
  cleanSeriesTitle,sourceTitleCandidate,deriveRawAnchors,commonPrefixTitle,verifyAnimeTitle,
  standardizedCaption,quotedCaption,titleFromMessage,titleEvidenceFromMessage,titlesClearlyConflict,
  episodeEvidenceFromMessage,meaningfulTitleSimilarity,bestAnchor,episodeVariantScore,episodeIdentityCompatible
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
