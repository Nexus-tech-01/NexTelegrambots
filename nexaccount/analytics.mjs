import { db, listAccounts } from './store.mjs';
import { touchAnalyticsUser } from './analytics-indexer.mjs';

const asDate=value=>{
  if(!value)return null;
  const d=value instanceof Date?value:new Date(value);
  return Number.isNaN(d.getTime())?null:d;
};

const accountFirstSeen=account=>asDate(account?.createdAt||account?.connectedAt);
const accountActivityAt=account=>asDate(
  account?.lastActivityAt||
  account?.lastRuntimeSeenAt||
  account?.updatedAt||
  account?.connectedAt||
  account?.createdAt
);

async function multisessionAccounts(){
  return listAccounts();
}

async function liveRuntimeMap(accounts=[]){
  const ids=accounts.map(a=>String(a.telegramUserId||'')).filter(Boolean);
  if(!ids.length)return new Map();
  const d=await db();
  const rows=await d.collection('nexaccount_runtime_leases').find({
    _id:{$in:ids},
    expiresAt:{$gt:new Date()}
  }).toArray();
  return new Map(rows.map(row=>[String(row._id),row]));
}

function languageOf(account){
  const raw=String(account?.preferredLanguage||account?.telegramLanguage||'').trim().toLowerCase().replace('_','-');
  if(!raw)return 'unknown';
  if(raw.startsWith('fr'))return 'fr';
  if(raw.startsWith('en'))return 'en';
  return raw.slice(0,12);
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
  const d=await db(),now=new Date();
  await d.collection('nexai_events').insertOne({
    telegramUserId:id,
    type:String(type||'interaction'),
    source:String(meta.source||'nexai'),
    command:String(meta.command||''),
    chatType:String(meta.chatType||''),
    createdAt:now
  });
  if(String(meta.source||'')==='nexaccount'){
    await d.collection('nexaccount_accounts').updateOne(
      {telegramUserId:id,enabled:true},
      {$set:{lastActivityAt:now,lastRuntimeSeenAt:now}}
    ).catch(()=>{});
  }
}

export async function analyticsSummary(){
  const accounts=await multisessionAccounts();
  const live=await liveRuntimeMap(accounts);
  const d24=Date.now()-86400000;
  const countries=new Set();
  let active24=0,new24=0,tgPremium=0;
  for(const account of accounts){
    const id=String(account.telegramUserId||'');
    const activity=accountActivityAt(account)?.getTime()||0;
    const first=accountFirstSeen(account)?.getTime()||0;
    if(live.has(id)||activity>=d24)active24++;
    if(first>=d24)new24++;
    if(account.premium===true)tgPremium++;
    const country=String(account.countryIso||'').trim().toUpperCase();
    if(country)countries.add(country);
  }
  return {
    users:accounts.length,
    active24,
    new24,
    tgPremium,
    paired:accounts.length,
    live:live.size,
    countries:countries.size
  };
}

export async function botStats(){
  const accounts=await multisessionAccounts();
  const live=await liveRuntimeMap(accounts);
  const ids=accounts.map(a=>String(a.telegramUserId||'')).filter(Boolean);
  const d=await db();
  const settings=ids.length
    ? await d.collection('nexaccount_settings').find(
        {telegramUserId:{$in:ids}},
        {projection:{telegramUserId:1,accessMode:1}}
      ).toArray()
    : [];
  const publicMode=settings.filter(s=>s.accessMode==='public').length;
  const premium=accounts.filter(a=>a.premium===true).length;
  const repairRequired=accounts.filter(a=>a.sessionRepairRequired===true).length;
  return {
    total:accounts.length,
    live:live.size,
    offline:Math.max(0,accounts.length-live.size),
    premium,
    repairRequired,
    publicMode,
    privateMode:Math.max(0,accounts.length-publicMode),
    workers:new Set([...live.values()].map(x=>String(x.workerId||'')).filter(Boolean)).size
  };
}

export async function activityStats(){
  const accounts=await multisessionAccounts();
  const live=await liveRuntimeMap(accounts);
  const now=Date.now();
  const countSince=ms=>accounts.filter(account=>{
    const id=String(account.telegramUserId||'');
    if(live.has(id))return true;
    const t=accountActivityAt(account)?.getTime()||0;
    return t>=now-ms;
  }).length;
  return {
    live:live.size,
    day:countSince(86400000),
    week:countSince(7*86400000),
    month:countSince(30*86400000),
    total:accounts.length
  };
}

