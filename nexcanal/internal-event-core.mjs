const DEFAULT_COMPLETED_LIMIT=10000;
const DEFAULT_COMPLETED_TTL_MS=7*24*60*60*1000;

function positiveId(value){
  const id=Number(value);
  return Number.isSafeInteger(id)&&id>0?id:0;
}

export function canonicalEventId(sourceKey,messageId){
  const source=String(sourceKey||'').trim().toLowerCase();
  const id=positiveId(messageId);
  if(!source||!id)throw new Error('invalid canonical source identity');
  return 'telegram:'+source+':'+id;
}

export function canonicalSourceEvent(sourceKey,messageId,{observedAt=Date.now()}={}){
  const source=String(sourceKey||'').trim().toLowerCase();
  const id=positiveId(messageId);
  const at=Number(observedAt)||Date.now();
  return {
    schema:'nex.interroute.source.v1',
    eventId:canonicalEventId(source,id),
    platform:'telegram',
    ownerType:'system',
    eventType:'source.message',
    source:{key:source,messageId:id},
    observedAt:at
  };
}

export function normalizeQueueItem(item={}){
  const source=String(item?.event?.source?.key||item.source||'').trim().toLowerCase();
  const id=positiveId(item?.event?.source?.messageId||item.id);
  if(!source||!id)return null;
  const event=item.event?.schema==='nex.interroute.source.v1'
    ?{...item.event,eventId:canonicalEventId(source,id),source:{key:source,messageId:id}}
    :canonicalSourceEvent(source,id,{observedAt:Number(item.addedAt)||Date.now()});
  return {
    ...item,
    key:event.eventId,
    source,
    id,
    event,
    addedAt:Number(item.addedAt)||Number(event.observedAt)||Date.now(),
    retries:Math.max(0,Number(item.retries)||0),
    nextRetryAt:Math.max(0,Number(item.nextRetryAt)||0)
  };
}

export function normalizeInterrouteState(state={}){
  state.queue=Array.isArray(state.queue)?state.queue.map(normalizeQueueItem).filter(Boolean):[];
  const seen=new Set();
  state.queue=state.queue.filter(item=>{
    if(seen.has(item.key))return false;
    seen.add(item.key);
    return true;
  });
  state.completed=Array.isArray(state.completed)?state.completed
    .filter(x=>x&&typeof x==='object'&&typeof x.eventId==='string')
    .map(x=>({eventId:String(x.eventId),completedAt:Number(x.completedAt)||0}))
    :[];
  return state;
}

export function pruneCompleted(state,{now=Date.now(),ttlMs=DEFAULT_COMPLETED_TTL_MS,limit=DEFAULT_COMPLETED_LIMIT}={}){
  const cutoff=Number(now)-Math.max(60000,Number(ttlMs)||DEFAULT_COMPLETED_TTL_MS);
  const dedup=new Map();
  for(const row of Array.isArray(state.completed)?state.completed:[]){
    if(!row?.eventId)continue;
    const completedAt=Number(row.completedAt)||0;
    if(completedAt<cutoff)continue;
    const previous=dedup.get(row.eventId);
    if(!previous||completedAt>previous.completedAt)dedup.set(row.eventId,{eventId:String(row.eventId),completedAt});
  }
  state.completed=[...dedup.values()].sort((a,b)=>a.completedAt-b.completedAt).slice(-Math.max(100,Number(limit)||DEFAULT_COMPLETED_LIMIT));
  return state.completed;
}

export function hasEvent(state,sourceKey,messageId){
  const id=canonicalEventId(sourceKey,messageId);
  return (state.queue||[]).some(x=>x?.key===id)||(state.completed||[]).some(x=>x?.eventId===id);
}

export function enqueueSourceEvent(state,sourceKey,messageId,{now=Date.now()}={}){
  normalizeInterrouteState(state);
  pruneCompleted(state,{now});
  if(hasEvent(state,sourceKey,messageId))return null;
  const event=canonicalSourceEvent(sourceKey,messageId,{observedAt:now});
  const item=normalizeQueueItem({event,addedAt:now,retries:0,nextRetryAt:0});
  state.queue.push(item);
  return item;
}

export function markEventCompleted(state,item,{now=Date.now()}={}){
  normalizeInterrouteState(state);
  const normalized=normalizeQueueItem(item);
  if(!normalized)return false;
  state.queue=state.queue.filter(x=>x.key!==normalized.key);
  state.completed.push({eventId:normalized.key,completedAt:Number(now)||Date.now()});
  pruneCompleted(state,{now});
  return true;
}
