import crypto from 'node:crypto';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { cfg } from './config.mjs';
import { deletePairingState, enableAccount, pairingStateRecord, saveAccount, savePairingState } from './store.mjs';

const pending=new Map();
let defaultOnConnected=null;

export function setPairingConnectedHandler(handler){
  defaultOnConnected=typeof handler==='function'?handler:null;
}

function safeError(e){
  return String(e?.errorMessage||e?.message||e||'Unknown error').slice(0,1000);
}

function authErrorCode(e){
  return String(e?.errorMessage||e?.message||'').trim().toUpperCase().slice(0,160);
}

function normalizePairingCode(value){
  const raw=String(value||'').normalize('NFKC').trim();
  if(!raw)throw new Error('Invalid Telegram code');
  if(/^[0-9\s-]+$/.test(raw)){
    const digits=raw.replace(/[^0-9]/g,'');
    if(digits.length>=4&&digits.length<=8)return digits;
  }
  if(/^[0-9A-Za-z\s-]+$/.test(raw)){
    const compact=raw.replace(/[\s-]+/g,'');
    if(compact.length>=3&&compact.length<=16)return compact;
  }
  throw new Error('Invalid Telegram code');
}

function isCodeRetryable(code){
  return code.includes('PHONE_CODE_INVALID')||code.includes('PHONE_CODE_EMPTY');
}

function isPasswordRetryable(code){
  return code.includes('PASSWORD_HASH_INVALID')||code.includes('PASSWORD_EMPTY');
}

async function persist(state){
  await savePairingState(state);
}

async function stateFor(id,{needClient=false}={}){
  const key=String(id);
  let state=pending.get(key)||null;
  if(!state){
    const saved=await pairingStateRecord(key);
    if(!saved)return null;
    state={...saved,client:null,onConnected:defaultOnConnected};
    if(state.stage==='verifying_code')state.stage='code';
    if(state.stage==='verifying_password')state.stage='password';
    pending.set(key,state);
  }
  if(needClient&&!state.client&&!['connected','error','cancelled'].includes(state.stage)){
    const client=new TelegramClient(new StringSession(state.session||''),cfg.apiId,cfg.apiHash,{
      connectionRetries:5,
      autoReconnect:true
    });
    await client.connect();
    state.client=client;
    state.onConnected=state.onConnected||defaultOnConnected;
  }
  return state;
}

function publicStatus(state,id=''){
  if(!state)return {id:String(id),stage:'missing'};
  return {
    id:String(state.id),
    stage:state.stage,
    error:state.error||undefined,
    errorCode:state.errorCode||undefined,
    codeAttempts:Number(state.codeAttempts||0),
    passwordAttempts:Number(state.passwordAttempts||0),
    codeViaApp:state.stage==='code'?state.codeViaApp:undefined,
    qrUrl:state.stage==='qr'?state.qrUrl||undefined:undefined,
    qrExpiresAt:state.stage==='qr'?Number(state.qrExpiresAt||0)||undefined:undefined,
    account:state.account?{
      telegramUserId:state.account.telegramUserId,
      username:state.account.username,
      firstName:state.account.firstName,
      premium:state.account.premium,
      phoneMasked:state.account.phoneMasked
    }:undefined
  };
}

function stopQrRuntime(state){
  if(state?.qrRefreshTimer){
    clearTimeout(state.qrRefreshTimer);
    state.qrRefreshTimer=null;
  }
  if(state?.qrHandler){
    try{state.client?.removeEventHandler?.(state.qrHandler)}catch{}
    state.qrHandler=null;
  }
}

async function failPairing(state,e,{disconnect=true}={}){
  stopQrRuntime(state);
  state.error=safeError(e);
  state.errorCode=authErrorCode(e)||'AUTH_ERROR';
  state.stage='error';
  await persist(state).catch(err=>console.error('[NexAccount pair persist]',state.id,String(err?.message||err)));
  if(disconnect){
    try{await state.client?.disconnect()}catch{}
  }
  return publicStatus(state,state.id);
}

async function finishPairing(state,user){
  stopQrRuntime(state);
  const client=state.client;
  const me=user||await client.getMe();
  if(state.expectedTelegramUserId&&String(me.id)!==String(state.expectedTelegramUserId)){
    return failPairing(state,new Error('CONNECTED_ACCOUNT_MISMATCH'));
  }

  const saved=await saveAccount({
    me,
    session:client.session.save(),
    phone:state.phone,
    enabled:false
  });

  state.stage='connected';
  state.error='';
  state.errorCode='';
  state.account=saved;
  await persist(state);

  // Attach the runtime first. The success message must only claim that the
  // personal engine is active after the account is actually ready to handle
  // commands.
  const handler=state.onConnected||defaultOnConnected;
  const handoffResult=await handler?.(client,saved);
  if(handler&&handoffResult===false)throw new Error('RUNTIME_HANDOFF_REFUSED');
  await enableAccount(saved.telegramUserId);
  saved.enabled=true;
  state.account=saved;
  state.handedOff=true;
  await persist(state).catch(()=>{});

  try{
    const savedMessage=saved.preferredLanguage==='en'
      ? 'NexAccount connected.\n\nYour personal engine is now active on this account.\nCommand: menu'
      : 'NexAccount connecté.\n\nLe moteur personnel est maintenant actif sur ce compte.\nCommande : menu';
    await client.sendMessage('me',{message:savedMessage});
  }catch{}
  console.log('[NexAccount pair]',state.id,'connected',String(saved.telegramUserId));
  return publicStatus(state,state.id);
}

