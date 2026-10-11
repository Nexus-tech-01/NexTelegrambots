import assert from 'node:assert/strict';
import {
  UNFREEZE_TYPES, UNFREEZE_TYPES_LIST, unfreezeUsage, parseUnfreezeCaseArgs, appealDraft
} from '../unfreeze-platforms.mjs';
import {
  createUnfreezeCase, statusUnfreezeCase, listUnfreezeCases, markUnfreezeCase, reconcileUnfreezeCases
} from '../unfreeze-workflow.mjs';

assert.deepEqual(UNFREEZE_TYPES_LIST,[
  'tg_account','tg_channel','tg_group','wa_account',
  'wa_group','wa_channel','tiktok_account','facebook_account'
]);
for(const kind of UNFREEZE_TYPES_LIST){
  assert.ok(UNFREEZE_TYPES[kind].portal.startsWith('https://'));
  assert.ok(UNFREEZE_TYPES[kind].steps.length>45);
  const parsed=parseUnfreezeCaseArgs(kind+' @TestAccount10 Suspension contestée le 10 octobre');
  assert.equal(parsed.ok,true,kind);
  assert.ok(appealDraft(parsed).includes('@TestAccount10'));
}
assert.equal(parseUnfreezeCaseArgs('unknown @foobar').ok,false);
assert.equal(parseUnfreezeCaseArgs('tg_account <html>').ok,false);
assert.ok(unfreezeUsage().includes('unfreeze_approved'));
assert.ok(!unfreezeUsage().includes('unfreeze_result'));
const stored=new Map();
const sampleCollection={
  async updateOne(filter,update,options={}){
    let row=stored.get(filter._id);
    if(!row){
      if(!options.upsert)return {modifiedCount:0};
      row={...update.$setOnInsert};
      stored.set(filter._id,row);
      return {modifiedCount:0,upsertedCount:1};
    }
    if(filter.ownerId&&row.ownerId!==filter.ownerId)return {modifiedCount:0};
    if(filter.state?.$in&&!filter.state.$in.includes(row.state))return {modifiedCount:0};
    Object.assign(row,update.$set||{});
    return {modifiedCount:1};
  },
  async findOne(filter){
    const row=stored.get(filter._id);
    return row&&(!filter.ownerId||filter.ownerId===row.ownerId)?{...row}:null;
  },
  find(filter){
    const rows=[...stored.values()].filter(x=>x.ownerId===filter.ownerId);
    return {sort(){return this},limit(){return this},async toArray(){return rows}};
  },
  async updateMany(filter,update){
    let modifiedCount=0;
    for(const row of stored.values()){
      if(row.state===filter.state&&row.reviewDueAt<=filter.reviewDueAt.$lte){
        Object.assign(row,update.$set);
        modifiedCount++;
      }
    }
    return {modifiedCount};
  }
};
const opts={collection:sampleCollection};
const raw='wa_group https://chat.whatsapp.com/Example Suspended after an unexpected admin change';
const first=await createUnfreezeCase({ownerId:42,raw},opts);
assert.ok(first.includes('Groupe WhatsApp'));
assert.ok(first.includes('non transmis'));
assert.ok(first.includes('Seul un administrateur'));
const same=await createUnfreezeCase({ownerId:42,raw},opts);
assert.equal(stored.size,1,'the same owner/platform/id must not create duplicate cases');
assert.equal(same,first);
const noAccess=await statusUnfreezeCase('intruder', 'wa_group https://chat.whatsapp.com/Example',opts);
assert.ok(noAccess.includes('introuvable'));
const marked=await markUnfreezeCase({ownerId:42,raw:'wa_group https://chat.whatsapp.com/Example',action:'sent'},opts);
assert.ok(marked.includes('Dépôt enregistré'));
assert.ok(marked.includes('non vérifié'));
const repeat=await markUnfreezeCase({ownerId:42,raw:'wa_group https://chat.whatsapp.com/Example',action:'sent'},opts);
assert.ok(repeat.includes('Aucune transition'));
assert.equal((await reconcileUnfreezeCases({...opts,now:new Date(Date.now()+30*60*1000)})).needsManualReview,0);
assert.equal((await reconcileUnfreezeCases({...opts,now:new Date(Date.now()+25*60*60*1000)})).needsManualReview,1);
assert.equal((await reconcileUnfreezeCases({...opts,now:new Date(Date.now()+26*60*60*1000)})).needsManualReview,0);
const updated=await markUnfreezeCase({ownerId:42,raw:'wa_group https://chat.whatsapp.com/Example',action:'approved'},opts);
assert.ok(updated.includes('Décision favorable'));
assert.ok((await listUnfreezeCases(42,opts)).includes('Groupe WhatsApp'));
assert.ok((await listUnfreezeCases(42,opts)).includes('Réactivation confirmée'));
const forbidden=await markUnfreezeCase({ownerId:42,raw:'wa_group https://chat.whatsapp.com/Example',action:'rejected'},opts);
assert.ok(forbidden.includes('Aucune transition'));
console.log('NexAI unfreeze eight-platform appeal case tests passed');
