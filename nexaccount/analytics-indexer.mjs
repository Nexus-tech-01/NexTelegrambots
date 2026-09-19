import { db } from './store.mjs';

const INDEX='nexai_user_index';
const STATE='nexai_analytics_state';
const COMMANDS='nexai_command_stats';

const asDate=v=>{
  if(!v)return null;
  if(v instanceof Date)return Number.isNaN(v.getTime())?null:v;
  const n=typeof v==='number'?v:Number(v);
  if(Number.isFinite(n)&&n>0){
    const d=new Date(n<1e12?n*1000:n);
    return Number.isNaN(d.getTime())?null:d;
  }
  const d=new Date(v);
  return Number.isNaN(d.getTime())?null:d;
};
const lang=v=>{
  const s=String(v||'').trim().toLowerCase().replace('_','-');
  if(!s)return '';
  if(s.startsWith('fr'))return 'fr';
  if(s.startsWith('en'))return 'en';
  return s.slice(0,12);
};
const activePremium=v=>v===true||['active','premium','pro','paid','enabled'].includes(String(v||'').toLowerCase());

function opFrom(source,row){
  const id=String(row.telegramUserId||'').trim();
  if(!id)return null;
  const set={updatedAt:new Date()};
  if(row.username)set.username=String(row.username);
  if(row.firstName)set.firstName=String(row.firstName);
  if(row.lastName)set.lastName=String(row.lastName);
  if(row.language)set.language=lang(row.language);
  if(row.countryIso)set.countryIso=String(row.countryIso).toUpperCase();
  if(row.telegramPremium===true)set.telegramPremium=true;
  if(row.nexaiPremium===true)set.nexaiPremium=true;
  if(row.paired===true)set.paired=true;
  set['usageBySource.'+source]=Number(row.usageCommandCount||0);
  const update={
    $set:set,
    $setOnInsert:{telegramUserId:id,createdAt:new Date()},
    $addToSet:{sources:source}
  };
  const firstSeen=asDate(row.firstSeen),lastSeen=asDate(row.lastSeen);
  if(firstSeen)update.$min={firstSeen};
  if(lastSeen)update.$max={lastSeen};
  return {updateOne:{filter:{telegramUserId:id},update,upsert:true}};
}

async function indexCursor(index,source,cursor,mapper){
  let ops=[],seen=0;
  for await(const doc of cursor){
    const op=opFrom(source,mapper(doc));
    if(!op)continue;
    ops.push(op);seen++;
    if(ops.length>=500){
      await index.bulkWrite(ops,{ordered:false});
      ops=[];
    }
  }
  if(ops.length)await index.bulkWrite(ops,{ordered:false});
  return seen;
}

