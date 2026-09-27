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
  if(cmd.proxy)errors.push('standalone-proxy-present:'+token+':'+cmd.proxy);
  if(cmd.sourceBot)errors.push('sibling-source-present:'+token+':'+cmd.sourceBot);
}
if(DIPPER_COMMANDS.length<178)errors.push('dipper-count-too-low:'+DIPPER_COMMANDS.length);
const sourceCount=Object.values(SOURCE_COMMANDS).reduce((n,v)=>n+(Array.isArray(v)?v.length:0),0);
if(sourceCount<150)errors.push('source-count:'+sourceCount);

const requiredGroup=['tag','tagall','hidetag','mediatag','tagadmin','promote','demote','kick','ban','unban','mute','unmute','warn','warnings','slowmode','config','permissions'];
for(const name of requiredGroup){
  const cmd=commands.get(name);
  if(!cmd)errors.push('group-command-missing:'+name);
  else{
    if(cmd.category!=='GROUP')errors.push('group-category:'+name+':'+cmd.category);
    if(cmd.engine!=='group')errors.push('group-engine:'+name+':'+String(cmd.engine||''));
    if(cmd.groupOnly!==true)errors.push('group-only-missing:'+name);
  }
}
for(const name of ['tagall','hidetag','mediatag','promote','demote','kick','ban','unban','mute','unmute','warn','warnings','slowmode','config','permissions']){
  if(commands.get(name)?.adminOnly!==true)errors.push('admin-flag-missing:'+name);
}
if(groups.ADMIN?.length)errors.push('legacy-admin-category:'+groups.ADMIN.length);

const mode=commands.get('mode');
if(!mode||mode.category!=='ACCOUNT'||mode.selfOnly!==true)errors.push('access-mode-command-invalid');

const runtime=fs.readFileSync(path.join(HERE,'..','runtime.mjs'),'utf8');
const compat=fs.readFileSync(path.join(HERE,'..','compat.mjs'),'utf8');
if(runtime.includes('adaptateur Telegram n’est pas encore chargé'))errors.push('legacy-placeholder-runtime');
if(!runtime.includes('handleCompatCommand'))errors.push('compat-router-not-loaded');
if(!runtime.includes("settings.accessMode==='public'"))errors.push('public-mode-runtime-missing');
if(!runtime.includes('userIsGroupAdmin'))errors.push('public-admin-guard-missing');
if(!runtime.includes('messageAuthorIsBot'))errors.push('public-bot-guard-missing');
if(!compat.includes("if(name==='tag')"))errors.push('tag-handler-missing');
if(!compat.includes("name==='tagall'||name==='hidetag'||name==='mediatag'||name==='tagadmin'"))errors.push('mass-tag-handler-missing');
if(!compat.includes('sendHiddenMentions'))errors.push('hidetag-handler-missing');
if(!compat.includes("name==='mode'||name==='accessmode'||name==='botmode'"))errors.push('access-mode-handler-missing');

const forbiddenSiblingRefs=['@TheNexDownloader_bot','@TheNexGame_bot','@The_Nexus_techbot','@Nexwhisper_bot','@Stacytg_bot'];
for(const ref of forbiddenSiblingRefs){
  if(runtime.includes(ref))errors.push('runtime-sibling-ref:'+ref);
}

let maxEstimatedMessage=0;
for(const [category,list] of Object.entries(groups)){
  const names=list
    .filter(c=>!c.hidden)
    .map(c=>'/'+c.name+(c.premium?' · Premium':''));
  // Menus are editable Telegram text messages (4096 chars), not photo captions.
  // Reserve a generous budget for the quoted themed header/category/footer.
  const estimate=900+names.join('\n').length;
  maxEstimatedMessage=Math.max(maxEstimatedMessage,estimate);
  if(estimate>4096)errors.push('message-risk:'+category+':'+estimate);
}
const report={
  ok:errors.length===0,
  standalone:true,
  stats,
  sourceCanonicalTokens:sourceCount,
  categories:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),
  groupAdminUnified:!groups.ADMIN?.length,
  publicPrivateMode:Boolean(mode),
  maxEstimatedMessage,
  errors
};
console.log(JSON.stringify(report,null,2));
if(errors.length)process.exitCode=1;