async function applyQrResult(state,result){
  if(result instanceof Api.auth.LoginTokenSuccess&&result.authorization instanceof Api.auth.Authorization){
    return finishPairing(state,result.authorization.user);
  }

  if(result instanceof Api.auth.LoginTokenMigrateTo){
    await state.client._switchDC(result.dcId);
    const migrated=await state.client.invoke(new Api.auth.ImportLoginToken({token:result.token}));
    return applyQrResult(state,migrated);
  }

  if(result instanceof Api.auth.LoginToken){
    const token=Buffer.from(result.token).toString('base64url');
    state.qrUrl='tg://login?token='+token;
    state.qrExpiresAt=Number(result.expires||0)*1000;
    state.stage='qr';
    state.error='';
    state.errorCode='';
    await persist(state);

    if(state.qrRefreshTimer)clearTimeout(state.qrRefreshTimer);
    const delay=Math.max(1000,(state.qrExpiresAt||Date.now()+30000)-Date.now()+250);
    state.qrRefreshTimer=setTimeout(()=>{
      refreshQrPairing(state).catch(error=>console.error('[NexAccount qr refresh]',state.id,safeError(error)));
    },delay);
    state.qrRefreshTimer.unref?.();
    return publicStatus(state,state.id);
  }

  throw new Error('UNEXPECTED_QR_LOGIN_RESULT');
}

async function refreshQrPairing(state){
  if(state.qrRefreshTimer){
    clearTimeout(state.qrRefreshTimer);
    state.qrRefreshTimer=null;
  }
  try{
    const result=await state.client.invoke(new Api.auth.ExportLoginToken({
      apiId:Number(cfg.apiId),
      apiHash:cfg.apiHash,
      exceptIds:[]
    }));
    return await applyQrResult(state,result);
  }catch(error){
    const code=authErrorCode(error);
    if(code.includes('SESSION_PASSWORD_NEEDED')){
      stopQrRuntime(state);
      state.stage='password_required';
      state.error='';
      state.errorCode='SESSION_PASSWORD_NEEDED';
      await persist(state);
      return publicStatus(state,state.id);
    }
    return failPairing(state,error);
  }
}

function ensureQrListener(state){
  if(state.qrHandler)return;
  state.qrHandler=async update=>{
    if(!(update instanceof Api.UpdateLoginToken))return;
    try{await refreshQrPairing(state)}
    catch(error){console.error('[NexAccount qr update]',state.id,safeError(error))}
  };
  state.client.addEventHandler(state.qrHandler);
}

export async function beginQrPairing(onConnected=defaultOnConnected,expectedTelegramUserId=''){
  const id=crypto.randomUUID();
  const state={
    id,
    phone:'',
    stage:'starting',
    error:'',
    errorCode:'',
    client:null,
    codeAttempts:0,
    passwordAttempts:0,
    qrUrl:'',
    qrExpiresAt:0,
    qrHandler:null,
    qrRefreshTimer:null,
    createdAt:Date.now(),
    expectedTelegramUserId:String(expectedTelegramUserId||''),
    onConnected:onConnected||defaultOnConnected,
    handedOff:false
  };
  pending.set(id,state);

  const client=new TelegramClient(new StringSession(''),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,
    autoReconnect:true
  });
  state.client=client;

  try{
    await client.connect();
    ensureQrListener(state);
    const status=await refreshQrPairing(state);
    console.log('[NexAccount qr]',id,'started');
    return status;
  }catch(error){
    console.error('[NexAccount qr start]',id,authErrorCode(error)||safeError(error));
    return failPairing(state,error);
  }
}

export async function qrPairingStatus(id){
  const state=await stateFor(id,{needClient:true});
  if(!state)return {id:String(id),stage:'missing'};
  if(['connected','error','cancelled','password_required'].includes(state.stage)){
    return publicStatus(state,id);
  }

  try{
    if(await state.client.checkAuthorization()){
      return finishPairing(state,await state.client.getMe());
    }
  }catch{}

  if(state.stage==='qr'&&state.qrUrl&&Number(state.qrExpiresAt||0)>Date.now()+1000){
    return publicStatus(state,id);
  }

  ensureQrListener(state);
  return refreshQrPairing(state);
}

