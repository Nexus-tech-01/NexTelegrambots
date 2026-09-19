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

function inertProxy(){
  let proxy;
  const fn=function(){return proxy};
  proxy=new Proxy(fn,{
    get(_target,prop){
      if(prop==='then')return undefined;
      if(prop===Symbol.iterator)return function*(){};
      if(prop===Symbol.toPrimitive)return ()=>'';
      if(prop==='toJSON')return ()=>null;
      return proxy;
    },
    apply(){return proxy},
    construct(){return proxy}
  });
  return proxy;
}

function sandboxRequire(file){
  const inert=inertProxy();
  const safeFs={
    existsSync:()=>false,
    readFileSync:()=>Buffer.alloc(0),
    readdirSync:()=>[],
    statSync:()=>({isDirectory:()=>false,isFile:()=>false}),
    promises:inert
  };
  const safeBuiltins=new Map([
    ['path',path],
    ['node:path',path],
    ['fs',safeFs],
    ['node:fs',safeFs],
    ['fs/promises',safeFs.promises],
    ['node:fs/promises',safeFs.promises]
  ]);
  const req=id=>safeBuiltins.get(String(id))||inert;
  req.resolve=id=>String(id||file);
  req.cache={};
  req.main={};
  return req;
}

function evaluateCommandModule(source,file){
  const module={exports:{}};
  const context={
    module,
    exports:module.exports,
    require:sandboxRequire(file),
    __filename:file,
    __dirname:path.dirname(file),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console:{log(){},warn(){},error(){},info(){},debug(){}},
    process:{
      env:{},
      cwd:()=>root,
      platform:process.platform,
      versions:process.versions,
      nextTick:fn=>{if(typeof fn==='function')fn()}
    },
    setTimeout:()=>0,
    clearTimeout(){},
    setInterval:()=>0,
    clearInterval(){},
    setImmediate:()=>0,
    clearImmediate(){},
    fetch:async()=>({ok:false,status:503,json:async()=>({}),text:async()=>'',arrayBuffer:async()=>new ArrayBuffer(0)})
  };
  context.global=context;
  context.globalThis=context;
  try{
    const script=new vm.Script('(function(module,exports,require,__filename,__dirname){'+source+'\n})',{filename:file});
    const fn=script.runInNewContext(context,{timeout:750});
    fn(module,module.exports,context.require,file,path.dirname(file));
    return {ok:true,exported:module.exports};
  }catch(error){
    return {ok:false,error:String(error?.message||error),exported:null};
  }
}

