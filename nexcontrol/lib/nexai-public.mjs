import { body, json } from './core.mjs';

const starts=new Map();
const actions=new Map();
const nexaccountBase='http://127.0.0.1:'+Number(process.env.NEXACCOUNT_PORT||3491);

function keyFor(req){
  const fwd=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
  return fwd||String(req.socket?.remoteAddress||'unknown');
}

function consume(bucket,key,limit,windowMs){
  const now=Date.now();
  const row=bucket.get(key);
  if(!row||now-row.since>windowMs){
    bucket.set(key,{since:now,count:1});
    return true;
  }
  if(row.count>=limit)return false;
  row.count++;
  return true;
}

function safeStage(result){
  if(!result||typeof result!=='object')return {stage:'error'};
  const out={id:result.id,stage:result.stage};
  if(result.account)out.account=result.account;
  const errorCode=String(result.errorCode||'').trim().toUpperCase();
  if(errorCode&&/^[A-Z0-9_]+$/.test(errorCode))out.errorCode=errorCode;
  if(result.stage==='error')out.error='Telegram rejected the connection request. Check the information and try again.';
  return out;
}

function sameOrigin(req){
  const origin=String(req.headers.origin||'').trim();
  if(!origin)return true;
  try{
    const originHost=new URL(origin).host;
    const host=String(req.headers['x-forwarded-host']||req.headers.host||'').trim();
    return !host||originHost===host;
  }catch{return false}
}

async function input(req){
  const q=await body(req);
  return q&&typeof q==='object'?q:{};
}

async function nexaccountCall(method,path,payload){
  const r=await fetch(nexaccountBase+path,{
    method,
    headers:payload?{'content-type':'application/json'}:undefined,
    body:payload?JSON.stringify(payload):undefined,
    signal:AbortSignal.timeout(35000)
  });
  const text=await r.text();
  let data;
  try{data=JSON.parse(text)}catch{data={ok:false,error:text||('HTTP '+r.status)}}
  if(!r.ok)throw new Error(data.error||('HTTP '+r.status));
  return data;
}

export async function nexaiPublicApi(req,res,path,url){
  if(!sameOrigin(req))return json(res,403,{ok:false,error:'origin_not_allowed'});
  const ip=keyFor(req);

  if(path==='/api/public/nexai/pair/start'&&req.method==='POST'){
    if(!consume(starts,ip,5,10*60*1000))return json(res,429,{ok:false,error:'too_many_requests'});
    const q=await input(req);
    const phone=String(q.phone||'').replace(/[\s()-]/g,'');
    if(!/^\+?[0-9]{7,16}$/.test(phone))return json(res,400,{ok:false,error:'invalid_phone'});
    try{
      return json(res,200,{ok:true,...safeStage(await nexaccountCall('POST','/pair/start',{phone}))});
    }catch{
      return json(res,400,{ok:false,error:'pairing_start_failed'});
    }
  }

  if(path==='/api/public/nexai/pair/code'&&req.method==='POST'){
    if(!consume(actions,ip,20,10*60*1000))return json(res,429,{ok:false,error:'too_many_requests'});
    const q=await input(req);
    const id=String(q.id||'');
    const code=String(q.code||'').replace(/\s+/g,'');
    if(!id||!/^[0-9A-Za-z-]{3,16}$/.test(code))return json(res,400,{ok:false,error:'invalid_code'});
    try{
      return json(res,200,{ok:true,...safeStage(await nexaccountCall('POST','/pair/code',{id,code}))});
    }catch{
      return json(res,400,{ok:false,error:'code_failed'});
    }
  }

  if(path==='/api/public/nexai/pair/password'&&req.method==='POST'){
    if(!consume(actions,ip,20,10*60*1000))return json(res,429,{ok:false,error:'too_many_requests'});
    const q=await input(req);
    const id=String(q.id||'');
    const password=String(q.password||'');
    if(!id||!password||password.length>256)return json(res,400,{ok:false,error:'invalid_password'});
    try{
      return json(res,200,{ok:true,...safeStage(await nexaccountCall('POST','/pair/password',{id,password}))});
    }catch{
      return json(res,400,{ok:false,error:'password_failed'});
    }
  }

  if(path==='/api/public/nexai/pair/status'&&req.method==='GET'){
    const id=String(url.searchParams.get('id')||'');
    if(!id)return json(res,400,{ok:false,error:'missing_id'});
    try{
      return json(res,200,{ok:true,...safeStage(await nexaccountCall('GET','/pair/status?id='+encodeURIComponent(id)))});
    }catch{
      return json(res,400,{ok:false,error:'status_failed'});
    }
  }

  if(path==='/api/public/nexai/pair/cancel'&&req.method==='POST'){
    const q=await input(req);
    const id=String(q.id||'');
    if(!id)return json(res,200,{ok:true,stage:'cancelled'});
    try{
      const result=await nexaccountCall('POST','/pair/cancel',{id});
      return json(res,200,{ok:true,...safeStage(result)});
    }catch{
      return json(res,200,{ok:true,stage:'cancelled'});
    }
  }

  return json(res,404,{ok:false,error:'not_found'});
}
