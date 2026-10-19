import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyOtakuPost,formatOtakuTelegramRelay} from './otaku-relay-style.mjs';
test('news remains factual with no invented date',()=>{
 const origin='Saison 3 annoncée. Date encore inconnue. Source : https://example.org/news';
 const post=formatOtakuTelegramRelay(origin,{media:[{type:'photo'}]});
 assert.match(post,/Saison 3 annoncée\. Date encore inconnue/);
 assert.match(post,/https:\/\/example.org\/news/);
 assert.doesNotMatch(post,/2026|Prime Video/);
 assert.match(post,/#OtakuNexus/);
});
test('reformatted sticker packs preserve old creator credit',()=>{
 const original='PACK DE STICKERS — Saitama\nCreator : THE GOD OF DEATH';
 assert.equal(classifyOtakuPost(original),'stickers');
 assert.match(formatOtakuTelegramRelay(original),/Creator : THE GOD OF DEATH/);
});
test('never touch non-Otaku Nexus channel sources',()=>{
 const original='LUXURY LIFE\nLamborghini';
 assert.equal(formatOtakuTelegramRelay(original,{source:'tresor_universe'}),original);
});
test('respects existing styled Otaku posts',()=>{
 const original='╭━━━━━━━━╮\n#OtakuNexus';
 assert.equal(formatOtakuTelegramRelay(original),original);
});
