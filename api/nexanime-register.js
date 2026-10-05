const BOT_TOKEN=process.env.NEXANIME_BOT_TOKEN||'';
const SETUP_KEY=process.env.NEXANIME_SETUP_KEY||'';
const WEBHOOK_SECRET=process.env.NEXANIME_WEBHOOK_SECRET||'';
const WEBHOOK_URL='https://nex-telegrambots.vercel.app/api/nexanime-webhook';

export default async function handler(req,res){
  res.setHeader('cache-control','no-store');
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'method_not_allowed'});
  if(!BOT_TOKEN||!SETUP_KEY||!WEBHOOK_SECRET)return res.status(503).json({ok:false,error:'nexanime_env_missing'});
  if(String(req.query?.key||'')!==SETUP_KEY)return res.status(401).json({ok:false,error:'unauthorized'});
  const r=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/setWebhook',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      url:WEBHOOK_URL,
      secret_token:WEBHOOK_SECRET,
      allowed_updates:['message','callback_query'],
      drop_pending_updates:true
    }),
    signal:AbortSignal.timeout(15000)
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data?.ok!==true)return res.status(502).json({ok:false,error:'telegram_setwebhook_failed',telegram:data});
  return res.status(200).json({ok:true,webhook:WEBHOOK_URL});
}
