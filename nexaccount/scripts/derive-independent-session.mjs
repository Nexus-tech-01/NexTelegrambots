import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const NEXACCOUNT_ROOT=path.dirname(HERE);
const HOST_ROOT=path.resolve(NEXACCOUNT_ROOT,'../..');

function parseEnvText(text){
  const out={};
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line.startsWith('#'))continue;
    const at=line.indexOf('=');
    if(at<1)continue;
    const key=line.slice(0,at).trim();
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))continue;
    let value=line.slice(at+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    out[key]=value;
  }
  return out;
}

async function loadHostEnvironment(){
  for(const file of [path.join(NEXACCOUNT_ROOT,'.env'),path.join(HOST_ROOT,'.env')]){
    try{
      const parsed=parseEnvText(await fs.readFile(file,'utf8'));
      for(const [key,value] of Object.entries(parsed)){
        if(process.env[key]===undefined&&value!=='')process.env[key]=value;
      }
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
    }
  }

  // Mirror the production bootstrap credential aliasing without exposing any
  // credential value. This keeps the recovery utility compatible with hosts
  // where MTProto app credentials are shared under another Nexus bot prefix.
  if(!process.env.NEXACCOUNT_TELEGRAM_API_ID||!process.env.NEXACCOUNT_TELEGRAM_API_HASH){
    const idKey=Object.keys(process.env).find(k=>k.endsWith('__TELEGRAM_API_ID')&&process.env[k]);
    if(idKey){
      const hashKey=idKey.replace(/API_ID$/,'API_HASH');
      if(process.env[hashKey]){
        process.env.NEXACCOUNT_TELEGRAM_API_ID ||= process.env[idKey];
        process.env.NEXACCOUNT_TELEGRAM_API_HASH ||= process.env[hashKey];
      }
    }
  }
}

await loadHostEnvironment();
const [{TelegramClient,Api},{StringSession},{cfg,assertCoreConfig},store]=await Promise.all([
  import('teleproto'),
  import('teleproto/sessions/index.js'),
  import('../config.mjs'),
  import('../store.mjs')
]);
assertCoreConfig();

let sourceId=String(process.argv[2]||'').trim();
const expectedUsername=String(
  process.argv[3]||
  process.env.NEXCANAL__WATCHER_EXPECTED_USERNAME||
  'tresor20000'
).trim().replace(/^@/,'').toLowerCase();
const outputPath=path.resolve(
  process.argv[4]||
  process.env.NEXCANAL__WATCHER_SESSION_FILE||
  '/home/container/.nexcontrol/nexcanal-reader-session.txt'
);
if(!expectedUsername)throw new Error('expected_username_required');
if(!sourceId){
  const accounts=await store.listAccounts();
  const match=accounts.find(x=>String(x.username||'').trim().replace(/^@/,'').toLowerCase()===expectedUsername);
  sourceId=String(match?.telegramUserId||'');
}
if(!/^\d{5,30}$/.test(sourceId))throw new Error('source_account_not_found');

let source=null,target=null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function withTimeout(promise,ms,label){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(String(label||'operation')+'_timeout')),Math.max(1000,Number(ms)||10000));
  });
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}
async function exportLoginToken(){
  return withTimeout(target.invoke(new Api.auth.ExportLoginToken({
    apiId:Number(cfg.apiId),
    apiHash:cfg.apiHash,
    exceptIds:[]
  })),15000,'export_login_token');
}
async function normalizeLoginToken(result){
  if(result instanceof Api.auth.LoginTokenMigrateTo){
    console.log(JSON.stringify({stage:'migrate_dc',dcId:Number(result.dcId)}));
    await withTimeout(target._switchDC(result.dcId),20000,'switch_dc');
    return withTimeout(
      target.invoke(new Api.auth.ImportLoginToken({token:result.token})),
      15000,
      'import_login_token'
    );
  }
  return result;
}

try{
  const account=await store.accountWithSession(sourceId);
  if(!account)throw new Error('source_session_not_available');

  source=new TelegramClient(new StringSession(account.session),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,
    autoReconnect:false
  });
  await withTimeout(source.connect(),15000,'source_connect');
  if(!(await withTimeout(source.isUserAuthorized(),10000,'source_authorized')))throw new Error('source_session_unauthorized');
  const sourceMe=await withTimeout(source.getMe(),10000,'source_get_me');
  const sourceUsername=String(sourceMe?.username||'').replace(/^@/,'').toLowerCase();
  if(sourceUsername!==expectedUsername)throw new Error('source_session_identity_mismatch');
  console.log(JSON.stringify({stage:'source_connected',username:'@'+sourceUsername}));

  target=new TelegramClient(new StringSession(''),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,
    autoReconnect:false
  });
  await withTimeout(target.connect(),15000,'target_connect');
  console.log(JSON.stringify({stage:'target_connected'}));

  let authorization=null;
  let result=await normalizeLoginToken(await exportLoginToken());
  const deadline=Date.now()+60000;
  let acceptedFingerprint='';
  let iterations=0;

  while(Date.now()<deadline&&iterations<40&&!authorization){
    iterations++;

    if(result instanceof Api.auth.LoginTokenSuccess){
      if(result.authorization instanceof Api.auth.Authorization){
        authorization=result.authorization;
        break;
      }
      throw new Error('login_token_success_without_authorization');
    }

    if(result instanceof Api.auth.LoginToken){
      const fingerprint=Buffer.from(result.token).toString('base64url');
      if(fingerprint!==acceptedFingerprint){
        await withTimeout(
          source.invoke(new Api.auth.AcceptLoginToken({token:result.token})),
          15000,
          'accept_login_token'
        );
        acceptedFingerprint=fingerprint;
        console.log(JSON.stringify({stage:'token_accepted',iteration:iterations}));
      }
      await sleep(700);
    }else if(result instanceof Api.auth.LoginTokenMigrateTo){
      // normalizeLoginToken handles this before returning, but keep this branch
      // as a defensive guard for future Teleproto schema changes.
      result=await normalizeLoginToken(result);
      continue;
    }else{
      throw new Error('unexpected_login_token_result:'+String(result?.className||result?.constructor?.name||'unknown'));
    }

    result=await normalizeLoginToken(await exportLoginToken());
  }

  if(!authorization&&result instanceof Api.auth.LoginTokenSuccess&&result.authorization instanceof Api.auth.Authorization){
    authorization=result.authorization;
  }
  if(!authorization)throw new Error('independent_session_login_timeout');

  const me=authorization.user||await withTimeout(target.getMe(),10000,'target_get_me');
  const username=String(me?.username||'').replace(/^@/,'').toLowerCase();
  if(username!==expectedUsername)throw new Error('independent_session_identity_mismatch');

  const saved=String(target.session.save()||'').trim();
  if(!saved)throw new Error('independent_session_empty');

  await fs.mkdir(path.dirname(outputPath),{recursive:true});
  const tmp=outputPath+'.tmp-'+process.pid;
  await fs.writeFile(tmp,saved,{mode:0o600});
  await fs.chmod(tmp,0o600);
  await fs.rename(tmp,outputPath);
  await fs.chmod(outputPath,0o600);

  console.log(JSON.stringify({
    ok:true,
    sourceTelegramUserId:String(sourceMe?.id||sourceId),
    telegramUserId:String(me?.id||''),
    username:username?('@'+username):'',
    independentSession:true,
    outputReady:true
  }));
}finally{
  try{await target?.disconnect?.()}catch{}
  try{await source?.disconnect?.()}catch{}
  await store.closeStore().catch(()=>{});
}
