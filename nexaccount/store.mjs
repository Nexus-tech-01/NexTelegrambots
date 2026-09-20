import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { cfg, sessionKey } from './config.mjs';

let clientPromise;
let indexesReady=false;
const watcherIdentityFile=process.env.NEXCANAL__WATCHER_ID_FILE||'/home/container/.nexcontrol/nexcanal-watcher-id.txt';

async function reservedWatcherId(){
  try{return String(await fs.readFile(watcherIdentityFile,'utf8')).trim()}catch{return ''}
}

export async function db(){
  clientPromise ??= new MongoClient(cfg.mongoUri).connect();
  const d=(await clientPromise).db(cfg.dbName);
  if(!indexesReady){
    indexesReady=true;
    await Promise.all([
      d.collection('nexaccount_accounts').createIndex({telegramUserId:1},{unique:true}),
      d.collection('nexaccount_accounts').createIndex({enabled:1,updatedAt:-1}),
      d.collection('nexaccount_accounts').createIndex({enabled:1,runtimeBucket:1,connectedAt:1}),
      d.collection('nexaccount_settings').createIndex({telegramUserId:1},{unique:true}),
      d.collection('nexaccount_runtime_leases').createIndex({expiresAt:1},{expireAfterSeconds:0})
    ]).catch(e=>{indexesReady=false;throw e;});
    await d.collection('nexaccount_accounts').updateMany(
      {runtimeBucket:{$exists:false}},
      [{$set:{runtimeBucket:{$toInt:{$mod:[{$toLong:'$telegramUserId'},cfg.runtimeBuckets]}}}}]
    ).catch(e=>console.warn('[NexAccount store] runtime bucket migration skipped:',String(e?.message||e)));
  }
  return d;
}

export function encryptSession(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',sessionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,encrypted]).toString('base64');
}

