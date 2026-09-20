import crypto from 'node:crypto';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { cfg } from './config.mjs';
import { deletePairingState, pairingStateRecord, saveAccount, savePairingState } from './store.mjs';

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
    account:state.account?{
      telegramUserId:state.account.telegramUserId,
      username:state.account.username,
      firstName:state.account.firstName,
      premium:state.account.premium,
      phoneMasked:state.account.phoneMasked
    }:undefined
  };
}

async function failPairing(state,e,{disconnect=true}={}){
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
  const client=state.client;
  const me=user||await client.getMe();
  if(state.expectedTelegramUserId&&String(me.id)!==String(state.expectedTelegramUserId)){
    return failPairing(state,new Error('CONNECTED_ACCOUNT_MISMATCH'));
  }

  const saved=await saveAccount({
    me,
    session:client.session.save(),
    phone:state.phone
  });

  state.stage='connected';
  state.error='';
  state.errorCode='';
  state.account=saved;
  await persist(state);

  try{
    const savedMessage=saved.preferredLanguage==='en'
      ? 'NexAccount connected.\n\nYour personal engine is now active on this account.\nCommand: .menu'
      : 'NexAccount connecté.\n\nLe moteur personnel est maintenant actif sur ce compte.\nCommande : .menu';
    await client.sendMessage('me',{message:savedMessage});
  }catch{}

  const handler=state.onConnected||defaultOnConnected;
  await handler?.(client,saved);
  state.handedOff=true;
  await persist(state).catch(()=>{});
  console.log('[NexAccount pair]',state.id,'connected',String(saved.telegramUserId));
  return publicStatus(state,state.id);
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
