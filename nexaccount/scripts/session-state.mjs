import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);
const HOST=path.resolve(ROOT,'../..');

function parse(text){
  const out={};
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim(); if(!line||line.startsWith('#'))continue;
    const at=line.indexOf('='); if(at<1)continue;
    const key=line.slice(0,at).trim(); if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))continue;
    let value=line.slice(at+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    out[key]=value;
  }
  return out;
}
for(const file of [path.join(ROOT,'.env'),path.join(HOST,'.env')]){
  try{
    for(const [k,v] of Object.entries(parse(await fs.readFile(file,'utf8')))){
      if(process.env[k]===undefined&&v!=='')process.env[k]=v;
    }
  }catch(error){if(error?.code!=='ENOENT')throw error}
}

const store=await import('../store.mjs');
const op=String(process.argv[2]||'show').toLowerCase();
const id=String(process.argv[3]||'').trim();
try{
  if(op==='repair'){
    if(!/^\d{5,30}$/.test(id))throw new Error('telegram_user_id_required');
    const row=await store.markSessionRepairRequired(id,process.argv[4]||'manual_repair_required');
    console.log(JSON.stringify({ok:true,op,telegramUserId:id,enabled:row?.enabled===true,sessionRepairRequired:row?.sessionRepairRequired===true,reason:row?.sessionRepairReason||''}));
  }else if(op==='clear'){
    if(!/^\d{5,30}$/.test(id))throw new Error('telegram_user_id_required');
    const row=await store.clearSessionRepairRequired(id);
    console.log(JSON.stringify({ok:true,op,telegramUserId:id,sessionRepairRequired:row?.sessionRepairRequired===true}));
  }else{
    const rows=await store.listAccounts();
    console.log(JSON.stringify({ok:true,accounts:rows.map(x=>({
      telegramUserId:String(x.telegramUserId||''),
      username:String(x.username||''),
      premium:x.premium===true,
      enabled:x.enabled===true,
      sessionRepairRequired:x.sessionRepairRequired===true,
      sessionRepairReason:String(x.sessionRepairReason||'')
    }))}));
  }
}finally{
  await store.closeStore().catch(()=>{});
}
