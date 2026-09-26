import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test } from '../inline-bot.mjs';
import { CATEGORY_ORDER, commandMap } from '../commands.mjs';
import { menuModel } from '../menu.mjs';

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
  entities:[{type:'blockquote',offset:0,length:10}],
  reply_markup:markup,
  photoUrl:'https://example.com/menu.jpg'
};
const photo=__test.inlineResult(model,'999','x',false,false);
assert.equal(photo.type,'photo');
assert.equal(photo.input_message_content.message_text,'NexAI menu');
assert.equal(photo.input_message_content.link_preview_options.url,'https://example.com/menu.jpg');
assert.equal(photo.caption,undefined,'menu photo result must send editable text content, not a 1024-char caption');
assert.equal(photo.reply_markup.inline_keyboard[0][0].callback_data,'menu:home|999');

const article=__test.inlineResult(model,'999','x',true,true);
assert.equal(article.type,'article');
assert.equal(article.input_message_content.entities[0]?.type,'blockquote','portable fallback must preserve the header citation');
assert.equal(article.reply_markup.inline_keyboard[0][0].callback_data,'menu:home|999');

const cachedPhoto=__test.inlineCachedPhotoResult(model,'999','cached-x','telegram-file-id',false);
assert.equal(cachedPhoto.type,'photo');
assert.equal(cachedPhoto.photo_file_id,'telegram-file-id');
assert.equal(cachedPhoto.input_message_content.message_text,'NexAI menu');
assert.equal(cachedPhoto.reply_markup.inline_keyboard[0][0].callback_data,'menu:home|999');

assert.deepEqual(
  __test.telegramCommandMenu().map(x=>x.command),
  ['start','menu','help','pair','language','creator'],
  'Telegram slash menu must contain only real Bot API handlers'
);

const inlineSource=fs.readFileSync(path.join(ROOT,'inline-bot.mjs'),'utf8');
const runtimeSource=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const menuSource=fs.readFileSync(path.join(ROOT,'menu.mjs'),'utf8');
const styleSource=fs.readFileSync(path.join(ROOT,'styles.mjs'),'utf8');
const themeSource=fs.readFileSync(path.join(ROOT,'theme-ui.mjs'),'utf8');
const generatedStyles=JSON.parse(fs.readFileSync(path.join(ROOT,'generated','dipper-styles.json'),'utf8'));

