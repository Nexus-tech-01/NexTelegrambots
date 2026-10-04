import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Api } from 'teleproto';
import { cfg } from './config.mjs';
import { loadBotToken } from './secrets.mjs';
import { consumeQuota, patchSettings, settingsFor } from './store.mjs';
import { sendTelegramMedia } from './media-send.mjs';
import { renderTgsToAnimatedWebp } from './lottie-renderer.mjs';
import { addStickerWatermark, removeStickerWatermark, roundSticker } from './sticker-transform.mjs';
import {
  claimStickerJob,
  completeStickerJob,
  createStickerJob,
  listPendingStickerJobs,
  newStickerJobId,
  patchStickerJob,
  releaseStickerJob,
  renewStickerJobLease
} from './sticker-jobs.mjs';

const FFMPEG=String(process.env.FFMPEG_PATH||'ffmpeg');
const MAX_SOURCE_BYTES=Math.max(1024*1024,Number(process.env.NEXAI_STICKER_MAX_SOURCE_BYTES||25*1024*1024));
const STICKER_PACK_PART_SIZE=Math.max(10,Math.min(120,Number(process.env.NEXAI_STICKER_PACK_PART_SIZE||120)));
const STICKER_PERSISTENT_RETRY_MS=Math.max(5000,Math.min(10*60*1000,Number(process.env.NEXAI_STICKER_PERSISTENT_RETRY_MS||30000)));
const CLONE_RETRY_ATTEMPTS=Math.max(2,Math.min(20,Number(process.env.NEXAI_STICKER_CLONE_RETRY_ATTEMPTS||8)));
const CLONE_RETRY_BASE_MS=Math.max(250,Math.min(10000,Number(process.env.NEXAI_STICKER_CLONE_RETRY_BASE_MS||1200)));
const CLONE_MUTATION_GAP_MS=Math.max(250,Math.min(5000,Number(process.env.NEXAI_STICKER_MUTATION_GAP_MS||900)));
const CLONE_TRANSIENT_MAX_MS=Math.max(5*60*1000,Math.min(12*60*60*1000,Number(process.env.NEXAI_STICKER_TRANSIENT_MAX_MS||6*60*60*1000)));
const activeCloneJobs=new Map();
let stickerMutationTail=Promise.resolve();
let stickerMutationNextAt=0;
const cloneDownloadTails=new Map();

const clean=v=>String(v??'').trim();
const randomLong=()=>BigInt.asIntN(64,BigInt('0x'+crypto.randomBytes(8).toString('hex')));
const className=x=>String(x?.className||x?.constructor?.name||'');
const tmp=ext=>path.join(os.tmpdir(),'nexai-sticker-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.'+ext);
const cleanup=(...files)=>{for(const f of files.flat().filter(Boolean))try{fs.unlinkSync(f)}catch{}};

function exec(cmd,args,timeout=90000){
  return new Promise((resolve,reject)=>{
    execFile(cmd,args,{timeout,maxBuffer:8*1024*1024},(err,stdout,stderr)=>{
      if(err)return reject(new Error(String(stderr||err.message||err).trim().slice(0,900)));
      resolve({stdout,stderr});
    });
  });
}
function replyId(message){
  return Number(message?.replyTo?.replyToMsgId||message?.replyToMsgId||message?.replyTo?.msgId||0);
}
async function sourceMessage(client,peer,event){
  const id=replyId(event?.message);
  if(id){
    const rows=await client.getMessages(peer,{ids:[id]});
    const msg=Array.isArray(rows)?rows[0]:rows;
    if(msg?.media)return msg;
  }
  if(event?.message?.media)return event.message;
  return null;
}
function documentOf(message){return message?.document||message?.media?.document||null}
function stickerAttr(doc){
  return (doc?.attributes||[]).find(a=>/DocumentAttributeSticker/i.test(className(a)))||null;
}
function mimeOf(message){
  const d=documentOf(message);
  if(d?.mimeType)return String(d.mimeType);
  if(message?.media instanceof Api.MessageMediaPhoto||message?.media?.photo)return 'image/jpeg';
  return 'application/octet-stream';
}
function inputDocument(doc){
  if(!doc?.id||!doc?.accessHash)return null;
  return new Api.InputDocument({id:doc.id,accessHash:doc.accessHash,fileReference:doc.fileReference||Buffer.alloc(0)});
}

async function downloadSource(client,message){
  if(!message?.media)throw new Error('Réponds à une image, vidéo ou sticker.');
  const b=Buffer.from(await client.downloadMedia(message));
  if(!b.length)throw new Error('Média vide ou indisponible.');
  if(b.length>MAX_SOURCE_BYTES)throw new Error('Média trop volumineux.');
  return {buffer:b,mime:mimeOf(message),doc:documentOf(message),sticker:stickerAttr(documentOf(message))};
}
async function downloadDocument(client,doc){
  const media=new Api.MessageMediaDocument({document:doc});
  const b=Buffer.from(await client.downloadMedia(media));
  if(!b.length)throw new Error('Sticker source indisponible.');
  return {buffer:b,mime:String(doc?.mimeType||'application/octet-stream'),doc,sticker:stickerAttr(doc)};
}

