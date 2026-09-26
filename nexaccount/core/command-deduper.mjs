const DEFAULT_TTL_MS=10*60*1000;

function peerKey(message){
  return String(
    message?.peerId?.userId||
    message?.peerId?.chatId||
    message?.peerId?.channelId||
    message?.chatId||
    'peer'
  );
}

export function createCommandDeduper({ttlMs=DEFAULT_TTL_MS}={}){
  const seen=new Map();

  function prune(now=Date.now()){
    for(const [key,at] of seen){
      if(now-at>ttlMs)seen.delete(key);
    }
  }

  function claim(accountId,message){
    const now=Date.now();
    prune(now);
    const key=String(accountId)+':'+peerKey(message)+':'+String(message?.id||'0');
    if(seen.has(key))return false;
    seen.set(key,now);
    return true;
  }

  return {claim,prune,size:()=>seen.size,clear:()=>seen.clear()};
}
