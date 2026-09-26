import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);

const json=(status,body)=>({status,headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(body)});
const ok=(result,extra={})=>json(200,{status:true,result,...extra});
const fail=(status,error,extra={})=>json(status,{status:false,error,...extra});
const one=(p,names)=>{for(const n of names){const v=p[n];if(v!==undefined&&v!==null&&String(v).trim()!=='')return String(v).trim()}return ''};

export async function readParams(req,url){
  const p=Object.fromEntries(url.searchParams.entries());
  if(req.method==='POST'){
    let raw=''; for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('body_too_large')}
    if(raw){const b=JSON.parse(raw); if(b&&typeof b==='object')Object.assign(p,b)}
  }
  return p;
}

function providerKey(path){return 'NEXAPIS_PROVIDER_'+path.replace(/^\//,'').replace(/[^A-Za-z0-9]+/g,'_').toUpperCase()}
async function proxyProvider(entry,p){
  const base=process.env[providerKey(entry.path)]; if(!base)return null;
  const u=new URL(base); for(const [k,v] of Object.entries(p))u.searchParams.set(k,String(v));
  const r=await fetch(u,{headers:{accept:'application/json'}}); const ct=r.headers.get('content-type')||'';
  const body=ct.includes('application/json')?await r.json():await r.text();
  return json(r.status,typeof body==='string'?{status:r.ok,result:body}:body);
}

async function llm(entry,p){
  const text=one(p,['prompt','q','text','question']); if(!text)return fail(400,'missing_input');
  const base=(process.env.NEXAPIS_AI_BASE_URL||'').replace(/\/$/,''); const key=process.env.NEXAPIS_AI_API_KEY||'';
  if(!base||!key)return fail(503,'ai_provider_not_configured');
  const model=process.env.NEXAPIS_AI_MODEL||'gpt-4.1-mini';
  const messages=[]; if(entry.prompt)messages.push({role:'system',content:entry.prompt}); messages.push({role:'user',content:text});
  const r=await fetch(base+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model,messages})});
  const data=await r.json(); if(!r.ok)return fail(r.status,'ai_provider_error',{details:data});
  return ok(data?.choices?.[0]?.message?.content??data);
}

async function imageGenerate(_entry,p){
  const prompt=one(p,['prompt','q','text']); if(!prompt)return fail(400,'missing_prompt');
  const base=(process.env.NEXAPIS_IMAGE_BASE_URL||process.env.NEXAPIS_AI_BASE_URL||'').replace(/\/$/,''); const key=process.env.NEXAPIS_IMAGE_API_KEY||process.env.NEXAPIS_AI_API_KEY||'';
  if(!base||!key)return fail(503,'image_provider_not_configured');
  const model=process.env.NEXAPIS_IMAGE_MODEL||'gpt-image-1';
  const r=await fetch(base+'/images/generations',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model,prompt,size:'1024x1024'})});
  const data=await r.json(); if(!r.ok)return fail(r.status,'image_provider_error',{details:data});
  return ok(data?.data?.[0]??data);
}

function isPrivateIp(ip){
  if(net.isIP(ip)===4){const a=ip.split('.').map(Number);return a[0]===10||a[0]===127||a[0]===0||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)}
  if(net.isIP(ip)===6){const s=ip.toLowerCase();return s==='::1'||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('fe80:')}
  return true;
}
async function safeUrl(raw){
  const u=new URL(raw); if(!['http:','https:'].includes(u.protocol))throw new Error('unsupported_protocol');
  if(['localhost','0.0.0.0'].includes(u.hostname.toLowerCase()))throw new Error('private_target');
  const addrs=await dns.lookup(u.hostname,{all:true}); if(!addrs.length||addrs.some(x=>isPrivateIp(x.address)))throw new Error('private_target');
  return u;
}

async function media(entry,p){
  const raw=one(p,['url']); if(!raw)return fail(400,'missing_url'); await safeUrl(raw);
  const format=(one(p,['format'])||entry.format||'best').toLowerCase();
  try{
    const {stdout}=await execFileAsync(process.env.YTDLP_BIN||'yt-dlp',['--dump-single-json','--no-playlist','--no-warnings',raw],{timeout:90_000,maxBuffer:8_000_000});
    const d=JSON.parse(stdout); const fs=Array.isArray(d.formats)?d.formats:[];
    const pick=format==='mp3'?fs.filter(x=>x.acodec&&x.acodec!=='none'&&(!x.vcodec||x.vcodec==='none')).at(-1):format==='mp4'?fs.filter(x=>x.ext==='mp4'&&x.url).at(-1):fs.filter(x=>x.url).at(-1);
    return ok({id:d.id,title:d.title,duration:d.duration,thumbnail:d.thumbnail,webpage_url:d.webpage_url,format,url:pick?.url||d.url||null});
  }catch(e){return fail(503,'media_backend_unavailable',{details:String(e?.message||e).slice(0,300)})}
}

