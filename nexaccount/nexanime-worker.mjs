import fsp from 'node:fs/promises';
import {db} from './store.mjs';
import {animeById,discoverReadCatalog,downloadEpisode,downloadReadChapter,uploaderRuntime} from './nexanime-bot.mjs';

const BOT_USERNAME=String(process.env.NEXANIME_BOT_USERNAME||'NexAnime01_bot').replace(/^@/,'');
const POLL_MS=Math.max(1000,Number(process.env.NEXANIME_JOB_POLL_MS||2500));
const CLAIM_MS=Math.max(8*60_000,Number(process.env.NEXANIME_JOB_CLAIM_MS||18*60_000));
const MAX_ATTEMPTS=Math.max(1,Math.min(3,Number(process.env.NEXANIME_JOB_MAX_ATTEMPTS||2)));
const UPLOAD_TIMEOUT_MS=Math.max(3*60_000,Number(process.env.NEXANIME_JOB_UPLOAD_TIMEOUT_MS||12*60_000));
const PROGRESS_MIN_MS=Math.max(5000,Number(process.env.NEXANIME_PROGRESS_MIN_MS||9000));
const PROGRESS_RELAY_ENABLED=/^(?:1|true|yes|on)$/i.test(String(process.env.NEXANIME_PROGRESS_RELAY||'1').trim());
const CACHE_MIGRATION_ID='nexanime_cache_purge_20261005_v1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let running=false;
let loopPromise=null;
let activeJob=null;
let lastProgress='';
let lastError='';

async function migrateLegacyCache(){
  const d=await db();
  const marker=await d.collection('nexaccount_system').findOne({_id:CACHE_MIGRATION_ID},{projection:{_id:1}}).catch(()=>null);
  if(marker)return false;
  await d.collection('nexanime_bot_cache').deleteMany({});
  await d.collection('nexaccount_system').updateOne(
    {_id:CACHE_MIGRATION_ID},
    {$set:{doneAt:new Date(),reason:'invalidate legacy webhook placeholder cache'}},
    {upsert:true}
  );
  console.log('[NexAnime worker] legacy webhook cache purged');
  return true;
}

async function recoverStaleJobs({startup=false}={}){
  const d=await db();
  const now=new Date();
  const filter=startup
    ?{status:'processing'}
    :{status:'processing',claimExpiresAt:{$lt:now}};
  await d.collection('nexanime_bot_jobs').updateMany(
    filter,
    {$set:{status:'pending',progress:startup?'Reprise automatique après redémarrage du worker…':'Reprise automatique après expiration du worker…',updatedAt:now},$unset:{claimExpiresAt:''}}
  );
}

async function claimNext(){
  const d=await db();
  const now=new Date();
  const expires=new Date(Date.now()+CLAIM_MS);
  const r=await d.collection('nexanime_bot_jobs').findOneAndUpdate(
    {status:'pending'},
    {$set:{status:'processing',progress:'Worker actif · recherche des sources…',updatedAt:now,claimExpiresAt:expires},$inc:{attempts:1}},
    {sort:{createdAt:1},returnDocument:'after'}
  );
  return r||null;
}

async function setProgress(job,text){
  const progress=String(text||'').slice(0,500);
  lastProgress=progress;
  try{
    const d=await db();
    await d.collection('nexanime_bot_jobs').updateOne(
      {_id:job._id},
      {$set:{progress,updatedAt:new Date(),claimExpiresAt:new Date(Date.now()+CLAIM_MS)}}
    );
  }catch{}
}

async function markUploaded(job){
  const d=await db();
  await d.collection('nexanime_bot_jobs').updateOne(
    {_id:job._id},
    {$set:{status:'uploaded_waiting_webhook',progress:'Upload terminé · finalisation Telegram…',uploadedAt:new Date(),updatedAt:new Date()},$unset:{claimExpiresAt:''}}
  );
}

async function markReadIndexComplete(job,series){
  const d=await db();
  await d.collection('nexanime_bot_jobs').updateOne(
    {_id:job._id},
    {$set:{
      status:'done',
      progress:'Catalogue lecteur finalisé',
      resultSeriesId:String(series?._id||job.seriesId||''),
      completedAt:new Date(),
      updatedAt:new Date()
    },$unset:{claimExpiresAt:''}}
  );
}

async function markRetry(job,error){
  const d=await db();
  const attempts=Number(job?.attempts||0);
  const message=String(error?.message||error||'download_failed').slice(0,900);
  lastError=message;

  const deterministic=/médias reçus étaient indisponibles|Aucune source vidéo|Anime FRAnime introuvable|faux épisodes|tous les lecteurs disponibles/i.test(message);
  if(attempts>=MAX_ATTEMPTS||deterministic){
    await d.collection('nexanime_bot_jobs').updateOne(
      {_id:job._id},
      {$set:{status:'failed',progress:'Échec',error:message,updatedAt:new Date()},$unset:{claimExpiresAt:''}}
    );
    return false;
  }
  await d.collection('nexanime_bot_jobs').updateOne(
    {_id:job._id},
    {$set:{status:'pending',progress:'Nouvelle tentative automatique…',error:message,updatedAt:new Date()},$unset:{claimExpiresAt:''}}
  );
  return true;
}

