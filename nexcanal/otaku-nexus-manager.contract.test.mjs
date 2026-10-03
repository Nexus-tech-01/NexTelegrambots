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
assert.ok(manager.includes('function stablePick('),'deterministic retry selection missing');
assert.ok(manager.includes('function timeWindowDue('),'interactive session catch-up window missing');
assert.ok(manager.includes('timeWindowDue(16,0,4*60)'),'choice-session restart catch-up missing');
assert.ok(manager.includes('timeWindowDue(quizHour,0,3*60)'),'quiz-session restart catch-up missing');

const packStart=publisher.indexOf("if(kind==='pack')");
const packEnd=publisher.indexOf("if(kind==='quiz_results')",packStart);
assert.ok(packStart>=0&&packEnd>packStart,'publisher pack handler missing');
const packBlock=publisher.slice(packStart,packEnd);
assert.ok(packBlock.includes('document:src'),'pack must be sent as one document');
assert.ok(packBlock.includes('.wastickers'),'wastickers filename requirement missing');
assert.ok(!packBlock.includes('{sticker:src}'),'individual sticker flood must stay disabled');
assert.ok(!packBlock.includes('for(const sticker of stickers)'),'pack handler must not loop over individual stickers');
assert.ok(publisher.includes('ensurePublisherSupervisor'),'WhatsApp publisher self-supervisor missing');
assert.ok(publisher.includes("--restart-supervisor"),'WhatsApp publisher restart entrypoint missing');
const textSendStart=publisher.indexOf('async function sendNewsletterTextDirect');
const textSendEnd=publisher.indexOf('function safeOtakuLocalPath',textSendStart);
assert.ok(textSendStart>=0&&textSendEnd>textSendStart,'newsletter text sender missing');
const textSendBlock=publisher.slice(textSendStart,textSendEnd);
assert.ok(textSendBlock.includes("socket.sendMessage(jid,{text:value})"),'newsletter text must use the standard WhatsApp send path');
assert.ok(textSendBlock.includes("Newsletter text send returned no message id"),'newsletter text must fail closed when no real message id is returned');
assert.ok(!textSendBlock.includes('socket.sendNode('),'raw newsletter sendNode path must stay disabled');

assert.ok(publisher.includes("const OTAKU_ACTION_LEDGER_FILE='otaku-action-ledger.json'"),'durable Otaku action ledger missing');
assert.ok(publisher.includes('function reserveOtakuAction(raw={})'),'Otaku send reservation guard missing');
assert.ok(publisher.includes("'Otaku duplicate publication blocked'"),'duplicate blocking log missing');
assert.ok(publisher.includes('function loadOtakuDurableState()'),'Otaku durable state restore missing');
assert.ok(publisher.includes("proto.Message.decode(Buffer.from(String(row.messageB64),'base64'))"),'poll creation message binary restore missing');
assert.ok(publisher.includes("options:Array.isArray(r.options)?r.options:[]"),'poll options persistence missing');
assert.ok(publisher.includes('messageB64'),'poll message binary persistence missing');
assert.ok(publisher.includes('function otakuActionMediaFingerprint('),'exact media fingerprint dedup missing');
assert.ok(publisher.includes("reason:'media'"),'duplicate media blocking path missing');
assert.ok(publisher.includes("const votes={...(record?.votes||{})}"),'poll vote aggregation must preserve restored votes');
assert.ok(publisher.includes('releaseOtakuAction(claim)'),'failed sends must release their dedup reservation');

console.log('Otaku Nexus coherence contract: ok');