function staticCommandNames(source,rel){
  const names=new Set(literalNames(source));

  const arrayRe=/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g;
  for(const match of source.matchAll(arrayRe)){
    const variable=match[1],body=match[2];
    const escaped=variable.replace(/[$]/g,'\\$&');
    const usedByFactory=
      new RegExp('\\b'+escaped+'\\s*\\.\\s*map\\s*\\([^)]*(?:command|cmd|create|make|build|effect)','i').test(source)||
      new RegExp('\\bof\\s*'+escaped+'\\b').test(source);
    if(!usedByFactory)continue;

    for(const m of body.matchAll(/(?:^|[,]\s*)\[\s*['"`]([A-Za-z0-9_][A-Za-z0-9_-]{0,63})['"`]/g)){
      const name=safeName(m[1].replace(/-/g,'_'));
      if(name)names.add(name);
    }
    for(const m of body.matchAll(/(?:^|[,]\s*)['"`]([A-Za-z0-9_][A-Za-z0-9_-]{0,63})['"`](?=\s*[,\]])/g)){
      const name=safeName(m[1].replace(/-/g,'_'));
      if(name)names.add(name);
    }
  }

  for(const match of source.matchAll(/for\s*\([^)]*\bof\s*\[([\s\S]*?)\]\s*\)[\s\S]{0,800}?(?:\.push\s*\(|module\.exports|return\s*\{)/gi)){
    const body=match[1];
    for(const m of body.matchAll(/\[\s*['"`]([A-Za-z0-9_][A-Za-z0-9_-]{0,63})['"`]/g)){
      const name=safeName(m[1].replace(/-/g,'_'));
      if(name)names.add(name);
    }
    for(const m of body.matchAll(/['"`]([A-Za-z0-9_][A-Za-z0-9_-]{0,63})['"`](?=\s*[,\]])/g)){
      const name=safeName(m[1].replace(/-/g,'_'));
      if(name)names.add(name);
    }
  }

  if(!names.size){
    const fallback=safeName(path.basename(rel,'.js').replace(/-/g,'_'));
    if(fallback&&!['index','base','utils','helper','helpers'].includes(fallback))names.add(fallback);
  }
  return [...names];
}

function flagsFor(source,category){
  return {
    ownerOnly:/\bownerOnly\s*:\s*true\b/.test(source)||category==='OWNER',
    groupOnly:/\bgroupOnly\s*:\s*true\b/.test(source),
    premium:/\b(?:premium|premiumOnly)\s*:\s*true\b/i.test(source)
  };
}

async function buildCommandManifest(){
  const commandRoot=path.join(root,'commands');
  const files=await walk(commandRoot);
  const byName=new Map();
  let scannedFiles=0,evaluatedFiles=0,fallbackFiles=0;

  function addCommand(raw,meta){
    const name=safeName(raw?.name);
    if(!name||byName.has(name))return;
    const aliases=Array.isArray(raw?.aliases)?raw.aliases.map(safeName).filter(Boolean):[];
    const category=categoryFor(meta.source,meta.rel);
    const flags=flagsFor(meta.source,category);
    const description=String(raw?.description||meta.description||'THE BIG DIPPER').slice(0,240);
    byName.set(name,{
      name,
      category,
      description,
      ownerOnly:raw?.ownerOnly===true||flags.ownerOnly,
      groupOnly:raw?.groupOnly===true||flags.groupOnly,
      premium:raw?.premium===true||raw?.premiumOnly===true||flags.premium,
      sourceFile:meta.rel
    });
    for(const aliasRaw of aliases){
      if(aliasRaw===name||byName.has(aliasRaw))continue;
      byName.set(aliasRaw,{
        name:aliasRaw,
        category,
        aliasFor:name,
        hidden:true,
        ownerOnly:raw?.ownerOnly===true||flags.ownerOnly,
        groupOnly:raw?.groupOnly===true||flags.groupOnly,
        premium:raw?.premium===true||raw?.premiumOnly===true||flags.premium,
        sourceFile:meta.rel
      });
    }
  }

  for(const file of files){
    const source=await fs.readFile(file,'utf8').catch(()=>null);
    if(!source||!/(module\.exports|exports\.)/.test(source))continue;
    const rel=path.relative(root,file).split(path.sep).join('/');
    scannedFiles++;
    const description=source.match(/\bdescription\s*:\s*['"`]([^'"`]{1,240})['"`]/i)?.[1]||'THE BIG DIPPER';
    const meta={source,rel,description};

    const evaluated=evaluateCommandModule(source,file);
    const exported=evaluated.exported;
    const list=Array.isArray(exported)?exported:[exported];
    const real=list.filter(command=>command&&typeof command==='object'&&command.name&&typeof command.execute==='function');

    if(real.length){
      evaluatedFiles++;
      for(const command of real)addCommand(command,meta);
      continue;
    }

    fallbackFiles++;
    const names=staticCommandNames(source,rel);
    const aliases=names.length===1?literalAliases(source):[];
    for(const name of names)addCommand({name,aliases},meta);
  }

  const commands=[...byName.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const canonical=commands.filter(c=>!c.aliasFor).length;
  const aliases=commands.length-canonical;
  return {
    generatedAt:new Date().toISOString(),
    source:'Tresor562/DIPPER-',
    scannedFiles,
    evaluatedFiles,
    fallbackFiles,
    canonical,
    aliases,
    total:commands.length,
    commands
  };
}
const manifest=await buildCommandManifest();
if(manifest.canonical<400){
  throw new Error('Dipper command extraction unexpectedly low: '+manifest.canonical+' canonical commands (expected about 437)');
}

await fs.mkdir(path.join(outRoot,'generated'),{recursive:true});
await fs.mkdir(path.join(outRoot,'vendor'),{recursive:true});
await fs.writeFile(path.join(outRoot,'generated','dipper-styles.json'),JSON.stringify({generatedAt:new Date().toISOString(),themes,images},null,2));
await fs.writeFile(path.join(outRoot,'generated','dipper-commands.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(outRoot,'vendor','dipper-menu.js.txt'),menuSource);
console.log('Synced Dipper styles:',Object.keys(themes).length);
console.log('Synced Dipper commands:',manifest.canonical,'canonical +',manifest.aliases,'aliases =',manifest.total,'tokens from',manifest.scannedFiles,'files; sandbox',manifest.evaluatedFiles,'fallback',manifest.fallbackFiles);
