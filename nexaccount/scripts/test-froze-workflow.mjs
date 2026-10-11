import assert from 'node:assert/strict';
import {
  frozeMailConfig, composeFrozeEmail, publicFrozeStatus, trySubmitCase
} from '../froze-workflow.mjs';

const mockEnv={
  NEXAI_REPORT_RESEND_API_KEY:'re_test_123',
  NEXAI_REPORT_FROM:'NexAi Reports <reports@example.org>',
  NEXAI_REPORT_REPLY_TO:'me@example.org'
};
assert.equal(frozeMailConfig({}).configured,false);
assert.equal(frozeMailConfig({...mockEnv,NEXAI_REPORT_FROM:''}).configured,false);
assert.equal(frozeMailConfig(mockEnv).to,'abuse@telegram.org');
assert.equal(frozeMailConfig(mockEnv).configured,true);
const mail=composeFrozeEmail({
  username:'@ExampleAcc',
  reasons:['froze','froze_spam','froze_hate'],
  notes:['Observé le 10 octobre vers 14h puis effacé']
});
assert.equal(mail.to,'abuse@telegram.org');
assert.ok(mail.text.includes('https://t.me/ExampleAcc'));
assert.ok(mail.text.includes('Observé le 10 octobre'));
assert.ok(mail.text.includes('déclarées'));
assert.ok(!mail.text.includes('Statut : brouillon uniquement'));
assert.ok(!mail.text.includes('compte a été gelé'));
assert.ok(publicFrozeStatus({username:'@ExampleAcc',status:'submitted',reasons:['froze']},true).includes('pas une confirmation de modération'));

let record={_id:'owner:@exampleacc',username:'@ExampleAcc',reasons:['froze'],status:'queued',notes:[]};
let networkCalls=0,dbUpdates=0;
const collection={
  async findOneAndUpdate(filter,update){
    if(record.status!==filter.status)return null;
    record={...record,status:update.$set.status,attemptCount:(record.attemptCount||0)+1};
    return {...record};
  },
  async updateOne(filter,update){
    dbUpdates++;
    record={...record,...update.$set};
    return {modifiedCount:1};
  }
};
const fakeFetch=async(url,options)=>{
  networkCalls++;
  assert.equal(url,'https://api.resend.com/emails');
  assert.equal(options.headers['Idempotency-Key'],'nexai-froze-owner:exampleacc');
  const message=JSON.parse(options.body);
  assert.deepEqual(message.to,['abuse@telegram.org']);
  assert.equal(message.reply_to,'me@example.org');
  return {ok:true,json:async()=>({id:'mail-test-1'})};
};
let submission=await trySubmitCase(record._id,{collection,fetchImpl:fakeFetch,env:mockEnv});
assert.equal(submission.status,'submitted');
assert.equal(record.status,'submitted');
assert.equal(record.providerId,'mail-test-1');
assert.equal(networkCalls,1);
submission=await trySubmitCase(record._id,{collection,fetchImpl:fakeFetch,env:mockEnv});
assert.equal(submission.status,'already_claimed_or_finished');
assert.equal(networkCalls,1);
assert.equal(dbUpdates,1);

record={_id:'owner:@otheracc',username:'@OtherAcc',reasons:['froze_hack'],status:'queued'};
const refused=await trySubmitCase(record._id,{collection,fetchImpl:async()=>({ok:false,status:403}),env:mockEnv});
assert.equal(refused.status,'delivery_failed');
assert.equal(record.status,'delivery_failed');
assert.equal(networkCalls,1);
record={_id:'owner:@lostacc',username:'@LostAcc',reasons:['froze'],status:'queued'};
const uncertain=await trySubmitCase(record._id,{collection,fetchImpl:async()=>{throw Error('network interrupted')},env:mockEnv});
assert.equal(uncertain.status,'delivery_uncertain');
assert.equal(record.status,'delivery_uncertain');
assert.ok(publicFrozeStatus(record,true).includes('aucune relance automatique'));

console.log('froze single-send + provider tracking tests passed');
