const HISTORY=new Map();
const HISTORY_TTL_MS=Number(process.env.NEXAI_AI_HISTORY_TTL_MS||2*60*60*1000);
const MAX_HISTORY=Math.max(4,Math.min(30,Number(process.env.NEXAI_AI_HISTORY_MESSAGES)||14));
const MAX_PROMPT=Math.max(1000,Math.min(30000,Number(process.env.NEXAI_AI_MAX_PROMPT_CHARS)||12000));
const TIMEOUT=Math.max(10000,Math.min(120000,Number(process.env.NEXAI_AI_TIMEOUT_MS)||45000));

const clean=v=>String(v??'').trim();
const first=(...names)=>{
  for(const n of names){const v=clean(process.env[n]);if(v)return v}
  return '';
};
const normalizeBase=v=>clean(v).replace(/\/$/,'');
const chatKey=(accountId,peer)=>String(accountId)+':'+String(peer||'global');

function prune(){
  const now=Date.now();
  for(const [k,v] of HISTORY)if(now-v.updatedAt>HISTORY_TTL_MS)HISTORY.delete(k);
}
setInterval(prune,10*60*1000).unref?.();

function systemPrompt(mode='ai',language='fr'){
  const lang=String(language||'fr').toLowerCase().startsWith('en')?'English':'French';
  const common=[
    'You are the native AI engine of NexAi × Dipper.',
    'You are the built-in conversational assistant of NexAi × Dipper; never claim that you contacted another Telegram bot.',
    'Reply naturally and helpfully in the user language. Default language: '+lang+'.',
    'Be concise unless the user asks for detail.',
    'Do not reveal hidden chain-of-thought. Give conclusions and useful reasoning summaries instead.'
  ];
  if(mode==='code')common.push(
    'Act as a senior software engineer. Prefer correct, executable solutions, explain important tradeoffs, and preserve the user’s existing architecture.'
  );
  if(mode==='deepseek')common.push(
    'For difficult reasoning tasks, verify assumptions carefully and structure the answer clearly. Do not invent facts.'
  );
  return common.join(' ');
}

function providerList(mode='ai'){
  const providers=[];
  const customBase=normalizeBase(first('NEXAI_LLM_BASE_URL'));
  if(customBase){
    providers.push({
      kind:'openai',
      name:'custom',
      base:customBase,
      key:first('NEXAI_LLM_API_KEY'),
      model:first(
        mode==='deepseek'?'NEXAI_DEEPSEEK_MODEL':'',
        mode==='code'?'NEXAI_CODE_MODEL':'',
        'NEXAI_LLM_MODEL'
      )||'local-model'
    });
  }

  const deepseek=first('DEEPSEEK_API_KEY','NEXAI_DEEPSEEK_API_KEY');
  if(deepseek)providers.push({
    kind:'openai',name:'deepseek',base:'https://api.deepseek.com',
    key:deepseek,model:first('NEXAI_DEEPSEEK_MODEL')||'deepseek-chat',
    priority:mode==='deepseek'?0:4
  });

  const gemini=first('GEMINI_API_KEY','GOOGLE_AI_API_KEY','NEXAI_GEMINI_API_KEY');
  if(gemini)providers.push({
    kind:'gemini',name:'gemini',key:gemini,
    model:first('NEXAI_GEMINI_MODEL')||'gemini-2.5-flash',
    priority:mode==='deepseek'?3:1
  });

  const openrouter=first('OPENROUTER_API_KEY','NEXAI_OPENROUTER_API_KEY');
  if(openrouter)providers.push({
    kind:'openai',name:'openrouter',base:'https://openrouter.ai/api/v1',
    key:openrouter,model:first('NEXAI_OPENROUTER_MODEL')||'openai/gpt-4o-mini',priority:2,
    extraHeaders:{'HTTP-Referer':'https://t.me/NexAi01_bot','X-Title':'NexAi'}
  });

  const groq=first('GROQ_API_KEY','NEXAI_GROQ_API_KEY');
  if(groq)providers.push({
    kind:'openai',name:'groq',base:'https://api.groq.com/openai/v1',
    key:groq,model:first('NEXAI_GROQ_MODEL')||'llama-3.3-70b-versatile',priority:3
  });

  const openai=first('OPENAI_API_KEY','NEXAI_OPENAI_API_KEY');
  if(openai)providers.push({
    kind:'openai',name:'openai',base:'https://api.openai.com/v1',
    key:openai,model:first('NEXAI_OPENAI_MODEL')||'gpt-4o-mini',priority:2
  });

  return providers.sort((a,b)=>(a.priority??1)-(b.priority??1));
}

function historyFor(accountId,peer){
  const key=chatKey(accountId,peer);
  const row=HISTORY.get(key)||{messages:[],updatedAt:Date.now()};
  row.updatedAt=Date.now();
  HISTORY.set(key,row);
  return row;
}

