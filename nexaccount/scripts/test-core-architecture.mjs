import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, textOf } from '../core/command-parser.mjs';
import { createCommandDeduper } from '../core/command-deduper.mjs';
import { createRuntimeContext, clearRuntimeTimers } from '../core/runtime-context.mjs';

assert.deepEqual(parseCommand('.menu','.'),{name:'menu',args:[],kind:'prefix'});
assert.deepEqual(parseCommand('/Ping@NexAi_bot now','.'),{name:'ping',args:['now'],kind:'slash'});
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
runtime.emojiLibraryTimer=setInterval(()=>{},60000);
clearRuntimeTimers(runtime);
assert.equal(runtime.autoJoinTimer,null);
assert.equal(runtime.leaseTimer,null);
assert.equal(runtime.emojiLibraryTimer,null);

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

assert.equal(runtimeSource.includes('syncOwnedCustomEmojiLibrary'),true,'runtime must synchronize the source custom emoji library');
assert.equal(runtimeSource.includes("cfg.creatorUsername||'tresor20001'"),true,'runtime must bind the emoji library to the creator/source account');

assert.equal(runtimeSource.includes('emojiLibrary:true'),true,'Premium connected replies must use the full custom emoji library');
assert.ok(
  runtimeSource.indexOf("sendBrandedText(client,peer,value,{") < runtimeSource.indexOf("putInlineResponse(value,{accountId})"),
  'Premium connected replies must prefer direct Telegram entities before Inline Mode'
);

const responseUiSource=fs.readFileSync(path.resolve(here,'../response-ui.mjs'),'utf8');
assert.equal(
  responseUiSource.includes('animatedCustomEmojiEntitySpecsFromLibrary'),
  true,
  'response UI must resolve arbitrary message emojis from the persistent custom emoji library'
);

const inlineSource=fs.readFileSync(path.resolve(here,'../inline-bot.mjs'),'utf8');
assert.equal(inlineSource.includes("from './runtime.mjs'"),false,'inline-bot must not import the multi-session runtime directly');

console.log('core architecture ok');
