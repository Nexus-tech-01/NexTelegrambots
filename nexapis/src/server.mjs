import http from 'node:http';
import { byPath,catalog,dashboardCount,totalCount } from './catalog.mjs';
import { readParams,execute,decodeShort } from './runtime.mjs';

const PORT=Number(process.env.PORT||8787);
function send(res,out){res.writeHead(out.status,out.headers);res.end(out.body)}
const server=http.createServer(async(req,res)=>{
  try{
    const origin=`http://${req.headers.host||`localhost:${PORT}`}`; const url=new URL(req.url||'/',origin);
    if(url.pathname==='/health')return send(res,{status:200,headers:{'content-type':'application/json'},body:JSON.stringify({status:true,service:'NexAPIs',version:'0.1.0',dashboardCount,totalCount})});
    if(url.pathname==='/catalog')return send(res,{status:200,headers:{'content-type':'application/json'},body:JSON.stringify({status:true,count:totalCount,dashboardCount,result:catalog})});
    if(url.pathname.startsWith('/r/')){const target=decodeShort(url.pathname.slice(3));if(!target){res.writeHead(404);return res.end('Not found')}res.writeHead(302,{location:target,'cache-control':'no-store'});return res.end()}
    if(url.pathname==='/')return send(res,{status:200,headers:{'content-type':'application/json'},body:JSON.stringify({status:true,result:{name:'NexAPIs',version:'0.1.0',dashboardCompatible:dashboardCount,total:totalCount,catalog:'/catalog',health:'/health'}})});
    const entry=byPath.get(url.pathname); if(!entry)return send(res,{status:404,headers:{'content-type':'application/json'},body:JSON.stringify({status:false,error:'not_found'})});
    if(!['GET','POST'].includes(req.method||''))return send(res,{status:405,headers:{'content-type':'application/json'},body:JSON.stringify({status:false,error:'method_not_allowed'})});
    const p=await readParams(req,url); return send(res,await execute(entry,p,{origin}));
  }catch(e){return send(res,{status:500,headers:{'content-type':'application/json'},body:JSON.stringify({status:false,error:'internal_error',details:String(e?.message||e).slice(0,250)})})}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`[NexAPIs] listening on :${PORT} — ${dashboardCount} dashboard routes / ${totalCount} total`));