async function rebuildCommandStats(d){
  const client=d.client;
  const totals=new Map();
  const add=(cmd,count)=>{
    const key=String(cmd||'').replace(/^\//,'').trim().toLowerCase();
    if(!key)return;
    totals.set(key,(totals.get(key)||0)+Number(count||0));
  };

  const specs=[
    [d.collection('nexdownloader_command_usage'),'count'],
    [d.collection('nexgroup_command_usage'),'count'],
    [d.collection('nexwhisper_command_usage'),'count'],
    [client.db('test').collection('nexgame_command_usage'),'count']
  ];
  for(const [col] of specs){
    const rows=await col.find({},{projection:{command:1,count:1}}).toArray();
    for(const r of rows)add(r.command,r.count);
  }

  const stick=client.db('test').collection('nexstick_command_logs');
  const stickRows=await stick.aggregate([
    {$match:{executed:true}},
    {$group:{_id:'$command',count:{$sum:1}}}
  ],{allowDiskUse:true}).toArray().catch(()=>[]);
  for(const r of stickRows)add(r._id,r.count);

  const out=d.collection(COMMANDS);
  await out.deleteMany({});
  if(totals.size){
    await out.insertMany([...totals.entries()].map(([command,count])=>({command,count,updatedAt:new Date()})),{ordered:false});
    await out.createIndex({count:-1});
  }
}

export async function rebuildAnalyticsIndex(){
  const d=await db(),client=d.client,index=d.collection(INDEX);
  await index.createIndex({telegramUserId:1},{unique:true});
  await Promise.all([
    index.createIndex({lastSeen:-1}),
    index.createIndex({firstSeen:-1}),
    index.createIndex({countryIso:1}),
    index.createIndex({language:1}),
    index.createIndex({sources:1})
  ]);

  const counts={};
  counts.nexdownloader=await indexCursor(
    index,'nexdownloader',
    d.collection('nexdownloader_users').find({},{projection:{telegramId:1,createdAt:1,firstName:1,language:1,lastSeenAt:1,username:1,usageCommandCount:1}}).batchSize(500),
    x=>({telegramUserId:x.telegramId,username:x.username,firstName:x.firstName,language:x.language,firstSeen:x.createdAt,lastSeen:x.lastSeenAt,usageCommandCount:x.usageCommandCount})
  );

  counts.nexgroup=await indexCursor(
    index,'nexgroup',
    d.collection('nexgroup_users').find({},{projection:{telegram_user_id:1,username:1,first_name:1,last_name:1,telegram_language_code:1,preferred_locale:1,created_at:1,updated_at:1,private_started_at:1,usage_command_count:1}}).batchSize(500),
    x=>({telegramUserId:x.telegram_user_id,username:x.username,firstName:x.first_name,lastName:x.last_name,language:x.preferred_locale||x.telegram_language_code,firstSeen:x.created_at||x.private_started_at,lastSeen:x.updated_at,usageCommandCount:x.usage_command_count})
  );

  counts.nexwhisper=await indexCursor(
    index,'nexwhisper',
    d.collection('nexwhisper_users').find({},{projection:{telegramUserId:1,firstName:1,lastName:1,firstSeenAt:1,languageCode:1,lastSeenAt:1,username:1,preferredLocale:1,usageCommandCount:1}}).batchSize(500),
    x=>({telegramUserId:x.telegramUserId,username:x.username,firstName:x.firstName,lastName:x.lastName,language:x.preferredLocale||x.languageCode,firstSeen:x.firstSeenAt,lastSeen:x.lastSeenAt,usageCommandCount:x.usageCommandCount})
  );

  counts.nexgame=await indexCursor(
    index,'nexgame',
    client.db('test').collection('nexgame_users').find({},{projection:{telegramUserId:1,createdAt:1,firstName:1,lastName:1,language:1,updatedAt:1,username:1,usageCommandCount:1}}).batchSize(500),
    x=>({telegramUserId:x.telegramUserId,username:x.username,firstName:x.firstName,lastName:x.lastName,language:x.language,firstSeen:x.createdAt,lastSeen:x.updatedAt,usageCommandCount:x.usageCommandCount})
  );

  counts.nexstick=await indexCursor(
    index,'nexstick',
    client.db('test').collection('nexstick_users').find({},{projection:{telegramId:1,createdAt:1,firstName:1,languageCode:1,lastSeenAt:1,updatedAt:1,username:1,premiumStatus:1}}).batchSize(500),
    x=>({telegramUserId:x.telegramId,username:x.username,firstName:x.firstName,language:x.languageCode,firstSeen:x.createdAt,lastSeen:x.lastSeenAt||x.updatedAt,nexaiPremium:activePremium(x.premiumStatus)})
  );

  counts.nexai=await indexCursor(
    index,'nexai',
    d.collection('nexai_users').find({}).batchSize(500),
    x=>({telegramUserId:x.telegramUserId,username:x.username,firstName:x.firstName,lastName:x.lastName,language:x.preferredLanguage||x.telegramLanguage,countryIso:x.countryIso,telegramPremium:x.telegramPremium===true,firstSeen:x.firstSeen||x.createdAt,lastSeen:x.lastSeen||x.updatedAt})
  );

  counts.nexaccount=await indexCursor(
    index,'nexaccount',
    d.collection('nexaccount_accounts').find({enabled:true},{projection:{sessionEncrypted:0}}).batchSize(500),
    x=>({telegramUserId:x.telegramUserId,username:x.username,firstName:x.firstName,lastName:x.lastName,language:x.preferredLanguage||x.telegramLanguage,countryIso:x.countryIso,telegramPremium:x.premium===true,firstSeen:x.createdAt||x.connectedAt,lastSeen:x.updatedAt||x.connectedAt,paired:true})
  );

  await rebuildCommandStats(d).catch(e=>console.error('[NexAI analytics command index]',e));
  const unique=await index.estimatedDocumentCount();
  const result={counts,unique,lastSync:new Date()};
  await d.collection(STATE).updateOne({_id:'main'},{$set:result},{upsert:true});
  return result;
}

let background=null;
export async function ensureAnalyticsIndex({maxAgeMs=5*60_000,waitForFirst=true}={}){
  const d=await db();
  const state=await d.collection(STATE).findOne({_id:'main'});
  const fresh=state?.lastSync && Date.now()-new Date(state.lastSync).getTime()<maxAgeMs;
  if(fresh)return state;
  if(!background)background=rebuildAnalyticsIndex().finally(()=>{background=null});
  if(!state&&waitForFirst)return background;
  return state||{lastSync:null};
}

export async function touchAnalyticsUser(row,source='nexai'){
  const d=await db(),index=d.collection(INDEX);
  await index.createIndex({telegramUserId:1},{unique:true});
  const op=opFrom(source,row);
  if(op)await index.bulkWrite([op],{ordered:false});
}