async function downloadCloneDocument(client,doc,{sourcePackName='',sourceIndex=0}={}){
  let current=doc;
  try{
    return await downloadDocument(client,current);
  }catch(error){
    const message=String(error?.message||error||'');
    if(sourcePackName&&/FILE_REFERENCE|FILEREF|document.*invalid|media.*invalid/i.test(message)){
      const refreshed=await telegramSetByName(client,sourcePackName);
      const fresh=refreshed?.documents?.[sourceIndex];
      if(fresh){
        current=fresh;
        return downloadDocument(client,current);
      }
    }
    throw error;
  }
}

async function prepareSticker(source){
  const mime=String(source.mime||'').toLowerCase();
  if(mime.includes('tgsticker')||mime.includes('x-tgsticker')){
    return {buffer:source.buffer,format:'animated',filename:'sticker.tgs',mime:'application/x-tgsticker'};
  }
  if(mime.includes('webm')){
    return {buffer:source.buffer,format:'video',filename:'sticker.webm',mime:'video/webm'};
  }
  if(mime.includes('webp')&&source.buffer.length<=512*1024){
    return {buffer:source.buffer,format:'static',filename:'sticker.webp',mime:'image/webp'};
  }

  const input=tmp(mime.includes('video')?'mp4':mime.includes('png')?'png':'jpg');
  const isVideo=mime.startsWith('video/');
  const output=tmp(isVideo?'webm':'webp');
  fs.writeFileSync(input,source.buffer);
  try{
    if(isVideo){
      await exec(FFMPEG,[
        '-hide_banner','-loglevel','error','-y','-i',input,'-t','3',
        '-vf',"fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        '-an','-c:v','libvpx-vp9','-b:v','0','-crf','38','-pix_fmt','yuva420p',output
      ]);
      const b=fs.readFileSync(output);
      if(b.length>1024*1024)throw new Error('Sticker vidéo > 1 Mo après conversion.');
      return {buffer:b,format:'video',filename:'sticker.webm',mime:'video/webm'};
    }
    await exec(FFMPEG,[
      '-hide_banner','-loglevel','error','-y','-i',input,
      '-vf',"scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
      '-c:v','libwebp','-lossless','0','-compression_level','6','-q:v','70','-frames:v','1',output
    ]);
    let b=fs.readFileSync(output);
    if(b.length>512*1024){
      await exec(FFMPEG,[
        '-hide_banner','-loglevel','error','-y','-i',input,
        '-vf',"scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
        '-c:v','libwebp','-lossless','0','-compression_level','6','-q:v','45','-frames:v','1',output
      ]);
      b=fs.readFileSync(output);
    }
    if(b.length>512*1024)throw new Error('Sticker image > 512 Ko après conversion.');
    return {buffer:b,format:'static',filename:'sticker.webp',mime:'image/webp'};
  }finally{cleanup(input,output)}
}

async function botApi(method,fields={},file=null,timeout=60000){
  const token=await loadBotToken();
  if(!token)throw new Error('Le token NexAi est indisponible dans le coffre local.');
  const url='https://api.telegram.org/bot'+token+'/'+method;
  let body,headers={};
  if(file){
    const form=new FormData();
    for(const [k,v] of Object.entries(fields)){
      if(v===undefined||v===null)continue;
      form.append(k,typeof v==='string'?v:JSON.stringify(v));
    }
    form.append(file.field,new Blob([file.buffer],{type:file.mime||'application/octet-stream'}),file.filename||'file.bin');
    body=form;
  }else{
    headers['content-type']='application/json';
    body=JSON.stringify(fields);
  }
  const r=await fetch(url,{method:'POST',headers,body,signal:AbortSignal.timeout(timeout)});
  const d=await r.json().catch(()=>null);
  if(!r.ok||!d?.ok){
    const error=new Error(clean(d?.description)||('Bot API '+method+' HTTP '+r.status));
    error.status=Number(r.status||0);
    error.retryAfter=Math.max(0,Number(d?.parameters?.retry_after||0));
    throw error;
  }
  return d.result;
}

function safeBase(v,max=24){
  return clean(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,max)||'pack';
}
function packSuffix(){
  const bot=safeBase(cfg.botUsername||'NexAi01_bot',28).replace(/_bot$/,'_bot');
  return '_by_'+bot;
}
function packName(accountId,label='nexai'){
  const suffix=packSuffix();
  const id=safeBase(String(accountId).slice(-12),12);
  const nonce=Date.now().toString(36).slice(-6)+crypto.randomBytes(2).toString('hex');
  const maxPrefix=Math.max(4,64-suffix.length);
  const tail='_'+id+'_'+nonce;
  const head=safeBase(label,Math.max(4,maxPrefix-tail.length));
  return (head+tail).slice(0,maxPrefix)+suffix;
}
function defaultPackName(accountId){
  const suffix=packSuffix();
  const maxPrefix=Math.max(4,64-suffix.length);
  return ('nexai_'+safeBase(String(accountId).slice(-16),16)).slice(0,maxPrefix)+suffix;
}

