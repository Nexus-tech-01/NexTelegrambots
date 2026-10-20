import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  fallbackWishlistCandidate,
  isMixedPackMeta,
  packLooksCharacterSpecific,
  stickGoodPackName,
  stickGoodPresentation,
  wishlistText
} from './stick-good-core.mjs';

assert.equal(
  stickGoodPackName('Satoru Gojo'),
  'ঔৣ𝐒𝐓𝐈𝐂𝐊 𝐆𝐎𝐎𝐃ঔৣ♫  ݁  ݂ 𝐒𝐀𝐓𝐎𝐑𝐔 𝐆𝐎𝐉𝐎'
);
assert.match(stickGoodPresentation('Katherine Pierce'),/𝒯𝓇𝑒́𝓈𝑜𝓇/);
assert.match(stickGoodPresentation('Katherine Pierce'),/KATHERINE PIERCE/);
assert.match(wishlistText(),/𝐖𝐈𝐒𝐇 𝐋𝐈𝐒𝐓/);
assert.equal(isMixedPackMeta('random anime mix pack'),true);
assert.equal(packLooksCharacterSpecific('Satoru Gojo',{title:'Gojo Satoru stickers',setName:'gojo_pack'}),true);
assert.equal(packLooksCharacterSpecific('Satoru Gojo',{title:'Anime mix',setName:'random_stickers'}),false);
assert.equal(fallbackWishlistCandidate('Gojo stp').valid,true);
assert.equal(fallbackWishlistCandidate('bonjour').valid,false);
assert.equal(fallbackWishlistCandidate('Gojo est meilleur que Sukuna').valid,false);

const manager=fs.readFileSync(new URL('./stick-good-manager.mjs',import.meta.url),'utf8');
for(const required of [
  "2*60*60_000",
  "12*60*60_000",
  "AUTOS_BEFORE_WISHLIST",
  "STICKER_SOURCES",
  "supremacy_sticks",
  "Leonild",
  "stickerspackanime",
  "stickeranimepack",
  "visuallyMatches",
  "downloadTelegramSet",
  "buildPinterestPack",
  "pinterest_verified_stickers_",
  "MAX_STICKERS=30",
  "stickGoodPresentation",
  "stickGoodPackName",
  "kind:'question'",
  "kind:'pack'",
  "/question-response",
  "requestCount",
  "activeWishlist"
]) assert.ok(manager.includes(required),'manager missing '+required);

assert.match(manager,/async function visuallyMatches\(character,filePath\)/);
assert.match(manager,/Identifie indépendamment le personnage principal visible/);
assert.match(manager,/if\(!\(await visuallyMatches\(character,target\)\)\)continue;/);
assert.doesNotMatch(manager,/Do not make a whole valid Telegram pack depend on the external vision service/);

console.log('STICK_GOOD_CONTRACT_OK');

const autoStart=manager.indexOf('async function canonicalAutoChoice(state){');
const autoEnd=manager.indexOf('async function botApi(',autoStart);
assert.ok(autoStart>=0&&autoEnd>autoStart);
const autoChoice=vm.runInNewContext(
 manager.slice(autoStart,autoEnd)+'\ncanonicalAutoChoice',
 {
  aiJson:async()=>{throw new Error('AI temporarily offline')},
  clean:v=>String(v??'').trim(),
  rand:rows=>rows[0],
  STICK_GOOD_MOODS:['friendly'],
  AUTO_CHARACTERS:[{name:'Gojo Satoru',medium:'anime'}],
  canonicalDisplayName:v=>String(v),
  console:{warn:()=>{}}
 }
);
const recovered=await autoChoice({recent:[]});
assert.equal(recovered.character,'Gojo Satoru');
assert.equal(recovered.medium,'anime');
assert.match(manager,/job\.nextAttemptAt=Date\.now\(\)/);
assert.match(manager,/type:'wishlist-error'/);
