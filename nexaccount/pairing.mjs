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

export async function beginPairing(phone,onConnected){
  const normalized=String(phone||'').replace(/[\s()-]/g,'');
  if(!/^\+?[0-9]{7,16}$/.test(normalized))throw new Error('Numéro Telegram invalide');
  const id=crypto.randomUUID();
  const code=deferred(),password=deferred();
  const state={
    id,phone:normalized,stage:'starting',error:'',client:null,
    resolveCode:code.resolve,resolvePassword:password.resolve,
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
          state.stage='code';
          return code.promise;
        },
        password:async()=>{
          state.stage='password';
          return password.promise;
        },
        onError:e=>{state.error=safeError(e)}
      });
      const me=await client.getMe();
      const saved=await saveAccount({me,session:client.session.save(),phone:normalized});
      state.stage='connected';
      state.account=saved;
      try{
        await client.sendMessage('me',{message:'NexAccount connecté.\n\nLe moteur personnel est maintenant actif sur ce compte.\nCommande : .menu'});
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
  if(!state)throw new Error('Pairing expiré ou introuvable');
  if(state.stage!=='code')return pairingStatus(id);
  const code=String(value||'').replace(/\s+/g,'');
  if(!/^[0-9A-Za-z-]{3,16}$/.test(code))throw new Error('Code Telegram invalide');
  state.stage='verifying_code';
  state.resolveCode(code);
  await waitStage(state,['password','connected','error'],20000);
  return pairingStatus(id);
}

export async function submitPairingPassword(id,value){
  const state=pending.get(String(id));
  if(!state)throw new Error('Pairing expiré ou introuvable');
  if(state.stage!=='password')return pairingStatus(id);
  state.stage='verifying_password';
  state.resolvePassword(String(value||''));
  await waitStage(state,['connected','error'],20000);
  return pairingStatus(id);
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
