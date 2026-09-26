import { handleNexAiPublic } from '../nexai-public.mjs';

export default async function handler(req,res){
  try{
    const u=new URL(req.url,'https://nexai-connect.local');
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='')){
      u.pathname='/nexai/connect';
    }
    if(await handleNexAiPublic(req,res,u))return;
    res.statusCode=404;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','no-store');
    res.end(JSON.stringify({ok:false,error:'not_found'}));
  }catch(error){
    console.error('[NexAI Connect]',error);
    res.statusCode=502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','no-store');
    res.end(JSON.stringify({ok:false,error:'gateway_unavailable'}));
  }
}
