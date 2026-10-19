/**
 * Conservative replay policy for WhatsApp publication backlogs.
 * Old posts stay pending instead of flooding a channel after reconnection.
 */
const MINUTE=60_000;
export const DEFAULT_GAP_MS=60_000;
export const DEFAULT_BACKLOG_MAX_AGE_MS=72*60*MINUTE;
export function isStalePending(job,{now=Date.now(),maxAgeMs=DEFAULT_BACKLOG_MAX_AGE_MS}={}){
  if(job?.status!=='pending')return false;
  const date=Date.parse(String(job.createdAt||job.pub?.createdAt||''));
  return Number.isFinite(date)&&date>0 && now-date>maxAgeMs;
}
export function mayAttemptQueueJob(job,{
  now=Date.now(),nextAllowedAt=0,allowStale=false,maxAgeMs=DEFAULT_BACKLOG_MAX_AGE_MS
}={}){
  if(job?.status!=='pending'||Number(job.nextAttemptAt||0)>now)return false;
  if(!allowStale&&isStalePending(job,{now,maxAgeMs}))return false;
  return now>=nextAllowedAt;
}
export function queuedBacklogStats(queue,{now=Date.now(),maxAgeMs=DEFAULT_BACKLOG_MAX_AGE_MS}={}){
  let pending=0,stale=0;
  for(const job of queue||[]){
    if(job?.status!=='pending')continue;
    pending++;
    if(isStalePending(job,{now,maxAgeMs}))stale++;
  }
  return {pending,stale,ready:pending-stale};
}
