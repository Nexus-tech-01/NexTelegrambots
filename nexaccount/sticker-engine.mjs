import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Api } from 'teleproto';
import { cfg } from './config.mjs';
import { loadBotToken } from './secrets.mjs';
import { patchSettings, settingsFor } from './store.mjs';
import { sendTelegramMedia } from './media-send.mjs';

const FFMPEG=String(process.env.FFMPEG_PATH||'ffmpeg');
const MAX_SOURCE_BYTES=Math.max(1024*1024,Number(process.env.NEXAI_STICKER_MAX_SOURCE_BYTES||25*1024*1024));
const MAX_CLONE=Math.max(1,Math.min(120,Number(process.env.NEXAI_STICKER_CLONE_LIMIT||50)));
const MAX_EXPORT=Math.max(1,Math.min(120,Number(process.env.NEXAI_STICKER_EXPORT_LIMIT||50)));

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
  if(!r.ok||!d?.ok)throw new Error(clean(d?.description)||('Bot API '+method+' HTTP '+r.status));
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
  const stamp=Date.now().toString(36).slice(-6);
  const maxPrefix=Math.max(4,64-suffix.length);
  return (safeBase(label,Math.max(4,maxPrefix-20))+'_'+id+'_'+stamp).slice(0,maxPrefix)+suffix;
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
function automaticPackTitle(account){
  return ('NexAi · '+accountDisplayName(account)).slice(0,64);
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
async function whatsappStickerWebp(source){
  const mime=String(source?.mime||'').toLowerCase();
  if(mime.includes('tgsticker')||mime.includes('x-tgsticker')){
    throw new Error('sticker TGS ignoré : conversion Lottie indisponible');
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

async function ensureDefaultPack(runtime,prepared){
  const {account}=runtime;
  const name=defaultPackName(account.telegramUserId);
  const existing=await packExists(name);
  if(existing)await addToSet(account,name,prepared);
  else await createSet(account,automaticPackTitle(account),name,prepared);
  await rememberPack(account.telegramUserId,{name,title:'NexAi Stickers',link:packLink(name),updatedAt:Date.now()});
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

export const STICKER_ENGINE_COMMANDS=new Set(['sticker','stickerinfo','clonepack','createpack','mypacks','exportwhatsapp']);
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
  const say=t=>typeof reply==='function'?reply(String(t)):client.sendMessage(peer,{message:String(t)});

  if(name==='mypacks'){
    const s=await settingsFor(account.telegramUserId),packs=Array.isArray(s.stickerPacks)?s.stickerPacks:[];
    await say(packs.length?'Mes packs NexAi\n\n'+packs.map((p,i)=>(i+1)+'. '+(p.title||p.name)+'\n'+(p.link||packLink(p.name))).join('\n\n'):'Aucun pack NexAi enregistré pour ce compte.');
    return true;
  }

  const source=await sourceMessage(client,peer,event);
  if(!source)throw new Error('Réponds à une image, vidéo ou sticker avec .'+name+'.');

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

    const title=clean(set?.set?.title)||automaticPackTitle(account);
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
      caption:'NexAi · WhatsApp stickers · '+Math.min(stickers.length,30)+' sticker(s) · '+stickers.filter(x=>x.animated).length+' animé(s)'+(skipped?' · '+skipped+' ignoré(s)':'')
    });
    if(typeof progress.done==='function')await progress.done('WhatsApp stickers · pack prêt');
    else await progress.update('✅ WhatsApp stickers · pack prêt.');
    return true;
  }

  if(name==='clonepack'){
    const set=await sourceSet(client,source);
    if(!set?.documents?.length)throw new Error('Réponds à un sticker appartenant à un pack.');
    const title=clean(args.join(' '))||automaticPackTitle(account);
    const newName=packName(account.telegramUserId,title);
    const docs=set.documents.slice(0,MAX_CLONE);
    const progress=externalProgress||await startProgress(client,peer,'⏳ Clone pack · 0/'+docs.length+'…');
    let added=0;
    for(let i=0;i<docs.length;i++){
      try{
        const raw=await downloadDocument(client,docs[i]);
        const prepared=await prepareSticker(raw);
        if(i===0)await createSet(account,title,newName,prepared,stickerAttr(docs[i])?.alt||'✨');
        else await addToSet(account,newName,prepared,stickerAttr(docs[i])?.alt||'✨');
        added++;
        if(i===0||i===docs.length-1||(i+1)%3===0)await progress.update('⏳ Clone pack · '+(i+1)+'/'+docs.length+'…');
      }catch(e){
        console.warn('[NexAi sticker clone]',String(e?.message||e));
      }
    }
    if(!added)throw new Error('Aucun sticker du pack n’a pu être cloné.');
    await rememberPack(account.telegramUserId,{name:newName,title,link:packLink(newName),count:added,updatedAt:Date.now()});
    if(typeof progress.done==='function')await progress.done('Pack cloné · '+added+' sticker(s)\n'+packLink(newName));
    else await progress.update('✅ Pack cloné · '+added+' sticker(s)\n'+packLink(newName));
    return true;
  }

  const raw=await downloadSource(client,source);
  const prepared=await prepareSticker(raw);

  if(name==='createpack'){
    const title=clean(args.join(' '))||automaticPackTitle(account);
    const newName=packName(account.telegramUserId,title);
    await createSet(account,title,newName,prepared,raw.sticker?.alt||'✨');
    await rememberPack(account.telegramUserId,{name:newName,title,link:packLink(newName),count:1,updatedAt:Date.now()});
    await say('Pack créé.\n'+packLink(newName));
    return true;
  }

  if(name==='sticker'){
    const pack=await ensureDefaultPack(runtime,prepared);
    const set=await waitTelegramSet(client,pack);
    const doc=set.documents?.[set.documents.length-1];
    if(doc)await sendStickerDocument(client,peer,doc);
    else await say('Sticker ajouté au pack : '+packLink(pack));
    return true;
  }

  return false;
}
