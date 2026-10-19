import test from 'node:test';
import assert from 'node:assert/strict';
import {mayAttemptQueueJob,isStalePending,queuedBacklogStats} from './queue-safety.mjs';
const now=Date.parse('2026-10-19T20:00:00Z');
const old={status:'pending',createdAt:'2026-10-10T11:00:00Z',nextAttemptAt:0};
const fresh={status:'pending',createdAt:'2026-10-19T19:00:00Z',nextAttemptAt:0};
test('old pending message is held, not marked failed or discarded',()=>{
 assert.ok(isStalePending(old,{now}));
 assert.equal(mayAttemptQueueJob(old,{now}),false);
 assert.equal(old.status,'pending');
 assert.equal(mayAttemptQueueJob(old,{now,allowStale:true}),true);
});
test('fresh posts respect outbound backpressure',()=>{
 assert.equal(mayAttemptQueueJob(fresh,{now,nextAllowedAt:now+5000}),false);
 assert.equal(mayAttemptQueueJob(fresh,{now,nextAllowedAt:now-1}),true);
});
test('stats separate stale and ready without mutation',()=>{
 assert.deepEqual(queuedBacklogStats([old,fresh],{now}),{pending:2,stale:1,ready:1});
});
