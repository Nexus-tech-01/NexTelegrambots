import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root=path.resolve(process.argv[2]||'_dipper');
const outRoot=path.resolve(process.argv[3]||'nexaccount');
const nodeRequire=createRequire(import.meta.url);

const catalog=nodeRequire(path.join(root,'utils','styleCatalog.js'));
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
    ['path',path],['node:path',path],
    ['fs',safeFs],['node:fs',safeFs],
    ['fs/promises',safeFs.promises],['node:fs/promises',safeFs.promises]
  ]);
  const req=id=>safeBuiltins.get(String(id))||inert;
  req.resolve=id=>String(id||file);
  req.cache={};
  req.main={};
  return req;
}

function evaluateModule(source,file){
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
    setTimeout:()=>0,clearTimeout(){},
    setInterval:()=>0,clearInterval(){},
    setImmediate:()=>0,clearImmediate(){},
    fetch:async()=>({
      ok:false,status:503,
      json:async()=>({}),
      text:async()=>'',
      arrayBuffer:async()=>new ArrayBuffer(0)
    })
  };
  context.global=context;
  context.globalThis=context;
  try{
    const script=new vm.Script(
      '(function(module,exports,require,__filename,__dirname){'+source+'\n})',
      {filename:file}
    );
    const fn=script.runInNewContext(context,{timeout:750});
    fn(module,module.exports,context.require,file,path.dirname(file));
    return {ok:true,exported:module.exports};
  }catch(error){
    return {ok:false,error:String(error?.message||error),exported:null};
  }
}

function token(value){
  const v=String(value||'').trim().toLowerCase();
  if(!v||[...v].length>64||/[\s/\\@]/u.test(v))return '';
  if(!/^[\p{L}\p{N}_-]+$/u.test(v))return '';
  return v;
}

function literalNames(source){
  const out=[];
  const re=/\bname\s*:\s*['"`]([^'"`]{1,80})['"`]/g;
  for(const m of source.matchAll(re)){
    const name=token(m[1]);
    if(name&&!out.includes(name))out.push(name);
  }
  return out;
}

function literalAliases(source){
  const out=[];
  const re=/\baliases\s*:\s*\[([^\]]*)\]/g;
  for(const m of source.matchAll(re)){
    for(const q of m[1].matchAll(/['"`]([^'"`]{1,80})['"`]/g)){
      const name=token(q[1]);
      if(name&&!out.includes(name))out.push(name);
    }
  }
  return out;
}

function staticFallback(source,rel){
  const names=new Set(literalNames(source));
  for(const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g)){
    const variable=match[1],body=match[2];
    const escaped=variable.replace(/[$]/g,'\\$&');
    const used=
      new RegExp('\\b'+escaped+'\\s*\\.\\s*map\\s*\\([^)]*(?:command|cmd|create|make|build|effect)','i').test(source)||
      new RegExp('\\bof\\s*'+escaped+'\\b').test(source);
    if(!used)continue;
    for(const m of body.matchAll(/(?:^|[,]\s*)\[\s*['"`]([^'"`]{1,80})['"`]/g)){
      const name=token(m[1]);if(name)names.add(name);
    }
  }
  if(!names.size){
    const fallback=token(path.basename(rel,'.js'));
    if(fallback&&!['index','base','utils','helper','helpers'].includes(fallback))names.add(fallback);
  }
  return [...names];
}

function cleanText(value,max=500){
  const text=String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
  return text.slice(0,max);
}

async function buildCommandManifest(){
  const files=await walk(path.join(root,'commands'));
  const commands=[];
  const canonicalSeen=new Set();
  const tokenOwner=new Map();
  let evaluatedFiles=0,fallbackFiles=0,skippedFiles=0;

  function add(raw,rel,sourceCategory,source){
    const name=token(raw?.name);
    if(!name||canonicalSeen.has(name))return;
    const aliases=[];
    for(const a of Array.isArray(raw?.aliases)?raw.aliases:[]){
      const alias=token(a);
      if(alias&&alias!==name&&!aliases.includes(alias))aliases.push(alias);
    }
    const spec={
      name,
      aliases,
      sourceCategory,
      file:rel,
      description:cleanText(raw?.description||'THE BIG DIPPER · '+name,500),
      usage:cleanText(raw?.usage||'',300),
      groupOnly:raw?.groupOnly===true,
      adminOnly:raw?.adminOnly===true,
      ownerOnly:raw?.ownerOnly===true||raw?.sudoOnly===true,
      botAdminNeeded:raw?.botAdminNeeded===true||raw?.botAdminOnly===true
    };
    canonicalSeen.add(name);
    commands.push(spec);
    if(!tokenOwner.has(name))tokenOwner.set(name,name);
    for(const alias of aliases)if(!tokenOwner.has(alias))tokenOwner.set(alias,name);
  }

  for(const file of files){
    const source=await fs.readFile(file,'utf8').catch(()=>null);
    if(!source||!/(module\.exports|exports\.)/.test(source)){skippedFiles++;continue}
    const rel=path.relative(root,file).split(path.sep).join('/');
    const sourceCategory=rel.split('/')[1]||'general_tools';
    const evaluated=evaluateModule(source,file);
    const list=Array.isArray(evaluated.exported)?evaluated.exported:[evaluated.exported];
    const real=list.filter(c=>c&&typeof c==='object'&&c.name&&typeof c.execute==='function');

    if(real.length){
      evaluatedFiles++;
      for(const command of real)add(command,rel,sourceCategory,source);
      continue;
    }

    fallbackFiles++;
    const names=staticFallback(source,rel);
    const aliases=names.length===1?literalAliases(source):[];
    for(const name of names)add({name,aliases},rel,sourceCategory,source);
  }

  commands.sort((a,b)=>a.name.localeCompare(b.name));
  const aliasCount=commands.reduce((n,c)=>n+c.aliases.length,0);
  return {
    generatedAt:new Date().toISOString(),
    source:'Tresor562/DIPPER-',
    scannedFiles:files.length,
    evaluatedFiles,
    fallbackFiles,
    skippedFiles,
    canonicalCount:commands.length,
    aliasCount,
    uniqueTokenCount:tokenOwner.size,
    commands
  };
}

const manifest=await buildCommandManifest();
if(manifest.canonicalCount<400){
  throw new Error(
    'Dipper extraction unexpectedly low: '+manifest.canonicalCount+
    ' canonical commands; expected at least 400 from the validated source runtime'
  );
}
if(manifest.uniqueTokenCount<500){
  throw new Error('Dipper token extraction unexpectedly low: '+manifest.uniqueTokenCount);
}

await fs.mkdir(path.join(outRoot,'generated'),{recursive:true});
await fs.mkdir(path.join(outRoot,'vendor'),{recursive:true});
await fs.writeFile(
  path.join(outRoot,'generated','dipper-styles.json'),
  JSON.stringify({generatedAt:new Date().toISOString(),themes,images},null,2)
);
await fs.writeFile(
  path.join(outRoot,'generated','dipper-commands.json'),
  JSON.stringify(manifest,null,2)
);
await fs.writeFile(path.join(outRoot,'vendor','dipper-menu.js.txt'),menuSource);

console.log('Synced Dipper styles:',Object.keys(themes).length);
console.log(
  'Synced Dipper commands:',
  manifest.canonicalCount,'canonical /',
  manifest.aliasCount,'aliases /',
  manifest.uniqueTokenCount,'unique tokens;',
  'sandbox files',manifest.evaluatedFiles,
  'fallback files',manifest.fallbackFiles
);
