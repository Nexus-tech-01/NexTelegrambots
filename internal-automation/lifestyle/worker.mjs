import fs from 'node:fs/promises';
import path from 'node:path';

const token=String(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const destination=String(process.env.LIFESTYLE_DESTINATION||'tresor_universe').trim().replace(/^@/,'');
const contentFile=process.env.LIFESTYLE_CONTENT_FILE||'/opt/nex/apps/internal-automation/lifestyle/content.json';
const stateFile=process.env.LIFESTYLE_STATE_FILE||'/var/lib/nex/state/lifestyle/state.json';
const dryRun=/^(?:1|true|yes|on)$/i.test(String(process.env.LIFESTYLE_DRY_RUN||''));
const timezone=process.env.LIFESTYLE_TIMEZONE||'Africa/Porto-Novo';
const waBridge=String(process.env.LIFESTYLE_WHATSAPP_BRIDGE||'http://127.0.0.1:18787/publish').trim();
const activeStart=Math.max(0,Math.min(23,Number(process.env.LIFESTYLE_ACTIVE_START_HOUR||7)));
const activeEnd=Math.max(1,Math.min(24,Number(process.env.LIFESTYLE_ACTIVE_END_HOUR||23)));
const minGapMs=Math.max(30*60_000,Number(process.env.LIFESTYLE_MIN_GAP_MS||45*60_000));
const maxGapMs=Math.max(minGapMs,Number(process.env.LIFESTYLE_MAX_GAP_MS||75*60_000));
const imageTimeoutMs=Math.max(5000,Number(process.env.LIFESTYLE_IMAGE_TIMEOUT_MS||15000));

const fallbackImages={
  luxury_life:[
    'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1400&q=88'
  ],
  mood:[
    'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=1400&q=88'
  ],
  phrase_du_jour:[
    'https://images.unsplash.com/photo-1490730141103-6cac27aaab94?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1400&q=88'
  ],
  poeme:[
    'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=1400&q=88',
    'https://images.unsplash.com/photo-1490730141103-6cac27aaab94?auto=format&fit=crop&w=1400&q=88'
  ]
};

function rand(arr){return arr[Math.floor(Math.random()*arr.length)];}
function nextGap(){return Math.round(minGapMs+Math.random()*(maxGapMs-minGapMs));}
function localHour(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hour12:false}).formatToParts(new Date());
  const raw=Number(parts.find(p=>p.type==='hour')?.value||0);
  return raw===24?0:raw;
}
function inActiveWindow(){
  const h=localHour();
  return activeStart<=activeEnd ? h>=activeStart&&h<activeEnd : (h>=activeStart||h<activeEnd);
}
async function loadState(){
  try{
    const s=JSON.parse(await fs.readFile(stateFile,'utf8'));
    return {
      index:Number(s?.index||0),
      lastMessageId:s?.lastMessageId||null,
      lastPublishedAt:s?.lastPublishedAt||null,
      lastCategory:s?.lastCategory||null,
      nextNotBefore:Number(s?.nextNotBefore||0),
      recentImages:Array.isArray(s?.recentImages)?s.recentImages.slice(-80):[],
      pendingWhatsApp:Array.isArray(s?.pendingWhatsApp)?s.pendingWhatsApp.slice(-50):[]
    };
  }catch{
    return {index:0,lastMessageId:null,lastPublishedAt:null,lastCategory:null,nextNotBefore:0,recentImages:[],pendingWhatsApp:[]};
  }
}
async function saveState(s){
  await fs.mkdir(path.dirname(stateFile),{recursive:true});
  const tmp=stateFile+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(s,null,2),{mode:0o600});
  await fs.rename(tmp,stateFile);
}
async function telegram(method,body){
  const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(30000)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok)throw new Error(method+': '+String(j.description||r.status));
  return j.result;
}
function decodeSearchHtml(html=''){
  return String(html)
    .replace(/\\u002F/gi,'/')
    .replace(/\\u0026/gi,'&')
    .replace(/\\\//g,'/')
    .replace(/&quot;|&#34;/gi,'"')
    .replace(/&amp;|&#38;/gi,'&');
}
function normalizeSemanticText(v=''){
  return String(v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function semanticPhrasePresent(haystack,phrase=''){
  const p=normalizeSemanticText(phrase);
  if(!p)return false;
  const h=' '+normalizeSemanticText(haystack)+' ';
  if(h.includes(' '+p+' '))return true;
  const parts=p.split(' ').filter(Boolean);
  return parts.length>1&&parts.every(x=>h.includes(' '+x+' '));
}
function derivedSemanticTerms(item={}){
  if(Array.isArray(item.imageTerms)&&item.imageTerms.length){
    return item.imageTerms.map(normalizeSemanticText).filter(Boolean);
  }
  const stop=new Set([
    'aesthetic','wallpaper','background','image','photo','picture','hd','4k','cinematic',
    'anime','manga','art','illustration','quote','lifestyle','dark','beautiful'
  ]);
  return normalizeSemanticText(item.imageQuery||'')
    .split(' ')
    .filter(x=>x.length>=3&&!stop.has(x))
    .slice(0,8);
}
function semanticScore(item,candidate){
  const terms=derivedSemanticTerms(item);
  if(!terms.length)return -1;
  const hits=terms.filter(term=>semanticPhrasePresent(candidate?.context||'',term));
  const explicit=Array.isArray(item.imageTerms)&&item.imageTerms.length>0;
  const requested=Number(item.imageMinHits);
  const minHits=Number.isFinite(requested)&&requested>0
    ?Math.min(terms.length,Math.max(1,requested))
    :(explicit?1:Math.min(2,terms.length));
  if(hits.length<minHits)return -1;
  return hits.reduce((n,t)=>n+Math.max(1,t.split(' ').length),0);
}
function pinterestCandidates(html=''){
  const source=decodeSearchHtml(html);
  const found=new Map();
  const re=/https:\/\/i\.pinimg\.com\/[^"'<>\\\s]+/g;
  for(const match of source.matchAll(re)){
    let raw=String(match[0]||'').replace(/["')},;]+$/,'');
    try{
      const u=new URL(raw);u.search='';
      const url=u.toString();
      if(!/\.(?:jpe?g|png|webp)$/i.test(u.pathname)||/\/60x60\//.test(u.pathname))continue;
      const i=Number(match.index||0);
      const context=source.slice(Math.max(0,i-1800),Math.min(source.length,i+2200));
      const previous=found.get(url);
      found.set(url,{url,context:(previous?.context||'')+' '+context});
    }catch{}
  }
  return [...found.values()].sort((a,b)=>{
    const rank=u=>(/\/originals\//.test(u)?4:/\/736x\//.test(u)?3:/\/564x\//.test(u)?2:1);
    return rank(b.url)-rank(a.url);
  });
}
function bingCandidates(html=''){
  const source=decodeSearchHtml(html);
  const found=new Map();
  const patterns=[
    /"murl"\s*:\s*"([^"]+)"/gi,
    /murl\s*:\s*"(https?:\/\/[^"]+)"/gi
  ];
  for(const re of patterns){
    for(const match of source.matchAll(re)){
      const raw=String(match[1]||'').replace(/\\u002f/gi,'/').replace(/\\\//g,'/');
      try{
        const u=new URL(raw);
        if(!/^https?:$/.test(u.protocol))continue;
        const url=u.toString();
        const i=Number(match.index||0);
        const context=source.slice(Math.max(0,i-1800),Math.min(source.length,i+2400));
        const previous=found.get(url);
        found.set(url,{url,context:(previous?.context||'')+' '+context});
      }catch{}
    }
  }
  return [...found.values()];
}
async function validImage(url){
  try{
    const r=await fetch(url,{
      method:'GET',
      headers:{Range:'bytes=0-2047','User-Agent':'Mozilla/5.0'},
      signal:AbortSignal.timeout(8000)
    });
    const type=String(r.headers.get('content-type')||'').toLowerCase();
    const len=Number(r.headers.get('content-length')||0);
    try{await r.body?.cancel();}catch{}
    return r.ok&&type.startsWith('image/')&&(len===0||len>=8000);
  }catch{return false;}
}
async function pinterestImage(item,recent){
  const query=String(item?.imageQuery||'');
  if(!query)return '';
  const r=await fetch('https://www.pinterest.com/search/pins/?q='+encodeURIComponent(query),{
    headers:{
      'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
      'Accept-Language':'en-US,en;q=0.9'
    },
    signal:AbortSignal.timeout(imageTimeoutMs)
  });
  if(!r.ok)throw new Error('Pinterest HTTP '+r.status);
  const ranked=pinterestCandidates(await r.text())
    .filter(x=>!recent.has(x.url))
    .map(x=>({...x,score:semanticScore(item,x)}))
    .filter(x=>x.score>=0)
    .sort((a,b)=>b.score-a.score);
  for(const candidate of ranked.slice(0,24)){
    if(await validImage(candidate.url))return candidate.url;
  }
  return '';
}
async function bingImage(item,recent){
  const query=String(item?.imageQuery||'');
  if(!query)return '';
  const r=await fetch('https://www.bing.com/images/search?q='+encodeURIComponent(query)+'&form=HDRSC3&first=1',{
    headers:{
      'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
      'Accept-Language':'en-US,en;q=0.9'
    },
    signal:AbortSignal.timeout(imageTimeoutMs)
  });
  if(!r.ok)throw new Error('Bing Images HTTP '+r.status);
  const ranked=bingCandidates(await r.text())
    .filter(x=>!recent.has(x.url))
    .map(x=>({...x,score:semanticScore(item,x)}))
    .filter(x=>x.score>=0)
    .sort((a,b)=>b.score-a.score);
  for(const candidate of ranked.slice(0,30)){
    if(await validImage(candidate.url))return candidate.url;
  }
  return '';
}
async function imageFor(item,state){
  const recent=new Set(state.recentImages||[]);
  try{
    const p=await pinterestImage(item,recent);
    if(p)return p;
  }catch(error){
    console.warn('[Lifestyle] Pinterest lookup failed:',String(error?.message||error));
  }
  try{
    const b=await bingImage(item,recent);
    if(b)return b;
  }catch(error){
    console.warn('[Lifestyle] Bing Images lookup failed:',String(error?.message||error));
  }
  // Fail closed for every category. A delayed post is preferable to an
  // unrelated visual. Generic category fallbacks are intentionally disabled.
  return '';
}
function waPayload(entry){
  return {
    id:entry.id,
    source:destination,
    sourceMessageId:entry.telegramMessageId,
    text:entry.text,
    mediaItems:[{
      type:'photo',
      url:entry.imageUrl,
      fileName:'lifestyle-'+entry.telegramMessageId+'.jpg',
      mimetype:'image/jpeg',
      position:0
    }],
    buttons:[],
    createdAt:entry.createdAt
  };
}
async function mirrorWhatsApp(entry){
  const r=await fetch(waBridge,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(waPayload(entry)),
    signal:AbortSignal.timeout(15000)
  });
  const out=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(String(out?.error||('WhatsApp bridge HTTP '+r.status)));
  return out;
}
async function retryWhatsApp(state){
  const keep=[];
  for(const entry of state.pendingWhatsApp||[]){
    try{
      await mirrorWhatsApp(entry);
      console.log('[Lifestyle] WhatsApp retry succeeded for Telegram #'+entry.telegramMessageId);
    }catch(error){
      entry.attempts=Number(entry.attempts||0)+1;
      entry.lastError=String(error?.message||error).slice(0,500);
      if(entry.attempts<30)keep.push(entry);
    }
  }
  state.pendingWhatsApp=keep.slice(-50);
}
function chooseItem(bank,state){
  if(!bank.length)throw new Error('empty lifestyle content bank');
  let index=Math.abs(Number(state.index||0))%bank.length;
  let item=bank[index]||{};
  if(bank.length>2&&item.category===state.lastCategory){
    index=(index+1)%bank.length;
    item=bank[index]||{};
  }
  return {index,item};
}

if(!token&&!dryRun)throw new Error('NEXCANAL__BOT_TOKEN missing');
const rawBank=JSON.parse(await fs.readFile(contentFile,'utf8'));
if(!Array.isArray(rawBank)||!rawBank.length)throw new Error('empty lifestyle content bank');
// Dark Universe legacy publisher is intentionally limited to Otaku Choice.
// Luxury/anime poetic posts come only from the TikTok -> analysis -> GPT flow.
const bank=rawBank.filter(item=>item?.category==='otaku_choice');
if(!bank.length)throw new Error('no otaku_choice content configured');
const state=await loadState();

await retryWhatsApp(state);
await saveState(state);

if(!inActiveWindow()&&!dryRun){
  console.log('[Lifestyle] outside active window',activeStart+'-'+activeEnd,timezone);
  process.exit(0);
}
if(Number(state.nextNotBefore||0)>Date.now()&&!dryRun){
  console.log('[Lifestyle] next slot at',new Date(state.nextNotBefore).toISOString());
  process.exit(0);
}

const {index,item}=chooseItem(bank,state);
if(dryRun){
  console.log(JSON.stringify({
    ok:true,dryRun:true,destination:'@'+destination,index,
    category:item.category,imageQuery:item.imageQuery,
    textPreview:String(item.text||'').slice(0,160),
    pollQuestion:item.pollQuestion||null
  }));
  process.exit(0);
}

const imageUrl=await imageFor(item,state);
if(!imageUrl){
  // Media-first invariant: NEVER emit a naked text post.
  state.nextNotBefore=Date.now()+15*60_000;
  await saveState(state);
  console.warn('[Lifestyle] skipped: no matching image for',item.category,item.imageQuery||'');
  process.exit(0);
}

const caption=String(item.text||'').trim().slice(0,1024);
if(!caption)throw new Error('empty lifestyle caption');
const sent=await telegram('sendPhoto',{
  chat_id:'@'+destination,
  photo:imageUrl,
  caption
});

if(item.pollQuestion&&Array.isArray(item.pollOptions)&&item.pollOptions.length>=2){
  try{
    await telegram('sendPoll',{
      chat_id:'@'+destination,
      question:String(item.pollQuestion).slice(0,300),
      options:item.pollOptions.map(x=>String(x).slice(0,100)).slice(0,10),
      is_anonymous:true,
      allows_multiple_answers:false
    });
  }catch(error){
    console.warn('[Lifestyle] poll add-on failed:',String(error?.message||error));
  }
}

const entry={
  id:'lifestyle:'+destination+':'+String(sent?.message_id||Date.now()),
  telegramMessageId:sent?.message_id||null,
  imageUrl,
  text:caption,
  createdAt:new Date().toISOString(),
  attempts:0
};
try{
  await mirrorWhatsApp(entry);
  console.log('[Lifestyle] mirrored to WhatsApp Otaku Nexus');
}catch(error){
  entry.attempts=1;
  entry.lastError=String(error?.message||error).slice(0,500);
  state.pendingWhatsApp.push(entry);
  state.pendingWhatsApp=state.pendingWhatsApp.slice(-50);
  console.warn('[Lifestyle] WhatsApp mirror queued:',entry.lastError);
}

state.index=(index+1)%bank.length;
state.lastCategory=item.category||null;
state.lastMessageId=sent?.message_id||null;
state.lastPublishedAt=new Date().toISOString();
state.nextNotBefore=Date.now()+nextGap();
state.recentImages.push(imageUrl);
state.recentImages=state.recentImages.slice(-80);
await saveState(state);
console.log(
  '[Lifestyle] published',item.category||'content',
  '-> @'+destination,'#'+String(sent?.message_id||''),
  'nextNotBefore='+new Date(state.nextNotBefore).toISOString()
);
