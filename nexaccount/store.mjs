import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { cfg, sessionKey } from './config.mjs';

let clientPromise;
let indexesReady=false;
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
      d.collection('nexaccount_runtime_leases').createIndex({expiresAt:1},{expireAfterSeconds:0}),
      d.collection('nexaccount_session_leases').createIndex({expiresAt:1},{expireAfterSeconds:0}),
      d.collection('nexaccount_pairing_state').createIndex({expiresAt:1},{expireAfterSeconds:0}),
      d.collection('nexaccount_command_claims').createIndex({expiresAt:1},{expireAfterSeconds:0}),
      d.collection('nexaccount_custom_emoji_library').createIndex({sourceUsername:1,documentId:1},{unique:true}),
      d.collection('nexaccount_custom_emoji_library').createIndex({sourceUsername:1,altNormalized:1,animated:-1,updatedAt:-1}),
      d.collection('nexaccount_premium_entitlements').createIndex({telegramUserId:1},{unique:true}),
      d.collection('nexaccount_premium_entitlements').createIndex({expiresAt:1}),
      d.collection('nexaccount_quotas').createIndex({resetAt:1},{expireAfterSeconds:0})
    ]).catch(e=>{indexesReady=false;throw e;});
    await d.collection('nexaccount_accounts').updateMany(
      {runtimeBucket:{$exists:false}},
      [{$set:{runtimeBucket:{$toInt:{$mod:[{$toLong:'$telegramUserId'},cfg.runtimeBuckets]}}}}]
    ).catch(e=>console.warn('[NexAccount store] runtime bucket migration skipped:',String(e?.message||e)));
  }
  return d;
}

