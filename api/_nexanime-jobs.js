import crypto from 'node:crypto';
import {getDb} from './_nexanime-db.js';

export const cacheKey=(id,lang,s,e,q)=>[id,lang,s,e,q].join(':');

export async function cachedEpisode(key){
  const d=await getDb();
  return d.collection('nexanime_bot_cache').findOne({_id:key},{projection:{fileId:1,kind:1,title:1,size:1}});
}
export async function queueEpisode({key,chatId,statusMessageId,animeId,lang,season,episode,quality,caption}){
  const d=await getDb();
  const existing=await d.collection('nexanime_bot_jobs').findOne({cacheKey:key,status:{$in:['pending','processing']}});
  if(existing)return existing;
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
export async function jobByClaim(claim){
  const d=await getDb();
  return d.collection('nexanime_bot_jobs').findOne({claim:String(claim)});
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
