const CANDIDATES=[
  ['nexcanal','NEXCANAL__BOT_TOKEN'],
  ['nexgroup','NEXGROUP__TELEGRAM_BOT_TOKEN'],
  ['nexstick','NEXSTICK__BOT_TOKEN'],
  ['nexgame','NEXGAME__BOT_TOKEN'],
  ['nexdownloader','NEXDOWNLOADER__BOT_TOKEN'],
  ['nexanime','NEXANIME_BOT_TOKEN']
];

async function tg(token,method,payload={}){
  const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(12000)
  });
  const j=await r.json().catch(()=>({}));
  return {ok:r.ok&&j?.ok===true,status:r.status,result:j?.result||null,error:String(j?.description||'')};
}

export default async function handler(req,res){
  if(req.method!=='GET'){res.status(405).json({ok:false,error:'method_not_allowed'});return}
  const rows=[];
  for(const [label,key] of CANDIDATES){
    const token=String(process.env[key]||'').trim();
    if(!token){rows.push({label,configured:false});continue}
    const me=await tg(token,'getMe');
    if(!me.ok){rows.push({label,configured:true,reachable:false});continue}
    const member=await tg(token,'getChatMember',{chat_id:'@Nextech_NexAi',user_id:me.result.id});
    rows.push({
      label,
      configured:true,
      reachable:true,
      username:String(me.result.username||''),
      channelStatus:member.ok?String(member.result?.status||'unknown'):'unavailable',
      canPost:member.ok&&['administrator','creator'].includes(String(member.result?.status||''))&&(member.result?.can_post_messages!==false)
    });
  }
  res.setHeader('cache-control','no-store');
  res.status(200).json({ok:true,channel:'@Nextech_NexAi',rows});
}
