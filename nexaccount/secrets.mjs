import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, sessionKey } from './config.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const file=path.join(here,'.runtime','nexai-bot-token.enc');

export async function saveBotToken(token){
  const value=String(token||'').trim();
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value))throw new Error('Invalid bot token');
  await fs.mkdir(path.dirname(file),{recursive:true});
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',sessionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  await fs.writeFile(file,Buffer.concat([iv,tag,encrypted]).toString('base64'),{mode:0o600});
}

export async function loadBotToken(){
  if(cfg.botToken)return cfg.botToken;
  try{
    const raw=Buffer.from((await fs.readFile(file,'utf8')).trim(),'base64');
    const iv=raw.subarray(0,12),tag=raw.subarray(12,28),encrypted=raw.subarray(28);
    const decipher=crypto.createDecipheriv('aes-256-gcm',sessionKey(),iv);
    decipher.setAuthTag(tag);
    const token=Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');
    return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token)?token:'';
  }catch{return ''}
}
