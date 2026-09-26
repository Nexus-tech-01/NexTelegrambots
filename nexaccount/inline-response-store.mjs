import crypto from 'node:crypto';
import { db } from './store.mjs';

const TTL_MS=5*60_000;
let indexReady=false;

async function collection(){
  const d=await db();
  const c=d.collection('nexaccount_inline_responses');
  if(!indexReady){
    indexReady=true;
    await Promise.all([
      c.createIndex({expiresAt:1},{expireAfterSeconds:0}),
      c.createIndex({createdAt:-1})
    ]).catch(error=>{
      indexReady=false;
      throw error;
    });
  }
  return c;
}

export async function putInlineResponse(text,{ttlMs=TTL_MS,accountId=''}={}){
  const token=crypto.randomBytes(12).toString('base64url');
  const now=new Date();
  const ttl=Math.max(10_000,Math.min(300_000,Number(ttlMs)||TTL_MS));
  const c=await collection();
  await c.insertOne({
    _id:token,
    text:String(text??'').slice(0,4096),
    accountId:String(accountId||''),
    createdAt:now,
    expiresAt:new Date(now.getTime()+ttl)
  });
  return token;
}

export async function getInlineResponse(token,accountId=''){
  const c=await collection();
  const row=await c.findOne({
    _id:String(token||''),
    accountId:String(accountId||''),
    expiresAt:{$gt:new Date()}
  });
  if(!row)return null;
  return {text:String(row.text||''),createdAt:row.createdAt,expiresAt:row.expiresAt};
}

export async function deleteInlineResponse(token){
  const c=await collection();
  const result=await c.deleteOne({_id:String(token||'')});
  return result.deletedCount===1;
}
