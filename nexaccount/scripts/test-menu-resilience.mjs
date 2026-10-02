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

assert.equal(__test.callbackAccessAllowed('999','999','private'),true,'private mode must allow the connected account');
assert.equal(__test.callbackAccessAllowed('111','999','private'),false,'private mode must reject other users');
assert.equal(__test.callbackAccessAllowed('111','999','private','tresor20001'),true,'private mode must allow the configured NexAi owner');
assert.equal(__test.callbackAccessAllowed('111','999','public'),true,'public mode must allow other users to use inline menu callbacks');

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

const articleNoArtwork=__test.inlineResult(model,'999','x',true,true,true);
assert.equal(articleNoArtwork.type,'article');
assert.equal(articleNoArtwork.input_message_content.link_preview_options.is_disabled,true,'last-resort inline fallback must not depend on artwork');

const cachedPhoto=__test.inlineCachedPhotoResult(model,'999','cached-x','telegram-file-id',false);
assert.equal(cachedPhoto.type,'photo');
assert.equal(cachedPhoto.photo_file_id,'telegram-file-id');
assert.equal(cachedPhoto.input_message_content.message_text,'NexAI menu');
assert.equal(cachedPhoto.reply_markup.inline_keyboard[0][0].callback_data,'menu:home|999');

const inlineReply=__test.inlineReplyModel(
  'Téléchargement terminé\n/Help Clonepack',
  {customEmojiIds:{NEXAI_EMOJI_NEXTECH:'5368324170671202400'}}
);
assert.ok(inlineReply.text.endsWith('By Nextech'),'inline reply must include clickable By Nextech');
assert.ok(inlineReply.entities.some(x=>x.type==='text_link'&&x.url.includes('t.me')),'By Nextech must be a Telegram text_link');
assert.ok(inlineReply.entities.some(x=>x.type==='bot_command'),'slash commands in replies must stay clickable');
assert.equal(inlineReply.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id,'5368324170671202400','Nextech CTA must use the session custom emoji when configured');

const inlineReplyFallback=__test.inlineReplyModel('Réponse test',{customEmojiIds:{}});
assert.match(inlineReplyFallback.reply_markup.inline_keyboard[0][0].text,/^⚡\s/,'Nextech CTA must fall back to a normal emoji');

assert.deepEqual(
  __test.telegramCommandMenu().map(x=>x.command),
  ['start','menu','help','pair','premium','language','creator'],
  'Telegram slash menu must contain only real Bot API handlers'
);

const inlineSource=fs.readFileSync(path.join(ROOT,'inline-bot.mjs'),'utf8');
const runtimeSource=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const daemonSource=fs.readFileSync(path.join(ROOT,'daemon.mjs'),'utf8');
const secretsSource=fs.readFileSync(path.join(ROOT,'secrets.mjs'),'utf8');
const botFactorySource=fs.readFileSync(path.join(ROOT,'bot-factory.mjs'),'utf8');
const pairingSource=fs.readFileSync(path.join(ROOT,'pairing.mjs'),'utf8');
const menuSource=fs.readFileSync(path.join(ROOT,'menu.mjs'),'utf8');
const styleSource=fs.readFileSync(path.join(ROOT,'styles.mjs'),'utf8');
const themeSource=fs.readFileSync(path.join(ROOT,'theme-ui.mjs'),'utf8');
const generatedStyles=JSON.parse(fs.readFileSync(path.join(ROOT,'generated','dipper-styles.json'),'utf8'));

