import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand } from '../core/command-parser.mjs';
import { commandMap } from '../commands.mjs';

const commands=commandMap();
const bareOptions={
  allowBare:true,
  isKnownCommand:name=>commands.has(name)
};

const HERE=path.dirname(fileURLToPath(import.meta.url));
const commandSource=fs.readFileSync(path.join(HERE,'..','commands.mjs'),'utf8');
const aliasStart=commandSource.indexOf('export const LEGACY_ALIASES');
const aliasEnd=commandSource.indexOf('export const REMOVED_COMMANDS',aliasStart);
const aliasSource=commandSource.slice(aliasStart,aliasEnd);
const aliasKeys=[...aliasSource.matchAll(/\b([A-Za-z0-9_]+)\s*:\s*'[^']+'/g)].map(m=>m[1].toLowerCase());
const seen=new Set();
for(const key of aliasKeys){
  assert.ok(!seen.has(key),'duplicate alias key in LEGACY_ALIASES: '+key);
  seen.add(key);
}

const cases=[
  ['/S','sticker',[]],
  ['/Sticker','sticker',[]],
  ['/Clone My Pack','clonepack',['My','Pack']],
  ['/Take My Pack','clonepack',['My','Pack']],
  ['/Take','clonepack',[]],
  ['/Wastickers','exportwhatsapp',[]],
  ['/Music never gonna give you up','song',['never','gonna','give','you','up']],
  ['/Ytv https://youtu.be/test','video',['https://youtu.be/test']],
  ['/Ig https://instagram.com/reel/x','instagram',['https://instagram.com/reel/x']],
  ['/Me','account',[]],
  ['/Lang fr','language',['fr']],
  ['/All hello','tagall',['hello']],
  ['/Htag hello','hidetag',['hello']],
  ['/Ani Frieren','animeinfo',['Frieren']],
  ['/Ep 12','episode',['12']]
];

for(const [input,target,args] of cases){
  const parsed=parseCommand(input,'.');
  assert.ok(parsed,'parse failed for '+input);
  const route=commands.get(parsed.name);
  assert.ok(route,'registry missing '+parsed.name);
  assert.equal(route.aliasFor||route.name,target,input+' must resolve to '+target);
  assert.deepEqual(parsed.args,args,input+' must preserve arguments');
  if(route.name!==target)assert.equal(route.hidden,true,input+' alias must stay hidden from menus');
}

const dotted=parseCommand('.take Pack Perso','.');
assert.equal(dotted.name,'take');
assert.deepEqual(dotted.args,['Pack','Perso']);
assert.equal(dotted.kind,'prefix');
assert.equal(commands.get(dotted.name).aliasFor,'clonepack');

const bare=parseCommand('take Pack Perso','.',bareOptions);
assert.ok(bare,'known command must parse without a prefix');
assert.equal(bare.name,'take');
assert.deepEqual(bare.args,['Pack','Perso']);
assert.equal(bare.kind,'bare');
assert.equal(commands.get(bare.name).aliasFor,'clonepack');

const bareCase=parseCommand('MUSIC never gonna give you up','.',bareOptions);
assert.ok(bareCase,'known alias must parse without a prefix');
assert.equal(bareCase.name,'music');
assert.deepEqual(bareCase.args,['never','gonna','give','you','up']);
assert.equal(bareCase.kind,'bare');

assert.equal(parseCommand('hello there','.',bareOptions),null,'normal conversation must not become a command');
assert.equal(parseCommand('take Pack Perso','.'),null,'bare parsing must stay opt-in');
assert.equal(parseCommand('/take Pack Perso','.',bareOptions).kind,'slash');

console.log('alias/parser regression tests: ok');