function accountDisplayName(account){
  const username=clean(account?.username).replace(/^@/,'');
  if(username)return '@'+username;
  const full=[clean(account?.firstName),clean(account?.lastName)].filter(Boolean).join(' ').trim();
  return full||'Telegram User';
}
function automaticPackTitle(account,settings=null){
  const bot=clean(settings?.botDisplayName)||'NexAi';
  return (bot+' · '+accountDisplayName(account)).slice(0,64);
}
async function startProgress(client,peer,text){
  const sent=await client.sendMessage(peer,{message:String(text)});
  const id=Number(sent?.id||sent?.message?.id||0);
  let inputPeer=null;
  try{inputPeer=await client.getInputEntity(peer)}catch{}
  return {
    id,
    async update(next){
      if(!id||!inputPeer)return;
      try{
        await client.invoke(new Api.messages.EditMessage({
          peer:inputPeer,id,message:String(next)
        }));
      }catch{}
    }
  };
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(ms)||0)));

function cloneRetryDelay(error,attempt){
  const explicit=Math.max(
    0,
    Number(error?.retryAfter||0),
    Number(error?.seconds||0),
    Number(String(error?.message||'').match(/(?:FLOOD_WAIT_|retry after\s+)(\d+)/i)?.[1]||0)
  );
  if(explicit>0)return Math.min(30*60*1000,explicit*1000+700);
  return Math.min(30000,CLONE_RETRY_BASE_MS*Math.max(1,2**Math.max(0,attempt-1)));
}

function cloneErrorRetryable(error){
  const status=Number(error?.status||0);
  const message=String(error?.message||error||'');
  if(status===429||status>=500)return true;
  return /FLOOD_WAIT|Too Many Requests|retry after|timeout|timed out|fetch failed|ECONN|EAI_AGAIN|ENET|socket|network|temporar|STICKERSET_INVALID|STICKERSET_NOT_MODIFIED|internal server error|bad gateway|service unavailable/i.test(message);
}

async function withCloneRetry(action,label='clone',{persistentTransient=false}={}){
  let last=null,attempt=0;
  const started=Date.now();
  while(true){
    attempt++;
    try{return await action()}
    catch(error){
      last=error;
      const retryable=cloneErrorRetryable(error);
      const withinPersistentWindow=persistentTransient&&retryable&&(Date.now()-started)<CLONE_TRANSIENT_MAX_MS;
      if(!withinPersistentWindow&&attempt>=CLONE_RETRY_ATTEMPTS)break;
      if(!retryable&&attempt>=Math.min(3,CLONE_RETRY_ATTEMPTS))break;
      const delay=cloneRetryDelay(error,attempt);
      console.warn('[NexAi sticker clone retry]',label,'attempt',attempt,'delay',delay,'retryable='+retryable,String(error?.message||error));
      await sleep(delay);
    }
  }
  throw last||new Error('Clone operation failed');
}

function queueCloneMutation(action,label='mutation'){
  const task=stickerMutationTail.then(async()=>{
    const wait=Math.max(0,stickerMutationNextAt-Date.now());
    if(wait)await sleep(wait);
    try{
      return await withCloneRetry(action,label,{persistentTransient:true});
    }finally{
      stickerMutationNextAt=Date.now()+CLONE_MUTATION_GAP_MS;
    }
  });
  stickerMutationTail=task.catch(()=>{});
  return task;
}

function queueCloneDownload(accountId,action,label='download'){
  const key=String(accountId||'0');
  const previous=cloneDownloadTails.get(key)||Promise.resolve();
  const task=previous.then(()=>withCloneRetry(action,label,{persistentTransient:true}));
  const tail=task.catch(()=>{});
  cloneDownloadTails.set(key,tail);
  tail.finally(()=>{
    if(cloneDownloadTails.get(key)===tail)cloneDownloadTails.delete(key);
  });
  return task;
}

function cloneJobId(accountId){
  return String(accountId||'0')+'-'+Date.now().toString(36)+'-'+crypto.randomBytes(4).toString('hex');
}

async function safeProgress(progress,text){
  try{
    if(typeof progress?.update==='function')await progress.update(String(text));
  }catch{}
}

async function runClonePackJob({id,runtime,docs,title,newName,progress,sourcePackName=''}) {
  const {client,account}=runtime;
  let added=0,failed=0,created=false;
  console.log('[NexAi sticker clone job]',id,'started','account='+account.telegramUserId,'total='+docs.length,'pack='+newName);
  try{
    for(let i=0;i<docs.length;i++){
      const doc=docs[i];
      try{
        const raw=await queueCloneDownload(
          account.telegramUserId,
          ()=>downloadCloneDocument(client,doc,{sourcePackName,sourceIndex:i}),
          id+' download '+(i+1)+'/'+docs.length
        );
        const prepared=await prepareSticker(raw);
        const emoji=stickerAttr(doc)?.alt||'✨';
        if(!created){
          await queueCloneMutation(
            ()=>createSet(account,title,newName,prepared,emoji),
            id+' create set'
          );
          created=true;
        }else{
          await queueCloneMutation(
            ()=>addToSet(account,newName,prepared,emoji),
            id+' add '+(i+1)+'/'+docs.length
          );
        }
        added++;
        console.log('[NexAi sticker clone job]',id,'progress',added+'/'+docs.length,'sourceIndex='+(i+1));
      }catch(error){
        failed++;
        console.error('[NexAi sticker clone job]',id,'sticker '+(i+1)+'/'+docs.length+' failed after retries',String(error?.message||error));
        throw new Error('Sticker '+(i+1)+'/'+docs.length+' impossible à cloner après les reprises: '+String(error?.message||error));
      }
      if(i===0||i===docs.length-1||(i+1)%3===0){
        await safeProgress(progress,'⏳ Clone pack · '+(i+1)+'/'+docs.length+' · '+added+' ajouté(s)…');
      }
    }

    if(added!==docs.length)throw new Error('Clone incomplet: '+added+'/'+docs.length);
    await rememberPack(account.telegramUserId,{
      name:newName,title,link:packLink(newName),count:added,sourceCount:docs.length,skipped:0,updatedAt:Date.now()
    });
    console.log('[NexAi sticker clone job]',id,'completed',added+'/'+docs.length,'pack='+newName);
    await safeProgress(progress,'✅ Pack cloné · '+added+'/'+docs.length+' sticker(s)\n'+packLink(newName));
  }catch(error){
    console.error('[NexAi sticker clone job]',id,'stopped',added+'/'+docs.length,'failed='+failed,String(error?.stack||error));
    await safeProgress(progress,'❌ Clone pack interrompu · '+added+'/'+docs.length+' sticker(s)\n'+String(error?.message||error).slice(0,300));
  }finally{
    activeCloneJobs.delete(id);
  }
}

