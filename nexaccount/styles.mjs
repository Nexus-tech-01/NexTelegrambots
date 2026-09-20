import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const generatedPath=path.join(HERE,'generated','dipper-styles.json');
const vendorMenuPath=path.join(HERE,'vendor','dipper-menu.js.txt');

export const toSmallCaps=text=>{
  const n='abcdefghijklmnopqrstuvwxyz0123456789';
  const s='ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀѕᴛᴜᴠᴡxʏᴢ0123456789';
  return String(text??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split('').map(c=>{
    const i=n.indexOf(c);return i<0?c:s[i];
  }).join('');
};
const toBSC=toSmallCaps;
let cache;

function extractStylesObject(source){
  const marker='const STYLES =';
  const start=source.indexOf(marker);
  if(start<0)return null;
  const open=source.indexOf('{',start);
  if(open<0)return null;
  let depth=0,quote=null,esc=false,lineComment=false,blockComment=false;
  for(let i=open;i<source.length;i++){
    const c=source[i],n=source[i+1];
    if(lineComment){if(c==='\n')lineComment=false;continue}
    if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++}continue}
    if(quote){
      if(esc){esc=false;continue}
      if(c==='\\'){esc=true;continue}
      if(c===quote){quote=null;continue}
      continue;
    }
    if(c==='/'&&n==='/'){lineComment=true;i++;continue}
    if(c==='/'&&n==='*'){blockComment=true;i++;continue}
    if(c==='"'||c==="'"||c.charCodeAt(0)===96){quote=c;continue}
    if(c==='{')depth++;
    if(c==='}'){depth--;if(depth===0)return source.slice(open,i+1)}
  }
  return null;
}

async function loadExactDipperStyles(){
  try{
    const source=await fs.readFile(vendorMenuPath,'utf8');
    const objectSource=extractStylesObject(source);
    if(!objectSource)return {};
    return vm.runInNewContext('('+objectSource+')',{toSmallCaps,toBSC},{timeout:1000})||{};
  }catch{return {}}
}

export async function loadStyleCatalog(){
  if(cache)return cache;
  let generated={themes:{},images:{}};
  try{generated=JSON.parse(await fs.readFile(generatedPath,'utf8'))}catch{}
  const exact=await loadExactDipperStyles();
  const themes={};
  const ids=new Set([...Object.keys(generated.themes||{}),...Object.keys(exact||{})].map(Number).filter(n=>Number.isInteger(n)&&n>0));
  for(const id of [...ids].sort((a,b)=>a-b)){
    const meta=generated.themes?.[id]||generated.themes?.[String(id)]||{};
    const old=exact?.[id];
    themes[id]={
      id,
      name:meta.name||old?.nom||('Style '+id),
      botName:meta.botName||'NEXAI',
      mark:meta.mark||'✦',
      accent:meta.accent||'',
      separator:meta.separator||'',
      tagline:meta.tagline||'',
      signature:meta.signature||'Nextech',
      images:generated.images?.[id]||generated.images?.[String(id)]||[],
      exactHeader:typeof old?.header==='function'?old.header:null,
      exactCatOpen:typeof old?.catOpen==='function'?old.catOpen:null,
      exactCatCmd:typeof old?.catCmd==='function'?old.catCmd:null,
      exactCatClose:typeof old?.catClose==='function'?old.catClose:null,
      exactFooter:typeof old?.footer==='function'?old.footer:null
    };
  }
  cache={themes,maxStyle:Math.max(0,...Object.keys(themes).map(Number))};
  return cache;
}

export async function getStyle(id){
  const {themes}=await loadStyleCatalog();
  const n=Number(id);
  return themes[n]||themes[1]||{id:1,name:'Dark',botName:'NEXAI',mark:'✦',images:[]};
}

export async function listStyles(){
  const {themes}=await loadStyleCatalog();
  return Object.values(themes).sort((a,b)=>a.id-b.id);
}

export function telegramizeDipperText(value){
  return String(value??'')
    .replace(/```/g,'')
    .replace(/\*+/g,'')
    .replace(/_([^_\n]+)_/g,'$1');
}

export async function renderDipperHeader(styleId,{botName='NEXAI',ownerName='Utilisateur',rank='utilisateur',prefix='.',count=0}={}){
  const s=await getStyle(styleId);
  if(s.exactHeader){
    try{return telegramizeDipperText(s.exactHeader(botName,ownerName,rank,prefix,count))}catch{}
  }
  return [
    s.separator||s.mark,
    toSmallCaps(s.botName||botName),
    s.separator||s.mark,
    '👤 '+toSmallCaps('Utilisateur')+' : '+toSmallCaps(ownerName),
    '🎖️ '+toSmallCaps('Rang')+' : '+toSmallCaps(rank),
    '⌁ '+toSmallCaps('Préfixe')+' : [ '+prefix+' ]',
    '📜 '+toSmallCaps('Commandes')+' : '+count,
    s.separator||s.mark,'',
    s.tagline?(toSmallCaps(s.tagline)+' '+(s.accent||'')):''
  ].filter(Boolean).join('\n')+'\n';
}

const directImageCache=new Map();
const lastStyleImage=new Map();

function randomOrder(values){
  const out=[...new Set(values.filter(Boolean))];
  for(let i=out.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [out[i],out[j]]=[out[j],out[i]];
  }
  return out;
}

async function directImage(url){
  if(directImageCache.has(url))return directImageCache.get(url);
  if(!/^https?:\/\//i.test(url))return '';
  if(!/https?:\/\/(?:www\.)?ibb\.co\//i.test(url)){
    directImageCache.set(url,url);
    return url;
  }
  try{
    const res=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(6000)});
    const html=await res.text();
    const m=html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)||html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const v=m?.[1]?.replace(/&amp;/g,'&')||'';
    if(v){directImageCache.set(url,v);return v}
  }catch{}
  return '';
}

export async function resolveStyleImage(styleId,fallback=''){
  const s=await getStyle(styleId);
  const key=Number(s.id)||1;
  let urls=randomOrder([...(s.images||[])]);
  const last=lastStyleImage.get(key);
  if(urls.length>1&&urls[0]===last){
    const swap=1+Math.floor(Math.random()*(urls.length-1));
    [urls[0],urls[swap]]=[urls[swap],urls[0]];
  }
  if(fallback)urls.push(fallback);

  for(const url of urls){
    const resolved=await directImage(url);
    if(!resolved)continue;
    if((s.images||[]).includes(url))lastStyleImage.set(key,url);
    return resolved;
  }
  return fallback||'';
}

