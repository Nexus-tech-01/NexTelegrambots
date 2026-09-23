import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
// Keep the historical in-tree location as the default, but allow normal VPS
// deployments to keep mutable key material outside the immutable code tree.
const runtimeDir=path.resolve(process.env.NEXACCOUNT_RUNTIME_DIR||path.join(here,'.runtime'));
const privatePath=path.join(runtimeDir,'pairing-private.pem');
const publicPath=path.join(runtimeDir,'pairing-public.pem');

async function exists(p){try{await fs.access(p);return true}catch{return false}}

export async function ensurePairingKeys(){
  await fs.mkdir(runtimeDir,{recursive:true});
  if(await exists(privatePath) && await exists(publicPath))return;
  const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{
    modulusLength:3072,
    publicKeyEncoding:{type:'spki',format:'pem'},
    privateKeyEncoding:{type:'pkcs8',format:'pem'}
  });
  await fs.writeFile(privatePath,privateKey,{mode:0o600});
  await fs.writeFile(publicPath,publicKey,{mode:0o644});
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
