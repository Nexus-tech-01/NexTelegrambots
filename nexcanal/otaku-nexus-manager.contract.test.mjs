import assert from 'node:assert/strict';
import fs from 'node:fs';

const manager=fs.readFileSync(new URL('./otaku-nexus-manager.mjs',import.meta.url),'utf8');
const publisher=fs.readFileSync(new URL('../whatsapp-publisher/server.mjs',import.meta.url),'utf8');

assert.ok(manager.includes('function packLooksCharacterSpecific('),'character-specific pack validator missing');
assert.ok(manager.includes('function isMixedPackMeta('),'mixed-pack rejection missing');
assert.ok(!manager.includes("const generic=searched.length>=4?[]:await publicStickerSetNames('');"),'generic pack fallback must stay disabled');
assert.ok(manager.includes('buildWastickersFile(canonical,stickers,dir)'),'wastickers archive build missing');
assert.ok(manager.includes("throw new Error('otaku_image_required:'"),'text-only image fallback must stay disabled');
assert.ok(manager.includes("options:['✅ Déjà vu','📌 Dans ma liste','👀 Pas encore']"),'recommendation response choices missing');
assert.ok(manager.includes("correctAnswer:m.name"),'mystery answer session missing');

const packStart=publisher.indexOf("if(kind==='pack')");
const packEnd=publisher.indexOf("if(kind==='quiz_results')",packStart);
assert.ok(packStart>=0&&packEnd>packStart,'publisher pack handler missing');
const packBlock=publisher.slice(packStart,packEnd);
assert.ok(packBlock.includes('document:src'),'pack must be sent as one document');
assert.ok(packBlock.includes('.wastickers'),'wastickers filename requirement missing');
assert.ok(!packBlock.includes('{sticker:src}'),'individual sticker flood must stay disabled');
assert.ok(!packBlock.includes('for(const sticker of stickers)'),'pack handler must not loop over individual stickers');

console.log('Otaku Nexus coherence contract: ok');
