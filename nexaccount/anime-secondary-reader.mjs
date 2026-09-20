import fs from 'node:fs/promises';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage } from 'teleproto/events/index.js';
import { cfg } from './config.mjs';
import { animeIngestStatus, handleAnimeIngestEvent, startAnimeIngest, stopAnimeIngest } from './anime-ingest.mjs';

const SESSION_FILE=process.env.NEXANIME_SECONDARY_SESSION_FILE||'/home/container/.nexcontrol/nexcanal-reader-session.txt';
let runtime=null;
let starting=null;

export async function startSecondaryAnimeReader(){
  if(runtime?.client?.connected===true)return secondaryAnimeStatus();
  if(starting)return starting;
  starting=(async()=>{
    let session='';
    try{session=String(await fs.readFile(SESSION_FILE,'utf8')).trim()}catch(error){
      if(error?.code==='ENOENT')return {enabled:false,connected:false,reason:'session_file_missing'};
      throw error;
    }
    if(!session)return {enabled:false,connected:false,reason:'empty_session'};
    const client=new TelegramClient(new StringSession(session),cfg.apiId,cfg.apiHash,{
      connectionRetries:8,
      autoReconnect:true
    });
    await client.connect();
    if(!(await client.isUserAuthorized())){
      await client.disconnect().catch(()=>{});
      return {enabled:false,connected:false,reason:'session_unauthorized'};
    }
    const me=await client.getMe();
    const local={
      client,
      account:{
        telegramUserId:String(me.id),
        username:String(me.username||''),
        firstName:String(me.firstName||''),
        premium:me.premium===true
      },
      startedAt:new Date(),
      secondaryAnimeReader:true
    };
    const started=await startAnimeIngest(local);
    if(!started){
      await client.disconnect().catch(()=>{});
      return {
        enabled:false,
        connected:false,
        username:local.account.username?('@'+local.account.username):'',
        reason:'account_not_in_listener_allowlist'
      };
    }
    client.addEventHandler(async event=>{
      try{await handleAnimeIngestEvent(local,event)}
      catch(error){console.error('[NexAnime secondary event]',String(error?.message||error))}
    },new NewMessage({incoming:true}));
    local.catchUpTimer=setInterval(async()=>{
      try{
        if(!client.connected)await client.connect();
        await client.catchUp?.();
      }catch(error){
        console.warn('[NexAnime secondary catchup]',String(error?.message||error).slice(0,240));
      }
    },60_000);
    local.catchUpTimer.unref?.();
    runtime=local;
    console.log('[NexAnime secondary] connected @'+String(local.account.username||local.account.telegramUserId));
    return secondaryAnimeStatus();
  })().finally(()=>{starting=null});
  return starting;
}

export async function stopSecondaryAnimeReader(){
  const r=runtime;
  runtime=null;
  if(!r)return;
  if(r.catchUpTimer)clearInterval(r.catchUpTimer);
  await stopAnimeIngest(r).catch(()=>{});
  await r.client?.disconnect?.().catch(()=>{});
}

export function secondaryAnimeStatus(){
  if(!runtime){
    return {enabled:false,connected:false,sessionFile:SESSION_FILE};
  }
  return {
    enabled:true,
    connected:runtime.client?.connected===true,
    username:runtime.account?.username?('@'+runtime.account.username):'',
    startedAt:runtime.startedAt||null,
    anime:animeIngestStatus(runtime)
  };
}
