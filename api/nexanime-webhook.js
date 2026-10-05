import {handleMessage} from './_nexanime-message.js';
import {handleCallback} from './_nexanime-callback.js';

export default async function handler(req,res){
  res.setHeader('cache-control','no-store');
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'method_not_allowed'});
  const secret=String(process.env.NEXANIME_WEBHOOK_SECRET||'');
  const provided=String(req.headers['x-telegram-bot-api-secret-token']||'');
  if(!secret||provided!==secret)return res.status(401).json({ok:false,error:'unauthorized'});
  try{
    const update=req.body||{};
    if(update.message)await handleMessage(update.message);
    else if(update.callback_query)await handleCallback(update.callback_query);
    return res.status(200).json({ok:true});
  }catch(error){
    console.error('[NexAnime webhook]',String(error?.stack||error).slice(0,1800));
    return res.status(200).json({ok:true,handled_error:true});
  }
}
