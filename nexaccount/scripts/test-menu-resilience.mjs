import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test } from '../inline-bot.mjs';
import { CATEGORY_ORDER } from '../commands.mjs';

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

assert.deepEqual(
  __test.telegramCommandMenu().map(x=>x.command),
  ['start','menu','help','pair','language','creator'],
  'Telegram slash menu must contain only real Bot API handlers'
);

const inlineSource=fs.readFileSync(path.join(ROOT,'inline-bot.mjs'),'utf8');
const runtimeSource=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const menuSource=fs.readFileSync(path.join(ROOT,'menu.mjs'),'utf8');
const styleSource=fs.readFileSync(path.join(ROOT,'styles.mjs'),'utf8');

assert.match(inlineSource,/bot\.command\('menu'/,'/menu handler must exist');
assert.match(inlineSource,/bot\.command\('help'/,'/help handler must exist');
assert.match(inlineSource,/ctx\.callbackQuery\.inline_message_id\|\|ctx\.callbackQuery\.message/,'callbacks must support inline and direct bot messages');
assert.match(inlineSource,/article-portable/,'inline fallback must preserve an interactive article result');
assert.match(inlineSource,/action==='menu:styles'/,'styles menu callback must be handled');
assert.match(inlineSource,/action\.startsWith\('style:set:'\)/,'style selection callback must be handled');
assert.match(inlineSource,/patchSettings\(accountId,\{style:styleId\}\)/,'style callback must persist selection');
assert.ok(!inlineSource.includes('for(const cmd of commands.values())'),'native slash menu must not advertise NexAccount commands');
assert.ok(!runtimeSource.includes('Le menu inline est temporairement indisponible'),'legacy alarming fallback must be removed');
assert.match(menuSource,/commandText\(visibleCommands,style,settings\.prefix\|\|'\.'\)/,'menu commands must use configured NexAccount prefix');
assert.ok(!menuSource.includes("type:'bot_command'"),'NexAccount commands must not be emitted as Bot API slash-command entities');
assert.match(menuSource,/menu:styles/,'home menu must expose styles callback');
assert.match(menuSource,/style:set:/,'styles must be selectable with callbacks');
assert.match(menuSource,/menuImageStyle/,'custom artwork must be bound to a style');
assert.match(menuSource,/Number\(settings\?\.menuImageStyle\|\|0\)===Number\(styleId\)/,'style binding guard missing');
assert.match(menuSource,/resolveInlinePhoto/,'custom artwork must be validated before inline use');
assert.equal(new Set(CATEGORY_ORDER).size,CATEGORY_ORDER.length,'menu categories must not be duplicated');
assert.match(styleSource,/INLINE_PHOTO_MAX_BYTES=5\*1024\*1024/,'inline photo size guard missing');
assert.match(styleSource,/image\/jpeg/,'inline artwork must validate JPEG content');

console.log('menu resilience regression tests: ok');