export function decryptSession(value){
  const raw=Buffer.from(String(value),'base64');
  if(raw.length<29)throw new Error('Invalid encrypted session');
  const iv=raw.subarray(0,12),tag=raw.subarray(12,28),encrypted=raw.subarray(28);
  const decipher=crypto.createDecipheriv('aes-256-gcm',sessionKey(),iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
}

export const maskPhone=phone=>{
  const s=String(phone||'').replace(/\s+/g,'');
  if(s.length<6)return s;
  return s.slice(0,3)+'••••'+s.slice(-3);
};

function countryFromPhone(phone){
  try{return parsePhoneNumberFromString(String(phone||''))?.country||''}catch{return ''}
}
function uiLanguage(code){
  const s=String(code||'').toLowerCase();
  return s.startsWith('en')?'en':'fr';
}

export function runtimeBucketFor(telegramUserId){
  try{
    return Number(BigInt(String(telegramUserId))%BigInt(cfg.runtimeBuckets));
  }catch{
    const h=crypto.createHash('sha256').update(String(telegramUserId||'')).digest();
    return h.readUInt32BE(0)%cfg.runtimeBuckets;
  }
}

export function accountAssignedToWorker(telegramUserId,workerIndex=cfg.workerIndex,workerCount=cfg.workerCount){
  const bucket=runtimeBucketFor(telegramUserId);
  return Math.min(workerCount-1,Math.floor((bucket*workerCount)/cfg.runtimeBuckets))===workerIndex;
}

function workerBucketRange(workerIndex=cfg.workerIndex,workerCount=cfg.workerCount){
  const start=Math.floor((workerIndex*cfg.runtimeBuckets)/workerCount);
  const end=Math.floor(((workerIndex+1)*cfg.runtimeBuckets)/workerCount)-1;
  return {start,end:Math.max(start,end)};
}

export async function saveAccount({me,session,phone}){
  const d=await db(),now=new Date();
  const telegramUserId=String(me.id);
  const reserved=await reservedWatcherId();
  if(reserved&&telegramUserId===reserved)throw new Error('This Telegram account is reserved for NexCanal watcher');
  const telegramLanguage=String(me.langCode||me.lang_code||'');
  const countryIso=countryFromPhone(phone);
  const preferredLanguage=uiLanguage(telegramLanguage);
  const doc={
    telegramUserId,
    username:me.username||'',
    firstName:me.firstName||'',
    lastName:me.lastName||'',
    premium:me.premium===true,
    telegramLanguage,
    preferredLanguage,
    countryIso,
    runtimeBucket:runtimeBucketFor(telegramUserId),
    phoneMasked:maskPhone(phone),
    sessionEncrypted:encryptSession(session),
    enabled:true,
    connectedAt:now,
    updatedAt:now
  };
  await d.collection('nexaccount_accounts').updateOne(
    {telegramUserId},
    {$set:doc,$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
  await d.collection('nexaccount_settings').updateOne(
    {telegramUserId},
    {$setOnInsert:{
      telegramUserId,
      language:preferredLanguage,
      style:cfg.defaultStyle,
      prefix:'.',
      autoReact:{enabled:cfg.autoReact,mode:'smart',targets:[...cfg.autoReactTargets],reactions:['🔥','❤️','👍']},
      autoJoin:{enabled:cfg.autoJoin,targets:[...cfg.autoJoinTargets]},
      welcome:{enabled:true,text:preferredLanguage==='fr'?'Bienvenue {name} dans {group}.':'Welcome {name} to {group}.'},
      goodbye:{enabled:false,text:preferredLanguage==='fr'?'Au revoir {name}.':'Goodbye {name}.'},
      antilink:{enabled:false,allowAdmins:true,allowlist:[]},
      createdAt:now
    },$set:{updatedAt:now}},
    {upsert:true}
  );
  return doc;
}

export async function listAccounts(){
  const d=await db();
  const reserved=await reservedWatcherId();
  const query=reserved?{enabled:true,telegramUserId:{$ne:reserved}}:{enabled:true};
  return d.collection('nexaccount_accounts').find(query,{projection:{sessionEncrypted:0}}).sort({connectedAt:1}).toArray();
}

export async function listAccountsForWorker({limit=cfg.maxRuntimesPerWorker}={}){
  const d=await db();
  const reserved=await reservedWatcherId();
  const {start,end}=workerBucketRange();
  const query={
    enabled:true,
    runtimeBucket:{$gte:start,$lte:end},
    ...(reserved?{telegramUserId:{$ne:reserved}}:{})
  };
  return d.collection('nexaccount_accounts')
    .find(query,{projection:{sessionEncrypted:0}})
    .sort({connectedAt:1})
    .limit(Math.max(1,Number(limit)||cfg.maxRuntimesPerWorker))
    .toArray();
}

export async function acquireRuntimeLease(telegramUserId,workerId=cfg.workerId,ttlMs=cfg.runtimeLeaseMs){
  const d=await db(),now=new Date(),expiresAt=new Date(Date.now()+ttlMs),id=String(telegramUserId);
  try{
    const row=await d.collection('nexaccount_runtime_leases').findOneAndUpdate(
      {_id:id,$or:[{workerId:String(workerId)},{expiresAt:{$lte:now}},{expiresAt:{$exists:false}}]},
      {$set:{workerId:String(workerId),expiresAt,updatedAt:now},$setOnInsert:{createdAt:now}},
      {upsert:true,returnDocument:'after'}
    );
    return String(row?.workerId||'')===String(workerId);
  }catch(e){
    if(Number(e?.code)===11000)return false;
    throw e;
  }
}

export async function renewRuntimeLease(telegramUserId,workerId=cfg.workerId,ttlMs=cfg.runtimeLeaseMs){
  const d=await db(),now=new Date(),expiresAt=new Date(Date.now()+ttlMs),id=String(telegramUserId);
  const result=await d.collection('nexaccount_runtime_leases').updateOne(
    {_id:id,workerId:String(workerId)},
    {$set:{expiresAt,updatedAt:now}}
  );
  return result.matchedCount===1;
}

export async function releaseRuntimeLease(telegramUserId,workerId=cfg.workerId){
  const d=await db();
  const result=await d.collection('nexaccount_runtime_leases').deleteOne({_id:String(telegramUserId),workerId:String(workerId)});
  return result.deletedCount===1;
}

export async function accountRecord(telegramUserId){
  const d=await db();
  return d.collection('nexaccount_accounts').findOne(
    {telegramUserId:String(telegramUserId)},
    {projection:{sessionEncrypted:0}}
  );
}

export async function enableAccount(telegramUserId){
  const reserved=await reservedWatcherId();
  if(reserved&&String(telegramUserId)===reserved)throw new Error('NexCanal watcher account cannot be enabled in NexAccount');
  const d=await db();
  await d.collection('nexaccount_accounts').updateOne(
    {telegramUserId:String(telegramUserId)},
    {$set:{enabled:true,updatedAt:new Date()}}
  );
  return accountRecord(telegramUserId);
}

export async function accountWithSession(telegramUserId){
  const reserved=await reservedWatcherId();
  if(reserved&&String(telegramUserId)===reserved)return null;
  const d=await db();
  const a=await d.collection('nexaccount_accounts').findOne({telegramUserId:String(telegramUserId),enabled:true});
  if(!a)return null;
  return {...a,session:decryptSession(a.sessionEncrypted)};
}

export async function settingsFor(telegramUserId){
  const d=await db();
  return d.collection('nexaccount_settings').findOne({telegramUserId:String(telegramUserId)})||{
    telegramUserId:String(telegramUserId),language:'fr',style:cfg.defaultStyle,prefix:'.',
    autoReact:{enabled:cfg.autoReact,mode:'smart',targets:[...cfg.autoReactTargets],reactions:['🔥','❤️','👍']},
    autoJoin:{enabled:cfg.autoJoin,targets:[...cfg.autoJoinTargets]},
    welcome:{enabled:true,text:'Bienvenue {name} dans {group}.'},
    goodbye:{enabled:false,text:'Au revoir {name}.'},
    antilink:{enabled:false,allowAdmins:true,allowlist:[]}
  };
}

export async function patchSettings(telegramUserId,patch){
  const d=await db(),now=new Date();
  const safe={...patch};
  if(safe.language!==undefined)safe.language=String(safe.language).toLowerCase().startsWith('en')?'en':'fr';
  await d.collection('nexaccount_settings').updateOne(
    {telegramUserId:String(telegramUserId)},
    {$set:{...safe,updatedAt:now},$setOnInsert:{telegramUserId:String(telegramUserId),createdAt:now}},
    {upsert:true}
  );
  return settingsFor(telegramUserId);
}

export async function disableAccount(telegramUserId){
  const d=await db();
  await d.collection('nexaccount_accounts').updateOne({telegramUserId:String(telegramUserId)},{$set:{enabled:false,updatedAt:new Date()}});
}

export async function closeStore(){
  if(clientPromise){
    try{(await clientPromise).close();}catch{}
    clientPromise=null;
  }
}
