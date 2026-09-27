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
try{
  const account=await store.accountWithSession(sourceId);
  if(!account)throw new Error('source_session_not_available');
  source=new TelegramClient(new StringSession(account.session),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,autoReconnect:false
  });
  await source.connect();
  if(!(await source.isUserAuthorized()))throw new Error('source_session_unauthorized');
  const sourceMe=await source.getMe();

  target=new TelegramClient(new StringSession(''),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,autoReconnect:false
  });
  await target.connect();

  let approvals=0;
  await target.signInUserWithQrCode(
    {apiId:cfg.apiId,apiHash:cfg.apiHash},
    {
      qrCode:async({token})=>{
        if(approvals>2)throw new Error('too_many_login_token_rotations');
        approvals++;
        await source.invoke(new Api.auth.AcceptLoginToken({token}));
      },
      password:async()=>{throw new Error('unexpected_password_request')},
      onError:async()=>false
    }
  );

  const me=await target.getMe();
  const username=String(me?.username||'').replace(/^@/,'').toLowerCase();
  if(username!==expectedUsername){
    throw new Error('independent_session_identity_mismatch');
  }
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
    independentSession:true
  }));
}finally{
  try{await target?.disconnect?.()}catch{}
  try{await source?.disconnect?.()}catch{}
  await store.closeStore().catch(()=>{});
}