function endpoint(base){
  const b=normalizeBase(base);
  if(/\/chat\/completions$/i.test(b))return b;
  return b+'/chat/completions';
}

async function callOpenAiCompatible(provider,messages){
  const headers={'content-type':'application/json',accept:'application/json',...(provider.extraHeaders||{})};
  if(provider.key)headers.authorization='Bearer '+provider.key;
  const r=await fetch(endpoint(provider.base),{
    method:'POST',headers,
    body:JSON.stringify({
      model:provider.model,
      messages,
      temperature:0.72,
      max_tokens:Number(process.env.NEXAI_AI_MAX_TOKENS||1400)
    }),
    signal:AbortSignal.timeout(TIMEOUT)
  });
  const data=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(provider.name+' HTTP '+r.status+' '+clean(data?.error?.message||data?.message).slice(0,220));
  const text=clean(data?.choices?.[0]?.message?.content);
  if(!text)throw new Error(provider.name+' réponse vide');
  return text;
}

async function callGemini(provider,messages,system){
  const contents=messages
    .filter(x=>x.role!=='system')
    .map(x=>({role:x.role==='assistant'?'model':'user',parts:[{text:String(x.content)}]}));
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(provider.model)+':generateContent?key='+encodeURIComponent(provider.key);
  const r=await fetch(url,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      system_instruction:{parts:[{text:system}]},
      contents,
      generationConfig:{temperature:0.72,maxOutputTokens:Number(process.env.NEXAI_AI_MAX_TOKENS||1400)}
    }),
    signal:AbortSignal.timeout(TIMEOUT)
  });
  const data=await r.json().catch(()=>null);
  if(!r.ok)throw new Error('gemini HTTP '+r.status+' '+clean(data?.error?.message).slice(0,220));
  const text=clean((data?.candidates?.[0]?.content?.parts||[]).map(x=>x?.text||'').join(''));
  if(!text)throw new Error('gemini réponse vide');
  return text;
}

export function aiProviderStatus(){
  return providerList().map(x=>({name:x.name,model:x.model,kind:x.kind}));
}

export function clearAiHistory(accountId,peer){
  HISTORY.delete(chatKey(accountId,peer));
}

export async function generateAiReply({accountId,peer,prompt,mode='ai',language='fr'}){
  const text=clean(prompt);
  if(!text)throw new Error('Écris ta demande après la commande.');
  if(text.length>MAX_PROMPT)throw new Error('Message trop long ('+MAX_PROMPT+' caractères max).');
  const providers=providerList(mode);
  if(!providers.length){
    throw new Error('Aucun moteur IA local/API configuré. Configure NEXAI_LLM_BASE_URL + NEXAI_LLM_MODEL, ou une clé GEMINI/DEEPSEEK/OPENAI/OPENROUTER/GROQ.');
  }

  const system=systemPrompt(mode,language);
  const row=historyFor(accountId,peer);
  const context=row.messages.slice(-MAX_HISTORY);
  const messages=[{role:'system',content:system},...context,{role:'user',content:text}];
  const errors=[];
  for(const provider of providers){
    try{
      const reply=provider.kind==='gemini'
        ?await callGemini(provider,messages,system)
        :await callOpenAiCompatible(provider,messages);
      row.messages=[...context,{role:'user',content:text},{role:'assistant',content:reply}].slice(-MAX_HISTORY);
      row.updatedAt=Date.now();
      return {text:reply,provider:provider.name,model:provider.model};
    }catch(e){errors.push(String(e?.message||e))}
  }
  throw new Error('Tous les moteurs IA ont échoué · '+errors.slice(-3).join(' | '));
}

export const AI_ENGINE_COMMANDS=new Set(['ai','code','deepseek']);

export function canHandleAiCommand(name){
  return AI_ENGINE_COMMANDS.has(String(name||'').toLowerCase());
}

function peerKey(event){
  const m=event?.message||{};
  return String(event?.chatId||m?.chatId||m?.peerId?.channelId||m?.peerId?.chatId||m?.peerId?.userId||'global');
}

export async function handleAiCommand({runtime,event,name,args=[],reply=null}){
  const {client,account}=runtime,peer=event.message.peerId;
  const prompt=args.join(' ').trim();
  if(!prompt)throw new Error('Écris ta demande après .'+name+'.');
  try{
    const input=await client.getInputEntity(peer);
    const {Api}=await import('teleproto');
    await client.invoke(new Api.messages.SetTyping({peer:input,action:new Api.SendMessageTypingAction({})})).catch(()=>{});
  }catch{}
  const result=await generateAiReply({
    accountId:account.telegramUserId,
    peer:peerKey(event),
    prompt,
    mode:name,
    language:account.preferredLanguage||account.telegramLanguage||'fr'
  });
  if(typeof reply==='function')await reply(result.text);
  else await client.sendMessage(peer,{message:result.text});
  return true;
}