assert.match(inlineSource,/bot\.command\('menu'/,'/menu handler must exist');
assert.match(inlineSource,/bot\.command\('help'/,'/help handler must exist');
assert.match(inlineSource,/ctx\.callbackQuery\.inline_message_id\|\|ctx\.callbackQuery\.message/,'callbacks must support inline and direct bot messages');
assert.match(inlineSource,/article-portable/,'inline fallback must preserve an interactive article result');
assert.match(inlineSource,/article-no-artwork/,'inline menu must survive artwork preview failures');
assert.match(inlineSource,/text-no-artwork/,'direct menu must survive artwork preview failures');
assert.match(inlineSource,/\['no-artwork'/,'callback edits must retry without artwork');
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
assert.match(runtimeSource,/runtimeBotUsername\(\)/,'runtime must resolve the inline bot identity on every worker');
assert.match(runtimeSource,/export function runtimeConnectionFor\(/,'runtime must expose a connected restored account for NexAI bot recovery');
assert.match(daemonSource,/async function recoverInlineBotAfterRestore\(\)/,'startup must recover a missing NexAI bot token after restoring accounts');
assert.match(daemonSource,/runtimeConnectionFor\(cfg\.creatorUsername\)\|\|runtimeConnectionFor\(''\)/,'token recovery must prefer the configured owner runtime');
assert.match(daemonSource,/made\.recovered\?'recovered'/,'a recovered BotFather token must start the inline bot, not only a newly created bot');
assert.match(daemonSource,/if\(cfg\.coordinator&&!PAIRING_ONLY&&!hadBotToken\)[\s\S]*recoverInlineBotAfterRestore\(\)/,'startup must retry inline bot setup after restored sessions are available');
assert.match(runtimeSource,/runtimeBotUsername\(\{refresh:true\}\)/,'inline transport must refresh a stale bot username before degrading');
assert.match(runtimeSource,/sharedBotIdentity\(\)/,'runtime workers must be able to recover the NexAI bot identity from shared storage');
assert.match(inlineSource,/saveSharedBotIdentity/,'the coordinator must persist the verified NexAI bot identity for other workers');
assert.match(inlineSource,/function schedulePollerSupervisor\(/,'inline polling must have a recovery supervisor');
assert.match(inlineSource,/pollerSupervisorStopping/,'intentional shutdown must be distinguished from an unexpected poller stop');
assert.match(inlineSource,/polling stopped unexpectedly · scheduling recovery/,'an unexpected long-poll stop must schedule automatic recovery');
assert.match(inlineSource,/standby · another NexAccount worker owns/,'standby workers must recognize the distributed poller lease');
assert.match(inlineSource,/schedulePollerSupervisor\(pollerRestartDelay\(\)\)/,'standby or failed pollers must retry takeover after the lease changes');
assert.match(secretsSource,/api\.telegram\.org\/bot.*\/getMe/,'bot username resolver must verify identity through Telegram getMe');
assert.match(secretsSource,/BOT_TOKEN_RECORD_ID='nexai_bot_token'/,'NexAI bot token must have a durable system-store record');
assert.match(secretsSource,/collection\('nexaccount_system'\)/,'NexAI bot token must survive release directory replacement through shared storage');
const knownRecoveryIndex=botFactorySource.indexOf('const knownUsername=');
const premiumCreationGateIndex=botFactorySource.indexOf("if(account?.premium!==true)return {created:false,reason:'premium_owner_required'};");
assert.ok(knownRecoveryIndex>=0&&premiumCreationGateIndex>knownRecoveryIndex,'existing NexAI bot recovery must happen before the Telegram Premium creation gate');
assert.match(pairingSource,/Command: menu/,'new accounts must be instructed to use bare menu');
assert.match(pairingSource,/Commande : menu/,'French pairing instructions must use bare menu');
assert.ok(pairingSource.indexOf('await handler?.(client,saved);')<pairingSource.indexOf("await client.sendMessage('me',{message:savedMessage})"),'runtime must attach before the pairing success message is sent');
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

const headerSignatures=new Set();
for(let style=1;style<=31;style++){
  const model=await menuModel({
    account:{telegramUserId:'770000',username:'header_probe',firstName:'Header',premium:true},
    settings:{style,prefix:'§',language:'fr',botDisplayName:'NexAi'},
    commands:registry,
    includeArtwork:false
  });
  const lines=model.text.split('\n');
  assert.ok(lines.length>=5&&lines.length<=7,'style '+style+' header must stay compact');
  assert.ok(model.text.length<=420,'style '+style+' header is too verbose for Telegram');
  assert.ok(model.text.includes('@header_probe'),'style '+style+' header must use the active session identity');
  assert.ok(model.text.includes('§'),'style '+style+' header must use the active session prefix');
  assert.ok(model.entities.some(x=>x.type==='blockquote'&&x.offset===0),'style '+style+' home header must be a real Telegram quote');
  headerSignatures.add(model.text);
}
assert.equal(headerSignatures.size,31,'all 31 styles must keep visually distinct headers');
assert.doesNotMatch(menuSource,/tresor20009/i,'menu UI must never hardcode a specific Telegram session username');
assert.doesNotMatch(themeSource,/tresor20009/i,'theme UI must never hardcode a specific Telegram session username');

assert.match(styleSource,/INLINE_PHOTO_MAX_BYTES=5\*1024\*1024/,'inline photo size guard missing');
assert.match(styleSource,/image\/jpeg/,'inline artwork must validate JPEG content');
assert.match(styleSource,/CHARACTER_ARTWORK/,'missing character artwork fallback map');
assert.match(styleSource,/2:'Naruto Uzumaki'/,'Naruto artwork fallback missing');
assert.match(styleSource,/31:'Benimaru Shinmon'/,'late character artwork fallbacks must cover style 31');
assert.match(styleSource,/for\(let start=0;start<urls\.length;start\+=4\)[\s\S]*const character=await characterArtwork\(key\)/,'character fallback must run after bundled/configured artwork is exhausted');
assert.match(styleSource,/NEXAI_STYLE_.*_IMAGE_URLS/,'per-style artwork environment overrides missing');
assert.equal(generatedStyles.themes?.['6']?.name,'Ai Hoshino','style 6 character name must be correct');
assert.equal(generatedStyles.themes?.['7']?.name,'Ruby Hoshino','style 7 character name must be correct');
assert.equal(generatedStyles.themes?.['26']?.name,'Soshiro Hoshina','style 26 character name must be correct');

const emojiModel=await menuModel({
  account:{telegramUserId:'7788',username:'emoji_test',firstName:'Emoji',premium:true},
  settings:{
    style:2,prefix:'.',language:'fr',
    customEmojiIds:{
      NEXAI_EMOJI_STYLE_2:'5368324170671202286',
      NEXAI_EMOJI_ANIME:'5368324170671202287'
    }
  },
  commands:registry,
  view:'category',
  category:'ANIME',
  includeArtwork:false
});
assert.ok(emojiModel.entities.filter(x=>x.type==='custom_emoji').length>=2,'style/category custom emoji entities must activate when validated session IDs are configured');

const overlapModel=await menuModel({
  account:{telegramUserId:'7799',username:'ruby_test',firstName:'Ruby',premium:true},
  settings:{
    style:7,prefix:'.',language:'fr',
    customEmojiIds:{
      NEXAI_EMOJI_STYLE_7:'5368324170671202290',
      NEXAI_EMOJI_ANIME:'5368324170671202291'
    }
  },
  commands:registry,
  view:'category',
  category:'ANIME',
  includeArtwork:false
});
const emojiRanges=overlapModel.entities
  .filter(x=>x.type==='custom_emoji')
  .map(x=>x.offset+':'+x.length);
assert.equal(new Set(emojiRanges).size,emojiRanges.length,'custom emoji entity ranges must never overlap exactly');

const sessionEmojiModel=await menuModel({
  account:{telegramUserId:'7800',username:'session_emoji',firstName:'Session',premium:true},
  settings:{
    style:2,prefix:'.',language:'fr',
    customEmojiIds:{
      NEXAI_EMOJI_STYLE_2:'5368324170671202300',
      NEXAI_EMOJI_ANIME:'5368324170671202301'
    }
  },
  commands:registry,
  view:'category',
  category:'ANIME',
  includeArtwork:false
});
const sessionEmojiIds=sessionEmojiModel.entities
  .filter(x=>x.type==='custom_emoji')
  .map(x=>x.custom_emoji_id);
assert.ok(sessionEmojiIds.includes('5368324170671202300'),'session style custom emoji ID must override environment defaults');
assert.ok(sessionEmojiIds.includes('5368324170671202301'),'session category custom emoji ID must be applied');

const normalFallbackModel=await menuModel({
  account:{telegramUserId:'7801',username:'normal_fallback',firstName:'Fallback',premium:false},
  settings:{style:2,prefix:'.',language:'fr',customEmojiIds:{}},
  commands:registry,
  view:'category',
  category:'ANIME',
  includeArtwork:false
});
assert.ok(normalFallbackModel.text.includes('🍃'),'missing animated style emoji must fall back to the normal style emoji');
assert.ok(normalFallbackModel.text.includes('🌸'),'missing animated category emoji must fall back to the normal category emoji');
assert.equal(normalFallbackModel.entities.some(x=>x.type==='custom_emoji'),false,'normal emoji fallback must not invent custom emoji entities');

const normalFallbackHome=await menuModel({
  account:{telegramUserId:'7802',username:'normal_button_fallback',firstName:'Fallback',premium:false},
  settings:{style:1,prefix:'.',language:'fr',customEmojiIds:{}},
  commands:registry,
  includeArtwork:false
});
assert.ok(
  normalFallbackHome.reply_markup.inline_keyboard.flat().some(button=>/^🏠\s/.test(String(button.text||''))),
  'menu buttons must use a normal emoji when no animated custom emoji ID is available'
);

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

const homeOne=await menuModel({
  account:{telegramUserId:'6601',username:'layout_test',firstName:'Layout',premium:true},
  settings:{style:1,prefix:'.',language:'fr'},
  commands:registry,
  includeArtwork:false
});
const homeLast=await menuModel({
  account:{telegramUserId:'6601',username:'layout_test',firstName:'Layout',premium:true},
  settings:{style:31,prefix:'.',language:'fr'},
  commands:registry,
  includeArtwork:false
});
const callbackLayout=model=>model.reply_markup.inline_keyboard.map(row=>row.map(b=>b.callback_data||('url:'+b.url)));
assert.deepEqual(callbackLayout(homeOne),callbackLayout(homeLast),'changing style must never move or reorder menu buttons');
assert.ok(homeOne.reply_markup.inline_keyboard.every(row=>row.length>=1&&row.length<=2),'Telegram home keyboard rows must stay compact and aligned');

const categoryCta=await menuModel({
  account:{telegramUserId:'6602',username:'cta_test',firstName:'CTA',premium:true},
  settings:{style:1,prefix:'.',language:'fr'},
  commands:registry,
  view:'category',category:'TOOLS',
  includeArtwork:false
});
assert.ok(categoryCta.reply_markup.inline_keyboard.some(row=>row.some(b=>b.url&&String(b.url).includes('t.me'))),'category replies must keep a Nextech URL button when configured');
assert.equal(categoryCta.reply_markup.inline_keyboard[0].length,1,'category back button must keep its own stable row');





console.log('menu resilience regression tests: ok');
