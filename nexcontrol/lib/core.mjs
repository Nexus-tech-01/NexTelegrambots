import crypto from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

let clientPromise, indexed = false;
export const X = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const A = s => X(s).replace(/`/g, '&#96;');
export const env = n => { if(!process.env[n]) throw new Error(`${n} missing`); return process.env[n]; };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const sign = s => crypto.createHmac('sha256', env('SESSION_SECRET')).update(s).digest('base64url');

export async function db(){
  clientPromise ??= new MongoClient(env('MONGODB_URI')).connect();
  const d = (await clientPromise).db(process.env.NEXCONTROL_DB_NAME || 'nexcontrol');
  if(!indexed){
    indexed = true;
    await Promise.all([
      d.collection('bots').createIndex({slug:1},{unique:true}),
      d.collection('bots').createIndex({apiKeyHash:1},{unique:true}),
      d.collection('destinations').createIndex({botId:1,chatId:1},{unique:true}),
      d.collection('deliveries').createIndex({botId:1,status:1,availableAt:1})
    ]).catch(e=>{indexed=false;throw e});
  }
  return d;
}

function cookies(r){
  return Object.fromEntries(String(r.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
}
export function newSession(){
  const payload=Buffer.from(JSON.stringify({exp:Date.now()+6048e5})).toString('base64url');
  return payload+'.'+sign(payload);
}
export function isAdmin(r){
  const v=cookies(r).nexcontrol_session;if(!v)return false;
  const [p,s]=v.split('.');
  try{return p&&s&&sign(p)===s&&JSON.parse(Buffer.from(p,'base64url')).exp>Date.now()}catch{return false}
}
export async function body(r){
  if(r.body&&typeof r.body==='object')return r.body;
  const a=[];for await(const c of r)a.push(c);
  const t=Buffer.concat(a).toString(),ct=r.headers['content-type']||'';
  if(ct.includes('json'))try{return JSON.parse(t)}catch{return{}};
  return Object.fromEntries(new URLSearchParams(t));
}
export const json=(s,n,o)=>(s.statusCode=n,s.setHeader('content-type','application/json'),s.end(JSON.stringify(o)));
export const redirect=(s,u)=>(s.statusCode=303,s.setHeader('location',u),s.end());
export const typeLabel=t=>({group:'Groupe',supergroup:'Supergroupe',channel:'Chaîne'}[t]||t);
export const fmtDate=v=>{try{return v?new Intl.DateTimeFormat('fr-FR',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)):'Jamais'}catch{return '—'}};

export function permission(type,status,r={}){
  if(['left','kicked'].includes(status))return[false,status==='left'?'Bot sorti':'Bot banni'];
  if(type==='channel'){
    if(status==='creator')return[true,''];
    if(status!=='administrator')return[false,'Bot non administrateur'];
    if(r.can_post_messages===false)return[false,'can_post_messages refusé'];
    return[true,''];
  }
  if(status==='restricted'&&r.can_send_messages===false)return[false,'Envoi de messages restreint'];
  return[['member','administrator','creator','restricted'].includes(status),'Statut Telegram insuffisant'];
}

async function authenticatedBot(r){
  const key=r.headers['x-nexcontrol-key']||String(r.headers.authorization||'').replace(/^Bearer\s+/i,'');
  return key?(await db()).collection('bots').findOne({apiKeyHash:hash(key),enabled:true}):null;
}

export async function botApi(r,s,p){
  const b=await authenticatedBot(r);if(!b)return json(s,401,{error:'unauthorized'});
  const d=await db(),q=await body(r),now=new Date();
  if(p==='/api/v1/heartbeat'){
    await d.collection('bots').updateOne({_id:b._id},{$set:{lastHeartbeatAt:now,version:q.version,username:q.username,updatedAt:now}});
    return json(s,200,{ok:true});
  }
  if(p==='/api/v1/destinations/known'){
    const a=await d.collection('destinations').find({botId:b._id,active:true},{projection:{chatId:1}}).sort({lastVerifiedAt:1}).limit(200).toArray();
    return json(s,200,{chatIds:a.map(x=>x.chatId)});
  }
  if(p==='/api/v1/destinations/sync'){
    let synced=0;
    for(const x of(q.items||[]).slice(0,500)){
      if(!['group','supergroup','channel'].includes(x.type)||!x.chatId)continue;
      const [can,reason]=permission(x.type,x.botStatus||'unknown',x.rights||{});
      await d.collection('destinations').updateOne({botId:b._id,chatId:String(x.chatId)},{$set:{type:x.type,title:String(x.title||x.chatId),username:x.username,botStatus:x.botStatus||'unknown',rights:x.rights||{},canPublish:can,publishBlockReason:reason,active:x.active!==false,lastSeenAt:now,lastVerifiedAt:now,updatedAt:now},$setOnInsert:{botId:b._id,chatId:String(x.chatId),createdAt:now}},{upsert:true});
      synced++;
    }
    return json(s,200,{ok:true,synced});
  }
  if(p==='/api/v1/jobs/claim'){
    await d.collection('deliveries').updateMany({botId:b._id,status:'claimed',claimExpiresAt:{$lt:now}},{$set:{status:'pending'}});
    const jobs=[];
    for(let i=0;i<Math.min(10,+q.limit||8);i++){
      const z=await d.collection('deliveries').findOneAndUpdate({botId:b._id,status:'pending',availableAt:{$lte:now}},{$set:{status:'claimed',claimedAt:now,claimExpiresAt:new Date(+now+9e4)},$inc:{attempts:1}},{returnDocument:'after'});
      if(!z)break;
      jobs.push({...z,_id:String(z._id),campaignId:String(z.campaignId),destinationId:String(z.destinationId)});
    }
    return json(s,200,{jobs});
  }
  if(p==='/api/v1/jobs/result'){
    if(!ObjectId.isValid(q.jobId))return json(s,400,{error:'bad_job'});
    const z=await d.collection('deliveries').findOne({_id:new ObjectId(q.jobId),botId:b._id});
    if(!z)return json(s,404,{error:'not_found'});
    await d.collection('deliveries').updateOne({_id:z._id},{$set:{status:q.ok?'sent':'failed',sentAt:q.ok?now:undefined,error:q.ok?undefined:String(q.error||'error'),updatedAt:now},$unset:{claimedAt:'',claimExpiresAt:''}});
    const left=await d.collection('deliveries').countDocuments({campaignId:z.campaignId,status:{$in:['pending','claimed']}});
    if(!left)await d.collection('campaigns').updateOne({_id:z.campaignId},{$set:{status:'completed'}});
    return json(s,200,{ok:true});
  }
  return json(s,404,{error:'not_found'});
}

export async function registerBot(r,s){
  const q=await body(r),key='nxc_'+crypto.randomBytes(32).toString('base64url'),d=await db();
  const x=await d.collection('bots').insertOne({slug:q.slug,displayName:q.displayName,username:q.username?.replace(/^@/,''),apiKeyHash:hash(key),enabled:true,createdAt:new Date()});
  return json(s,200,{ok:true,botId:String(x.insertedId),apiKey:key});
}

export async function createCampaign(r,s){
  const q=await body(r),ids=(q.botIds||[]).filter(ObjectId.isValid).map(x=>new ObjectId(x));
  if(!ids.length||(!q.text&&!q.mediaUrl))return json(s,400,{error:'invalid_campaign'});
  const d=await db(),filter={botId:{$in:ids},active:true,canPublish:true};
  if(q.types?.length)filter.type={$in:q.types};
  const ds=await d.collection('destinations').find(filter).toArray(),now=new Date(),at=q.scheduledAt?new Date(q.scheduledAt):now;
  const c=await d.collection('campaigns').insertOne({title:q.title||'Annonce',text:q.text||'',mediaUrl:q.mediaUrl||'',botIds:ids,status:'queued',scheduledAt:at,createdAt:now});
  if(ds.length)await d.collection('deliveries').insertMany(ds.map(x=>({campaignId:c.insertedId,botId:x.botId,destinationId:x._id,chatId:x.chatId,destinationTitle:x.title,status:'pending',availableAt:at,attempts:0,payload:{text:q.text||'',mediaUrl:q.mediaUrl||'',parseMode:'HTML'},createdAt:now})));
  return json(s,200,{ok:true,deliveries:ds.length});
}