function launchClonePackJob({runtime,docs,title,newName,progress,sourcePackName=''}) {
  const id=cloneJobId(runtime?.account?.telegramUserId);
  const immutableDocs=[...docs];
  activeCloneJobs.set(id,{
    id,
    accountId:String(runtime?.account?.telegramUserId||''),
    title,
    newName,
    total:immutableDocs.length,
    sourcePackName,
    startedAt:Date.now()
  });
  void runClonePackJob({id,runtime,docs:immutableDocs,title,newName,progress,sourcePackName});
  return id;
}

function transformArg(args,key,fallback=''){
  const prefix='--'+key+'=';
  const found=(Array.isArray(args)?args:[]).find(x=>String(x).toLowerCase().startsWith(prefix));
  return found===undefined?fallback:String(found).slice(prefix.length).trim();
}

function transformTitleArgs(args){
  return (Array.isArray(args)?args:[])
    .filter(x=>!String(x).startsWith('--'))
    .join(' ')
    .trim();
}

function transformScope(args,set){
  const flags=new Set((Array.isArray(args)?args:[]).map(x=>String(x).toLowerCase()));
  if(flags.has('--one')||flags.has('--single'))return 'one';
  if(flags.has('--pack')||flags.has('--all'))return 'pack';
  return set?.documents?.length?'pack':'one';
}

function transformOpacity(value,fallback=0.18){
  if(value===undefined||value===null||String(value).trim()==='')return fallback;
  let n=Number(String(value).replace('%','').trim());
  if(!Number.isFinite(n))return fallback;
  if(n>1)n/=100;
  return Math.max(0.02,Math.min(0.90,n));
}

function transformNumber(value,fallback,min,max){
  const n=Number(String(value??'').trim());
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}

function transformFlag(args,key){
  const wanted='--'+String(key||'').toLowerCase();
  return (Array.isArray(args)?args:[]).some(x=>{
    const v=String(x).toLowerCase();
    return v===wanted||v===wanted+'=true'||v===wanted+'=1'||v===wanted+'=yes'||v===wanted+'=on';
  });
}

async function runTransformPackJob({
  id,runtime,docs,title,newName,progress,sourcePackName='',kind='transform',transform
}) {
  const {client,account}=runtime;
  let added=0,created=false;
  const label=kind==='filitake'?'Filitake':kind==='delfilig'?'Delfilig':kind==='ultratake'?'Ultratake':'Noteclone';
  console.log('[NexAi sticker transform]',id,'started','kind='+kind,'account='+account.telegramUserId,'total='+docs.length,'pack='+newName);
  try{
    for(let i=0;i<docs.length;i++){
      const doc=docs[i];
      const raw=await queueCloneDownload(
        account.telegramUserId,
        ()=>downloadCloneDocument(client,doc,{sourcePackName,sourceIndex:i}),
        id+' '+kind+' download '+(i+1)+'/'+docs.length
      );
      const prepared=await transform(raw,{index:i,doc});
      const emoji=stickerAttr(doc)?.alt||'✨';
      if(!created){
        await queueCloneMutation(
          ()=>createSet(account,title,newName,prepared,emoji),
          id+' '+kind+' create set'
        );
        created=true;
      }else{
        await queueCloneMutation(
          ()=>addToSet(account,newName,prepared,emoji),
          id+' '+kind+' add '+(i+1)+'/'+docs.length
        );
      }
      added++;
      if(i===0||i===docs.length-1||(i+1)%3===0){
        await safeProgress(progress,'⏳ '+label+' · '+(i+1)+'/'+docs.length+' · '+added+' ajouté(s)…');
      }
    }
    if(added!==docs.length)throw new Error(label+' incomplet: '+added+'/'+docs.length);
    await rememberPack(account.telegramUserId,{
      name:newName,title,link:packLink(newName),count:added,sourceCount:docs.length,
      transform:kind,updatedAt:Date.now()
    });
    await safeProgress(progress,'✅ '+label+' terminé · '+added+'/'+docs.length+' sticker(s)\n'+packLink(newName));
    console.log('[NexAi sticker transform]',id,'completed','kind='+kind,added+'/'+docs.length,'pack='+newName);
  }catch(error){
    console.error('[NexAi sticker transform]',id,'stopped','kind='+kind,added+'/'+docs.length,String(error?.stack||error));
    await safeProgress(progress,'❌ '+label+' interrompu · '+added+'/'+docs.length+' sticker(s)\n'+String(error?.message||error).slice(0,300));
  }finally{
    activeCloneJobs.delete(id);
  }
}

