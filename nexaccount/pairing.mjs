import crypto from 'node:crypto';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { cfg } from './config.mjs';
import { saveAccount } from './store.mjs';

const pending=new Map();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function deferred(){
  let resolve,reject;
  const promise=new Promise((a,b)=>{resolve=a;reject=b});
  return {promise,resolve,reject};
}

async function waitStage(state,allowed,timeout=20000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(allowed.includes(state.stage))return state.stage;
    await sleep(100);
  }
  return state.stage;
}

function safeError(e){
  return String(e?.errorMessage||e?.message||e||'Unknown error').slice(0,1000);
}

export async function beginPairing(phone,onConnected,expectedTelegramUserId=''){
  const normalized=String(phone||'').replace(/[\s()-]/g,'');
  if(!/^\+?[0-9]{7,16}$/.test(normalized))throw new Error('Invalid Telegram phone number');

  const id=crypto.randomUUID();
  const state={
    id,phone:normalized,stage:'starting',error:'',client:null,
    codeWaiter:null,passwordWaiter:null,
    createdAt:Date.now()
  };
  pending.set(id,state);

  const client=new TelegramClient(new StringSession(''),cfg.apiId,cfg.apiHash,{
    connectionRetries:5,
    autoReconnect:true
  });
  state.client=client;

  state.task=(async()=>{
    try{
      await client.start({
        phoneNumber:async()=>normalized,
        phoneCode:async()=>{
          const next=deferred();
          state.codeWaiter=next;
          state.stage='code';
          try{return await next.promise}finally{if(state.codeWaiter===next)state.codeWaiter=null}
        },
        password:async()=>{
          const next=deferred();
          state.passwordWaiter=next;
          state.stage='password';
          try{return await next.promise}finally{if(state.passwordWaiter===next)state.passwordWaiter=null}
        },
        onError:e=>{state.error=safeError(e)}
      });

      const me=await client.getMe();
      if(expectedTelegramUserId&&String(me.id)!==String(expectedTelegramUserId)){
        throw new Error('Connected Telegram account does not match this NexAI DM');
      }

      const saved=await saveAccount({
        me,
        session:client.session.save(),
        phone:normalized
      });

      state.stage='connected';
      state.account=saved;

      try{
        const savedMessage=saved.preferredLanguage==='en'
          ? 'NexAccount connected.\n\nYour personal engine is now active on this account.\nCommand: .menu'
          : 'NexAccount connecté.\n\nLe moteur personnel est maintenant actif sur ce compte.\nCommande : .menu';
        await client.sendMessage('me',{message:savedMessage});
      }catch{}

      await onConnected?.(client,saved);
      return saved;
    }catch(e){
      state.error=safeError(e);
      state.stage='error';
      try{await client.disconnect()}catch{}
      throw e;
    }
  })();
  state.task.catch(()=>{});

  await waitStage(state,['code','password','connected','error'],15000);
  return pairingStatus(id);
}

export async function submitPairingCode(id,value){
  const state=pending.get(String(id));
  if(!state)throw new Error('Pairing expired or not found');
  if(state.stage!=='code')return pairingStatus(id);

  const code=String(value||'').replace(/\s+/g,'');
  if(!/^[0-9A-Za-z-]{3,16}$/.test(code))throw new Error('Invalid Telegram code');

  const waiter=state.codeWaiter;
  if(!waiter)throw new Error('Telegram code input is not ready');
  state.stage='verifying_code';
  waiter.resolve(code);
  await waitStage(state,['code','password','connected','error'],20000);
  return pairingStatus(id);
}

export async function submitPairingPassword(id,value){
  const state=pending.get(String(id));
  if(!state)throw new Error('Pairing expired or not found');
  if(state.stage!=='password')return pairingStatus(id);

  const waiter=state.passwordWaiter;
  if(!waiter)throw new Error('Telegram 2FA input is not ready');
  state.stage='verifying_password';
  waiter.resolve(String(value||''));
  await waitStage(state,['password','connected','error'],20000);
  return pairingStatus(id);
}

export async function cancelPairing(id){
  const state=pending.get(String(id));
  if(!state)return {id:String(id),stage:'missing'};

  state.stage='cancelled';
  const err=new Error('Pairing cancelled');
  try{state.codeWaiter?.reject?.(err)}catch{}
  try{state.passwordWaiter?.reject?.(err)}catch{}
  try{await state.client?.disconnect()}catch{}
  pending.delete(String(id));
  return {id:String(id),stage:'cancelled'};
}

export function pairingStatus(id){
  const state=pending.get(String(id));
  if(!state)return {id:String(id),stage:'missing'};
  return {
    id:state.id,
    stage:state.stage,
    error:state.error||undefined,
    account:state.account?{
      telegramUserId:state.account.telegramUserId,
      username:state.account.username,
      firstName:state.account.firstName,
      premium:state.account.premium,
      phoneMasked:state.account.phoneMasked
    }:undefined
  };
}

export function cleanupPairings(){
  const now=Date.now();
  for(const [id,state] of pending){
    if(now-state.createdAt>10*60*1000&&state.stage!=='connected'){
      try{state.client?.disconnect()}catch{}
      pending.delete(id);
    }else if(now-state.createdAt>60*60*1000&&state.stage==='connected'){
      pending.delete(id);
    }
  }
}
