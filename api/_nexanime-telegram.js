const token=()=>process.env.NEXANIME_BOT_TOKEN||'';
export async function tg(method,payload){
  const t=token();
  if(!t)throw new Error('NEXANIME_BOT_TOKEN missing');
  const r=await fetch('https://api.telegram.org/bot'+t+'/'+method,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(30000)
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok||d?.ok!==true)throw new Error(method+': '+String(d?.description||r.status));
  return d.result;
}
export const keyboard=rows=>({inline_keyboard:rows});
