import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, textOf } from '../core/command-parser.mjs';
import { createCommandDeduper } from '../core/command-deduper.mjs';
import { createRuntimeContext, clearRuntimeTimers } from '../core/runtime-context.mjs';

assert.deepEqual(parseCommand('.menu','.'),{name:'menu',args:[]});
assert.deepEqual(parseCommand('/Ping@NexAi_bot now','.'),{name:'ping',args:['now']});
assert.equal(parseCommand('hello','.'),null);
assert.equal(textOf({message:'  hello  '}),'hello');

const dedupe=createCommandDeduper({ttlMs:60000});
const message={id:42,peerId:{userId:99}};
assert.equal(dedupe.claim('1',message),true);
assert.equal(dedupe.claim('1',message),false);
assert.equal(dedupe.claim('2',message),true);

const runtime=createRuntimeContext({client:{},account:{telegramUserId:'1'}});
runtime.autoJoinTimer=setInterval(()=>{},60000);
runtime.leaseTimer=setInterval(()=>{},60000);
clearRuntimeTimers(runtime);
assert.equal(runtime.autoJoinTimer,null);
assert.equal(runtime.leaseTimer,null);

const here=path.dirname(fileURLToPath(import.meta.url));
const runtimeSource=fs.readFileSync(path.resolve(here,'../runtime.mjs'),'utf8');
for(const forbidden of [
  'canHandleAnimeCommand',
  'canHandleDownloadCommand',
  'canHandleAiCommand',
  'canHandleStickerCommand',
  'canHandleGameCommand'
]){
  assert.equal(runtimeSource.includes(forbidden),false,'runtime.mjs still owns engine routing: '+forbidden);
}

console.log('core architecture ok');
