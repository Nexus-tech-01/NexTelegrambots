const DEFAULT_TTL_MS=10*60*1000;
const DEFAULT_BURST_MS=2500;

function peerKey(message){
  return String(
    message?.peerId?.userId||
    message?.peerId?.chatId||
    message?.peerId?.channelId||
    message?.chatId||
    'peer'
  );
}

function normalizedCommandText(message){
  return String(message?.message||message?.text||message?.rawText||'')
    .trim()
    .replace(/\s+/g,' ')
    .toLowerCase();
}

export function createCommandDeduper({ttlMs=DEFAULT_TTL_MS,burstMs=DEFAULT_BURST_MS}={}){
  const seen=new Map();
  const recentText=new Map();

  function prune(now=Date.now()){
    for(const [key,at] of seen){
      if(now-at>ttlMs)seen.delete(key);
    }
    for(const [key,at] of recentText){
      if(now-at>burstMs)recentText.delete(key);
    }
  }

  function claim(accountId,message){
    const now=Date.now();
    prune(now);
    const account=String(accountId);
    const peer=peerKey(message);
    const idKey=account+':'+peer+':'+String(message?.id||'0');
    if(seen.has(idKey))return false;

    // Mark the Telegram message ID first so a delayed raw/update fallback can
    // never execute the same message after the short burst window expires.
    seen.set(idKey,now);

    // Some Telegram sessions can surface the same self-authored command as
    // multiple new message IDs during reconnect/sync races. Collapse that
    // burst by normalized command text + chat while preserving normal reuse.
    const text=normalizedCommandText(message);
    if(text){
      const burstKey=account+':'+peer+':'+text;
      const previous=recentText.get(burstKey);
      recentText.set(burstKey,now);
      if(previous!==undefined&&now-previous<=burstMs)return false;
    }
    return true;
  }

  function clear(){
    seen.clear();
    recentText.clear();
  }

  return {claim,prune,size:()=>seen.size+recentText.size,clear};
}
