import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalEventId,
  canonicalSourceEvent,
  enqueueSourceEvent,
  hasEvent,
  markEventCompleted,
  normalizeInterrouteState,
  normalizeQueueItem,
  pruneCompleted
} from './internal-event-core.mjs';

test('canonical ids are stable and normalized',()=>{
  assert.equal(canonicalEventId(' LiteAPKs ',42),'telegram:liteapks:42');
  assert.equal(canonicalSourceEvent('iMadeAux',7).source.key,'imadeaux');
});

test('legacy queue items migrate to canonical events',()=>{
  const st={queue:[{key:'liteapks:42',source:'liteapks',id:42,addedAt:10}],completed:[]};
  normalizeInterrouteState(st);
  assert.equal(st.queue.length,1);
  assert.equal(st.queue[0].key,'telegram:liteapks:42');
  assert.equal(st.queue[0].event.schema,'nex.interroute.source.v1');
});

test('enqueue is idempotent across queued and completed events',()=>{
  const st={queue:[],completed:[]};
  assert.ok(enqueueSourceEvent(st,'liteapks',99,{now:1000}));
  assert.equal(enqueueSourceEvent(st,'liteapks',99,{now:1100}),null);
  const item=st.queue[0];
  assert.equal(hasEvent(st,'liteapks',99),true);
  assert.equal(markEventCompleted(st,item,{now:1200}),true);
  assert.equal(st.queue.length,0);
  assert.equal(st.completed[0].eventId,'telegram:liteapks:99');
  assert.equal(enqueueSourceEvent(st,'liteapks',99,{now:1300}),null);
});

test('completed registry is pruned by ttl and limit',()=>{
  const st={queue:[],completed:[
    {eventId:'telegram:x:1',completedAt:1},
    {eventId:'telegram:x:2',completedAt:1000},
    {eventId:'telegram:x:3',completedAt:1100}
  ]};
  pruneCompleted(st,{now:1200,ttlMs:100,limit:100});
  assert.deepEqual(st.completed.map(x=>x.eventId),['telegram:x:3']);
});

test('invalid legacy entries are discarded',()=>{
  assert.equal(normalizeQueueItem({source:'x',id:0}),null);
  const st={queue:[{source:'x',id:0},{source:'x',id:2}],completed:[]};
  normalizeInterrouteState(st);
  assert.equal(st.queue.length,1);
  assert.equal(st.queue[0].key,'telegram:x:2');
});
