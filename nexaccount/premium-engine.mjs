import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db } from './store.mjs';
import { generateAiReply } from './ai-engine.mjs';

const POWER_NAMES=new Set(['autopilot','botforge','webapp','mirror','vault','watch','studio','research','build','memory']);
const RUNNER_MS=Math.max(30000,Number(process.env.NEXAI_PREMIUM_RUNNER_MS||60000));
const MIRROR_CACHE_TTL=Math.max(5000,Number(process.env.NEXAI_MIRROR_CACHE_TTL_MS||20000));
const mirrorCache=new Map();

const clean=v=>String(v??'').trim();
const shortId=()=>crypto.randomBytes(4).toString('hex');
const now=()=>new Date();

function accountId(runtime){return String(runtime?.account?.telegramUserId||'')}
function eventPeerId(event){
  const m=event?.message||{};
  return String(event?.chatId||m?.chatId||m?.peerId?.channelId||m?.peerId?.chatId||m?.peerId?.userId||'');
}
function extractUrls(text){
  return [...new Set((clean(text).match(/https?:\/\/[^\s<>"']+/gi)||[]).map(x=>x.replace(/[),.;!?]+$/,'')))].slice(0,5);
}
function parseIntervalMs(text,defaultMs=60*60*1000){
  const s=clean(text).toLowerCase();
  const m=s.match(/(?:every|chaque|toutes?\s+les?)\s*(\d{1,3})?\s*(minute|min|minutes|hour|hours|heure|heures|h|day|days|jour|jours)\b/i);
  if(!m)return defaultMs;
  const n=Math.max(1,Number(m[1]||1));
  const unit=m[2].toLowerCase();
  const mult=/minute|min/.test(unit)?60000:/hour|heure|h/.test(unit)?3600000:86400000;
  return Math.max(5*60000,Math.min(30*86400000,n*mult));
}
function taskLine(row){
  return '#'+String(row.powerId||'????')+' · '+String(row.kind||'power')+' · '+String(row.status||'active')+' · '+clean(row.label||row.instruction||row.sourceRef||'').slice(0,90);
}
async function collection(name){return (await db()).collection(name)}

async function listPowers(id,kind=''){
  const c=await collection('nexaccount_premium_powers');
  return c.find({telegramUserId:id,...(kind?{kind}:{})}).sort({createdAt:-1}).limit(20).toArray();
}
async function stopPower(id,powerId){
  const c=await collection('nexaccount_premium_powers');
  const r=await c.updateOne({telegramUserId:id,powerId:clean(powerId)},{$set:{status:'stopped',updatedAt:now()}});
  mirrorCache.delete(id);
  return r.matchedCount===1;
}
async function createPower(id,doc){
  const c=await collection('nexaccount_premium_powers');
  const powerId=shortId(),createdAt=now();
  await c.insertOne({telegramUserId:id,powerId,status:'active',createdAt,updatedAt:createdAt,...doc});
  mirrorCache.delete(id);
  return powerId;
}

async function safeFetch(url,{limit=30000}={}){
  const r=await fetch(url,{
    headers:{'user-agent':'NexAI-Premium/1.0','accept':'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'},
    signal:AbortSignal.timeout(15000),
    redirect:'follow'
  });
  if(!r.ok)throw new Error('HTTP '+r.status);
  const type=String(r.headers.get('content-type')||'');
  if(!/text|json|xml|html/i.test(type))return {url:r.url,type,text:'[contenu non textuel]'};
  const text=(await r.text()).replace(/\0/g,'').slice(0,limit);
  return {url:r.url,type,text};
}
async function contextFromUrls(prompt){
  const urls=extractUrls(prompt);
  if(!urls.length)return '';
  const chunks=[];
  for(const url of urls.slice(0,3)){
    try{
      const page=await safeFetch(url,{limit:12000});
      chunks.push('SOURCE '+page.url+'\n'+page.text);
    }catch(error){
      chunks.push('SOURCE '+url+'\n[lecture impossible: '+clean(error?.message||error).slice(0,160)+']');
    }
  }
  return chunks.join('\n\n---\n\n').slice(0,28000);
}
async function ai(runtime,event,prompt,mode='deepseek'){
  return generateAiReply({
    accountId:accountId(runtime),
    peer:eventPeerId(event)||'premium',
    prompt,
    mode,
    language:runtime?.account?.preferredLanguage||runtime?.account?.telegramLanguage||'fr'
  });
}
function codeBlock(text){
  const m=String(text||'').match(/\`\`\`([a-zA-Z0-9_+-]*)\n([\s\S]*?)\`\`\`/);
  return m?{lang:(m[1]||'txt').toLowerCase(),code:m[2].trim()}:null;
}
function extensionFor(lang){
  const map={html:'html',javascript:'js',js:'js',typescript:'ts',ts:'ts',python:'py',py:'py',json:'json',css:'css',bash:'sh',shell:'sh'};
  return map[lang]||'txt';
}
async function sendGeneratedFile(runtime,event,result,{base='nexai-build',caption='NexAI Premium'}={}){
  const block=codeBlock(result.text);
  if(!block)return false;
  const file=path.join(os.tmpdir(),base+'-'+Date.now()+'.'+extensionFor(block.lang));
  await fs.writeFile(file,block.code,'utf8');
  try{
    await runtime.client.sendFile(event.message.peerId,{file,caption});
    return true;
  }finally{
    await fs.unlink(file).catch(()=>{});
  }
}
async function repliedMessage(event){
  try{return await event?.message?.getReplyMessage?.()}catch{return null}
}
async function resolveEntityId(client,ref){
  const value=clean(ref);
  if(!value)throw new Error('cible_manquante');
  const entity=await client.getEntity(value);
  return String(entity?.id||entity?.userId||entity?.channelId||'');
}

async function handleTaskCommand({runtime,name,args,reply}){
  const id=accountId(runtime);
  const op=clean(args[0]).toLowerCase();
  if(op==='list'){
    const rows=await listPowers(id,name);
    await reply(rows.length?rows.map(taskLine).join('\n'):'Aucun '+name+' actif.');
    return true;
  }
  if(op==='stop'||op==='delete'||op==='off'){
    const ok=await stopPower(id,args[1]);
    await reply(ok?'Power #'+clean(args[1])+' arrêté.':'Power introuvable.');
    return true;
  }
  const instruction=clean(args.join(' '));
  if(!instruction){
    await reply('/'+name+' <instruction>\n/'+name+' list\n/'+name+' stop <id>');
    return true;
  }
  const intervalMs=parseIntervalMs(instruction,name==='watch'?15*60000:60*60000);
  const urls=extractUrls(instruction);
  const powerId=await createPower(id,{
    kind:name,instruction,label:instruction.slice(0,120),intervalMs,urls,
    nextRunAt:new Date(Date.now()+Math.min(intervalMs,60000)),peerRef:'me'
  });
  await reply('NexAI '+name+' #'+powerId+' activé.\nFréquence : '+Math.round(intervalMs/60000)+' min'+(urls.length?'\nSources : '+urls.join(', '):''));
  return true;
}

async function handleMirror({runtime,args,reply}){
  const id=accountId(runtime);
  const op=clean(args[0]).toLowerCase();
  if(op==='list'){
    const rows=await listPowers(id,'mirror');
    await reply(rows.length?rows.map(taskLine).join('\n'):'Aucun mirror actif.');
    return true;
  }
  if(op==='stop'||op==='delete'||op==='off'){
    const ok=await stopPower(id,args[1]);
    await reply(ok?'Mirror #'+clean(args[1])+' arrêté.':'Mirror introuvable.');
    return true;
  }
  const raw=clean(args.join(' '));
  const parts=raw.split(/\s*(?:->|=>|vers|to)\s*/i).filter(Boolean);
  if(parts.length!==2){
    await reply('/mirror @source -> @destination\n/mirror list\n/mirror stop <id>');
    return true;
  }
  const [sourceRef,targetRef]=parts;
  const [sourceId,targetId]=await Promise.all([
    resolveEntityId(runtime.client,sourceRef),
    resolveEntityId(runtime.client,targetRef)
  ]);
  if(!sourceId||!targetId)throw new Error('Impossible de résoudre la source ou la destination.');
  if(sourceId===targetId)throw new Error('La source et la destination doivent être différentes.');
  const powerId=await createPower(id,{kind:'mirror',sourceRef,targetRef,sourceId,targetId,label:sourceRef+' → '+targetRef});
  await reply('Mirror #'+powerId+' actif : '+sourceRef+' → '+targetRef);
  return true;
}

function escapedRx(text){
  return clean(text).replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');
}
async function handleMemory({runtime,args,reply}){
  const id=accountId(runtime),c=await collection('nexaccount_premium_memory');
  const op=clean(args[0]).toLowerCase();
  if(op==='list'){
    const rows=await c.find({telegramUserId:id}).sort({updatedAt:-1}).limit(25).toArray();
    await reply(rows.length?rows.map(x=>'#'+x.memoryId+' · '+clean(x.text).slice(0,120)).join('\n'):'Mémoire vide.');
    return true;
  }
  if(op==='find'||op==='search'){
    const q=clean(args.slice(1).join(' '));
    if(!q){await reply('/memory find <texte>');return true}
    const words=q.split(/\s+/).filter(Boolean).slice(0,8);
    const rx=new RegExp(words.map(escapedRx).join('|'),'i');
    const rows=await c.find({telegramUserId:id,text:rx}).sort({updatedAt:-1}).limit(10).toArray();
    await reply(rows.length?rows.map(x=>'#'+x.memoryId+' · '+clean(x.text).slice(0,180)).join('\n'):'Aucun souvenir correspondant.');
    return true;
  }
  if(op==='forget'||op==='delete'){
    const r=await c.deleteOne({telegramUserId:id,memoryId:clean(args[1])});
    await reply(r.deletedCount?'Souvenir supprimé.':'Souvenir introuvable.');
    return true;
  }
  const text=clean((op==='remember'||op==='save')?args.slice(1).join(' '):args.join(' '));
  if(!text){await reply('/memory remember <information>\n/memory find <texte>\n/memory list\n/memory forget <id>');return true}
  const memoryId=shortId(),stamp=now();
  await c.insertOne({telegramUserId:id,memoryId,text:text.slice(0,5000),createdAt:stamp,updatedAt:stamp});
  await reply('Mémorisé sous #'+memoryId+'.');
  return true;
}

async function handleVault({runtime,event,args,reply}){
  const id=accountId(runtime),c=await collection('nexaccount_premium_vault');
  const op=clean(args[0]).toLowerCase();
  if(op==='list'){
    const rows=await c.find({telegramUserId:id}).sort({createdAt:-1}).limit(20).toArray();
    await reply(rows.length?rows.map(x=>'#'+x.vaultId+' · '+clean(x.text||x.mediaType||'message').slice(0,120)).join('\n'):'Vault vide.');
    return true;
  }
  if(op==='find'||op==='search'){
    const q=clean(args.slice(1).join(' '));
    if(!q){await reply('/vault find <texte>');return true}
    const rx=new RegExp(escapedRx(q),'i');
    const rows=await c.find({telegramUserId:id,$or:[{text:rx},{mediaType:rx}]}).sort({createdAt:-1}).limit(10).toArray();
    await reply(rows.length?rows.map(x=>'#'+x.vaultId+' · '+clean(x.text||x.mediaType||'message').slice(0,180)).join('\n'):'Aucun élément correspondant.');
    return true;
  }
  if(op==='delete'||op==='remove'){
    const r=await c.deleteOne({telegramUserId:id,vaultId:clean(args[1])});
    await reply(r.deletedCount?'Élément supprimé du Vault.':'Élément introuvable.');
    return true;
  }
  const msg=await repliedMessage(event);
  if(!msg){await reply('Réponds au message à conserver puis utilise /vault save.');return true}
  const vaultId=shortId(),stamp=now();
  const text=clean(msg.message||msg.text||msg.rawText||'').slice(0,20000);
  const mediaType=clean(msg.media?.className||msg.media?.constructor?.name||'');
  await c.insertOne({
    telegramUserId:id,vaultId,text,mediaType,
    sourcePeerId:String(msg.peerId?.channelId||msg.peerId?.chatId||msg.peerId?.userId||''),
    sourceMessageId:Number(msg.id)||0,createdAt:stamp
  });
  await reply('Ajouté au Vault sous #'+vaultId+(mediaType?' · '+mediaType:'')+'.');
  return true;
}

async function handleResearch({runtime,event,args,reply}){
  const prompt=clean(args.join(' '));
  if(!prompt){await reply('/research <question, sujet ou URLs>');return true}
  const sources=await contextFromUrls(prompt);
  const result=await ai(runtime,event,[
    'NEXAI PREMIUM RESEARCH',
    'Produce a rigorous research brief in the user language.',
    'Separate established facts, uncertainty, and recommendations.',
    'Never invent citations or claim you browsed sources that were not provided below.',
    'Question: '+prompt,
    sources?'Retrieved source material:\n'+sources:'No URL source was supplied. State that the answer is model analysis rather than verified live web research.'
  ].join('\n\n'),'deepseek');
  await reply(result.text);
  return true;
}

async function handleGenerator({runtime,event,name,args,reply}){
  const request=clean(args.join(' '));
  if(!request){await reply('/'+name+' <ce que tu veux créer>');return true}
  let instruction='';
  if(name==='webapp')instruction='Create a polished single-file HTML application with embedded CSS and JavaScript. Return the complete runnable HTML in one html code block, then a very short usage note.';
  else if(name==='botforge')instruction='Create a production-minded Telegram bot in Node.js. Prefer grammY. Return one complete runnable JavaScript file in a js code block. Do not include secrets; read BOT_TOKEN from environment.';
  else instruction='Build the requested software now. Choose sensible defaults. Return the most useful complete runnable core file in a single code block before explanations.';
  const result=await ai(runtime,event,instruction+'\n\nUSER REQUEST:\n'+request,'code');
  const sent=await sendGeneratedFile(runtime,event,result,{
    base:name==='webapp'?'nexai-webapp':name==='botforge'?'nexai-bot':'nexai-build',
    caption:'NexAI Premium · '+name
  }).catch(()=>false);
  if(!sent||clean(result.text).replace(/\`\`\`[\s\S]*?\`\`\`/g,'').trim())await reply(result.text);
  return true;
}

async function handleStudio({runtime,event,args,reply}){
  const msg=await repliedMessage(event);
  const extra=clean(args.join(' '));
  if(!msg&&!extra){await reply('Réponds à une vidéo/audio/image avec /studio, éventuellement suivi de ton objectif.');return true}
  const mediaType=clean(msg?.media?.className||msg?.media?.constructor?.name||'média');
  const caption=clean(msg?.message||msg?.text||msg?.rawText||'');
  const result=await ai(runtime,event,[
    'NEXAI PREMIUM STUDIO',
    'Act as a short-form content producer.',
    'Create a concrete production pack: strongest hook, 5 clip ideas, captions, subtitle style, thumbnail concept, platform-specific posting copy, and CTA.',
    'Do not invent timestamps or pretend you inspected audio/video frames if only metadata/caption is available.',
    'Media type: '+mediaType,
    'Existing caption/context: '+caption,
    'User objective: '+extra
  ].join('\n'),'deepseek');
  await reply(result.text);
  return true;
}

export function canHandlePremiumCommand(name){return POWER_NAMES.has(clean(name).toLowerCase())}

export async function handlePremiumCommand({runtime,event,name,args=[],reply}){
  const key=clean(name).toLowerCase();
  if(!POWER_NAMES.has(key))return false;
  if(key==='autopilot'||key==='watch')return handleTaskCommand({runtime,name:key,args,reply});
  if(key==='mirror')return handleMirror({runtime,args,reply});
  if(key==='memory')return handleMemory({runtime,args,reply});
  if(key==='vault')return handleVault({runtime,event,args,reply});
  if(key==='research')return handleResearch({runtime,event,args,reply});
  if(key==='webapp'||key==='botforge'||key==='build')return handleGenerator({runtime,event,name:key,args,reply});
  if(key==='studio')return handleStudio({runtime,event,args,reply});
  return false;
}

async function dueTasks(id){
  const c=await collection('nexaccount_premium_powers');
  return c.find({telegramUserId:id,status:'active',kind:{$in:['autopilot','watch']},nextRunAt:{$lte:now()}}).sort({nextRunAt:1}).limit(5).toArray();
}
async function claimTask(row){
  const c=await collection('nexaccount_premium_powers');
  const lockedUntil=new Date(Date.now()+2*60000);
  return c.findOneAndUpdate(
    {_id:row._id,status:'active',$or:[{lockedUntil:{$exists:false}},{lockedUntil:{$lt:now()}}]},
    {$set:{lockedUntil,updatedAt:now()}},{returnDocument:'after'}
  );
}
async function finishTask(row,patch={}){
  const c=await collection('nexaccount_premium_powers');
  const interval=Math.max(5*60000,Number(row.intervalMs)||60*60000);
  await c.updateOne({_id:row._id},{$set:{...patch,lockedUntil:null,lastRunAt:now(),nextRunAt:new Date(Date.now()+interval),updatedAt:now()}});
}

async function runWatch(runtime,row){
  const url=row.urls?.[0]||extractUrls(row.instruction||'')[0];
  if(!url)return finishTask(row,{lastError:'Aucune URL à surveiller'});
  const page=await safeFetch(url,{limit:100000});
  const fingerprint=crypto.createHash('sha256').update(page.text).digest('hex');
  if(row.fingerprint&&row.fingerprint!==fingerprint){
    await runtime.client.sendMessage('me',{message:'NexAI Watch #'+row.powerId+' · changement détecté\n'+url});
  }
  await finishTask(row,{fingerprint,lastError:''});
}
async function runAutopilot(runtime,row){
  const source=await contextFromUrls(row.instruction||'');
  const result=await generateAiReply({
    accountId:accountId(runtime),peer:'autopilot:'+row.powerId,
    prompt:['NEXAI AUTOPILOT RUN','Execute this recurring knowledge-work instruction and return only the useful result for the owner.','Instruction: '+clean(row.instruction),source?'Current fetched source context:\n'+source:''].join('\n\n'),
    mode:'deepseek',language:runtime?.account?.preferredLanguage||runtime?.account?.telegramLanguage||'fr'
  });
  await runtime.client.sendMessage('me',{message:'NexAI Autopilot #'+row.powerId+'\n\n'+result.text});
  await finishTask(row,{lastError:''});
}

export async function runPremiumPowers(runtime){
  if(!runtime?.account?.nexaiPremium)return false;
  const rows=await dueTasks(accountId(runtime));
  for(const original of rows){
    const row=await claimTask(original);
    if(!row)continue;
    try{
      if(row.kind==='watch')await runWatch(runtime,row);
      else if(row.kind==='autopilot')await runAutopilot(runtime,row);
    }catch(error){
      await finishTask(row,{lastError:clean(error?.message||error).slice(0,500)}).catch(()=>{});
    }
  }
  return true;
}

export async function startPremiumPowers(runtime){
  if(!runtime||runtime.premiumPowersTimer)return false;
  runPremiumPowers(runtime).catch(error=>console.warn('[NexAI Premium runner]',clean(error?.message||error).slice(0,300)));
  runtime.premiumPowersTimer=setInterval(()=>runPremiumPowers(runtime).catch(error=>console.warn('[NexAI Premium runner]',clean(error?.message||error).slice(0,300))),RUNNER_MS);
  runtime.premiumPowersTimer.unref?.();
  return true;
}

async function mirrorRows(id){
  const cached=mirrorCache.get(id);
  if(cached&&cached.expires>Date.now())return cached.rows;
  const c=await collection('nexaccount_premium_powers');
  const rows=await c.find({telegramUserId:id,kind:'mirror',status:'active'}).limit(30).toArray();
  mirrorCache.set(id,{rows,expires:Date.now()+MIRROR_CACHE_TTL});
  return rows;
}

export async function handlePremiumPowerEvent(runtime,event){
  if(!runtime?.account?.nexaiPremium)return false;
  const sourceId=eventPeerId(event);
  if(!sourceId)return false;
  const rows=await mirrorRows(accountId(runtime));
  const msg=event?.message;
  if(!msg?.id)return false;
  for(const row of rows){
    if(String(row.sourceId)!==sourceId)continue;
    try{
      const target=await runtime.client.getInputEntity(row.targetRef||row.targetId);
      await runtime.client.forwardMessages(target,{messages:[msg.id],fromPeer:msg.peerId});
    }catch(error){
      console.warn('[NexAI Mirror]',row.powerId,clean(error?.message||error).slice(0,250));
    }
  }
  return false;
}

export const __test={extractUrls,parseIntervalMs,codeBlock,extensionFor};
