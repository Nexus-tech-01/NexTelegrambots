import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_COMMANDS, commandMap, commandStats } from '../commands.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);
const runtime=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const compat=fs.readFileSync(path.join(ROOT,'compat.mjs'),'utf8');
const commands=commandMap();
const stats=commandStats(commands);
const coreNames=new Set(CORE_COMMANDS.map(c=>String(c.name).toLowerCase()));

function textMentionsCore(name){
  const q=String(name).replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  const patterns=[
    new RegExp("case\\s+['\"]"+q+"['\"]"),
    new RegExp("name\\s*={2,3}\\s*['\"]"+q+"['\"]"),
    new RegExp("['\"]"+q+"['\"]\\s*:"),
    new RegExp("[,\\[]\\s*['\"]"+q+"['\"]")
  ];
  return patterns.some(re=>re.test(runtime)||re.test(compat));
}

const unresolved=[];
const invalid=[];
for(const [token,cmd] of commands){
  if(!token||token.length>96||/[\s/@]/u.test(token))invalid.push(token);
  const canonical=String(cmd.aliasFor||cmd.name||token).toLowerCase();
  if(cmd.aliasFor&&commands.has(canonical))continue;
  if(cmd.proxy||cmd.sourceBot||cmd.dipper)continue;
  if(coreNames.has(canonical)&&textMentionsCore(canonical))continue;
  unresolved.push(token);
}

if(stats.tokens<500)throw new Error('NexAI registry below 500 tokens: '+stats.tokens);
if(stats.dipperCanonical<150)throw new Error('Dipper canonical command import unexpectedly low: '+stats.dipperCanonical);
if(invalid.length)throw new Error('Invalid command tokens: '+invalid.slice(0,30).join(', '));
if(unresolved.length)throw new Error('Unrouted commands: '+unresolved.slice(0,60).join(', '));

console.log(JSON.stringify({
  ok:true,
  tokens:stats.tokens,
  visible:stats.visible,
  aliases:stats.aliases,
  dipperCanonical:stats.dipperCanonical,
  sourceTokens:stats.sourceTokens,
  unresolved:0
},null,2));
