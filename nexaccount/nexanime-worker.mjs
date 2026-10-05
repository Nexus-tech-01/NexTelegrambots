import fsp from 'node:fs/promises';
import {db} from './store.mjs';
import {animeById,downloadEpisode,uploaderRuntime} from './nexanime-bot.mjs';

const BOT_USERNAME=String(process.env.NEXANIME_BOT_USERNAME||'NexAnime01_bot').replace(/^@/,'');
const POLL_MS=Math.max(1000,Number(process.env.NEXANIME_JOB_POLL_MS||2500));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let running=false;
let loopPromise=null;
let activeJob=null;

async function recoverStaleJobs(){
  const d=await db();
  await d.collection('nexanime_bot_jobs').updateMany(
    {status:'processing',claimExpiresAt:{$lt:new Date()}},
    {$set:{status:'pending',updatedAt:new Date()},$unset:{claimExpiresAt:''}}
  );
}

async function claimNext(){
  const d=await db();
  const now=new Date();
  const expires=new Date(Date.now()+30*60_000);
  const r=await d.collection('nexanime_bot_jobs').findOneAndUpdate(
    {status:'pending'},
    {$set:{status:'processing',updatedAt:now,claimExpiresAt:expires},$inc:{attempts:1}},
    {sort:{createdAt:1},returnDocument:'after'}
  );
  return r||null;
}

async function markUploaded(job){
  const d=await db();
  await d.collection('nexanime_bot_jobs').updateOne(
    {_id:job._id},
    {$set:{status:'uploaded_waiting_webhook',uploadedAt:new Date(),updatedAt:new Date()},$unset:{claimExpiresAt:''}}
  );
}

async function markRetry(job,error){
  const d=await db();
  const attempts=Number(job?.attempts||0);
  const message=String(error?.message||error||'download_failed').slice(0,900);
  if(attempts>=3){
    await d.collection('nexanime_bot_jobs').updateOne(
      {_id:job._id},
      {$set:{status:'failed',error:message,updatedAt:new Date()},$unset:{claimExpiresAt:''}}
    );
    return false;
  }
  await d.collection('nexanime_bot_jobs').updateOne(
    {_id:job._id},
    {$set:{status:'pending',error:message,updatedAt:new Date()},$unset:{claimExpiresAt:''}}
  );
  return true;
}

async function notifyBot(text){
  const rt=uploaderRuntime();
  if(!rt?.client)throw new Error('Aucun compte Telegram uploader connecté');
  await rt.client.sendMessage('@'+BOT_USERNAME,{message:text});
}

async function processJob(job){
  let work='';
  try{
    const anime=await animeById(job.animeId);
    if(!anime)throw new Error('Anime FRAnime introuvable');
    const dl=await downloadEpisode(anime,job.lang,Number(job.season),Number(job.episode),Number(job.quality));
    work=dl.work;
    const rt=uploaderRuntime();
    if(!rt?.client)throw new Error('Aucun compte Telegram uploader connecté');
    await rt.client.sendFile('@'+BOT_USERNAME,{
      file:dl.file,
      caption:'#NXA_CACHE:'+job.claim+'\n'+String(job.caption||'').slice(0,700),
      workers:4
    });
    await markUploaded(job);
  }catch(error){
    const willRetry=await markRetry(job,error).catch(()=>false);
    if(!willRetry){
      await notifyBot('#NXA_FAIL:'+job.claim+'\n'+String(error?.message||error).slice(0,300)).catch(()=>{});
    }
  }finally{
    if(work)await fsp.rm(work,{recursive:true,force:true}).catch(()=>{});
  }
}

async function loop(){
  await recoverStaleJobs().catch(()=>{});
  while(running){
    try{
      const job=await claimNext();
      if(!job){await sleep(POLL_MS);continue}
      activeJob=String(job._id);
      await processJob(job);
      activeJob=null;
    }catch(error){
      activeJob=null;
      console.error('[NexAnime worker]',String(error?.message||error).slice(0,500));
      await sleep(Math.max(POLL_MS,4000));
    }
  }
}

export async function startNexAnimeWorker(){
  if(running)return nexAnimeWorkerStatus();
  running=true;
  loopPromise=loop();
  console.log('[NexAnime worker] started');
  return nexAnimeWorkerStatus();
}

export async function stopNexAnimeWorker(){
  running=false;
  try{await Promise.race([loopPromise||Promise.resolve(),sleep(3000)])}catch{}
  loopPromise=null;
}

export function nexAnimeWorkerStatus(){
  return {ok:true,running,activeJob,pollMs:POLL_MS,username:BOT_USERNAME};
}
