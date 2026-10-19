import test from 'node:test';
import assert from 'node:assert/strict';
import {backoffMs,candidateIsDue,registerCandidateFailure,queuedWhatsappRetry} from './tiktok-retry-policy.mjs';

test('first failure postpones, never marks video as published',()=>{
 const failed={},seen=[];
 const row=registerCandidateFailure(failed,'01234567890123456789',new Error('yt-dlp error'),{now:1000});
 assert.equal(row.count,1);
 assert.equal(row.nextAttemptAt,301000);
 assert.equal(candidateIsDue('01234567890123456789',failed,1000),false);
 assert.equal(candidateIsDue('01234567890123456789',failed,301000),true);
 assert.deepEqual(seen,[]);
});
test('fourth failure remains eligible later, not permanently quarantined',()=>{
 const failed={};for(let i=0;i<4;i++)registerCandidateFailure(failed,'id','error',{now:i*1000});
 assert.equal(failed.id.count,4);
 assert.equal(candidateIsDue('id',failed,failed.id.nextAttemptAt),true);
});
test('backoff caps reasonably',()=>{
 assert.equal(backoffMs(1),300000);
 assert.equal(backoffMs(100),12*3600000);
});
test('WhatsApp mirror failures remain pending with a future retry',()=>{
 const entry={id:'q1',attempts:19,telegramMessageId:7};
 const next=queuedWhatsappRetry(entry,{now:100000});
 assert.equal(next.attempts,20);
 assert.ok(next.nextAttemptAt>100000);
 assert.equal(next.telegramMessageId,7);
});