export async function growthStats(days=14){
  const accounts=await multisessionAccounts();
  const n=Math.max(1,Math.min(60,Number(days)||14));
  const start=new Date();start.setHours(0,0,0,0);start.setDate(start.getDate()-(n-1));
  const counts=new Map();
  for(const account of accounts){
    const first=accountFirstSeen(account);
    if(!first||first<start)continue;
    const key=new Date(first.getTime()-first.getTimezoneOffset()*60000).toISOString().slice(0,10);
    counts.set(key,(counts.get(key)||0)+1);
  }
  const out=[];
  for(let i=0;i<n;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);
    const key=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    out.push({date:key,count:counts.get(key)||0});
  }
  return out;
}

export async function countryStats(limit=15){
  const accounts=await multisessionAccounts();
  const counts=new Map();
  let unknown=0;
  for(const account of accounts){
    const country=String(account.countryIso||'').trim().toUpperCase();
    if(!country){unknown++;continue}
    counts.set(country,(counts.get(country)||0)+1);
  }
  const rows=[...counts.entries()]
    .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
    .slice(0,Math.max(1,Math.min(50,Number(limit)||15)))
    .map(([country,count])=>({country,count}));
  return {known:accounts.length-unknown,unknown,rows};
}

export async function languageStats(){
  const accounts=await multisessionAccounts();
  const counts=new Map();
  for(const account of accounts){
    const language=languageOf(account);
    counts.set(language,(counts.get(language)||0)+1);
  }
  return [...counts.entries()]
    .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
    .map(([_id,count])=>({_id,count}));
}

export async function usersList(limit=40){
  const accounts=await multisessionAccounts();
  const live=await liveRuntimeMap(accounts);
  return accounts
    .map(account=>({
      telegramUserId:String(account.telegramUserId||''),
      username:String(account.username||''),
      firstName:String(account.firstName||''),
      lastName:String(account.lastName||''),
      premium:account.premium===true,
      countryIso:String(account.countryIso||'').toUpperCase(),
      language:languageOf(account),
      connectedAt:account.connectedAt||account.createdAt||null,
      lastActivityAt:accountActivityAt(account),
      live:live.has(String(account.telegramUserId||'')),
      sessionRepairRequired:account.sessionRepairRequired===true,
      sessionRepairReason:String(account.sessionRepairReason||''),
      sessionRepairAt:account.sessionRepairAt||null
    }))
    .sort((a,b)=>Number(b.live)-Number(a.live)||(new Date(b.connectedAt||0)-new Date(a.connectedAt||0)))
    .slice(0,Math.max(1,Math.min(100,Number(limit)||40)));
}

export async function userAnalytics(query){
  const accounts=await multisessionAccounts();
  const raw=String(query||'').trim();
  const needle=raw.startsWith('@')?raw.slice(1).toLowerCase():'';
  const account=raw.startsWith('@')
    ? accounts.find(a=>String(a.username||'').toLowerCase()===needle)
    : accounts.find(a=>String(a.telegramUserId||'')===raw);
  if(!account)return null;

  const id=String(account.telegramUserId||'');
  const d=await db(),now=new Date();
  const [lease,settings,eventCount,lastEvent]=await Promise.all([
    d.collection('nexaccount_runtime_leases').findOne({_id:id,expiresAt:{$gt:now}}),
    d.collection('nexaccount_settings').findOne({telegramUserId:id}),
    d.collection('nexai_events').countDocuments({telegramUserId:id,source:'nexaccount',type:'command'}),
    d.collection('nexai_events').find({telegramUserId:id,source:'nexaccount'}).sort({createdAt:-1}).limit(1).next()
  ]);

  return {
    telegramUserId:id,
    username:String(account.username||''),
    firstName:String(account.firstName||''),
    lastName:String(account.lastName||''),
    countryIso:String(account.countryIso||'').toUpperCase(),
    language:languageOf(account),
    telegramPremium:account.premium===true,
    paired:true,
    live:Boolean(lease),
    workerId:String(lease?.workerId||''),
    accessMode:settings?.accessMode==='public'?'public':'private',
    prefix:String(settings?.prefix||'.'),
    firstSeen:accountFirstSeen(account),
    lastSeen:lastEvent?.createdAt||accountActivityAt(account),
    totalCommandCount:eventCount,
    sessionRepairRequired:account.sessionRepairRequired===true,
    sessionRepairReason:String(account.sessionRepairReason||''),
    sessionRepairAt:account.sessionRepairAt||null,
    sources:['nexaccount']
  };
}

export async function commandStats(){
  const d=await db();
  return d.collection('nexai_events').aggregate([
    {$match:{source:'nexaccount',type:'command',command:{$nin:['',null]}}},
    {$group:{_id:{$toLower:'$command'},count:{$sum:1}}},
    {$sort:{count:-1,_id:1}},
    {$limit:20},
    {$project:{_id:0,command:'$_id',count:1}}
  ]).toArray();
}