function launchTransformPackJob({
  runtime,docs,title,newName,progress,sourcePackName='',kind='transform',transform
}) {
  const id=cloneJobId(runtime?.account?.telegramUserId);
  const immutableDocs=[...docs];
  activeCloneJobs.set(id,{
    id,
    accountId:String(runtime?.account?.telegramUserId||''),
    title,newName,total:immutableDocs.length,sourcePackName,kind,startedAt:Date.now()
  });
  void runTransformPackJob({
    id,runtime,docs:immutableDocs,title,newName,progress,sourcePackName,kind,transform
  });
  return id;
}

export function stickerCloneJobs(accountId=null){
  const rows=[...activeCloneJobs.values()].map(row=>({...row}));
  if(accountId===null||accountId===undefined)return rows;
  return rows.filter(row=>row.accountId===String(accountId));
}
async function whatsappStickerWebp(source){
  const mime=String(source?.mime||'').toLowerCase();
  if(mime.includes('tgsticker')||mime.includes('x-tgsticker')){
    const buffer=await renderTgsToAnimatedWebp(source.buffer,{size:512,targetFps:15,maxSeconds:6});
    return {buffer,animated:true};
  }
  const animated=mime.includes('webm')||mime.startsWith('video/');
  const input=tmp(mime.includes('webm')?'webm':animated?'mp4':mime.includes('png')?'png':mime.includes('webp')?'webp':'jpg');
  const output=tmp('webp');
  fs.writeFileSync(input,source.buffer);
  try{
    if(animated){
      for(const fps of [20,15,12]){
        for(const quality of [62,50,40,32,24]){
          await exec(FFMPEG,[
            '-hide_banner','-loglevel','error','-y','-i',input,'-t','6',
            '-vf',"fps="+fps+",scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
            '-an','-loop','0','-c:v','libwebp','-lossless','0','-compression_level','6','-q:v',String(quality),output
          ]);
          const b=fs.readFileSync(output);
          if(b.length<=500*1024)return {buffer:b,animated:true};
        }
      }
      throw new Error('sticker animé WhatsApp > 500 Ko après optimisation');
    }

    for(const quality of [72,58,44,30,20]){
      await exec(FFMPEG,[
        '-hide_banner','-loglevel','error','-y','-i',input,
        '-vf',"scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
        '-frames:v','1','-c:v','libwebp','-lossless','0','-compression_level','6','-q:v',String(quality),output
      ]);
      const b=fs.readFileSync(output);
      if(b.length<=100*1024)return {buffer:b,animated:false};
    }
    throw new Error('sticker WhatsApp > 100 Ko après optimisation');
  }finally{cleanup(input,output)}
}

async function whatsappTray(webp){
  const input=tmp('webp'),output=tmp('png');
  fs.writeFileSync(input,webp);
  try{
    await exec(FFMPEG,[
      '-hide_banner','-loglevel','error','-y','-i',input,
      '-vf',"scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba",
      '-frames:v','1','-compression_level','9',output
    ]);
    const b=fs.readFileSync(output);
    if(!b.length||b.length>50*1024)throw new Error('icône WhatsApp invalide');
    return b;
  }finally{cleanup(input,output)}
}
async function packExists(name){
  try{return await botApi('getStickerSet',{name})}catch{return null}
}
async function createSet(account,title,name,prepared,emoji='✨'){
  const sticker={sticker:'attach://sticker_file',format:prepared.format,emoji_list:[emoji]};
  return botApi('createNewStickerSet',{
    user_id:String(account.telegramUserId),name,title:String(title).slice(0,64),
    stickers:[sticker],sticker_type:'regular'
  },{field:'sticker_file',buffer:prepared.buffer,mime:prepared.mime,filename:prepared.filename});
}
async function addToSet(account,name,prepared,emoji='✨'){
  return botApi('addStickerToSet',{
    user_id:String(account.telegramUserId),name,
    sticker:{sticker:'attach://sticker_file',format:prepared.format,emoji_list:[emoji]}
  },{field:'sticker_file',buffer:prepared.buffer,mime:prepared.mime,filename:prepared.filename});
}
async function rememberPack(accountId,pack){
  const s=await settingsFor(accountId);
  const list=Array.isArray(s.stickerPacks)?s.stickerPacks:[];
  const next=[pack,...list.filter(x=>x?.name!==pack.name)].slice(0,100);
  await patchSettings(accountId,{stickerPacks:next});
}
async function telegramSet(client,stickerSetInput){
  if(!stickerSetInput)return null;
  return client.invoke(new Api.messages.GetStickerSet({stickerset:stickerSetInput,hash:0}));
}
async function telegramSetByName(client,name){
  return telegramSet(client,new Api.InputStickerSetShortName({shortName:name}));
}
async function sendStickerDocument(client,peer,doc){
  const input=inputDocument(doc);
  if(!input)throw new Error('Document sticker invalide.');
  const inputPeer=await client.getInputEntity(peer);
  return client.invoke(new Api.messages.SendMedia({
    peer:inputPeer,
    media:new Api.InputMediaDocument({id:input}),
    message:'',
    randomId:randomLong()
  }));
}
async function waitTelegramSet(client,name){
  let last;
  for(let i=0;i<5;i++){
    try{
      const set=await telegramSetByName(client,name);
      if(set?.documents?.length)return set;
      last=new Error('pack vide');
    }catch(e){last=e}
    await new Promise(r=>setTimeout(r,500));
  }
  throw last||new Error('pack Telegram indisponible');
}
function packLink(name){return 'https://t.me/addstickers/'+name}

