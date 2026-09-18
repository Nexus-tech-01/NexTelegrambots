import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { body, db, json } from './core.mjs';

let indexed=false;
const hash=s=>crypto.createHash('sha256').update(String(s??'')).digest();
const equal=(a,b)=>{try{return crypto.timingSafeEqual(hash(a),hash(b))}catch{return false}};
const JOB_KINDS=new Set(['fs.list','fs.read','fs.search','fs.write','fs.mkdir','fs.move','fs.delete','fs.rollback','check.run','logs.tail','runtime.restart']);

async function agentDb(){
  const d=await db();
  if(!indexed){
    indexed=true;
    await Promise.all([
      d.collection('agents').createIndex({slug:1},{unique:true}),
      d.collection('agent_jobs').createIndex({agentSlug:1,status:1,availableAt:1}),
      d.collection('agent_jobs').createIndex({createdAt:-1})
    ]).catch(e=>{indexed=false;throw e});
  }
  return d;
}

function identity(req){
  // Dedicated key is preferred. Fleet-key fallback lets existing v61.07 deployments
  // adopt the Agent without requiring a second secret immediately.
  const expected=String(process.env.NEXCONTROL_AGENT_KEY||process.env.NEXCONTROL_FLEET_KEY||'').trim();
  const supplied=String(req.headers['x-nexcontrol-agent-key']||'').trim();
  const slug=String(req.headers['x-nexcontrol-agent']||'').trim().toLowerCase();
  if(!expected||!supplied||!slug||!equal(expected,supplied))return null;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)?slug:null;
}

export function agentControlConfigured(){
  return Boolean(String(process.env.NEXCONTROL_AGENT_KEY||process.env.NEXCONTROL_FLEET_KEY||'').trim());
}

export async function agentApi(req,res,path){
  const slug=identity(req);if(!slug)return json(res,401,{error:'unauthorized'});
  const d=await agentDb(),q=await body(req),now=new Date();
  if(path==='/api/v1/agent/heartbeat'){
    await d.collection('agents').updateOne({slug},{
      $set:{
        displayName:String(q.displayName||slug).slice(0,120),
        version:String(q.version||'unknown').slice(0,80),
        hostname:String(q.hostname||'').slice(0,160),platform:String(q.platform||'').slice(0,80),nodeVersion:String(q.nodeVersion||'').slice(0,80),
        pid:Number(q.pid)||null,uptime:Number(q.uptime)||0,
        memory:q.memory&&typeof q.memory==='object'?q.memory:{},
        capabilities:q.capabilities&&typeof q.capabilities==='object'?q.capabilities:{},
        roots:Array.isArray(q.roots)?q.roots.slice(0,100):[],
        lastHeartbeatAt:now,updatedAt:now,enabled:true
      },
      $setOnInsert:{slug,createdAt:now}
    },{upsert:true});
    return json(res,200,{ok:true,serverTime:now.toISOString()});
  }
  if(path==='/api/v1/agent/jobs/claim'){
    await d.collection('agent_jobs').updateMany({agentSlug:slug,status:'claimed',claimExpiresAt:{$lt:now}},{$set:{status:'pending',updatedAt:now},$unset:{claimedAt:'',claimExpiresAt:''}});
    const jobs=[],limit=Math.max(1,Math.min(5,Number(q.limit)||3));
    for(let i=0;i<limit;i++){
      const z=await d.collection('agent_jobs').findOneAndUpdate(
        {agentSlug:slug,status:'pending',availableAt:{$lte:now}},
        {$set:{status:'claimed',claimedAt:now,claimExpiresAt:new Date(Date.now()+120000),updatedAt:now},$inc:{attempts:1}},
        {sort:{createdAt:1},returnDocument:'after'}
      );
      if(!z)break;
      jobs.push({id:String(z._id),kind:z.kind,payload:z.payload||{},attempts:z.attempts||1,createdAt:z.createdAt});
    }
    return json(res,200,{jobs});
  }
  if(path==='/api/v1/agent/jobs/result'){
    if(!ObjectId.isValid(q.jobId))return json(res,400,{error:'bad_job'});
    const id=new ObjectId(q.jobId),z=await d.collection('agent_jobs').findOne({_id:id,agentSlug:slug});
    if(!z)return json(res,404,{error:'not_found'});
    const ok=q.ok===true,result=q.result&&typeof q.result==='object'?q.result:(q.result==null?null:{value:String(q.result).slice(0,200000)});
    await d.collection('agent_jobs').updateOne({_id:id},{
      $set:{status:ok?'succeeded':'failed',result:ok?result:null,error:ok?null:String(q.error||'Agent job failed').slice(0,20000),finishedAt:now,updatedAt:now},
      $unset:{claimedAt:'',claimExpiresAt:''}
    });
    await d.collection('agents').updateOne({slug},{$set:{lastJobAt:now,lastJobStatus:ok?'succeeded':'failed',updatedAt:now}});
    return json(res,200,{ok:true});
  }
  return json(res,404,{error:'not_found'});
}

export async function createAgentJob(req,res){
  const q=await body(req),agentSlug=String(q.agentSlug||'').trim().toLowerCase(),kind=String(q.kind||'').trim();
  if(!agentSlug||!JOB_KINDS.has(kind))return json(res,400,{error:'invalid_job'});
  let payload=q.payload;
  if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{return json(res,400,{error:'invalid_payload_json'})}}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return json(res,400,{error:'invalid_payload'});
  const d=await agentDb(),agent=await d.collection('agents').findOne({slug:agentSlug,enabled:{$ne:false}});
  if(!agent)return json(res,404,{error:'agent_not_found'});
  const now=new Date(),availableAt=q.availableAt?new Date(q.availableAt):now;
  if(Number.isNaN(+availableAt))return json(res,400,{error:'invalid_available_at'});
  const x=await d.collection('agent_jobs').insertOne({agentSlug,kind,payload,status:'pending',attempts:0,availableAt,createdAt:now,updatedAt:now});
  return json(res,202,{ok:true,jobId:String(x.insertedId),status:'pending'});
}

export async function getAgentJob(req,res,url){
  const id=String(url.searchParams.get('id')||'');if(!ObjectId.isValid(id))return json(res,400,{error:'bad_job'});
  const d=await agentDb(),z=await d.collection('agent_jobs').findOne({_id:new ObjectId(id)});if(!z)return json(res,404,{error:'not_found'});
  return json(res,200,{...z,_id:String(z._id)});
}