async function notifyBot(text){
  const rt=uploaderRuntime();
  if(!rt?.client)throw new Error('Aucun compte Telegram uploader connecté');
  await rt.client.sendMessage('@'+BOT_USERNAME,{message:text});
}

async function withTimeout(promise,ms,label){
  let timer;
  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout')),ms)})
    ]);
  }finally{
    if(timer)clearTimeout(timer);
  }
}

async function processJob(job){
  let work='';
  let lastNotifyAt=0;
  let lastNotifyText='';

  const relayProgress=async info=>{
    const text=String(info?.message||'Téléchargement en cours…').slice(0,500);
    await setProgress(job,text);
    const now=Date.now();
    if(text===lastNotifyText&&now-lastNotifyAt<PROGRESS_MIN_MS)return;
    if(now-lastNotifyAt<PROGRESS_MIN_MS&&info?.force!==true)return;
    lastNotifyAt=now;
    lastNotifyText=text;
    if(PROGRESS_RELAY_ENABLED){
      await notifyBot('#NXA_PROGRESS:'+job.claim+'\n'+text).catch(()=>{});
    }
  };

  try{
    if(String(job?.kind||'anime')==='read-index'){
      await relayProgress({message:'Fusion de tous les catalogues de chapitres…',force:true});
      const series=await discoverReadCatalog(
        String(job.readTitle||job.title||''),
        {onProgress:relayProgress}
      );
      await markReadIndexComplete(job,series);
      await notifyBot('#NXA_READ_INDEX:'+job.claim);
      return;
    }

    let dl=null;
    if(String(job?.kind||'anime')==='read'){
      await relayProgress({message:'Recherche du chapitre…',force:true});
      dl=await downloadReadChapter(
        String(job.readTitle||job.title||''),
        String(job.readChapter||job.chapter||''),
        Array.isArray(job.alternatives)?job.alternatives:[],
        {onProgress:relayProgress,aliases:Array.isArray(job.aliases)?job.aliases:[]}
      );
      work=dl.work;
      await relayProgress({message:'Chapitre valide trouvé · envoi vers Telegram…',force:true});
    }else{
      await relayProgress({message:'Préparation du téléchargement…',force:true});
      const anime=await animeById(job.animeId);
      if(!anime)throw new Error('Anime introuvable');
      dl=await downloadEpisode(
        anime,
        job.lang,
        Number(job.season),
        Number(job.episode),
        Number(job.quality),
        {
          onProgress:relayProgress,
          preResolvedUrls:Array.isArray(job.sourceUrls)?job.sourceUrls:[]
        }
      );
      work=dl.work;
      await relayProgress({message:'Épisode valide trouvé · envoi vers Telegram…',force:true});
    }

    const rt=uploaderRuntime();
    if(!rt?.client)throw new Error('Aucun compte Telegram uploader connecté');

    await withTimeout(rt.client.sendFile('@'+BOT_USERNAME,{
      file:dl.file,
      caption:'#NXA_CACHE:'+job.claim+'\n'+String(job.caption||'').slice(0,700),
      workers:4
    }),UPLOAD_TIMEOUT_MS,'Telegram upload');

    await markUploaded(job);
  }catch(error){
    const willRetry=await markRetry(job,error).catch(()=>false);
    if(willRetry){
      if(PROGRESS_RELAY_ENABLED){
        await notifyBot('#NXA_PROGRESS:'+job.claim+'\nNouvelle tentative automatique après un échec temporaire…').catch(()=>{});
      }
    }else{
      await notifyBot('#NXA_FAIL:'+job.claim+'\n'+String(error?.message||error).slice(0,300)).catch(()=>{});
    }
  }finally{
    if(work)await fsp.rm(work,{recursive:true,force:true}).catch(()=>{});
  }
}
async function loop(){
  await migrateLegacyCache().catch(error=>console.warn('[NexAnime worker] cache migration',String(error?.message||error).slice(0,300)));
  // Any processing job left in MongoDB at process startup belongs to the old
  // worker instance and must be resumed immediately, not 30 minutes later.
  await recoverStaleJobs({startup:true}).catch(()=>{});
  let staleSweepAt=Date.now();

  while(running){
    try{
      if(Date.now()-staleSweepAt>60_000){
        staleSweepAt=Date.now();
        await recoverStaleJobs().catch(()=>{});
      }

      // Do not claim a job until an MTProto uploader is ready. Otherwise a
      // download can finish successfully and then be lost at the handoff.
      if(!uploaderRuntime()?.client){
        lastProgress='En attente d’un compte Telegram uploader connecté…';
        await sleep(Math.max(POLL_MS,3000));
        continue;
      }

      const job=await claimNext();
      if(!job){await sleep(POLL_MS);continue}

      activeJob=String(job._id);
      lastError='';
      await processJob(job);
      activeJob=null;
    }catch(error){
      activeJob=null;
      lastError=String(error?.message||error).slice(0,500);
      console.error('[NexAnime worker]',lastError);
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
  return {
    ok:true,
    running,
    activeJob,
    pollMs:POLL_MS,
    username:BOT_USERNAME,
    uploaderReady:Boolean(uploaderRuntime()?.client),
    lastProgress,
    lastError,
    progressRelayEnabled:PROGRESS_RELAY_ENABLED
  };
}