async function ensureDefaultPack(runtime,prepared,settings=null){
  const {account}=runtime;
  const name=defaultPackName(account.telegramUserId);
  const existing=await packExists(name);
  if(existing)await addToSet(account,name,prepared);
  else await createSet(account,automaticPackTitle(account,settings),name,prepared);
  await rememberPack(account.telegramUserId,{name,title:automaticPackTitle(account,settings),link:packLink(name),updatedAt:Date.now()});
  return name;
}

async function sourceSet(client,message){
  const doc=documentOf(message),attr=stickerAttr(doc);
  if(!doc||!attr?.stickerset)return null;
  return telegramSet(client,attr.stickerset);
}

const CRC_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}
  return table;
})();
function crc32(buf){
  let c=0xffffffff;
  for(const b of buf)c=CRC_TABLE[(c^b)&0xff]^(c>>>8);
  return (c^0xffffffff)>>>0;
}
function dosTimeDate(date=new Date()){
  const year=Math.max(1980,date.getFullYear());
  const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
  const day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  return {time,day};
}
function makeZip(files){
  const locals=[],centrals=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name);
    const data=Buffer.from(file.data);
    const crc=crc32(data),{time,day}=dosTimeDate();
    const local=Buffer.alloc(30+name.length);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(time,10);local.writeUInt16LE(day,12);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);name.copy(local,30);
    locals.push(local,data);
    const central=Buffer.alloc(46+name.length);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);
    central.writeUInt16LE(time,12);central.writeUInt16LE(day,14);central.writeUInt32LE(crc,16);
    central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt16LE(0,30);
    central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);name.copy(central,46);
    centrals.push(central);offset+=local.length+data.length;
  }
  const centralSize=centrals.reduce((n,b)=>n+b.length,0),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);
  end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
  return Buffer.concat([...locals,...centrals,end]);
}

function isWebp(buffer){
  const b=Buffer.from(buffer||[]);
  return b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
}
function isPng(buffer){
  const b=Buffer.from(buffer||[]);
  return b.length>=8&&b[0]===0x89&&b.toString('ascii',1,4)==='PNG'&&b[4]===0x0d&&b[5]===0x0a&&b[6]===0x1a&&b[7]===0x0a;
}
export function buildWastickersArchive({title='NexAi Stickers',author='NexAi',stickers=[],cover}={}){
  const rows=Array.isArray(stickers)?stickers:[];
  if(rows.length<3||rows.length>30)throw new Error('wastickers : 3 à 30 stickers requis');
  const coverBuffer=Buffer.from(cover||[]);
  if(!isPng(coverBuffer))throw new Error('wastickers : cover.png doit être un PNG valide');
  if(coverBuffer.length>50*1024)throw new Error('wastickers : cover.png dépasse 50 Ko');

  const files=[
    {name:'title.txt',data:Buffer.from(String(title||'NexAi Stickers').slice(0,128),'utf8')},
    {name:'author.txt',data:Buffer.from(String(author||'NexAi').slice(0,128),'utf8')},
    {name:'cover.png',data:coverBuffer}
  ];
  rows.forEach((item,index)=>{
    const buffer=Buffer.from(item?.buffer||item||[]);
    const animated=item?.animated===true;
    if(!isWebp(buffer))throw new Error('wastickers : sticker '+(index+1)+' n’est pas un WebP valide');
    const limit=(animated?500:100)*1024;
    if(buffer.length>limit)throw new Error('wastickers : sticker '+(index+1)+' dépasse '+(animated?500:100)+' Ko');
    files.push({name:'sticker_'+String(index+1).padStart(2,'0')+'.webp',data:buffer});
  });
  return makeZip(files);
}

export const STICKER_ENGINE_COMMANDS=new Set(['sticker','stickerinfo','clonepack','createpack','mypacks','exportwhatsapp','ultratake','delfilig','filitake','noteclone']);
export function canHandleStickerCommand(name){return STICKER_ENGINE_COMMANDS.has(String(name||'').toLowerCase())}

let stickerDiagnosticCache={at:0,value:null};

export async function stickerEngineDiagnostic({force=false}={}){
  const now=Date.now();
  if(!force&&stickerDiagnosticCache.value&&now-stickerDiagnosticCache.at<60000){
    return stickerDiagnosticCache.value;
  }
  const png=Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=',
    'base64'
  );
  const prepared=await prepareSticker({buffer:png,mime:'image/png'});
  if(prepared.format!=='static'||prepared.mime!=='image/webp'||!prepared.buffer?.length){
    throw new Error('conversion sticker locale invalide');
  }
  const me=await botApi('getMe',{},null,12000);
  const value={
    ok:true,
    localConversion:true,
    format:prepared.format,
    bytes:prepared.buffer.length,
    botReachable:Boolean(me?.id),
    botUsername:me?.username||''
  };
  stickerDiagnosticCache={at:now,value};
  return value;
}

