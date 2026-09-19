import { saveBotToken, loadBotToken } from './secrets.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitAfter(client,peer,id,timeout=18000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    await sleep(700);
    const list=await client.getMessages(peer,{limit:12});
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
  await sendAndWait(client,peer,command);
  await sendAndWait(client,peer,'@'+username);
  if(value!==undefined)await sendAndWait(client,peer,value);
}

export async function ensureNexAiBot(client,account){
  const existing=await loadBotToken();
  if(existing)return {created:false,reason:'already_configured'};
  if(account?.premium!==true)return {created:false,reason:'premium_owner_required'};

  const peer=await client.getInputEntity('@BotFather');
  const start=await sendAndWait(client,peer,'/newbot');
  if(/too many|try again later|flood/i.test(start))throw new Error('BotFather rate limit');

  await sendAndWait(client,peer,'NexAI');

  const suffix=String(account.telegramUserId||Date.now()).replace(/\D/g,'').slice(-6);
  const candidates=[
    'NexAI_Nextech_bot',
    'NexAI_Nexus_bot',
    'NexAI_'+suffix+'_bot',
    'TheNexAI_'+suffix+'_bot'
  ];

  let username='',token='';
  for(const candidate of candidates){
    const response=await sendAndWait(client,peer,candidate,22000);
    const match=response.match(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
    if(match){
      username=candidate;
      token=match[0];
      break;
    }
    if(/too many|try again later|flood/i.test(response))throw new Error('BotFather rate limit');
  }
  if(!token)throw new Error('BotFather could not allocate a NexAI username');

  await saveBotToken(token);

  await configure(client,peer,username,'/setinline','Search NexAI commands…').catch(()=>{});
  await configure(client,peer,username,'/setdescription','NexAI · personal Telegram automation powered by Nextech.').catch(()=>{});
  await configure(client,peer,username,'/setabouttext','NexAI · powered by Nextech.').catch(()=>{});

  return {created:true,username};
}
