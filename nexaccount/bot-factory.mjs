import { saveBotToken, loadBotToken } from './secrets.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitAfter(client,peer,id,timeout=18000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    await sleep(700);
    const list=await client.getMessages(peer,{limit:16});
    const found=list
      .filter(m=>!m.out&&Number(m.id)>Number(id))
      .sort((a,b)=>Number(a.id)-Number(b.id))
      .at(-1);
    if(found)return String(found.message||'');
  }
  return '';
}

async function sendAndWait(client,peer,text,timeout=18000){
  const sent=await client.sendMessage(peer,{message:text});
  return waitAfter(client,peer,sent.id,timeout);
}

async function configure(client,peer,username,command,value){
  await sendAndWait(client,peer,'/cancel').catch(()=>{});
  await sendAndWait(client,peer,command);
  await sendAndWait(client,peer,'@'+username);
  if(value!==undefined)await sendAndWait(client,peer,value);
}

function tokenFrom(text){
  return String(text||'').match(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/)?.[0]||'';
}

function safeBotFatherText(text){
  return String(text||'')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,'[TOKEN REDACTED]')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,300);
}

export async function ensureNexAiBot(client,account){
  const existing=await loadBotToken();
  if(existing)return {created:false,reason:'already_configured'};

  const peer=await client.getInputEntity('@BotFather');
  await sendAndWait(client,peer,'/cancel').catch(()=>{});

  const start=await sendAndWait(client,peer,'/newbot');
  if(/cannot create new bots/i.test(start))throw new Error('BotFather creation restricted; contact @SpamBot');
  if(/too many bots/i.test(start))throw new Error('BotFather account bot limit reached');
  if(/try again later|flood|too many attempts/i.test(start))throw new Error('BotFather rate limit');

  const nameReply=await sendAndWait(client,peer,'NexAI');
  if(/try again later|flood|too many attempts/i.test(nameReply))throw new Error('BotFather rate limit');

  const suffix=String(account?.telegramUserId||'').replace(/\D/g,'').slice(-6)||Date.now().toString().slice(-6);
  const nonce=Date.now().toString(36).slice(-7);
  const candidates=[
    'NexAI_'+nonce+'_bot',
    'NextechAI_'+nonce+'_bot',
    'NexAI_'+suffix+'_'+nonce.slice(-3)+'_bot',
    'TheNexAI_'+nonce+'_bot'
  ];

  let username='',token='',lastReply='';
  for(const candidate of candidates){
    const response=await sendAndWait(client,peer,candidate,22000);
    lastReply=response;
    token=tokenFrom(response);
    if(token){username=candidate;break}
    if(/try again later|flood|too many attempts/i.test(response))throw new Error('BotFather rate limit');
    if(/too many bots/i.test(response))throw new Error('BotFather account bot limit reached');
  }
  if(!token){
    throw new Error('BotFather did not create NexAI: '+safeBotFatherText(lastReply||nameReply||start));
  }

  await saveBotToken(token);

  await configure(client,peer,username,'/setinline','Search NexAI commands…').catch(()=>{});
  await configure(client,peer,username,'/setdescription','NexAI · personal Telegram automation powered by Nextech.').catch(()=>{});
  await configure(client,peer,username,'/setabouttext','NexAI · powered by Nextech.').catch(()=>{});

  return {created:true,username};
}
