import fs from 'node:fs/promises';
import path from 'node:path';
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
  try{oldImages=(await import('node:vm')).default.runInNewContext('('+literal+')',{}, {timeout:1000})||{}}catch{}
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

await fs.mkdir(path.join(outRoot,'generated'),{recursive:true});
await fs.mkdir(path.join(outRoot,'vendor'),{recursive:true});
await fs.writeFile(path.join(outRoot,'generated','dipper-styles.json'),JSON.stringify({generatedAt:new Date().toISOString(),themes,images},null,2));
await fs.writeFile(path.join(outRoot,'vendor','dipper-menu.js.txt'),menuSource);
console.log('Synced Dipper styles:',Object.keys(themes).length);