assert.match(inlineSource,/bot\.command\('menu'/,'/menu handler must exist');
assert.match(inlineSource,/bot\.command\('help'/,'/help handler must exist');
assert.match(inlineSource,/ctx\.callbackQuery\.inline_message_id\|\|ctx\.callbackQuery\.message/,'callbacks must support inline and direct bot messages');
assert.match(inlineSource,/article-portable/,'inline fallback must preserve an interactive article result');
assert.match(inlineSource,/cachePhotoFileId/,'inline artwork must be cached as a Telegram file_id');
assert.match(inlineSource,/photo_file_id/,'cached inline photo result must use Telegram media');
assert.match(inlineSource,/prefer_large_media:true,show_above_text:true/,'menu artwork must render as a stable large link preview above text');
assert.match(inlineSource,/Never truncate a long category/,'legacy media callbacks must not truncate long categories');
assert.match(inlineSource,/function portableEntities/,'portable menu fallback must preserve clickable slash-command entities');
assert.match(inlineSource,/action==='menu:styles'/,'styles menu callback must be handled');
assert.match(inlineSource,/action\.startsWith\('style:set:'\)/,'style selection callback must be handled');
assert.match(inlineSource,/patchSettings\(accountId,\{style:styleId\}\)/,'style callback must persist selection');
assert.ok(!inlineSource.includes('for(const cmd of commands.values())'),'native slash menu must not advertise NexAccount commands');
assert.ok(!runtimeSource.includes('Le menu inline est temporairement indisponible'),'legacy alarming fallback must be removed');
assert.match(runtimeSource,/import \{ menuModel, stylesModel \} from '\.\/menu\.mjs';/,'runtime must import styles fallback model');
assert.match(runtimeSource,/\[NexAccount styles\].*inline:failed/s,'style selector must log inline failures');
assert.match(runtimeSource,/stylesModel\(\{account,settings\}\)/,'style selector must fall back to a direct styles model');
assert.match(menuSource,/const command=slashCommand\(line\.name\)/,'menu commands must display Telegram slash commands');
assert.match(menuSource,/type:'bot_command'/,'menu slash commands must be emitted as clickable Telegram bot_command entities');
assert.match(menuSource,/quoteRange=\{start:0,length:header\.length\}/,'header must be the quoted Telegram block');
assert.match(menuSource,/function displayUser\(/,'menu header identity must be resolved from the active session');
assert.match(menuSource,/menu:styles/,'home menu must expose styles callback');
assert.match(menuSource,/style:set:/,'styles must be selectable with callbacks');
assert.match(menuSource,/menuImageStyle/,'custom artwork must be bound to a style');
assert.match(menuSource,/Number\(settings\?\.menuImageStyle\|\|0\)===Number\(styleId\)/,'style binding guard missing');
assert.match(menuSource,/resolveInlinePhoto/,'custom artwork must be validated before inline use');
assert.ok(!menuSource.includes("resolveStyleImage(1,''"),'a missing theme image must not silently reuse Dark artwork');
assert.ok(!menuSource.includes('const perPage=16'),'category pagination must be removed');
assert.ok(!menuSource.includes("localized(settings,'Suivant','Next')"),'category next/previous navigation must be removed');
assert.ok(!menuSource.includes("photoUrl:view==='category'?'':"),'category artwork must no longer be dropped just to avoid caption limits');
assert.match(themeSource,/THEME_UI_IDS/,'new theme UI registry must be present');
assert.match(themeSource,/31:/,'all 31 theme layouts must be defined');
assert.ok(Object.keys(generatedStyles.themes||{}).length>=31,'all 31 public Dipper styles must be bundled');
assert.equal(Number(generatedStyles.themes?.['20']?.id),20,'style20 must be present in the bundled catalog');
assert.match(styleSource,/for\(let start=0;start<urls\.length;start\+=4\)/,'artwork resolver must scan beyond the first broken URL batch');
assert.match(styleSource,/files\.catbox\.moe/,'Catbox artwork conversion guard missing');
assert.match(styleSource,/img\.vxs\.nl/,'verified JPEG conversion proxy missing');
assert.equal(new Set(CATEGORY_ORDER).size,CATEGORY_ORDER.length,'menu categories must not be duplicated');

// Every public style must keep a complete category inside one Telegram text
// message, quote only the compact header, and resolve identity per session.
const registry=commandMap();
for(let style=1;style<=31;style++){
  const accountA={telegramUserId:'991'+style,username:'alpha_'+style,firstName:'Alpha',premium:style%2===0};
  const accountB={telegramUserId:'881'+style,username:'beta_'+style,firstName:'Beta',premium:false};
  const settings={style,prefix:style%2===0?'!':'.',language:'fr'};
  const modelA=await menuModel({account:accountA,settings,commands:registry,view:'category',category:'ANIME',includeArtwork:false});
  const modelB=await menuModel({account:accountB,settings,commands:registry,view:'category',category:'ANIME',includeArtwork:false});
  assert.ok(modelA.text.length<=4096,'style '+style+' Anime menu exceeds Telegram text limit');
  assert.ok(modelA.text.includes('@alpha_'+style),'style '+style+' must render active session username');
  assert.ok(modelB.text.includes('@beta_'+style),'style '+style+' must not reuse another session username');
  assert.ok(!modelB.text.includes('@alpha_'+style),'style '+style+' leaked session identity');
  assert.ok(modelA.entities.some(x=>x.type==='blockquote'&&x.offset===0),'style '+style+' header must be a Telegram blockquote');
  assert.ok(modelA.entities.some(x=>x.type==='bot_command'),'style '+style+' commands must stay clickable');
  assert.ok(!/\bpage\s+\d+/i.test(modelA.text),'style '+style+' must not paginate categories');
}


assert.match(styleSource,/INLINE_PHOTO_MAX_BYTES=5\*1024\*1024/,'inline photo size guard missing');
assert.match(styleSource,/image\/jpeg/,'inline artwork must validate JPEG content');

process.env.NEXAI_EMOJI_STYLE_2='5368324170671202286';
process.env.NEXAI_EMOJI_ANIME='5368324170671202287';
const emojiModel=await menuModel({
  account:{telegramUserId:'7788',username:'emoji_test',firstName:'Emoji',premium:true},
  settings:{style:2,prefix:'.',language:'fr'},
  commands:registry,
  view:'category',
  category:'ANIME',
  includeArtwork:false
});
assert.ok(emojiModel.entities.filter(x=>x.type==='custom_emoji').length>=2,'style/category custom emoji entities must activate when IDs are configured');
delete process.env.NEXAI_EMOJI_STYLE_2;
delete process.env.NEXAI_EMOJI_ANIME;

process.env.NEXAI_EMOJI_STYLE_7='5368324170671202290';
process.env.NEXAI_EMOJI_ANIME='5368324170671202291';
const overlapModel=await menuModel({
  account:{telegramUserId:'7799',username:'ruby_test',firstName:'Ruby',premium:true},
  settings:{style:7,prefix:'.',language:'fr'},
  commands:registry,
  view:'category',
  category:'ANIME',
    includeArtwork:false
  });
const emojiRanges=overlapModel.entities
  .filter(x=>x.type==='custom_emoji')
  .map(x=>x.offset+':'+x.length);
assert.equal(new Set(emojiRanges).size,emojiRanges.length,'custom emoji entity ranges must never overlap exactly');
delete process.env.NEXAI_EMOJI_STYLE_7;
delete process.env.NEXAI_EMOJI_ANIME;

const brandedA=await menuModel({
  account:{telegramUserId:'5511',username:'brand_a',firstName:'A',premium:false},
  settings:{style:1,prefix:'.',language:'fr',botDisplayName:'NexAi Alpha'},
  commands:registry,
  view:'category',category:'GENERAL',includeArtwork:false
});
const brandedB=await menuModel({
  account:{telegramUserId:'5522',username:'brand_b',firstName:'B',premium:false},
  settings:{style:9,prefix:'!',language:'fr',botDisplayName:'NexAi Beta'},
  commands:registry,
  view:'category',category:'GENERAL',includeArtwork:false
});
assert.ok(brandedA.text.includes('NexAi Alpha'),'style 1 must use the session bot display name');
assert.ok(brandedB.text.includes('NexAi Beta'),'style 9 must use the session bot display name');
assert.ok(!brandedB.text.includes('NexAi Alpha'),'bot display name leaked between sessions');



console.log('menu resilience regression tests: ok');
