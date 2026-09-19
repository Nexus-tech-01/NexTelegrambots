import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandMap, commandStats, commandsByCategory, DIPPER_COMMANDS, SOURCE_COMMANDS } from '../commands.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const commands=commandMap();
const stats=commandStats(commands);
const groups=commandsByCategory(commands);
const errors=[];

for(const [token,cmd] of commands){
  if(!token||token!==token.toLowerCase())errors.push('invalid-token:'+token);
  if(!cmd.category)errors.push('missing-category:'+token);
  if(cmd.aliasFor&&!commands.has(cmd.aliasFor))errors.push('broken-alias:'+token+'->'+cmd.aliasFor);
  if(cmd.proxy&&!/^@[A-Za-z0-9_]{5,}$/.test(cmd.proxy))errors.push('bad-proxy:'+token+':'+cmd.proxy);
}
if(DIPPER_COMMANDS.length!==178)errors.push('dipper-count:'+DIPPER_COMMANDS.length);
const sourceCount=Object.values(SOURCE_COMMANDS).reduce((n,v)=>n+(Array.isArray(v)?v.length:0),0);
if(sourceCount<150)errors.push('source-count:'+sourceCount);

const expectedProxies=['@TheNexDownloader_bot','@TheNexGame_bot','@The_Nexus_techbot','@Nexwhisper_bot','@Stacytg_bot'];
for(const p of expectedProxies)if(![...commands.values()].some(c=>c.proxy===p))errors.push('proxy-missing:'+p);

const runtime=fs.readFileSync(path.join(HERE,'..','runtime.mjs'),'utf8');
const compat=fs.readFileSync(path.join(HERE,'..','compat.mjs'),'utf8');
if(runtime.includes('adaptateur Telegram n’est pas encore chargé'))errors.push('legacy-placeholder-runtime');
if(!runtime.includes('handleCompatCommand'))errors.push('compat-router-not-loaded');
if(!compat.includes("cmd?.sourceBot==='nexgroup'"))errors.push('nexgroup-compat-missing');

const perPage=16;
let maxEstimatedCaption=0;
for(const [category,list] of Object.entries(groups)){
  for(let i=0;i<list.length;i+=perPage){
    const names=list.slice(i,i+perPage).map(c=>'/'+c.name+(c.premium?' · Premium':''));
    const estimate=360+names.join('\n').length;
    maxEstimatedCaption=Math.max(maxEstimatedCaption,estimate);
    if(estimate>1000)errors.push('caption-risk:'+category+':'+(i/perPage+1)+':'+estimate);
  }
}

const report={
  ok:errors.length===0,
  stats,
  sourceCanonicalTokens:sourceCount,
  categories:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),
  maxEstimatedCaption,
  errors
};
console.log(JSON.stringify(report,null,2));
if(errors.length)process.exitCode=1;