export async function handleStickerCommand({runtime,event,name,args=[],progress:externalProgress=null,reply=null}){
  const {client,account}=runtime,peer=event.message.peerId;
  const sessionSettings=await settingsFor(account.telegramUserId);
  const say=t=>typeof reply==='function'?reply(String(t)):client.sendMessage(peer,{message:String(t)});

  if(name==='mypacks'){
    const s=sessionSettings,packs=Array.isArray(s.stickerPacks)?s.stickerPacks:[];
    await say(packs.length?'Mes packs NexAi\n\n'+packs.map((p,i)=>(i+1)+'. '+(p.title||p.name)+'\n'+(p.link||packLink(p.name))).join('\n\n'):'Aucun pack NexAi enregistré pour ce compte.');
    return true;
  }

  const source=await sourceMessage(client,peer,event);
  if(!source)throw new Error('Réponds à une image, vidéo ou sticker avec /'+name+'.');

  if(name==='stickerinfo'){
    const doc=documentOf(source),attr=stickerAttr(doc);
    if(!doc||!attr)throw new Error('Le média répondu n’est pas un sticker Telegram.');
    let set=null;try{set=await sourceSet(client,source)}catch{}
    const shortName=clean(set?.set?.shortName||attr?.stickerset?.shortName);
    await say([
      'Sticker · NexAi',
      'Emoji : '+(attr.alt||'?'),
      'MIME : '+(doc.mimeType||'?'),
      'ID : '+String(doc.id||'?'),
      shortName?'Pack : '+(set?.set?.title||shortName):'Pack : privé/inconnu',
      shortName?'Lien : '+packLink(shortName):''
    ].filter(Boolean).join('\n'));
    return true;
  }

  if(name==='exportwhatsapp'){
    const progress=externalProgress||await startProgress(client,peer,'⏳ WhatsApp stickers · préparation du pack…');
    const set=await sourceSet(client,source).catch(()=>null);
    const docs=(set?.documents?.length?set.documents:[documentOf(source)]).filter(Boolean).slice(0,Math.min(MAX_EXPORT,30));
    if(!docs.length)throw new Error('Aucun sticker à exporter.');

    const stickers=[];
    let skipped=0;
    for(let i=0;i<docs.length;i++){
      try{
        const raw=await downloadDocument(client,docs[i]);
        const webp=await whatsappStickerWebp(raw);
        stickers.push(webp);
      }catch(error){
        skipped++;
        console.warn('[NexAi wastickers]',String(error?.message||error));
      }
      if(i===0||i===docs.length-1||(i+1)%3===0){
        await progress.update('⏳ WhatsApp stickers · '+(i+1)+'/'+docs.length+' traité(s)…');
      }
    }
    if(!stickers.length)throw new Error('Aucun sticker du pack n’a pu être converti pour WhatsApp.');
    while(stickers.length<3)stickers.push({buffer:Buffer.from(stickers[0].buffer),animated:stickers[0].animated===true});
    const tray=await whatsappTray(stickers[0].buffer);

    const title=clean(set?.set?.title)||automaticPackTitle(account,sessionSettings);
    const author=accountDisplayName(account);
    const pack=buildWastickersArchive({
      title,
      author,
      cover:tray,
      stickers:stickers.slice(0,30)
    });
    const safe=safeBase(title,48)||'nexai-pack';
    await progress.update('⬆️ WhatsApp stickers · envoi du fichier…');
    await sendTelegramMedia(client,peer,pack,{
      fileName:safe+'.wastickers',
      mimeType:'application/zip',
      kind:'document',
      caption:'NexAi · WhatsApp stickers · '+Math.min(stickers.length,30)+' sticker(s) · '+stickers.filter(x=>x.animated).length+' animé(s)'+(skipped?' · '+skipped+' ignoré(s)':''),
      afterSend:null
    });
    if(typeof progress.done==='function')await progress.done('WhatsApp stickers · pack prêt');
    else await progress.update('✅ WhatsApp stickers · pack prêt.');
    return true;
  }

  if(name==='ultratake'||name==='delfilig'||name==='filitake'||name==='noteclone'){
    const set=await sourceSet(client,source).catch(()=>null);
    const scope=transformScope(args,set);
    if(scope==='pack'&&!set?.documents?.length){
      throw new Error('Ce sticker n’appartient pas à un pack accessible. Utilise --one pour traiter seulement ce sticker.');
    }
    const docs=(scope==='pack'?set.documents:[documentOf(source)]).filter(Boolean).slice(0,MAX_CLONE);
    if(!docs.length)throw new Error('Aucun sticker à transformer.');

    const sourceTitle=clean(set?.set?.title)||automaticPackTitle(account,sessionSettings);
    const sourcePackName=clean(set?.set?.shortName||stickerAttr(documentOf(source))?.stickerset?.shortName);
    const requestedTitle=transformTitleArgs(args);
    let title='';
    let kind=name;
    let transform=null;

    if(name==='filitake'){
      if(!requestedTitle){
        throw new Error('Utilise /filitake NomDuFiligrane en répondant à un sticker. Options : --color=#FFFFFF --opacity=12 --position=bottom --size=28 --rotation=-20 --repeat.');
      }
      title=requestedTitle;
      const color=transformArg(args,'color','#FFFFFF');
      const opacity=transformOpacity(transformArg(args,'opacity','18'),0.18);
      const position=transformArg(args,'position','bottom')||'bottom';
      const size=transformNumber(transformArg(args,'size','0'),0,0,96);
      const rotationRaw=transformArg(args,'rotation','');
      const rotation=rotationRaw===''?null:transformNumber(rotationRaw,0,-180,180);
      const repeat=transformFlag(args,'repeat')||['repeat','tile','tiled'].includes(String(position).toLowerCase());
      const outline=!transformFlag(args,'no-outline');
      transform=raw=>addStickerWatermark(raw,{text:title,color,opacity,position,size,rotation,repeat,outline});
    }else if(name==='ultratake'||name==='delfilig'){
      title=requestedTitle||(sourceTitle+(name==='delfilig'?' Clean':' Ultra')).slice(0,64);
      const zone=transformArg(args,'zone','bottom')||'bottom';
      transform=raw=>removeStickerWatermark(raw,{zone});
    }else{
      title=requestedTitle||(sourceTitle+' Note').slice(0,64);
      transform=raw=>roundSticker(raw);
    }

    const newName=packName(account.telegramUserId,title);
    const label=name==='filitake'?'Filitake':name==='delfilig'?'Delfilig':name==='ultratake'?'Ultratake':'Noteclone';
    const progress=externalProgress||await startProgress(client,peer,'⏳ '+label+' · 0/'+docs.length+'…');
    launchTransformPackJob({
      runtime,docs,title,newName,progress,sourcePackName,kind,transform
    });
    return true;
  }

  if(name==='clonepack'){
    const set=await sourceSet(client,source);
    if(!set?.documents?.length)throw new Error('Réponds à un sticker appartenant à un pack.');
    if(account.nexaiPremium!==true){
      const quota=await consumeQuota(account.telegramUserId,'clonepack',{limit:2,windowMs:3*24*60*60*1000});
      if(!quota.allowed){
        const error=new Error('NEXAI_PREMIUM_REQUIRED: quota Free Clonepack atteint');
        error.code='NEXAI_PREMIUM_REQUIRED';
        error.quotaKey='clonepack';
        error.resetAt=quota.resetAt||null;
        throw error;
      }
    }
    const title=clean(args.join(' '))||automaticPackTitle(account,sessionSettings);
    const newName=packName(account.telegramUserId,title);
    const docs=[...set.documents];
    const sourcePackName=clean(set?.set?.shortName||stickerAttr(documentOf(source))?.stickerset?.shortName);
    const progress=externalProgress||await startProgress(client,peer,'⏳ Clone pack · 0/'+docs.length+'…');
    launchClonePackJob({runtime,docs,title,newName,progress,sourcePackName});
    return true;
  }

  const raw=await downloadSource(client,source);
  const prepared=await prepareSticker(raw);

  if(name==='createpack'){
    const title=clean(transformTitleArgs(args))||automaticPackTitle(account,sessionSettings);
    const newName=packName(account.telegramUserId,title);
    const watermarkValue=transformArg(args,'watermark',transformArg(args,'filigrane',''));
    const watermarkRequested=Boolean(watermarkValue)||transformFlag(args,'watermark')||transformFlag(args,'filigrane');
    const roundRequested=transformFlag(args,'round')||transformFlag(args,'rond');
    let finalSticker=prepared;

    if(roundRequested)finalSticker=await roundSticker(raw);

    if(watermarkRequested){
      const text=watermarkValue||title;
      const color=transformArg(args,'color','#FFFFFF');
      const opacity=transformOpacity(transformArg(args,'opacity','12'),0.12);
      const position=transformArg(args,'position','bottom')||'bottom';
      const size=transformNumber(transformArg(args,'size','0'),0,0,96);
      const rotationRaw=transformArg(args,'rotation','');
      const rotation=rotationRaw===''?null:transformNumber(rotationRaw,0,-180,180);
      const repeat=transformFlag(args,'repeat')||['repeat','tile','tiled'].includes(String(position).toLowerCase());
      const outline=!transformFlag(args,'no-outline');
      finalSticker=await addStickerWatermark(roundRequested?finalSticker:raw,{
        text,color,opacity,position,size,rotation,repeat,outline
      });
    }

    await createSet(account,title,newName,finalSticker,raw.sticker?.alt||'✨');
    await rememberPack(account.telegramUserId,{
      name:newName,title,link:packLink(newName),count:1,
      watermark:watermarkRequested?true:false,
      round:roundRequested?true:false,
      updatedAt:Date.now()
    });
    await say('Pack créé.'+(watermarkRequested?' · Filigrane actif':'')+(roundRequested?' · Forme ronde':'')+'\n'+packLink(newName));
    return true;
  }

  if(name==='sticker'){
    const pack=await ensureDefaultPack(runtime,prepared,sessionSettings);
    const set=await waitTelegramSet(client,pack);
    const doc=set.documents?.[set.documents.length-1];
    if(doc){
      await sendStickerDocument(client,peer,doc);
    }else await say('Sticker ajouté au pack : '+packLink(pack));
    return true;
  }

  return false;
}