export function sessionFingerprint(value){
  const raw=String(value||'');
  if(!raw)throw new Error('Telegram session fingerprint requires a non-empty session');
  return crypto.createHash('sha256').update(raw,'utf8').digest('hex');
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

export async function saveAccount({me,session,phone,enabled=true}){
  const d=await db(),now=new Date();
  const telegramUserId=String(me.id);
  const telegramLanguage=String(me.langCode||me.lang_code||'');
  const countryIso=countryFromPhone(phone);
  const preferredLanguage=uiLanguage(telegramLanguage);
  const doc={
    telegramUserId,
    username:me.username||'',
    firstName:me.firstName||'',
    lastName:me.lastName||'',
    premium:me.premium===true,
    telegramPremium:me.premium===true,
    telegramLanguage,
    preferredLanguage,
    countryIso,
    runtimeBucket:runtimeBucketFor(telegramUserId),
    phoneMasked:maskPhone(phone),
    sessionEncrypted:encryptSession(session),
    sessionFingerprint:sessionFingerprint(session),
    enabled:enabled===true,
    sessionRepairRequired:false,
    sessionRepairReason:'',
    sessionRepairAt:null,
    connectedAt:now,
    updatedAt:now
  };
  await d.collection('nexaccount_accounts').updateOne(
    {telegramUserId},
    {
      $set:doc,
      $setOnInsert:{createdAt:now}
    },
    {upsert:true}
  );
  await d.collection('nexaccount_settings').updateOne(
    {telegramUserId},
    {$setOnInsert:{
      telegramUserId,
      language:preferredLanguage,
      style:cfg.defaultStyle,
      prefix:'.',
      accessMode:'private',
      botDisplayName:'NexAi',
      menuImageUrl:'',
      menuImageStyle:0,
      customEmojiIds:{},
      autoReact:{enabled:true,mode:'smart',targets:['*'],reactions:['🔥','❤️','👍']},
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
  return d.collection('nexaccount_accounts')
    .find({enabled:true},{projection:{sessionEncrypted:0,sessionFingerprint:0}})
    .sort({connectedAt:1})
    .toArray();
}

export async function listAccountsForWorker({limit=cfg.maxRuntimesPerWorker}={}){
  const d=await db();
  const {start,end}=workerBucketRange();
  const query={
    enabled:true,
    sessionRepairRequired:{$ne:true},
    runtimeBucket:{$gte:start,$lte:end}
  };
  return d.collection('nexaccount_accounts')
    .find(query,{projection:{sessionEncrypted:0,sessionFingerprint:0}})
    .sort({connectedAt:1})
    .limit(Math.max(1,Number(limit)||cfg.maxRuntimesPerWorker))
    .toArray();
}

export async function acquireRuntimeLease(telegramUserId,workerId=cfg.workerId,ttlMs=cfg.runtimeLeaseMs){
  const d=await db(),now=new Date(),expiresAt=new Date(Date.now()+ttlMs),id=String(telegramUserId);
  const leases=d.collection('nexaccount_runtime_leases');
  const owner=String(workerId);
  const set={$set:{workerId:owner,expiresAt,updatedAt:now}};

  // A single NexAccount worker is authoritative for all account runtime leases.
  // Reclaim the runtime lease immediately after a supervised restart; the
  // separate session-fingerprint lease still prevents one auth key from being
  // used concurrently by distinct runtimes.
  if(cfg.workerCount===1){
    const updated=await leases.updateOne({_id:id},set);
    if(updated.matchedCount===1)return true;
    try{
      await leases.insertOne({_id:id,workerId:owner,expiresAt,updatedAt:now,createdAt:now});
      return true;
    }catch(error){
      if(Number(error?.code)!==11000)throw error;
      const retried=await leases.updateOne({_id:id},set);
      return retried.matchedCount===1;
    }
  }

  const filter={_id:id,$or:[
    {workerId:owner},
    {expiresAt:{$lte:now}},
    {expiresAt:{$exists:false}}
  ]};
  const updated=await leases.updateOne(filter,set);
  if(updated.matchedCount===1)return true;
  try{
    await leases.insertOne({_id:id,workerId:owner,expiresAt,updatedAt:now,createdAt:now});
    return true;
  }catch(error){
    if(Number(error?.code)===11000)return false;
    throw error;
  }
}

function workerIdentity(value){
  const raw=String(value||'');
  const at=raw.lastIndexOf(':');
  if(at<1)return {host:raw,pid:0};
  return {host:raw.slice(0,at),pid:Number(raw.slice(at+1))||0};
}

function deadPreviousWorkerOnSameHost(previousOwner,currentOwner){
  const previous=workerIdentity(previousOwner),current=workerIdentity(currentOwner);
  if(!previous.host||previous.host!==current.host||!previous.pid||previous.pid===current.pid)return false;
  try{
    process.kill(previous.pid,0);
    return false;
  }catch{
    return true;
  }
}

export async function acquireSessionLease(fingerprint,telegramUserId,workerId=cfg.workerId,ttlMs=cfg.runtimeLeaseMs){
  const key=String(fingerprint||'').trim().toLowerCase();
  const id=String(telegramUserId||'');
  const owner=String(workerId);
  if(!/^[a-f0-9]{64}$/.test(key)||!id)return false;
  const d=await db(),now=new Date(),expiresAt=new Date(Date.now()+ttlMs);
  const leases=d.collection('nexaccount_session_leases');
  const set={$set:{workerId:owner,telegramUserId:id,expiresAt,updatedAt:now}};

  // Fast path for the current owner or an expired/unowned lease.
  const updated=await leases.updateOne(
    {_id:key,$or:[
      {workerId:owner,telegramUserId:id},
      {expiresAt:{$lte:now}},
      {expiresAt:{$exists:false}}
    ]},
    set
  );
  if(updated.matchedCount===1)return true;

  const existing=await leases.findOne({_id:key},{projection:{workerId:1,telegramUserId:1,expiresAt:1}});
  if(existing){
    // A supervised restart changes only the PID portion of cfg.workerId.
    // Reclaim immediately only when the previous owner belongs to the same
    // host, the same Telegram account, and that previous local PID is dead.
    // A live same-host process or any different host must retain the lease.
    if(
      String(existing.telegramUserId||'')===id&&
      deadPreviousWorkerOnSameHost(existing.workerId,owner)
    ){
      const reclaimed=await leases.updateOne(
        {_id:key,workerId:String(existing.workerId||''),telegramUserId:id},
        set
      );
      return reclaimed.matchedCount===1;
    }
    return false;
  }

  try{
    await leases.insertOne({_id:key,workerId:owner,telegramUserId:id,expiresAt,updatedAt:now,createdAt:now});
    return true;
  }catch(error){
    if(Number(error?.code)===11000)return false;
    throw error;
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

export async function renewSessionLease(fingerprint,telegramUserId,workerId=cfg.workerId,ttlMs=cfg.runtimeLeaseMs){
  const key=String(fingerprint||'').trim().toLowerCase();
  const id=String(telegramUserId||'');
  if(!/^[a-f0-9]{64}$/.test(key)||!id)return false;
  const d=await db(),now=new Date(),expiresAt=new Date(Date.now()+ttlMs);
  const result=await d.collection('nexaccount_session_leases').updateOne(
    {_id:key,workerId:String(workerId),telegramUserId:id},
    {$set:{expiresAt,updatedAt:now}}
  );
  return result.matchedCount===1;
}

export async function releaseSessionLease(fingerprint,telegramUserId,workerId=cfg.workerId){
  const key=String(fingerprint||'').trim().toLowerCase();
  const id=String(telegramUserId||'');
  if(!/^[a-f0-9]{64}$/.test(key)||!id)return false;
  const d=await db();
  const result=await d.collection('nexaccount_session_leases').deleteOne(
    {_id:key,workerId:String(workerId),telegramUserId:id}
  );
  return result.deletedCount===1;
}

export async function claimCommandDelivery(telegramUserId,commandKey,{ttlMs=24*60*60*1000}={}){
  const d=await db();
  const now=new Date();
  const ttl=Math.max(60_000,Math.min(7*24*60*60*1000,Number(ttlMs)||24*60*60*1000));
  const id=String(telegramUserId)+':'+String(commandKey||'');
  try{
    await d.collection('nexaccount_command_claims').insertOne({
      _id:id,
      telegramUserId:String(telegramUserId),
      commandKey:String(commandKey||''),
      createdAt:now,
      expiresAt:new Date(now.getTime()+ttl)
    });
    return true;
  }catch(error){
    if(Number(error?.code)===11000)return false;
    throw error;
  }
}

export async function sharedBotIdentity(){
  const d=await db();
  const row=await d.collection('nexaccount_system').findOne({_id:'nexai_bot_identity'});
  return {
    username:String(row?.username||'').trim().replace(/^@/,''),
    telegramBotId:String(row?.telegramBotId||''),
    updatedAt:row?.updatedAt||null
  };
}

export async function saveSharedBotIdentity({username,telegramBotId=''}={}){
  const clean=String(username||'').trim().replace(/^@/,'');
  if(!clean)return sharedBotIdentity();
  const d=await db();
  const now=new Date();
  await d.collection('nexaccount_system').updateOne(
    {_id:'nexai_bot_identity'},
    {$set:{username:clean,telegramBotId:String(telegramBotId||''),updatedAt:now},$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
  return {username:clean,telegramBotId:String(telegramBotId||''),updatedAt:now};
}

export async function accountRecord(telegramUserId){
  const d=await db();
  return d.collection('nexaccount_accounts').findOne(
    {telegramUserId:String(telegramUserId)},
    {projection:{sessionEncrypted:0,sessionFingerprint:0}}
  );
}

export async function enableAccount(telegramUserId){
  const d=await db();
  await d.collection('nexaccount_accounts').updateOne(
    {telegramUserId:String(telegramUserId)},
    {$set:{enabled:true,updatedAt:new Date()}}
  );
  return accountRecord(telegramUserId);
}

export async function accountWithSession(telegramUserId){
  const d=await db();
  const a=await d.collection('nexaccount_accounts').findOne({
    telegramUserId:String(telegramUserId),
    enabled:true,
    sessionRepairRequired:{$ne:true}
  });
  if(!a)return null;
  return {...a,session:decryptSession(a.sessionEncrypted)};
}

export async function markSessionRepairRequired(telegramUserId,reason='session_repair_required'){
  const d=await db(),now=new Date();
  await d.collection('nexaccount_accounts').updateOne(
    {telegramUserId:String(telegramUserId)},
    {$set:{
      enabled:true,
      sessionRepairRequired:true,
      sessionRepairReason:String(reason||'session_repair_required').slice(0,120),
      sessionRepairAt:now,
      updatedAt:now
    }}
  );
  return accountRecord(telegramUserId);
}

export async function clearSessionRepairRequired(telegramUserId){
  const d=await db(),now=new Date();
  await d.collection('nexaccount_accounts').updateOne(
    {telegramUserId:String(telegramUserId)},
    {$set:{
      sessionRepairRequired:false,
      sessionRepairReason:'',
      sessionRepairAt:null,
      updatedAt:now
    }}
  );
  return accountRecord(telegramUserId);
}


function normalizeCustomEmojiAlt(value){
  return String(value??'').replace(/\uFE0F/g,'').replace(/\u200D/g,'').trim();
}

export async function replaceCustomEmojiLibrary({sourceUsername,sourceTelegramUserId='',items=[]}={}){
  const source=String(sourceUsername||'').trim().replace(/^@/,'').toLowerCase();
  if(!source)throw new Error('custom_emoji_source_required');
  const now=new Date();
  const byId=new Map();
  for(const item of Array.isArray(items)?items:[]){
    const documentId=String(item?.documentId||'').trim();
    const alt=String(item?.alt||'').trim();
    if(!/^\d{5,30}$/.test(documentId)||!alt)continue;
    byId.set(documentId,{
      sourceUsername:source,
      sourceTelegramUserId:String(sourceTelegramUserId||''),
      documentId,
      alt,
      altNormalized:normalizeCustomEmojiAlt(alt),
      mimeType:String(item?.mimeType||'').toLowerCase(),
      animated:item?.animated===true,
      stickerSetId:String(item?.stickerSetId||''),
      stickerSetAccessHash:String(item?.stickerSetAccessHash||''),
      stickerSetTitle:String(item?.stickerSetTitle||'').slice(0,200),
      stickerSetShortName:String(item?.stickerSetShortName||'').slice(0,200)
    });
  }
  const rows=[...byId.values()];
  const d=await db();
  const collection=d.collection('nexaccount_custom_emoji_library');
  if(rows.length){
    await collection.bulkWrite(rows.map(row=>({
      updateOne:{
        filter:{sourceUsername:source,documentId:row.documentId},
        update:{$set:{...row,updatedAt:now},$setOnInsert:{createdAt:now}},
        upsert:true
      }
    })),{ordered:false});
  }
  const keep=rows.map(row=>row.documentId);
  await collection.deleteMany({
    sourceUsername:source,
    ...(keep.length?{documentId:{$nin:keep}}:{})
  });
  return {sourceUsername:source,count:rows.length,updatedAt:now};
}

export async function customEmojiLibraryMatches(glyphs,{sourceUsername='tresor20001',animatedOnly=true}={}){
  const source=String(sourceUsername||'').trim().replace(/^@/,'').toLowerCase();
  const wanted=[...new Set((Array.isArray(glyphs)?glyphs:[]).map(normalizeCustomEmojiAlt).filter(Boolean))];
  if(!source||!wanted.length)return [];
  const d=await db();
  return d.collection('nexaccount_custom_emoji_library')
    .find({
      sourceUsername:source,
      altNormalized:{$in:wanted},
      ...(animatedOnly?{animated:true}:{})
    })
    .sort({animated:-1,updatedAt:-1})
    .toArray();
}

export async function customEmojiLibraryStats(sourceUsername='tresor20001'){
  const source=String(sourceUsername||'').trim().replace(/^@/,'').toLowerCase();
  if(!source)return {sourceUsername:'',count:0,animated:0};
  const d=await db();
  const collection=d.collection('nexaccount_custom_emoji_library');
  const [count,animated]=await Promise.all([
    collection.countDocuments({sourceUsername:source}),
    collection.countDocuments({sourceUsername:source,animated:true})
  ]);
  return {sourceUsername:source,count,animated};
}

export async function settingsFor(telegramUserId){
  const d=await db();
  const row=await d.collection('nexaccount_settings').findOne({telegramUserId:String(telegramUserId)});
  if(row)return {...row,accessMode:row.accessMode==='public'?'public':'private'};
  return {
    telegramUserId:String(telegramUserId),language:'fr',style:cfg.defaultStyle,prefix:'.',accessMode:'private',
    botDisplayName:'NexAi',menuImageUrl:'',menuImageStyle:0,customEmojiIds:{},
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
  if(safe.accessMode!==undefined)safe.accessMode=String(safe.accessMode).toLowerCase()==='public'?'public':'private';
  if(safe.prefix!==undefined)safe.prefix=String(safe.prefix||'.').trim().slice(0,4)||'.';
  if(safe.botDisplayName!==undefined)safe.botDisplayName=String(safe.botDisplayName||'NexAi').trim().slice(0,32)||'NexAi';
  if(safe.menuImageUrl!==undefined){
    const url=String(safe.menuImageUrl||'').trim();
    safe.menuImageUrl=/^https?:\/\//i.test(url)?url.slice(0,1000):'';
  }
  if(safe.menuImageStyle!==undefined)safe.menuImageStyle=Math.max(0,Math.min(31,Number(safe.menuImageStyle)||0));
  if(safe.customEmojiIds!==undefined){
    const normalized={};
    for(const [key,value] of Object.entries(safe.customEmojiIds&&typeof safe.customEmojiIds==='object'?safe.customEmojiIds:{})){
      const k=String(key||'').toUpperCase().replace(/[^A-Z0-9_]+/g,'').slice(0,64);
      const v=String(value||'').trim();
      if(/^NEXAI_EMOJI_[A-Z0-9_]+$/.test(k)&&/^\d{5,30}$/.test(v))normalized[k]=v;
      if(Object.keys(normalized).length>=64)break;
    }
    safe.customEmojiIds=normalized;
  }
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

export async function savePairingState(state){
  const d=await db(),now=new Date();
  const createdAt=Number(state?.createdAt||Date.now());
  const connected=String(state?.stage||'')==='connected';
  const expiresAt=new Date(createdAt+(connected?60*60*1000:10*60*1000));
  const session=state?.client?.session?.save?.()||state?.session||'';
  const account=state?.account?{
    telegramUserId:String(state.account.telegramUserId||''),
    username:String(state.account.username||''),
    firstName:String(state.account.firstName||''),
    lastName:String(state.account.lastName||''),
    premium:state.account.premium===true,
    phoneMasked:String(state.account.phoneMasked||'')
  }:null;
  const doc={
    stage:String(state?.stage||'starting'),
    error:String(state?.error||''),
    errorCode:String(state?.errorCode||''),
    codeViaApp:state?.codeViaApp===true,
    codeAttempts:Number(state?.codeAttempts||0),
    passwordAttempts:Number(state?.passwordAttempts||0),
    qrUrl:String(state?.qrUrl||''),
    qrExpiresAt:Number(state?.qrExpiresAt||0),
    expectedTelegramUserId:String(state?.expectedTelegramUserId||''),
    phoneEncrypted:encryptSession(String(state?.phone||'')),
    phoneCodeHashEncrypted:encryptSession(String(state?.phoneCodeHash||'')),
    sessionEncrypted:encryptSession(String(session||'')),
    handedOff:state?.handedOff===true,
    account,
    createdAt:new Date(createdAt),
    updatedAt:now,
    expiresAt
  };
  await d.collection('nexaccount_pairing_state').updateOne({_id:String(state.id)},{$set:doc},{upsert:true});
  return true;
}

export async function pairingStateRecord(id){
  const d=await db();
  const row=await d.collection('nexaccount_pairing_state').findOne({_id:String(id),expiresAt:{$gt:new Date()}});
  if(!row)return null;
  return {
    id:String(row._id),
    stage:String(row.stage||'starting'),
    error:String(row.error||''),
    errorCode:String(row.errorCode||''),
    codeViaApp:row.codeViaApp===true,
    codeAttempts:Number(row.codeAttempts||0),
    passwordAttempts:Number(row.passwordAttempts||0),
    qrUrl:String(row.qrUrl||''),
    qrExpiresAt:Number(row.qrExpiresAt||0),
    expectedTelegramUserId:String(row.expectedTelegramUserId||''),
    phone:decryptSession(row.phoneEncrypted),
    phoneCodeHash:decryptSession(row.phoneCodeHashEncrypted),
    session:decryptSession(row.sessionEncrypted),
    handedOff:row.handedOff===true,
    account:row.account||null,
    createdAt:new Date(row.createdAt||Date.now()).getTime()
  };
}

export async function deletePairingState(id){
  const d=await db();
  await d.collection('nexaccount_pairing_state').deleteOne({_id:String(id)});
  return true;
}


const NEXAI_PREMIUM_PERIOD_MS=30*24*60*60*1000;

export async function nexAiPremiumState(telegramUserId){
  const id=String(telegramUserId||'');
  if(!id)return {active:false,expiresAt:null,autoRenew:false,chargeId:''};
  const d=await db();
  const row=await d.collection('nexaccount_premium_entitlements').findOne({_id:id});
  const expiresAt=row?.expiresAt?new Date(row.expiresAt):null;
  const active=Boolean(expiresAt&&Number.isFinite(expiresAt.getTime())&&expiresAt.getTime()>Date.now());
  return {
    active,
    expiresAt:active?expiresAt:null,
    autoRenew:row?.autoRenew===true,
    chargeId:String(row?.chargeId||''),
    updatedAt:row?.updatedAt||null
  };
}

export async function grantNexAiPremium(telegramUserId,{
  expirationDate=0,
  chargeId='',
  providerChargeId='',
  autoRenew=true,
  amount=250,
  currency='XTR'
}={}){
  const id=String(telegramUserId||'');
  if(!id)throw new Error('telegram_user_id_required');
  const d=await db(),now=new Date();
  const paymentId=String(chargeId||'').trim();
  if(paymentId){
    try{
      await d.collection('nexaccount_premium_payments').insertOne({
        _id:paymentId,
        telegramUserId:id,
        providerChargeId:String(providerChargeId||''),
        amount:Number(amount)||250,
        currency:String(currency||'XTR'),
        createdAt:now
      });
    }catch(error){
      if(Number(error?.code)===11000)return nexAiPremiumState(id);
      throw error;
    }
  }

  const requested=Number(expirationDate)||0;
  let expiresAt;
  if(requested>Math.floor(Date.now()/1000)){
    expiresAt=new Date(requested*1000);
  }else{
    const current=await d.collection('nexaccount_premium_entitlements').findOne({_id:id},{projection:{expiresAt:1}});
    const base=Math.max(Date.now(),new Date(current?.expiresAt||0).getTime()||0);
    expiresAt=new Date(base+NEXAI_PREMIUM_PERIOD_MS);
  }

  await d.collection('nexaccount_premium_entitlements').updateOne(
    {_id:id},
    {
      $set:{
        telegramUserId:id,
        expiresAt,
        autoRenew:autoRenew===true,
        chargeId:paymentId,
        providerChargeId:String(providerChargeId||''),
        amount:Number(amount)||250,
        currency:String(currency||'XTR'),
        updatedAt:now
      },
      $setOnInsert:{createdAt:now}
    },
    {upsert:true}
  );
  return nexAiPremiumState(id);
}

export async function consumeQuota(telegramUserId,key,{limit=1,windowMs=24*60*60*1000}={}){
  const id=String(telegramUserId||'');
  const quotaKey=String(key||'').trim().toLowerCase();
  const max=Math.max(1,Number(limit)||1);
  const span=Math.max(60_000,Number(windowMs)||24*60*60*1000);
  if(!id||!quotaKey)throw new Error('invalid_quota_key');
  const d=await db(),collection=d.collection('nexaccount_quotas');
  const _id=id+':'+quotaKey;

  for(let attempt=0;attempt<4;attempt++){
    const now=new Date();
    const row=await collection.findOne({_id});
    const resetAt=row?.resetAt?new Date(row.resetAt):null;
    if(!row||!resetAt||resetAt.getTime()<=now.getTime()){
      const nextReset=new Date(now.getTime()+span);
      if(!row){
        try{
          await collection.insertOne({_id,telegramUserId:id,key:quotaKey,count:1,windowStartedAt:now,resetAt:nextReset,updatedAt:now});
          return {allowed:true,count:1,remaining:max-1,resetAt:nextReset};
        }catch(error){
          if(Number(error?.code)!==11000)throw error;
          continue;
        }
      }
      const reset=await collection.updateOne(
        {_id,resetAt:row.resetAt,count:Number(row.count)||0},
        {$set:{count:1,windowStartedAt:now,resetAt:nextReset,updatedAt:now}}
      );
      if(reset.matchedCount===1)return {allowed:true,count:1,remaining:max-1,resetAt:nextReset};
      continue;
    }

    const bumped=await collection.updateOne(
      {_id,resetAt:{$gt:now},count:{$lt:max}},
      {$inc:{count:1},$set:{updatedAt:now}}
    );
    if(bumped.matchedCount===1){
      const next=await collection.findOne({_id});
      const count=Math.max(1,Number(next?.count)||1);
      return {allowed:true,count,remaining:Math.max(0,max-count),resetAt:new Date(next.resetAt)};
    }
    const latest=await collection.findOne({_id});
    return {
      allowed:false,
      count:Math.max(max,Number(latest?.count)||max),
      remaining:0,
      resetAt:latest?.resetAt?new Date(latest.resetAt):resetAt
    };
  }

  const latest=await collection.findOne({_id});
  return {
    allowed:false,
    count:Number(latest?.count)||max,
    remaining:0,
    resetAt:latest?.resetAt?new Date(latest.resetAt):new Date(Date.now()+span)
  };
}

export async function closeStore(){
  if(clientPromise){
    try{(await clientPromise).close();}catch{}
    clientPromise=null;
  }
}
