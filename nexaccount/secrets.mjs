import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, sessionKey } from './config.mjs';
import { db } from './store.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const defaultFile=path.join(here,'.runtime','nexai-bot-token.enc');
const configuredFile=String(process.env.NEXAI_BOT_TOKEN_FILE||'').trim();
const file=configuredFile?path.resolve(configuredFile):defaultFile;
const BOT_TOKEN_RECORD_ID='nexai_bot_token';
let botUsernameCache='';

function encryptBotToken(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',sessionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,encrypted]).toString('base64');
}

function decryptBotToken(value){
  try{
    const raw=Buffer.from(String(value||'').trim(),'base64');
    if(raw.length<29)return '';
    const iv=raw.subarray(0,12),tag=raw.subarray(12,28),encrypted=raw.subarray(28);
    const decipher=crypto.createDecipheriv('aes-256-gcm',sessionKey(),iv);
    decipher.setAuthTag(tag);
    const token=Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
    return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token)?token:'';
  }catch{return ''}
}

async function saveBotTokenToStore(value){
  const d=await db();
  const now=new Date();
  await d.collection('nexaccount_system').updateOne(
    {_id:BOT_TOKEN_RECORD_ID},
    {$set:{encryptedToken:encryptBotToken(value),updatedAt:now},$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
}

async function loadBotTokenFromStore(){
  const d=await db();
  const row=await d.collection('nexaccount_system').findOne(
    {_id:BOT_TOKEN_RECORD_ID},
    {projection:{encryptedToken:1}}
  );
  return decryptBotToken(row?.encryptedToken||'');
}

async function saveBotTokenToFile(value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,encryptBotToken(value),{mode:0o600});
}

async function loadBotTokenFromFile(){
  try{return decryptBotToken(await fs.readFile(file,'utf8'))}
  catch{return ''}
}

export async function saveBotToken(token){
  const value=String(token||'').trim();
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value))throw new Error('Invalid bot token');

  // Mongo is the durable source of truth. Release directories are replaced on
  // every deployment, so the local encrypted file is only a compatibility copy.
  let stored=false,fileSaved=false;
  try{
    await saveBotTokenToStore(value);
    stored=true;
  }catch(error){
    console.warn('[NexAccount bot token] durable_store_write_failed',String(error?.message||error).slice(0,220));
  }
  try{
    await saveBotTokenToFile(value);
    fileSaved=true;
  }catch(error){
    console.warn('[NexAccount bot token] local_copy_write_failed',String(error?.message||error).slice(0,220));
  }
  if(!stored&&!fileSaved)throw new Error('Unable to persist NexAI bot token');
}

export async function loadBotToken(){
  if(cfg.botToken)return cfg.botToken;

  try{
    const stored=await loadBotTokenFromStore();
    if(stored)return stored;
  }catch(error){
    console.warn('[NexAccount bot token] durable_store_read_failed',String(error?.message||error).slice(0,220));
  }

  // One-way migration for installations that saved the token inside an old
  // release directory before durable storage existed.
  const legacy=await loadBotTokenFromFile();
  if(legacy){
    await saveBotTokenToStore(legacy).catch(error=>{
      console.warn('[NexAccount bot token] legacy_migration_failed',String(error?.message||error).slice(0,220));
    });
    return legacy;
  }
  return '';
}

export async function resolveBotUsername({refresh=false}={}){
  if(!refresh&&botUsernameCache)return botUsernameCache;

  const configured=String(cfg.botUsername||'').trim().replace(/^@/,'');
  const token=await loadBotToken();
  if(token){
    try{
      const response=await fetch('https://api.telegram.org/bot'+token+'/getMe',{
        signal:AbortSignal.timeout(5000)
      });
      const data=await response.json().catch(()=>null);
      const username=String(data?.result?.username||'').trim().replace(/^@/,'');
      if(response.ok&&data?.ok===true&&username){
        botUsernameCache=username;
        cfg.botUsername=username;
        return username;
      }
    }catch(error){
      console.warn('[NexAccount bot identity] getMe_failed',String(error?.message||error).slice(0,180));
    }
  }

  if(configured){
    botUsernameCache=configured;
    return configured;
  }
  return '';
}