export async function beginPairing(phone,onConnected=defaultOnConnected,expectedTelegramUserId=''){
  const normalized=String(phone||'').replace(/[\s()-]/g,'');
  if(!/^\+?[0-9]{7,16}$/.test(normalized))throw new Error('Invalid Telegram phone number');

  const id=crypto.randomUUID();
  const state={
    id,
    phone:normalized,
    stage:'starting',
    error:'',
    errorCode:'',
    client:null,
    phoneCodeHash:'',
    codeViaApp:false,
    codeAttempts:0,
    passwordAttempts:0,
    createdAt:Date.now(),
    expectedTelegramUserId:String(expectedTelegramUserId||''),
    onConnected:onConnected||defaultOnConnected,
    handedOff:false
  };
  pending.set(id,state);

  const client=new TelegramClient(new StringSession(''),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,
    autoReconnect:true
  });
  state.client=client;

  try{
    await client.connect();
    const sent=await client.sendCode(
      {apiId:cfg.apiId,apiHash:cfg.apiHash},
      normalized,
      false
    );

    if(sent?.emailRequired||sent?.emailCodeSent){
      return failPairing(state,new Error('EMAIL_VERIFICATION_REQUIRED'));
    }
    if(typeof sent?.phoneCodeHash!=='string'||!sent.phoneCodeHash){
      return failPairing(state,new Error('PHONE_CODE_HASH_MISSING'));
    }

    state.phoneCodeHash=sent.phoneCodeHash;
    state.codeViaApp=sent.isCodeViaApp===true;
    state.stage='code';
    await persist(state);
    console.log('[NexAccount pair]',id,'code_requested','viaApp='+state.codeViaApp);
    return publicStatus(state,id);
  }catch(e){
    console.error('[NexAccount pair start]',id,authErrorCode(e)||safeError(e));
    return failPairing(state,e);
  }
}

export async function submitPairingCode(id,value){
  const state=await stateFor(id,{needClient:true});
  if(!state)throw new Error('Pairing expired or not found');
  if(state.stage!=='code')return publicStatus(state,id);

  const code=normalizePairingCode(value);
  state.error='';
  state.errorCode='';
  state.codeAttempts=Number(state.codeAttempts||0)+1;
  state.stage='verifying_code';
  await persist(state);

  try{
    const result=await state.client.invoke(new Api.auth.SignIn({
      phoneNumber:state.phone,
      phoneCodeHash:state.phoneCodeHash,
      phoneCode:code
    }));

    if(result instanceof Api.auth.AuthorizationSignUpRequired){
      return failPairing(state,new Error('SIGN_UP_REQUIRED'));
    }

    const user=result?.user||await state.client.getMe();
    return finishPairing(state,user);
  }catch(e){
    const codeName=authErrorCode(e);
    console.warn('[NexAccount pair code]',state.id,codeName||safeError(e));

    if(codeName.includes('SESSION_PASSWORD_NEEDED')){
      state.error='';
      state.errorCode='';
      state.stage='password';
      await persist(state);
      return publicStatus(state,id);
    }

    state.error=safeError(e);
    state.errorCode=codeName||'AUTH_ERROR';

    if(isCodeRetryable(codeName)){
      state.stage='code';
      await persist(state);
      return publicStatus(state,id);
    }

    return failPairing(state,e);
  }
}

export async function submitPairingPassword(id,value){
  const state=await stateFor(id,{needClient:true});
  if(!state)throw new Error('Pairing expired or not found');
  if(state.stage!=='password')return publicStatus(state,id);

  const password=String(value||'');
  if(!password)throw new Error('Invalid Telegram 2FA password');

  state.error='';
  state.errorCode='';
  state.passwordAttempts=Number(state.passwordAttempts||0)+1;
  state.stage='verifying_password';
  await persist(state);

  let capturedError=null;
  try{
    const user=await state.client.signInWithPassword(
      {apiId:cfg.apiId,apiHash:cfg.apiHash},
      {
        password:async()=>password,
        onError:async e=>{
          capturedError=e;
          return true;
        }
      }
    );
    if(!user)return failPairing(state,new Error('PASSWORD_AUTH_FAILED'));
    return finishPairing(state,user);
  }catch(e){
    const actual=capturedError||e;
    const codeName=authErrorCode(actual);
    console.warn('[NexAccount pair password]',state.id,codeName||safeError(actual));

    state.error=safeError(actual);
    state.errorCode=codeName||'AUTH_ERROR';

    if(isPasswordRetryable(codeName)){
      state.stage='password';
      await persist(state);
      return publicStatus(state,id);
    }

    return failPairing(state,actual);
  }
}

export async function cancelPairing(id){
  const state=await stateFor(id);
  if(!state)return {id:String(id),stage:'missing'};

  stopQrRuntime(state);
  state.stage='cancelled';
  if(!state.handedOff){
    try{await state.client?.disconnect()}catch{}
  }
  pending.delete(String(id));
  await deletePairingState(id).catch(()=>{});
  return {id:String(id),stage:'cancelled'};
}

export async function pairingStatus(id){
  const state=await stateFor(id);
  return publicStatus(state,id);
}

export async function cleanupPairings(){
  const now=Date.now();
  for(const [id,state] of pending){
    const ttl=state.stage==='connected'?60*60*1000:10*60*1000;
    if(now-state.createdAt>ttl){
      if(!state.handedOff){
        try{await state.client?.disconnect()}catch{}
      }
      pending.delete(id);
      await deletePairingState(id).catch(()=>{});
    }
  }
}
