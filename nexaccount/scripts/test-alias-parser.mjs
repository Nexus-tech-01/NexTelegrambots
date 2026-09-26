import assert from 'node:assert/strict';
import { parseCommand } from '../core/command-parser.mjs';
import { commandMap } from '../commands.mjs';

const commands=commandMap();

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
assert.equal(commands.get(dotted.name).aliasFor,'clonepack');

console.log('alias/parser regression tests: ok');
