const TARGET='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol';

function outboundHeaders(req,path){
  const h=new Headers();
  for(const [k,v] of Object.entries(req.headers||{})){
    const key=String(k).toLowerCase();
    if(['host','content-length','connection','transfer-encoding','keep-alive','upgrade','proxy-connection','te','trailer'].includes(key))continue;
    if(v==null)continue;
    if(Array.isArray(v)){for(const x of v)h.append(key,String(x));}
    else h.set(key,String(v));
  }
  h.set('x-nexcontrol-path',path);
  h.set('accept-encoding','identity');
  return h;
}

function outboundBody(req,headers){
  if(req.method==='GET'||req.method==='HEAD')return undefined;
  const b=req.body;
  if(b==null)return undefined;
  if(Buffer.isBuffer(b)||typeof b==='string')return b;
  const ct=String(headers.get('content-type')||'').toLowerCase();
  if(ct.includes('application/x-www-form-urlencoded')){
    return new URLSearchParams(Object.entries(b).map(([k,v])=>[k,String(v??'')])).toString();
  }
  if(ct.includes('application/json')||typeof b==='object'){
    headers.set('content-type','application/json');
    return JSON.stringify(b);
  }
  return String(b);
}

export default async function handler(req,res){
  try{
    const u=new URL(req.url,'https://nexcontrol.local');
    const headers=outboundHeaders(req,u.pathname);
    const body=outboundBody(req,headers);
    const upstream=await fetch(TARGET+u.search,{
      method:req.method,
      headers,
      body,
      redirect:'manual',
      signal:AbortSignal.timeout(30000)
    });

    res.statusCode=upstream.status;
    const skip=new Set(['content-length','transfer-encoding','connection','content-encoding']);
    for(const [k,v] of upstream.headers){
      if(!skip.has(k.toLowerCase()))res.setHeader(k,v);
    }
    if(typeof upstream.headers.getSetCookie==='function'){
      const cookies=upstream.headers.getSetCookie();
      if(cookies?.length)res.setHeader('set-cookie',cookies);
    }else{
      const cookie=upstream.headers.get('set-cookie');
      if(cookie)res.setHeader('set-cookie',cookie);
    }
    const buf=Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  }catch(error){
    console.error('[NexControl proxy]',error);
    res.statusCode=502;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:'upstream_unavailable'}));
  }
}
