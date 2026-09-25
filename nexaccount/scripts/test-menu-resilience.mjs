import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test } from '../inline-bot.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);

const markup={
  inline_keyboard:[[
    {text:'Menu',callback_data:'menu:home',style:'primary',icon_custom_emoji_id:'123456'}
  ]]
};

const stamped=__test.stampMarkup(markup,'999');
assert.equal(stamped.inline_keyboard[0][0].callback_data,'menu:home|999');
assert.equal(markup.inline_keyboard[0][0].callback_data,'menu:home','stampMarkup must not mutate source');

const portable=__test.portableMarkup(stamped);
assert.equal(portable.inline_keyboard[0][0].callback_data,'menu:home|999');
assert.equal(portable.inline_keyboard[0][0].style,undefined);
assert.equal(portable.inline_keyboard[0][0].icon_custom_emoji_id,undefined);

const model={
  text:'NexAI menu',
  entities:[{type:'expandable_blockquote',offset:0,length:10}],
  reply_markup:markup,
  photoUrl:'https://example.com/menu.jpg'
};
const photo=__test.inlineResult(model,'999','x',false,false);
assert.equal(photo.type,'photo');
assert.equal(photo.reply_markup.inline_keyboard[0][0].callback_data,'menu:home|999');

const article=__test.inlineResult(model,'999','x',true,true);
assert.equal(article.type,'article');
assert.deepEqual(article.input_message_content.entities,[]);
assert.equal(article.reply_markup.inline_keyboard[0][0].callback_data,'menu:home|999');

const inlineSource=fs.readFileSync(path.join(ROOT,'inline-bot.mjs'),'utf8');
const runtimeSource=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const menuSource=fs.readFileSync(path.join(ROOT,'menu.mjs'),'utf8');
const styleSource=fs.readFileSync(path.join(ROOT,'styles.mjs'),'utf8');

assert.match(inlineSource,/bot\.command\('menu'/,'/menu handler must exist');
assert.match(inlineSource,/bot\.command\('help'/,'/help handler must exist');
assert.match(inlineSource,/ctx\.callbackQuery\.inline_message_id\|\|ctx\.callbackQuery\.message/,'callbacks must support inline and direct bot messages');
assert.match(inlineSource,/article-portable/,'inline fallback must preserve an interactive article result');
assert.ok(!runtimeSource.includes('Le menu inline est temporairement indisponible'),'legacy alarming fallback must be removed');
assert.ok(!menuSource.includes("settings.menuImageUrl||''"),'stale per-user artwork must not override the active style');
assert.match(styleSource,/INLINE_PHOTO_MAX_BYTES=5\*1024\*1024/,'inline photo size guard missing');
assert.match(styleSource,/image\/jpeg/,'inline artwork must validate JPEG content');

console.log('menu resilience regression tests: ok');
