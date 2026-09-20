import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_COMMANDS, REMOVED_COMMANDS, commandMap, commandStats } from '../commands.mjs';
import { canHandleDownloadCommand } from '../dipper-fallback.mjs';
import { canHandleAiCommand } from '../ai-engine.mjs';
import { canHandleStickerCommand } from '../sticker-engine.mjs';
import { canHandleGameCommand } from '../game-engine.mjs';
import { canHandleAnimeCommand } from '../anime-engine.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);
const runtime=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const compat=fs.readFileSync(path.join(ROOT,'compat.mjs'),'utf8');
const commandSource=fs.readFileSync(path.join(ROOT,'commands.mjs'),'utf8');
const registrySource=fs.readFileSync(path.join(ROOT,'engine-registry.json'),'utf8');
const configSource=fs.readFileSync(path.join(ROOT,'config.mjs'),'utf8');
const aiSource=fs.readFileSync(path.join(ROOT,'ai-engine.mjs'),'utf8');
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
const engineErrors=[];
const independenceErrors=[];

for(const [token,cmd] of commands){
  if(!token||token.length>64||/[\s/@]/u.test(token))invalid.push(token);
  if(cmd.privateOnly&&cmd.groupOnly)policyErrors.push(token+': privateOnly+groupOnly');
  if(cmd.adminOnly&&!cmd.groupOnly)policyErrors.push(token+': adminOnly without groupOnly');
  if(REMOVED_COMMANDS.has(token))policyErrors.push(token+': removed command leaked into registry');
  if(cmd.proxy||cmd.proxyService||cmd.sourceBot)independenceErrors.push(token+': external execution marker');
  const canonical=cmd.aliasFor||cmd.name;
  if(cmd.engine==='anime'&&!canHandleAnimeCommand(canonical))engineErrors.push(token+': unknown Anime engine route');
  if(cmd.engine==='ai'&&!canHandleAiCommand(canonical))engineErrors.push(token+': unknown AI engine route');
  if(cmd.engine==='download'&&!canHandleDownloadCommand(canonical))engineErrors.push(token+': unknown Download engine route');
  if(cmd.engine==='sticker'&&!canHandleStickerCommand(canonical))engineErrors.push(token+': unknown Sticker engine route');
  if(cmd.engine==='game'&&!canHandleGameCommand(canonical))engineErrors.push(token+': unknown Game engine route');

  if(cmd.hidden&&cmd.aliasFor){
    if(!commands.has(String(cmd.aliasFor).toLowerCase()))policyErrors.push(token+': alias target missing');
    continue;
  }

  const route=String(cmd.handler||cmd.sourceCommand||cmd.name||token).toLowerCase();
  if(['anime','ai','download','sticker','game'].includes(String(cmd.engine||'')))continue;
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

const forbiddenRuntimePatterns=[
  'proxyCommand','handleProxyFlowInput','PROXY_SERVICE_SPECS','resolveProxyUsername',
  '@TheNexDownloader_bot','@The_Nexus_techbot','@TheNexGame_bot','@Stacytg_bot',
  '@DarkNexus01_bot','@Nexwhisper_bot','@the_big_dipper_bot'
];
for(const pattern of forbiddenRuntimePatterns){
  if(runtime.includes(pattern)||compat.includes(pattern)||commandSource.includes(pattern)||registrySource.includes(pattern)){
    independenceErrors.push('forbidden dependency marker: '+pattern);
  }
}
for(const prefix of ['NEXGROUP__','NEXDOWNLOADER__','NEXWHISPER__','NEXGAME__','NEXCANAL__','NEXSTICK__','STACY_']){
  if(configSource.includes(prefix)||aiSource.includes(prefix)){
    independenceErrors.push('forbidden sibling env fallback: '+prefix);
  }
}

if(stats.visible<70)throw new Error('NexAi useful command surface unexpectedly low: '+stats.visible);
if(stats.visible>260)throw new Error('NexAi visible command surface grew too large: '+stats.visible);
if(stats.dipperSourceCanonical<150)throw new Error('Dipper source manifest unexpectedly low: '+stats.dipperSourceCanonical);
if(invalid.length)throw new Error('Invalid command tokens: '+invalid.slice(0,30).join(', '));
if(policyErrors.length)throw new Error('Invalid command policies: '+policyErrors.slice(0,40).join(', '));
if(engineErrors.length)throw new Error('Invalid local engine routes: '+engineErrors.slice(0,60).join(', '));
if(independenceErrors.length)throw new Error('NexAi is not standalone: '+independenceErrors.slice(0,60).join(', '));
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
  standalone:true,
  localEngines:['ai','download','group','sticker','game','anime','audio'],
  unresolved:0
},null,2));
