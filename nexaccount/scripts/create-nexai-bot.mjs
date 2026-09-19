import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { saveBotToken } from '../secrets.mjs';
import { cfg } from '../config.mjs';

const session=String(process.env.NEXGROUP__TELEGRAM_MTPROTO_SESSION||process.env.NEXACCOUNT_BOOTSTRAP_SESSION||'').trim();
if(!session)throw new Error('No MTProto bootstrap session available');
if(!cfg.apiId||!cfg.apiHash)throw new Error('Telegram API credentials missing');

const client=new TelegramClient(new StringSession(session),cfg.apiId,cfg.apiHash,{connectionRetries:5});
await client.connect();
const bf=await client.getInputEntity('@BotFather');

async function send(text){
  const m=await client.sendMessage(bf,{message:text});
  return Number(m.id);
}
async function waitAfter(id,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    await new Promise(r=>setTimeout(r,800));
    const list=await client.getMessages(bf,{limit:8});
    const found=list.filter(m=>!m.out&&Number(m.id)>id).sort((a,b)=>Number(a.id)-Number(b.id)).at(-1);
    if(found)return String(found.message||'');
  }
  return '';
}

const start=await send('/newbot');
await waitAfter(start);
const nameId=await send('NexAI');
await waitAfter(nameId);

const candidates=[
  'NexAI_Nextech_bot',
  'NexAI_Nexus_bot',
  'NexAI_Telegram_bot',
  'TheNexAI_bot'
];
let username='',token='';
for(const candidate of candidates){
  const id=await send(candidate);
  const response=await waitAfter(id,18000);
  const match=response.match(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
  if(match){
    username=candidate;
    token=match[0];
    break;
  }
  if(!/username|sorry|invalid|taken|must end/i.test(response)&&response){
    continue;
  }
}
if(!token)throw new Error('BotFather did not create NexAI with the available usernames');

await saveBotToken(token);

async function configure(command,value){
  const a=await send(command);await waitAfter(a);
  const b=await send('@'+username);await waitAfter(b);
  if(value!==undefined){const c=await send(value);await waitAfter(c);}
}
await configure('/setinline','Search NexAI commands…').catch(()=>{});
await configure('/setdescription','NexAI · personal Telegram automation powered by Nextech.').catch(()=>{});
await configure('/setabouttext','NexAI · powered by Nextech.').catch(()=>{});

console.log('NEXAI_CREATED @'+username);
await client.disconnect();
