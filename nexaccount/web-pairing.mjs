import crypto from 'node:crypto';
import { db } from './store.mjs';
import { cfg } from './config.mjs';

let indexesPromise;
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');

async function collection(){
  const d=await db();
  const c=d.collection('nexai_web_pairings');
  indexesPromise ??= Promise.all([
    c.createIndex({id:1},{unique:true}),
    c.createIndex({tokenHash:1},{unique:true}),
    c.createIndex({expiresAt:1},{expireAfterSeconds:0}),
    d.collection('nexai_platform_links').createIndex({telegramUserId:1},{unique:true})
  ]);
  await indexesPromise;
  return {d,c};
}

export async function createWebPairing(){
  const {c}=await collection();
  const id=crypto.randomUUID();
  const token=crypto.randomBytes(24).toString('base64url');
  const now=new Date();
  const expiresAt=new Date(now.getTime()+10*60*1000);
  await c.insertOne({
    id,
    tokenHash:hash(token),
    stage:'waiting',
    createdAt:now,
    expiresAt
  });
  const username=String(cfg.botUsername||'NexAi01_bot').replace(/^@/,'');
  return {
    id,
    stage:'waiting',
    expiresAt:expiresAt.toISOString(),
    botUrl:'https://t.me/'+username+'?start=web_'+token
  };
}

export async function claimWebPairing(token,user){
  const value=String(token||'').trim();
  if(!/^[A-Za-z0-9_-]{20,80}$/.test(value))return null;
  const {d,c}=await collection();
  const now=new Date();
  const telegramUserId=String(user?.id||'');
  if(!telegramUserId)return null;
  const linked={
    telegramUserId,
    username:String(user?.username||''),
    firstName:String(user?.first_name||user?.firstName||''),
    lastName:String(user?.last_name||user?.lastName||''),
    languageCode:String(user?.language_code||user?.languageCode||''),
    linkedAt:now,
    updatedAt:now
  };
  const result=await c.findOneAndUpdate(
    {tokenHash:hash(value),stage:'waiting',expiresAt:{$gt:now}},
    {$set:{stage:'linked',linkedAt:now,user:linked}},
    {returnDocument:'after'}
  );
  if(!result)return null;
  await d.collection('nexai_platform_links').updateOne(
    {telegramUserId},
    {$set:linked,$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
  return {id:result.id,stage:'linked',user:linked};
}

export async function webPairingStatus(id){
  const {c}=await collection();
  const doc=await c.findOne({id:String(id||'')});
  if(!doc)return {id:String(id||''),stage:'missing'};
  if(doc.expiresAt<=new Date()&&doc.stage==='waiting')return {id:doc.id,stage:'expired'};
  return {
    id:doc.id,
    stage:doc.stage,
    expiresAt:doc.expiresAt?.toISOString?.()||doc.expiresAt,
    user:doc.stage==='linked'?{
      telegramUserId:doc.user?.telegramUserId,
      username:doc.user?.username||'',
      firstName:doc.user?.firstName||''
    }:undefined
  };
}
