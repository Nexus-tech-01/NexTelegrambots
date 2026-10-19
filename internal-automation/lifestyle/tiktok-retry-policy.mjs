/**
 * Failure backoff for TikTok publishing; an attempted video is not a published
 * video. Only Telegram sendVideo success may enter seenIds.
 */
export const FAIL_MIN_MS=5*60_000;
export const FAIL_MAX_MS=12*60*60_000;
export const WA_MIN_MS=2*60_000;
export const WA_MAX_MS=3*60*60_000;

const safeCount=v=>Math.max(0,Number(v)||0);
export function backoffMs(attempts,{base=FAIL_MIN_MS,cap=FAIL_MAX_MS}={}){
  return Math.min(cap,base*Math.pow(2,Math.min(16,Math.max(0,safeCount(attempts)-1))));
}

export function candidateIsDue(id,failedIds={},now=Date.now()){
  const entry=failedIds?.[id];
  return !entry || Number(entry.nextAttemptAt||0)<=now;
}

export function registerCandidateFailure(failedIds,id,error,{now=Date.now()}={}){
  const old=failedIds?.[id]||{};
  const count=safeCount(old.count)+1;
  const nextAttemptAt=now+backoffMs(count);
  failedIds[id]={
    count,
    lastError:String(error?.message||error||'inconnu').slice(0,500),
    updatedAt:new Date(now).toISOString(),
    nextAttemptAt
  };
  return failedIds[id];
}

export function queuedWhatsappRetry(entry,{now=Date.now()}={}){
  const attempts=safeCount(entry.attempts)+1;
  return {...entry,attempts,nextAttemptAt:now+backoffMs(attempts,{base:WA_MIN_MS,cap:WA_MAX_MS})};
}
