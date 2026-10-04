import assert from 'node:assert/strict';
import { commandMap } from '../commands.mjs';
import { menuModel } from '../menu.mjs';
import { canHandlePremiumCommand, __test as premiumEngineTest } from '../premium-engine.mjs';
import { cfg, isAdminIdentity, isAdminUsername } from '../config.mjs';

const commands=commandMap();

assert.ok(cfg.adminUsernames.includes('josh_33_06'),'Josh must remain in the NexAI administrator allowlist');
assert.equal(isAdminUsername('@josh_33_06'),true,'Josh username must resolve as NexAI administrator');
assert.equal(isAdminIdentity('', 'josh_33_06'),true,'Josh must inherit owner/admin command routing');
assert.equal(isAdminIdentity('', 'random_user'),false,'Unlisted users must not inherit NexAI admin access');

const tg=commands.get('customreact');
assert.equal(tg.telegramPremium,true,'customreact must require Telegram Premium');
assert.notEqual(tg.nexaiPremium,true,'Telegram Premium commands must not require NexAI Premium');

for(const name of ['waifuhd','cosplayvip','amvhd','openingvip']){
  const cmd=commands.get(name);
  assert.equal(cmd.nexaiPremium,true,name+' must require NexAI Premium');
  assert.notEqual(cmd.telegramPremium,true,name+' must not require Telegram Premium');
}

const premiumPowers=['autopilot','botforge','webapp','mirror','vault','watch','nexstudio','research','build','memory'];
for(const name of premiumPowers){
  const cmd=commands.get(name);
  assert.ok(cmd,name+' must be registered');
  assert.equal(cmd.category,'PREMIUM',name+' must live in the Premium category');
  assert.equal(cmd.nexaiPremium,true,name+' must require NexAI Premium');
  assert.equal(cmd.engine,'premium',name+' must use the premium engine');
  assert.equal(canHandlePremiumCommand(name),true,name+' must have a premium engine handler');
}
assert.equal(premiumEngineTest.parseIntervalMs('chaque 15 minutes'),15*60*1000);
assert.equal(premiumEngineTest.extractUrls('watch https://example.com now')[0],'https://example.com');

const clone=commands.get('clonepack');
assert.notEqual(clone.nexaiPremium,true,'clonepack stays available to Free users under quota');
assert.notEqual(clone.telegramPremium,true,'clonepack must not depend on Telegram Premium');

const settings={
  language:'fr',
  style:1,
  prefix:'.',
  botDisplayName:'NexAi',
  menuImageUrl:'',
  menuImageStyle:0,
  customEmojiIds:{}
};
const baseAccount={
  telegramUserId:'9876543210123',
  username:'premium_test',
  firstName:'Premium',
  lastName:'Test',
  premium:false,
  telegramPremium:false,
  nexaiPremium:false
};

const premiumMenu=await menuModel({
  account:baseAccount,
  settings,
  commands,
  view:'category',
  category:'PREMIUM',
  includeArtwork:false
});
assert.match(premiumMenu.text,/\/Waifuhd/i,'Premium category must aggregate NexAI Premium commands');
assert.match(premiumMenu.text,/\/Autopilot/i,'Premium category must expose NexAI Premium Powers');
assert.match(premiumMenu.text,/\/Customreact/i,'Premium category must include Telegram Premium commands');
assert.ok(
  premiumMenu.reply_markup.inline_keyboard.flat().some(button=>String(button.callback_data||'')==='premium:buy'),
  'Free users must see the 250 Stars Premium purchase button'
);

const animeMenu=await menuModel({
  account:baseAccount,
  settings,
  commands,
  view:'category',
  category:'ANIME',
  includeArtwork:false
});
assert.match(animeMenu.text,/\/Waifuhd[^\n]*👑/i,'Premium commands remain visible and marked in their original category');

const paidMenu=await menuModel({
  account:{...baseAccount,nexaiPremium:true},
  settings,
  commands,
  view:'category',
  category:'PREMIUM',
  includeArtwork:false
});
assert.ok(
  !paidMenu.reply_markup.inline_keyboard.flat().some(button=>String(button.callback_data||'')==='premium:buy'),
  'Active NexAI Premium users must not see a redundant purchase button'
);

console.log('NexAI Premium separation checks passed');
