import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const runtimeDir=path.resolve(
  process.env.NEXACCOUNT_PAIRING_KEY_DIR||
  '/var/lib/nex/runtime/public/nexaccount/pairing-crypto'
);
const privatePath=path.join(runtimeDir,'pairing-private.pem');
const publicPath=path.join(runtimeDir,'pairing-public.pem');
const lockPath=path.join(runtimeDir,'.pairing-key.lock');

async function exists(p){try{await fs.access(p);return true}catch{return false}}
async function pairReady(){return await exists(privatePath)&&await exists(publicPath)}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function acquireGenerationLock(){
  for(let attempt=0;attempt<100;attempt++){
    try{return await fs.open(lockPath,'wx',0o600)}
    catch(error){
      if(error?.code!=='EEXIST')throw error;
      if(await pairReady())return null;
      try{
        const stat=await fs.stat(lockPath);
        if(Date.now()-stat.mtimeMs>30000)await fs.unlink(lockPath).catch(()=>{});
      }catch{}
      await sleep(75);
    }
  }
  throw new Error('pairing_key_generation_lock_timeout');
}

export async function ensurePairingKeys(){
  await fs.mkdir(runtimeDir,{recursive:true,mode:0o700});
  if(await pairReady())return;

  const lock=await acquireGenerationLock();
  if(lock===null)return;

  const suffix=String(process.pid)+'-'+Date.now();
  const tempPrivate=privatePath+'.'+suffix+'.tmp';
  const tempPublic=publicPath+'.'+suffix+'.tmp';
  try{
    if(await pairReady())return;

    const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{
      modulusLength:3072,
      publicKeyEncoding:{type:'spki',format:'pem'},
      privateKeyEncoding:{type:'pkcs8',format:'pem'}
    });

    await fs.writeFile(tempPrivate,privateKey,{mode:0o600});
    await fs.writeFile(tempPublic,publicKey,{mode:0o644});
    await fs.rename(tempPublic,publicPath);
    await fs.rename(tempPrivate,privatePath);
    await fs.chmod(privatePath,0o600).catch(()=>{});
    await fs.chmod(publicPath,0o644).catch(()=>{});
  }finally{
    await fs.unlink(tempPrivate).catch(()=>{});
    await fs.unlink(tempPublic).catch(()=>{});
    await lock.close().catch(()=>{});
    await fs.unlink(lockPath).catch(()=>{});
  }
}

export async function pairingPublicKey(){
  await ensurePairingKeys();
  return fs.readFile(publicPath,'utf8');
}

export async function decryptPairingEnvelope(value){
  await ensurePairingKeys();
  const key=await fs.readFile(privatePath,'utf8');
  const raw=Buffer.from(String(value||''),'base64');
  if(!raw.length)throw new Error('Encrypted pairing payload missing');
  const clear=crypto.privateDecrypt({
    key,
    padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash:'sha256'
  },raw).toString('utf8');
  const data=JSON.parse(clear);
  if(!data||typeof data!=='object')throw new Error('Invalid pairing payload');
  return data;
}
