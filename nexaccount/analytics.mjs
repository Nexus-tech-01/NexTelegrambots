import { db } from './store.mjs';
import { ensureAnalyticsIndex, touchAnalyticsUser } from './analytics-indexer.mjs';

async function index(){
  const d=await db();
  await ensureAnalyticsIndex({waitForFirst:true});
  return d.collection('nexai_user_index');
}

export async function observeUser(from={},meta={}){
  const id=String(from.id??from.telegramUserId??'').trim();
  if(!id)return;
  const d=await db(),now=new Date();
  const language=String(meta.preferredLanguage||'').toLowerCase();
  const set={
    telegramUserId:id,
    username:String(from.username||''),
    firstName:String(from.first_name??from.firstName??''),
    lastName:String(from.last_name??from.lastName??''),
    telegramLanguage:String(from.language_code??from.telegramLanguage??''),
    telegramPremium:from.is_premium===true||from.premium===true,
    lastSeen:now,
    updatedAt:now
  };
  if(language==='fr'||language==='en')set.preferredLanguage=language;
  if(meta.countryIso)set.countryIso=String(meta.countryIso).toUpperCase();

  await d.collection('nexai_users').updateOne(
    {telegramUserId:id},
    {$set:set,$setOnInsert:{firstSeen:now,createdAt:now},$addToSet:{sources:String(meta.source||'nexai')}},
    {upsert:true}
  );

  await touchAnalyticsUser({
    telegramUserId:id,
    username:set.username,
    firstName:set.firstName,
    lastName:set.lastName,
    language:set.preferredLanguage||set.telegramLanguage,
    countryIso:set.countryIso,
    telegramPremium:set.telegramPremium,
    firstSeen:now,
    lastSeen:now
  },String(meta.source||'nexai')).catch(()=>{});
}

export async function recordEvent(from,type,meta={}){
  const id=String(from?.id??from?.telegramUserId??'').trim();
  if(!id)return;
  await observeUser(from,meta);
  const d=await db();
  await d.collection('nexai_events').insertOne({
    telegramUserId:id,
    type:String(type||'interaction'),
    source:String(meta.source||'nexai'),
    command:String(meta.command||''),
    chatType:String(meta.chatType||''),
    createdAt:new Date()
  });
}

export async function analyticsSummary(){
  const c=await index();
  const d24=new Date(Date.now()-86400000);
  const [users,active24,new24,tgPremium,paired,countries]=await Promise.all([
    c.estimatedDocumentCount(),
    c.countDocuments({lastSeen:{$gte:d24}}),
    c.countDocuments({firstSeen:{$gte:d24}}),
    c.countDocuments({telegramPremium:true}),
    c.countDocuments({paired:true}),
    c.distinct('countryIso',{countryIso:{$nin:[null,'']}})
  ]);
  return {users,active24,new24,tgPremium,paired,countries:countries.length};
}

export async function botStats(){
  const c=await index();
  const sources=['nexdownloader','nexgroup','nexgame','nexstick','nexwhisper'];
  const counts=await Promise.all(sources.map(s=>c.countDocuments({sources:s})));
  const [twoPlus,threePlus,allFive,total]=await Promise.all([
    c.countDocuments({$expr:{$gte:[{$size:{$setIntersection:['$sources',sources]}},2]}}),
    c.countDocuments({$expr:{$gte:[{$size:{$setIntersection:['$sources',sources]}},3]}}),
    c.countDocuments({$expr:{$eq:[{$size:{$setIntersection:['$sources',sources]}},5]}}),
    c.estimatedDocumentCount()
  ]);
  return {total,bySource:Object.fromEntries(sources.map((s,i)=>[s,counts[i]]),),multi:{twoPlus,threePlus,allFive}};
}

export async function activityStats(){
  const c=await index(),now=Date.now();
  const [day,week,month,total]=await Promise.all([
    c.countDocuments({lastSeen:{$gte:new Date(now-86400000)}}),
    c.countDocuments({lastSeen:{$gte:new Date(now-7*86400000)}}),
    c.countDocuments({lastSeen:{$gte:new Date(now-30*86400000)}}),
    c.estimatedDocumentCount()
  ]);
  return {day,week,month,total};
}

export async function growthStats(days=14){
  const c=await index();
  const n=Math.max(1,Math.min(60,Number(days)||14));
  const start=new Date();start.setHours(0,0,0,0);start.setDate(start.getDate()-(n-1));
  const rows=await c.aggregate([
    {$match:{firstSeen:{$gte:start}}},
    {$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$firstSeen'}},count:{$sum:1}}},
    {$sort:{_id:1}}
  ]).toArray();
  const map=new Map(rows.map(r=>[r._id,r.count]));
  const out=[];
  for(let i=0;i<n;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);
    const key=d.toISOString().slice(0,10);
    out.push({date:key,count:map.get(key)||0});
  }
  return out;
}

export async function countryStats(limit=15){
  const c=await index();
  const [known,unknown,rows]=await Promise.all([
    c.countDocuments({countryIso:{$nin:[null,'']}}),
    c.countDocuments({$or:[{countryIso:{$exists:false}},{countryIso:null},{countryIso:''}]}),
    c.aggregate([
      {$match:{countryIso:{$nin:[null,'']}}},
      {$group:{_id:'$countryIso',count:{$sum:1}}},
      {$sort:{count:-1}},
      {$limit:Math.max(1,Math.min(50,Number(limit)||15))}
    ]).toArray()
  ]);
  return {known,unknown,rows:rows.map(r=>({country:r._id,count:r.count}))};
}

export async function languageStats(){
  const c=await index();
  return c.aggregate([
    {$group:{_id:{$ifNull:['$language','unknown']},count:{$sum:1}}},
    {$sort:{count:-1}}
  ]).toArray();
}

export async function userAnalytics(query){
  const c=await index();
  const raw=String(query||'').trim();
  const safe=raw.slice(1).replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&');
  const filter=raw.startsWith('@')
    ? {username:{$regex:'^'+safe+'$',$options:'i'}}
    : {telegramUserId:raw};
  const user=await c.findOne(filter);
  if(!user)return null;
  const d=await db();
  const eventCount=await d.collection('nexai_events').countDocuments({telegramUserId:user.telegramUserId});
  const usageBySource=user.usageBySource||{};
  const legacyCount=Object.values(usageBySource).reduce((a,b)=>a+Number(b||0),0);
  return {...user,eventCount,totalCommandCount:legacyCount+eventCount};
}

export async function commandStats(){
  const d=await db();
  await ensureAnalyticsIndex({waitForFirst:true});
  return d.collection('nexai_command_stats').find({}).sort({count:-1}).limit(20).toArray();
}
