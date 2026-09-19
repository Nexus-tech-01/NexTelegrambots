import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root=path.resolve(process.argv[2]||'_dipper');
const outRoot=path.resolve(process.argv[3]||'nexaccount');
const require=createRequire(import.meta.url);

const catalog=require(path.join(root,'utils','styleCatalog.js'));
const menuPath=path.join(root,'commands','general_tools','menu.js');
const menuSource=await fs.readFile(menuPath,'utf8');

function extractLiteralObject(source,marker){
  const start=source.indexOf(marker);
  if(start<0)return null;
  const open=source.indexOf('{',start);
  if(open<0)return null;
  let depth=0,quote=null,esc=false,line=false,block=false;
  for(let i=open;i<source.length;i++){
    const c=source[i],n=source[i+1];
    if(line){if(c==='\n')line=false;continue}
    if(block){if(c==='*'&&n==='/'){block=false;i++}continue}
    if(quote){
      if(esc){esc=false;continue}
      if(c==='\\'){esc=true;continue}
      if(c===quote){quote=null;continue}
      continue;
    }
    if(c==='/'&&n==='/'){line=true;i++;continue}
    if(c==='/'&&n==='*'){block=true;i++;continue}
    if(c==='"'||c==="'"||c.charCodeAt(0)===96){quote=c;continue}
    if(c==='{')depth++;
    if(c==='}'&&--depth===0)return source.slice(open,i+1);
  }
  return null;
}

let oldImages={};
const literal=extractLiteralObject(menuSource,'const STYLE_IMAGE_URLS =');
if(literal){
  try{oldImages=vm.runInNewContext('('+literal+')',{}, {timeout:1000})||{}}catch{}
}

const themes={};
const images={};
for(let id=1;id<=Number(catalog.MAX_STYLE||31);id++){
  const t=catalog.THEMES?.[id];
  if(!t)continue;
  themes[id]={
    id,
    name:t.name,
    botName:t.botName,
    mark:t.mark,
    accent:t.accent,
    separator:t.separator,
    signature:t.signature,
    tagline:t.tagline
  };
  images[id]=[
    ...((oldImages?.[id]||[]).filter(Boolean)),
    ...((catalog.IMAGE_PAGES?.[id]||[]).filter(Boolean))
  ];
}

async function walk(dir){
  const out=[];
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...await walk(full));
    else if(entry.isFile()&&entry.name.endsWith('.js'))out.push(full);
  }
  return out;
}

function normalizeText(value=''){
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}

function categoryFor(source,rel){
  const explicit=source.match(/\bcategory\s*:\s*['"`]([^'"`]+)['"`]/i)?.[1]||'';
  const s=normalizeText(explicit+' '+rel);
  if(/owner|sovereignty|propriet|supreme/.test(s))return 'OWNER';
  if(/telecharg|download|media|social_downloader/.test(s))return 'DOWNLOAD';
  if(/group|groupe|admin|moderation/.test(s))return 'GROUP';
  if(/protect|anti[_ -]?(link|spam|raid)|security/.test(s))return 'PROTECTION';
  if(/sticker|emoji/.test(s))return 'STICKERS';
  if(/game|jeux|fun|quiz|riddle/.test(s))return 'GAMES';
  if(/anime|manga|waifu/.test(s))return 'ANIME';
  if(/search|recherche|google|imdb|weather|define|gsmarena/.test(s))return 'SEARCH';
  if(/\bai\b|ia|artificial|gpt|deepseek|gemini/.test(s))return 'AI';
  return 'TOOLS';
}

function safeName(value){
  const name=String(value||'').trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(name)?name:'';
}

function literalNames(source){
  const out=[];
  const re=/\bname\s*:\s*['"`]([A-Za-z0-9_][A-Za-z0-9_-]{0,63})['"`]/g;
  for(const m of source.matchAll(re)){
    const name=safeName(m[1].replace(/-/g,'_'));
    if(name&&!out.includes(name))out.push(name);
  }
  return out;
}

function literalAliases(source){
  const out=[];
  const re=/\baliases\s*:\s*\[([^\]]*)\]/g;
  for(const m of source.matchAll(re)){
    for(const q of m[1].matchAll(/['"`]([A-Za-z0-9_][A-Za-z0-9_-]{0,63})['"`]/g)){
      const name=safeName(q[1].replace(/-/g,'_'));
      if(name&&!out.includes(name))out.push(name);
    }
  }
  return out;
}

async function buildCommandManifest(){
  const commandRoot=path.join(root,'commands');
  const files=await walk(commandRoot);
  const byName=new Map();
  let scannedFiles=0;

  for(const file of files){
    const source=await fs.readFile(file,'utf8').catch(()=>null);
    if(!source||!/(module\.exports|exports\.)/.test(source))continue;
    const rel=path.relative(root,file).split(path.sep).join('/');
    let names=literalNames(source);

    if(!names.length){
      const fallback=safeName(path.basename(file,'.js').replace(/-/g,'_'));
      if(fallback&&!['index','base','utils','helper','helpers'].includes(fallback))names=[fallback];
    }
    if(!names.length)continue;
    scannedFiles++;

    const category=categoryFor(source,rel);
    const ownerOnly=/\bownerOnly\s*:\s*true\b/.test(source)||category==='OWNER';
    const groupOnly=/\bgroupOnly\s*:\s*true\b/.test(source);
    const premium=/\bpremium(?:Only)?\s*:\s*true\b/i.test(source);
    const description=source.match(/\bdescription\s*:\s*['"`]([^'"`]{1,240})['"`]/i)?.[1]||'THE BIG DIPPER';

    for(const name of names){
      if(!byName.has(name)){
        byName.set(name,{name,category,description,ownerOnly,groupOnly,premium,sourceFile:rel});
      }
    }

    if(names.length===1){
      for(const alias of literalAliases(source)){
        if(alias===names[0]||byName.has(alias))continue;
        byName.set(alias,{
          name:alias,
          category,
          aliasFor:names[0],
          hidden:true,
          ownerOnly,
          groupOnly,
          premium,
          sourceFile:rel
        });
      }
    }
  }

  const commands=[...byName.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const canonical=commands.filter(c=>!c.aliasFor).length;
  return {generatedAt:new Date().toISOString(),source:'Tresor562/DIPPER-',scannedFiles,canonical,total:commands.length,commands};
}

const manifest=await buildCommandManifest();
if(manifest.canonical<300){
  throw new Error('Dipper command extraction unexpectedly low: '+manifest.canonical+' canonical commands');
}

await fs.mkdir(path.join(outRoot,'generated'),{recursive:true});
await fs.mkdir(path.join(outRoot,'vendor'),{recursive:true});
await fs.writeFile(path.join(outRoot,'generated','dipper-styles.json'),JSON.stringify({generatedAt:new Date().toISOString(),themes,images},null,2));
await fs.writeFile(path.join(outRoot,'generated','dipper-commands.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(outRoot,'vendor','dipper-menu.js.txt'),menuSource);
console.log('Synced Dipper styles:',Object.keys(themes).length);
console.log('Synced Dipper commands:',manifest.canonical,'canonical /',manifest.total,'with aliases from',manifest.scannedFiles,'files');
