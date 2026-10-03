import { MongoClient } from 'mongodb';

const uri=String(process.env.MONGO_URI||process.env.MONGODB_URI||'').trim();
const dbName=String(process.env.MONGODB_DB_NAME||'nexus_bots').trim()||'nexus_bots';
const prefix=String(process.env.MONGODB_COLLECTION_PREFIX||'nexstick_').trim()||'nexstick_';

let client=null,collection=null,connecting=null;

async function col(){
  if(collection)return collection;
  if(!uri)return null;
  if(!connecting){
    connecting=(async()=>{
      client=new MongoClient(uri,{maxPoolSize:4,minPoolSize:0,serverSelectionTimeoutMS:8000});
      await client.connect();
      collection=client.db(dbName).collection(prefix+'users');
      await collection.createIndex({userId:1},{unique:true});
      return collection;
    })().catch(error=>{connecting=null;throw error});
  }
  return connecting;
}

export async function rememberPack(userId,pack){
  const c=await col().catch(()=>null);
  if(!c)return;
  const now=new Date();
  await c.updateOne(
    {userId:Number(userId)},
    {$setOnInsert:{createdAt:now},$set:{updatedAt:now},$push:{packs:{$each:[{...pack,updatedAt:now}],$position:0,$slice:100}}},
    {upsert:true}
  ).catch(()=>{});
}

export async function packsFor(userId){
  const c=await col().catch(()=>null);
  if(!c)return [];
  const row=await c.findOne({userId:Number(userId)},{projection:{packs:1}});
  return Array.isArray(row?.packs)?row.packs:[];
}

export async function closeStore(){
  if(client)await client.close().catch(()=>{});
}
