const SUPABASE_URL='https://ojbyvjqurlamplmujmyu.supabase.co';
const SUPABASE_KEY='sb_publishable_EnV_q5ePfEOB1NxN3-gtpA_HdwjtPyu';

export async function rpc(name,args){
  const r=await fetch(SUPABASE_URL+'/rest/v1/rpc/'+name,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      authorization:'Bearer '+SUPABASE_KEY,
      'content-type':'application/json',
      accept:'application/json'
    },
    body:JSON.stringify(args),
    signal:AbortSignal.timeout(30000)
  });
  const text=await r.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={error:text||('HTTP '+r.status)}}
  if(!r.ok){
    const e=new Error(String(data?.message||data?.error||('HTTP '+r.status)));
    e.status=r.status;e.data=data;throw e;
  }
  return data;
}
export function body(req){
  if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}
  return {};
}
export function agentAuth(req){
  return {
    slug:String(req.headers['x-nexcontrol-agent']||'').trim().toLowerCase(),
    key:String(req.headers['x-nexcontrol-agent-key']||'')
  };
}
export function send(res,status,data){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.end(JSON.stringify(data));
}
