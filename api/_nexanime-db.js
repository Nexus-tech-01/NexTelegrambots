import {MongoClient} from 'mongodb';
let clientPromise=null;
export async function getDb(){
  const uri=process.env.NEXUS_MONGODB_URI||'';
  if(!uri)throw new Error('NEXUS_MONGODB_URI missing');
  if(!clientPromise)clientPromise=new MongoClient(uri,{maxPoolSize:4,minPoolSize:0}).connect();
  return (await clientPromise).db(process.env.NEXUS_MONGODB_DB_NAME||'nexus_bots');
}
