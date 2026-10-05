import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionKey } from './config.mjs';
import { db } from './store.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const file=path.resolve(String(process.env.NEXANIME_BOT_TOKEN_FILE||path.join(here,'.runtime','nexanime-bot-token.enc')));
const RECORD_ID='nexanime_bot_token';

function encrypt(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',sessionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,encrypted]).toString('base64');
}

function decrypt(value){
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

export async function saveNexAnimeBotToken(token){
  const value=String(token||'').trim();
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value))throw new Error('Invalid NexAnime bot token');
  let durable=false,local=false;
  try{
    const d=await db();
    const now=new Date();
    await d.collection('nexaccount_system').updateOne(
      {_id:RECORD_ID},
      {$set:{encryptedToken:encrypt(value),updatedAt:now},$setOnInsert:{createdAt:now}},
      {upsert:true}
    );
    durable=true;
  }catch(error){
    console.warn('[NexAnime token] durable_store_write_failed',String(error?.message||error).slice(0,220));
  }
  try{
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,encrypt(value),{mode:0o600});
    local=true;
  }catch(error){
    console.warn('[NexAnime token] local_copy_write_failed',String(error?.message||error).slice(0,220));
  }
  if(!durable&&!local)throw new Error('Unable to persist NexAnime bot token');
}

export async function loadNexAnimeBotToken(){
  const env=String(process.env.NEXANIME_BOT_TOKEN||'').trim();
  if(/^\d+:[A-Za-z0-9_-]{20,}$/.test(env))return env;
  try{
    const d=await db();
    const row=await d.collection('nexaccount_system').findOne({_id:RECORD_ID},{projection:{encryptedToken:1}});
    const token=decrypt(row?.encryptedToken||'');
    if(token)return token;
  }catch(error){
    console.warn('[NexAnime token] durable_store_read_failed',String(error?.message||error).slice(0,220));
  }
  try{
    const token=decrypt(await fs.readFile(file,'utf8'));
    if(token)return token;
  }catch{}
  return '';
}
