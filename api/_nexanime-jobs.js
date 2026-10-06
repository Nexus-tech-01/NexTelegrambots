import crypto from 'node:crypto';
import {getDb} from './_nexanime-db.js';

const CACHE_VERSION='v5-cascade-progress';
const ACTIVE_JOB_TTL_MS=20*60_000;

export const cacheKey=(id,lang,s,e,q)=>[CACHE_VERSION,id,lang,s,e,q].join(':');
export const readCacheKey=(seriesId,chapter)=>[CACHE_VERSION,'read',String(seriesId),String(chapter).replace(',','.')].join(':');

export async function cachedEpisode(key){
  const d=await getDb();
  return d.collection('nexanime_bot_cache').findOne({_id:key},{projection:{fileId:1,kind:1,title:1,size:1}});
}
export async function activeEpisodeJob(key){
  const d=await getDb();
  const cutoff=new Date(Date.now()-ACTIVE_JOB_TTL_MS);
  return d.collection('nexanime_bot_jobs').findOne({
    cacheKey:key,
    status:{$in:['pending','processing','uploaded_waiting_webhook']},
    updatedAt:{$gte:cutoff}
  },{sort:{updatedAt:-1}});
}

export async function queueEpisode({key,chatId,statusMessageId,animeId,lang,season,episode,quality,caption}){
  const d=await getDb();
  const existing=await activeEpisodeJob(key);
  if(existing)return {...existing,reused:true};
  const doc={
    claim:crypto.randomUUID(),
    cacheKey:key,
    chatId,
    statusMessageId,
    animeId:String(animeId),
    lang,
    season:Number(season),
    episode:Number(episode),
    quality:Number(quality),
    caption:String(caption),
    status:'pending',
    attempts:0,
    createdAt:new Date(),
    updatedAt:new Date()
  };
  const r=await d.collection('nexanime_bot_jobs').insertOne(doc);
  return {...doc,_id:r.insertedId};
}
export async function queueReadIndex({key,chatId,statusMessageId,seriesId,title}){
  const d=await getDb();
  const existing=await activeEpisodeJob(key);
  if(existing)return {...existing,reused:true};
  const now=new Date();
  const doc={
    claim:crypto.randomUUID(),
    kind:'read-index',
    cacheKey:key,
    chatId,
    statusMessageId,
    seriesId:String(seriesId),
    readTitle:String(title||'').slice(0,180),
    caption:String(title||'').slice(0,180),
    status:'pending',
    attempts:0,
    createdAt:now,
    updatedAt:now
  };
  const r=await d.collection('nexanime_bot_jobs').insertOne(doc);
  return {...doc,_id:r.insertedId};
}

export async function queueReadChapter({key,chatId,statusMessageId,seriesId,title,chapter,alternatives=[],caption}){
  const d=await getDb();
  const existing=await activeEpisodeJob(key);
  if(existing)return {...existing,reused:true};
  const now=new Date();
  const doc={
    claim:crypto.randomUUID(),
    kind:'read',
    cacheKey:key,
    chatId,
    statusMessageId,
    seriesId:String(seriesId),
    readTitle:String(title||'').slice(0,180),
    readChapter:String(chapter||'').replace(',','.'),
    alternatives:Array.isArray(alternatives)?alternatives.slice(0,40):[],
    caption:String(caption||'').slice(0,500),
    status:'pending',
    attempts:0,
    createdAt:now,
    updatedAt:now
  };
  const r=await d.collection('nexanime_bot_jobs').insertOne(doc);
  return {...doc,_id:r.insertedId};
}

export async function jobByClaim(claim){
  const d=await getDb();
  return d.collection('nexanime_bot_jobs').findOne({claim:String(claim)});
}
export async function updateJobProgress(jobOrClaim,text){
  const d=await getDb();
  const filter=typeof jobOrClaim==='string'?{claim:String(jobOrClaim)}:{_id:jobOrClaim._id};
  const progress=String(text||'').slice(0,500);
  await d.collection('nexanime_bot_jobs').updateOne(filter,{$set:{progress,updatedAt:new Date()}});
}

export async function completeJob(job,{fileId,kind,size=0}){
  const d=await getDb();
  await d.collection('nexanime_bot_cache').updateOne(
    {_id:job.cacheKey},
    {$set:{fileId,kind,title:job.caption,size:Number(size)||0,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},
    {upsert:true}
  );
  await d.collection('nexanime_bot_jobs').updateOne({_id:job._id},{$set:{status:'done',fileId,kind,completedAt:new Date(),updatedAt:new Date()}});
}
export async function failJob(job,error){
  const d=await getDb();
  await d.collection('nexanime_bot_jobs').updateOne({_id:job._id},{$set:{status:'failed',error:String(error||'').slice(0,1000),updatedAt:new Date()}});
}
