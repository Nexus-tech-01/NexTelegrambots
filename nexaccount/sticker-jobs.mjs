import crypto from 'node:crypto';
import { cfg } from './config.mjs';
import { db } from './store.mjs';

const ACTIVE_STATUSES=['queued','running','retrying'];
const DEFAULT_LEASE_MS=Math.max(5*60_000,Number(process.env.NEXAI_STICKER_JOB_LEASE_MS||30*60*1000));
let indexesReady=false;

async function jobs(){
  const d=await db();
  const c=d.collection('nexaccount_sticker_jobs');
  if(!indexesReady){
    indexesReady=true;
    await Promise.all([
      c.createIndex({telegramUserId:1,status:1,updatedAt:1}),
      c.createIndex({leaseExpiresAt:1}),
      c.createIndex({completedAt:1},{expireAfterSeconds:30*24*60*60})
    ]).catch(error=>{
      indexesReady=false;
      console.warn('[NexAi sticker jobs] index setup failed',String(error?.message||error).slice(0,300));
    });
  }
  return c;
}

function cleanText(value,max=500){
  return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}

export function newStickerJobId(accountId='0'){
  return String(accountId||'0')+'-'+Date.now().toString(36)+'-'+crypto.randomBytes(5).toString('hex');
}

export async function createStickerJob(job={}){
  const c=await jobs();
  const now=new Date();
  const id=cleanText(job.id||job._id||newStickerJobId(job.telegramUserId),160);
  const doc={
    ...job,
    _id:id,
    id,
    telegramUserId:String(job.telegramUserId||''),
    kind:cleanText(job.kind||'clonepack',40),
    status:'queued',
    nextIndex:Math.max(0,Number(job.nextIndex)||0),
    total:Math.max(0,Number(job.total)||0),
    attempts:Math.max(0,Number(job.attempts)||0),
    lastError:'',
    leaseOwner:'',
    leaseExpiresAt:new Date(0),
    createdAt:now,
    updatedAt:now
  };
  await c.insertOne(doc);
  return doc;
}

export async function listPendingStickerJobs(telegramUserId,{limit=25}={}){
  const c=await jobs();
  return c.find({
    telegramUserId:String(telegramUserId||''),
    status:{$in:ACTIVE_STATUSES}
  }).sort({createdAt:1}).limit(Math.max(1,Math.min(100,Number(limit)||25))).toArray();
}

export async function claimStickerJob(id,telegramUserId,{leaseMs=DEFAULT_LEASE_MS}={}){
  const c=await jobs();
  const now=new Date(),owner=String(cfg.workerId||process.pid);
  const leaseExpiresAt=new Date(Date.now()+Math.max(60_000,Number(leaseMs)||DEFAULT_LEASE_MS));
  const filter={
    _id:String(id),
    telegramUserId:String(telegramUserId||''),
    status:{$in:ACTIVE_STATUSES},
    $or:[
      {leaseOwner:owner},
      {leaseExpiresAt:{$lte:now}},
      {leaseExpiresAt:{$exists:false}},
      {leaseOwner:''},
      {leaseOwner:{$exists:false}}
    ]
  };
  const result=await c.findOneAndUpdate(
    filter,
    {$set:{status:'running',leaseOwner:owner,leaseExpiresAt,updatedAt:now}},
    {returnDocument:'after'}
  );
  return result||null;
}

export async function renewStickerJobLease(id,{leaseMs=DEFAULT_LEASE_MS}={}){
  const c=await jobs();
  const owner=String(cfg.workerId||process.pid);
  const leaseExpiresAt=new Date(Date.now()+Math.max(60_000,Number(leaseMs)||DEFAULT_LEASE_MS));
  const result=await c.updateOne(
    {_id:String(id),leaseOwner:owner,status:{$in:ACTIVE_STATUSES}},
    {$set:{leaseExpiresAt,updatedAt:new Date()}}
  );
  return result.matchedCount===1;
}

export async function patchStickerJob(id,patch={}){
  const c=await jobs();
  const safe={...patch};
  delete safe._id;
  delete safe.id;
  delete safe.telegramUserId;
  safe.updatedAt=new Date();
  await c.updateOne({_id:String(id)},{$set:safe});
  return c.findOne({_id:String(id)});
}

export async function releaseStickerJob(id,patch={}){
  const c=await jobs();
  const owner=String(cfg.workerId||process.pid);
  const safe={...patch,status:patch.status||'queued',updatedAt:new Date(),leaseOwner:'',leaseExpiresAt:new Date(0)};
  delete safe._id;
  delete safe.id;
  delete safe.telegramUserId;
  await c.updateOne({_id:String(id),$or:[{leaseOwner:owner},{leaseOwner:''},{leaseOwner:{$exists:false}}]},{$set:safe});
  return true;
}

export async function completeStickerJob(id,patch={}){
  const c=await jobs();
  const now=new Date();
  const safe={...patch,status:'done',updatedAt:now,completedAt:now,leaseOwner:'',leaseExpiresAt:new Date(0),lastError:''};
  delete safe._id;
  delete safe.id;
  delete safe.telegramUserId;
  await c.updateOne({_id:String(id)},{$set:safe});
  return true;
}
