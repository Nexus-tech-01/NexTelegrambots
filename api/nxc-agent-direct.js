import {agentAuth,body,rpc,send} from './_nxc-agent-direct.js';

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
  const op=String(req.query?.op||'');
  try{
    const a=agentAuth(req),q=body(req);
    if(op==='heartbeat'){
      const d=await rpc('nxc_direct_agent_heartbeat',{p_slug:a.slug,p_key:a.key,p_body:q});
      if(d?.ok!==true)return send(res,d?.error==='unauthorized'?401:400,{error:d?.error||'agent_error'});
      return send(res,200,{ok:true,agentId:d.agentId});
    }
    if(op==='claim'){
      const d=await rpc('nxc_direct_agent_claim',{p_slug:a.slug,p_key:a.key,p_limit:Number(q.limit||3)});
      if(d?.ok!==true)return send(res,d?.error==='unauthorized'?401:400,{error:d?.error||'agent_error'});
      return send(res,200,{jobs:Array.isArray(d.jobs)?d.jobs:[]});
    }
    if(op==='result'){
      const d=await rpc('nxc_direct_agent_result',{
        p_slug:a.slug,p_key:a.key,p_job_id:String(q.jobId||''),
        p_ok:q.ok===true,p_result:q.result&&typeof q.result==='object'?q.result:{},
        p_error:q.error==null?null:String(q.error)
      });
      if(d?.ok!==true)return send(res,d?.error==='unauthorized'?401:d?.error==='not_found'?404:400,{error:d?.error||'agent_error'});
      return send(res,200,{ok:true});
    }
    return send(res,404,{error:'not_found'});
  }catch(e){
    return send(res,500,{error:'direct_control_error'});
  }
}
