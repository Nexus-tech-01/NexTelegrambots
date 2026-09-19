import fs from 'node:fs/promises';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { ensureNexAiBot } from '../bot-factory.mjs';

const sessionPath='/home/container/.nexcontrol/nexcanal-reader-session.txt';
const session=String(await fs.readFile(sessionPath,'utf8')).trim();
if(!session)throw new Error('Authorized Telegram reader session is missing');

const apiId=Number(process.env.NEXACCOUNT_TELEGRAM_API_ID||process.env.NEXGROUP__TELEGRAM_API_ID||process.env.TELEGRAM_API_ID);
const apiHash=String(process.env.NEXACCOUNT_TELEGRAM_API_HASH||process.env.NEXGROUP__TELEGRAM_API_HASH||process.env.TELEGRAM_API_HASH||'').trim();
if(!apiId||!apiHash)throw new Error('Telegram API credentials are missing');

const client=new TelegramClient(new StringSession(session),apiId,apiHash,{connectionRetries:5,autoReconnect:false});
await client.connect();
if(!(await client.isUserAuthorized()))throw new Error('Telegram reader session is not authorized');
const me=await client.getMe();
if(me?.bot)throw new Error('Telegram reader session belongs to a bot');

try{
  const result=await ensureNexAiBot(client,{telegramUserId:String(me.id),premium:me.premium===true});
  console.log(JSON.stringify({ok:true,created:!!result.created,username:result.username||null,reason:result.reason||null}));
}finally{
  await client.disconnect().catch(()=>{});
}