async function countries(p){
  const q=one(p,['q']); if(!q)return fail(400,'missing_q');
  const r=await fetch('https://restcountries.com/v3.1/name/'+encodeURIComponent(q)+'?fields=name,capital,region,subregion,population,flags,currencies,languages');
  if(!r.ok)return fail(r.status,'country_not_found'); return ok(await r.json());
}
async function money(p){
  const amount=Number(one(p,['amount'])||1),from=(one(p,['from'])||'USD').toUpperCase(),to=(one(p,['to'])||'EUR').toUpperCase();
  if(!Number.isFinite(amount)||amount<0)return fail(400,'invalid_amount');
  const base=(process.env.NEXAPIS_FX_BASE_URL||'https://api.frankfurter.app').replace(/\/$/,'');
  const r=await fetch(`${base}/latest?amount=${encodeURIComponent(amount)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); const d=await r.json();
  if(!r.ok)return fail(r.status,'fx_provider_error',{details:d}); return ok({amount,from,to,value:d?.rates?.[to]??null,raw:d});
}
async function lyrics(p){
  const q=one(p,['query','q']); if(!q)return fail(400,'missing_query');
  const base=(process.env.NEXAPIS_LYRICS_BASE_URL||'https://lrclib.net').replace(/\/$/,'');
  const r=await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`); const d=await r.json(); if(!r.ok)return fail(r.status,'lyrics_provider_error'); return ok(d);
}
async function ytsearch(p){
  const q=one(p,['q']); if(!q)return fail(400,'missing_q');
  try{const {stdout}=await execFileAsync(process.env.YTDLP_BIN||'yt-dlp',['--dump-json','--flat-playlist',`ytsearch10:${q}`],{timeout:45_000,maxBuffer:8_000_000});
    const result=stdout.trim().split(/\n+/).filter(Boolean).map(x=>JSON.parse(x)).map(x=>({id:x.id,title:x.title,url:x.url||x.webpage_url,duration:x.duration,channel:x.channel||x.uploader,thumbnail:x.thumbnail})); return ok(result);
  }catch(e){return fail(503,'search_backend_unavailable',{details:String(e?.message||e).slice(0,300)})}
}

const styleMap={
  bold:['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789','𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗'],
  mono:['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789','𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿']
};
function transform(text,pair){const [from,to]=pair;const a=[...from],b=[...to];const m=new Map(a.map((x,i)=>[x,b[i]||x]));return [...text].map(c=>m.get(c)||c).join('')}
function font(p){const text=one(p,['text']);if(!text)return fail(400,'missing_text');return ok({plain:text,bold:transform(text,styleMap.bold),monospace:transform(text,styleMap.mono)})}
function roast(){const xs=['Your Wi‑Fi has more consistency than that argument.','That plan needs a patch before production.','Even the loading spinner is making more progress.'];return ok(xs[Math.floor(Math.random()*xs.length)])}

function sign(raw){const secret=process.env.NEXAPIS_SHORT_SECRET||'change-me';return crypto.createHmac('sha256',secret).update(raw).digest('base64url').slice(0,16)}
function shorten(p,origin){const raw=one(p,['url']);if(!raw)return fail(400,'missing_url');let u;try{u=new URL(raw)}catch{return fail(400,'invalid_url')}if(!['http:','https:'].includes(u.protocol))return fail(400,'invalid_url');const b=Buffer.from(u.toString()).toString('base64url');const token=b+'.'+sign(b);return ok({token,url:`${origin}/r/${token}`})}
export function decodeShort(token){const [b,s]=String(token||'').split('.');if(!b||!s)return null;const expected=sign(b);if(Buffer.byteLength(expected)!==Buffer.byteLength(s)||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(s)))return null;try{return Buffer.from(b,'base64url').toString('utf8')}catch{return null}}

async function webcopy(p){const raw=one(p,['url']);if(!raw)return fail(400,'missing_url');const u=await safeUrl(raw);const r=await fetch(u,{redirect:'follow',headers:{'user-agent':'NexAPIs/0.1'}});const text=await r.text();if(text.length>2_000_000)return fail(413,'page_too_large');return ok({url:r.url,contentType:r.headers.get('content-type'),html:text})}

export async function execute(entry,p,ctx={}){
  if(entry.mode==='disabled')return fail(451,'endpoint_disabled',{reason:entry.reason});
  const proxied=await proxyProvider(entry,p); if(proxied)return proxied;
  switch(entry.mode){
    case'llm':return llm(entry,p);
    case'imageGenerate':return imageGenerate(entry,p);
    case'media':return media(entry,p);
    case'countries':return countries(p);
    case'money':return money(p);
    case'lyrics':return lyrics(p);
    case'ytsearch':return ytsearch(p);
    case'font':return font(p);
    case'roast':return roast();
    case'shorten':return shorten(p,ctx.origin);
    case'webcopy':return webcopy(p);
    default:return fail(501,'provider_not_configured',{providerEnv:providerKey(entry.path)});
  }
}
