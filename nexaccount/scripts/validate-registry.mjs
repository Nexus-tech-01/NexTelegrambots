import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_COMMANDS, REMOVED_COMMANDS, commandMap, commandStats } from '../commands.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);
const runtime=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const compat=fs.readFileSync(path.join(ROOT,'compat.mjs'),'utf8');
const commands=commandMap();
const stats=commandStats(commands);

function textMentionsRoute(name){
  const q=String(name).replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  const patterns=[
    new RegExp("case\\s+['\"]"+q+"['\"]"),
    new RegExp("name\\s*={2,3}\\s*['\"]"+q+"['\"]"),
    new RegExp("['\"]"+q+"['\"]\\s*:"),
    new RegExp("[,\\[]\\s*['\"]"+q+"['\"]")
  ];
  return patterns.some(re=>re.test(runtime)||re.test(compat));
}

const invalid=[];
const unresolved=[];
const policyErrors=[];

for(const [token,cmd] of commands){
  if(!token||token.length>64||/[\s/@]/u.test(token))invalid.push(token);
  if(cmd.privateOnly&&cmd.groupOnly)policyErrors.push(token+': privateOnly+groupOnly');
  if(cmd.adminOnly&&!cmd.groupOnly)policyErrors.push(token+': adminOnly without groupOnly');
  if(REMOVED_COMMANDS.has(token))policyErrors.push(token+': removed command leaked into registry');

  if(cmd.hidden&&cmd.aliasFor){
    if(!commands.has(String(cmd.aliasFor).toLowerCase()))policyErrors.push(token+': alias target missing');
    continue;
  }

  const route=String(cmd.handler||cmd.sourceCommand||cmd.name||token).toLowerCase();
  if(cmd.proxy)continue;
  if(textMentionsRoute(route))continue;
  unresolved.push(token+' -> '+route);
}


const REQUIRED_ALIAS_TARGETS={
  dipper:'menu',grimoire:'menu',play:'song',dlmusic:'song',yta:'song',
  mp3:'tomp3',toaudio:'tomp3',paroles:'lyrics',lyric:'lyrics',lirik:'lyrics',
  identify:'shazam',identifie:'shazam',reconnaitre:'shazam',
  ytv:'video',ytmp4:'video',dlyoutube:'video',ig:'instagram',fb:'facebook',fbdl:'facebook',tt:'tiktok',apksearch:'apk'
};
for(const [alias,target] of Object.entries(REQUIRED_ALIAS_TARGETS)){
  const cmd=commands.get(alias);
  if(!cmd||cmd.aliasFor!==target||cmd.hidden!==true){
    policyErrors.push(alias+': expected hidden alias for '+target);
  }
}

if(stats.visible<70)throw new Error('NexAi useful command surface unexpectedly low: '+stats.visible);
if(stats.visible>180)throw new Error('NexAi visible command surface grew too large: '+stats.visible);
if(stats.dipperSourceCanonical<150)throw new Error('Dipper source manifest unexpectedly low: '+stats.dipperSourceCanonical);
if(invalid.length)throw new Error('Invalid command tokens: '+invalid.slice(0,30).join(', '));
if(policyErrors.length)throw new Error('Invalid command policies: '+policyErrors.slice(0,40).join(', '));
if(unresolved.length)throw new Error('Unrouted commands: '+unresolved.slice(0,60).join(', '));

console.log(JSON.stringify({
  ok:true,
  brand:'NexAi',
  secondaryName:'Dipper',
  tokens:stats.tokens,
  visible:stats.visible,
  aliases:stats.aliases,
  removed:stats.removed,
  dipperSourceCanonical:stats.dipperSourceCanonical,
  sourceTokens:stats.sourceTokens,
  unresolved:0
},null,2));
