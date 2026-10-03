import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { attachWhatsAppCommandEngine } from './command-engine.mjs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateWAMessageFromContent,
  generateMessageIDV2,
  encodeNewsletterMessage,
  encryptedStream,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';

const PUBLISHER_SELF=fileURLToPath(import.meta.url);
const PUBLISHER_SUPERVISOR_DIR=String(process.env.WA_PUBLISHER_SUPERVISOR_DIR||'/var/lib/nex/state/internal-automation/whatsapp-publisher-supervisor');
const PUBLISHER_SUPERVISOR_PID=path.join(PUBLISHER_SUPERVISOR_DIR,'supervisor.pid');
const PUBLISHER_SUPERVISOR_OUT=path.join(PUBLISHER_SUPERVISOR_DIR,'worker.log');
const PUBLISHER_SUPERVISOR_ERR=path.join(PUBLISHER_SUPERVISOR_DIR,'worker.err.log');
const PUBLISHER_MODE_SUPERVISE=process.argv.includes('--supervise');
const PUBLISHER_MODE_RESTART=process.argv.includes('--restart-supervisor');
const publisherSupervisorSleep=ms=>new Promise(r=>setTimeout(r,ms));

function ensureBaileysStickerPackMediaPatch(){
  const baileysEntry=fileURLToPath(import.meta.resolve('@whiskeysockets/baileys'));
  const target=path.join(path.dirname(baileysEntry),'Defaults','index.js');
  if(!fs.existsSync(target))return {ok:false,reason:'defaults_missing',target};
  let src=fs.readFileSync(target,'utf8');
  const before=src;
  if(!src.includes("'sticker-pack': '/mms/sticker-pack'")){
    src=src.replace(
      /sticker:\s*'\/mms\/image',/,
      "sticker: '/mms/image',\n    'sticker-pack': '/mms/sticker-pack',\n    'thumbnail-sticker-pack': '/mms/thumbnail-sticker-pack',"
    );
  }
  if(!src.includes("'sticker-pack': 'Sticker Pack'")){
    src=src.replace(
      /ptt:\s*'Audio',/,
      "ptt: 'Audio',\n    'sticker-pack': 'Sticker Pack',\n    'thumbnail-sticker-pack': 'Sticker Pack Thumbnail',"
    );
  }
  if(src===before)return {ok:true,changed:false,target};
  if(!src.includes("'sticker-pack': '/mms/sticker-pack'")||!src.includes("'thumbnail-sticker-pack': '/mms/thumbnail-sticker-pack'")||!src.includes("'sticker-pack': 'Sticker Pack'")){
    throw new Error('baileys_sticker_pack_patch_contract_failed');
  }
  const backup=target+'.bak-stick-good';
  if(!fs.existsSync(backup))fs.copyFileSync(target,backup);
  const tmp=target+'.tmp-'+process.pid;
  fs.writeFileSync(tmp,src);
  fs.renameSync(tmp,target);
  return {ok:true,changed:true,target};
}


async function publisherPidAlive(pid){
  try{if(!Number.isInteger(pid)||pid<=1)return false;process.kill(pid,0);return true}catch{return false}
}
async function stopPublisherPid(pid){
  if(!(await publisherPidAlive(pid)))return;
  try{process.kill(pid,'SIGTERM')}catch{}
  for(let i=0;i<30;i++){if(!(await publisherPidAlive(pid)))return;await publisherSupervisorSleep(200)}
  try{process.kill(pid,'SIGKILL')}catch{}
}
async function publisherSupervise(){
  fs.mkdirSync(PUBLISHER_SUPERVISOR_DIR,{recursive:true});
  const mediaPatch=ensureBaileysStickerPackMediaPatch();
  console.log('[StickGood] Baileys media map ready',JSON.stringify(mediaPatch));
  let child=null,closing=false,backoff=2000;
  const close=async()=>{
    if(closing)return;closing=true;
    if(child&&child.exitCode==null)try{child.kill('SIGTERM')}catch{}
    try{fs.rmSync(PUBLISHER_SUPERVISOR_PID,{force:true})}catch{}
    process.exit(0);
  };
  process.on('SIGTERM',()=>void close());
  process.on('SIGINT',()=>void close());
  while(!closing){
    const out=fs.openSync(PUBLISHER_SUPERVISOR_OUT,'a');
    const err=fs.openSync(PUBLISHER_SUPERVISOR_ERR,'a');
    child=spawn(process.execPath,[PUBLISHER_SELF,'--worker'],{
      cwd:path.dirname(PUBLISHER_SELF),env:process.env,stdio:['ignore',out,err]
    });
    await new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve)});
    try{fs.closeSync(out)}catch{}try{fs.closeSync(err)}catch{}
    child=null;
    if(!closing){await publisherSupervisorSleep(backoff);backoff=Math.min(60000,backoff*2)}
  }
}
async function ensurePublisherSupervisor(restart=false){
  fs.mkdirSync(PUBLISHER_SUPERVISOR_DIR,{recursive:true});
  let old=null;
  try{old=Number(String(fs.readFileSync(PUBLISHER_SUPERVISOR_PID,'utf8')).trim())||null}catch{}
  if(old&&await publisherPidAlive(old)){
    if(!restart)return {ok:true,pid:old,alreadyRunning:true};
    await stopPublisherPid(old);
  }
  const out=fs.openSync(PUBLISHER_SUPERVISOR_OUT,'a');
  const err=fs.openSync(PUBLISHER_SUPERVISOR_ERR,'a');
  const child=spawn(process.execPath,[PUBLISHER_SELF,'--supervise'],{
    cwd:path.dirname(PUBLISHER_SELF),env:process.env,detached:true,stdio:['ignore',out,err]
  });
  child.unref();
  try{fs.closeSync(out)}catch{}try{fs.closeSync(err)}catch{}
  fs.writeFileSync(PUBLISHER_SUPERVISOR_PID,String(child.pid),{mode:0o600});
  await publisherSupervisorSleep(700);
  if(!(await publisherPidAlive(child.pid)))throw new Error('whatsapp_publisher_supervisor_failed');
  return {ok:true,pid:child.pid,restarted:restart};
}
if(PUBLISHER_MODE_SUPERVISE){
  await publisherSupervise();
  process.exit(0);
}
if(PUBLISHER_MODE_RESTART){
  console.log(JSON.stringify(await ensurePublisherSupervisor(true)));
  process.exit(0);
}

const PORT = Number(process.env.WA_PUBLISHER_PORT || 8787);
const BRIDGE_PORT = Number(process.env.WA_PUBLISHER_BRIDGE_PORT || 18787);
const HOST = process.env.WA_PUBLISHER_HOST || '127.0.0.1';
const DATA_DIR = process.env.WA_PUBLISHER_DATA_DIR || '/var/lib/nex/data/internal/whatsapp-publisher';
const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const GROUP_JID = process.env.WHATSAPP_GROUP_JID || '120363426961054070@g.us';
const SECONDARY_APK_GROUP_INVITE_URL = process.env.WHATSAPP_SECONDARY_APK_GROUP_INVITE_URL || 'https://chat.whatsapp.com/GsxCPLB9XyI9zT39c4T9K1';
const CHANNEL_INVITE_URL = process.env.WHATSAPP_CHANNEL_INVITE_URL || 'https://whatsapp.com/channel/0029VbDkWGYHltYHGr1HHQ07';
const OTAKU_CHANNEL_INVITE_URL = process.env.OTAKU_WHATSAPP_CHANNEL_INVITE_URL || 'https://whatsapp.com/channel/0029VbCKhnq7j6gEhuUKMP1V';
const STICK_GOOD_CHANNEL_INVITE_URL = process.env.STICK_GOOD_WHATSAPP_CHANNEL_INVITE_URL || 'https://whatsapp.com/channel/0029VbC3Uo00LKZNYkEQ9m03';
const PRESENTATION_NEWSLETTER_JID = process.env.PRESENTATION_NEWSLETTER_JID || '120363411005383995@newsletter';
const WEBHOOK_TOKEN = process.env.NEX_WHATSAPP_PUBLISHER_TOKEN || process.env.NEXCANAL__WEBHOOK_SECRET || '';
const DASHBOARD_PASSWORD = process.env.NEX_WHATSAPP_DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.NEX_WHATSAPP_SESSION_SECRET || '';
const TELEGRAM_BOT_TOKEN = process.env.NEXCANAL__BOT_TOKEN || '';
const SOURCES = new Set(['thenexusorigin', 'thenexnews', 'tresor_universe']);
const BLOCKED_DOC_EXT = new Set(['apk','xapk','apks','apkm']);
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

fs.mkdirSync(AUTH_DIR, { recursive: true });

const state = {
  status: 'disconnected',
  connectedAt: null,
  me: null,
  lastError: null,
  qr: null,
  channelJid: null,
  channelTitle: null,
  otakuChannelJid: null,
  otakuChannelTitle: null,
  stickGoodChannelJid: null,
  stickGoodChannelTitle: null,
  secondaryApkGroupJid: null,
  secondaryApkGroupTitle: null,
  lastPublishAt: null,
};
let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let processing = false;
let lastPairRequestAt = 0;
let pairingResetInProgress = false;
let commandEngine = null;

// Otaku Nexus pro manager: one shared serialization lane for every Otaku
// newsletter update. Dark Universe relay and the autonomous manager remain
// separate workers, but they cannot publish at the exact same time.
const OTAKU_MANAGER_URL=String(process.env.OTAKU_MANAGER_URL||'http://127.0.0.1:18812').replace(/\/$/,'');
const STICK_GOOD_MANAGER_URL=String(process.env.STICK_GOOD_MANAGER_URL||'http://127.0.0.1:18815').replace(/\/$/,'');
const STICK_GOOD_MIN_GAP_MS=Math.max(1200,Number(process.env.STICK_GOOD_MIN_GAP_MS||3500));
const OTAKU_MIN_GAP_MS=Math.max(15000,Number(process.env.OTAKU_MIN_GAP_MS||120000));
const OTAKU_RELAY_GAP_MS=Math.max(120000,Number(process.env.OTAKU_RELAY_GAP_MS||180000));
const OTAKU_RELAY_DENY_KEYS=new Set(['lustdev','toolsbnn4d','devs101','nextech']);
const OTAKU_RELAY_DENY_INVITE=String(process.env.OTAKU_RELAY_DENY_INVITE||'GsxCPLB9XyI9zT39c4T9K1');
let otakuRelayBusy=false;
let otakuSendChain=Promise.resolve();
let otakuLastSendAt=0;
const otakuPollMessages=new Map();
const otakuPollRecords=new Map();
const OTAKU_ACTION_LEDGER_FILE='otaku-action-ledger.json';
const OTAKU_ACTION_ID_TTL_MS=Math.max(24*60*60_000,Number(process.env.OTAKU_ACTION_ID_TTL_MS||14*24*60*60_000));
const OTAKU_CONTENT_DEDUP_TTL_MS=Math.max(10*60_000,Number(process.env.OTAKU_CONTENT_DEDUP_TTL_MS||12*60*60_000));
const OTAKU_MEDIA_DEDUP_TTL_MS=Math.max(60*60_000,Number(process.env.OTAKU_MEDIA_DEDUP_TTL_MS||7*24*60*60_000));
const OTAKU_ACTION_LEDGER_MAX=Math.max(100,Math.min(5000,Number(process.env.OTAKU_ACTION_LEDGER_MAX||1200)));
let otakuActionLedger=[];
let stickGoodSendChain=Promise.resolve();
let stickGoodLastSendAt=0;

function stickGoodSleep(ms){return new Promise(r=>setTimeout(r,ms));}
function withStickGoodSendLock(fn){
  const lane=async()=>{
    const wait=Math.max(0,STICK_GOOD_MIN_GAP_MS-(Date.now()-stickGoodLastSendAt));
    if(wait)await stickGoodSleep(wait);
    const out=await fn();
    stickGoodLastSendAt=Date.now();
    return out;
  };
  const task=stickGoodSendChain.then(lane,lane);
  stickGoodSendChain=task.then(()=>undefined,()=>undefined);
  return task;
}

function otakuSleep(ms){return new Promise(r=>setTimeout(r,ms));}
function withOtakuSendLock(fn){
  const task=otakuSendChain.then(async()=>{
    const wait=Math.max(0,OTAKU_MIN_GAP_MS-(Date.now()-otakuLastSendAt));
    if(wait)await otakuSleep(wait);
    const out=await fn();
    otakuLastSendAt=Date.now();
    return out;
  },async()=>{
    const wait=Math.max(0,OTAKU_MIN_GAP_MS-(Date.now()-otakuLastSendAt));
    if(wait)await otakuSleep(wait);
    const out=await fn();
    otakuLastSendAt=Date.now();
    return out;
  });
  otakuSendChain=task.then(()=>undefined,()=>undefined);
  return task;
}

function otakuRelayKey(v=''){return String(v||'').normalize('NFKC').replace(/[Øø]/g,'o').toLowerCase().replace(/[^a-z0-9]+/g,'')}
function otakuRelayBare(v=''){return String(v||'').replace(/:\\d+@/,'@')}
async function otakuRelayTargets(){
  if(!socket||state.status!=='connected'||typeof socket.groupFetchAllParticipating!=='function')return [];
  const all=await socket.groupFetchAllParticipating();
  const deny=new Set((readJson('otaku-relay-deny.json',{})?.jids||[]).map(String));
  for(const m of Object.values(all||{})){
    const jid=String(m?.id||'');
    if(jid.endsWith('@g.us')&&OTAKU_RELAY_DENY_KEYS.has(otakuRelayKey(m?.subject||'')))deny.add(jid);
  }
  if(typeof socket.groupGetInviteInfo==='function'){
    try{const m=await socket.groupGetInviteInfo(OTAKU_RELAY_DENY_INVITE);const jid=String(m?.id||'');if(jid.endsWith('@g.us'))deny.add(jid)}catch{}
  }
  writeJson('otaku-relay-deny.json',{jids:[...deny],updatedAt:new Date().toISOString()});
  const me=otakuRelayBare(socket.user?.id||'');
  return Object.values(all||{}).filter(m=>{
    const jid=String(m?.id||'');
    if(!jid.endsWith('@g.us')||deny.has(jid)||OTAKU_RELAY_DENY_KEYS.has(otakuRelayKey(m?.subject||'')))return false;
    if(!m?.announce)return true;
    const p=(m?.participants||[]).find(x=>otakuRelayBare(x?.id||'')===me);
    return p?.admin==='admin'||p?.admin==='superadmin';
  }).map(m=>({jid:String(m.id),subject:String(m.subject||'Groupe WhatsApp')}));
}
async function queueOtakuRelay(raw={}){
  const kind=String(raw.kind||'').toLowerCase();
  if(!['text','image','pack'].includes(kind))return;
  const id=String(raw.id||''); if(!id)return;
  const q=readJson('otaku-relay-queue.json',[]);
  if(q.some(x=>x.id===id&&['pending','done'].includes(x.status)))return;
  const groups=await otakuRelayTargets(); if(!groups.length)return;
  let media=null;
  const src=kind==='pack'?raw.cover:(raw.image||{url:raw.imageUrl,localPath:raw.localPath});
  if(src?.url)media={url:String(src.url)};
  else if(src?.localPath&&fs.existsSync(src.localPath)){
    const d='/var/lib/nex/tmp/shared-whatsapp/otaku-relay';fs.mkdirSync(d,{recursive:true});
    const p=path.join(d,Date.now()+'-'+path.basename(src.localPath));fs.copyFileSync(src.localPath,p);media={localPath:p};
  }
  q.push({id,status:'pending',index:0,groups,text:String(raw.text||raw.caption||''),media,createdAt:Date.now(),nextAt:Date.now()+30000});
  writeJson('otaku-relay-queue.json',q);
}
async function processOtakuRelay(){
  if(otakuRelayBusy||!socket||state.status!=='connected')return;
  otakuRelayBusy=true;
  try{
    const q=readJson('otaku-relay-queue.json',[]),job=q.find(x=>x.status==='pending'&&Number(x.nextAt||0)<=Date.now());
    if(!job)return;
    if(job.index>=job.groups.length){job.status='done';job.completedAt=Date.now();writeJson('otaku-relay-queue.json',q);return}
    const g=job.groups[job.index],ctx=state.otakuChannelJid?{forwardingScore:1,isForwarded:true,forwardedNewsletterMessageInfo:{newsletterJid:state.otakuChannelJid,newsletterName:state.otakuChannelTitle||'Otaku Nexus'}}:{};
    try{
      if(job.media){const src=await otakuMediaSource(job.media);await socket.sendMessage(g.jid,{image:src,caption:(job.text+'\n\n'+OTAKU_CHANNEL_INVITE_URL).slice(0,1024),contextInfo:ctx})}
      else await socket.sendMessage(g.jid,{text:(job.text||'Nouvelle publication Otaku Nexus')+'\n\n'+OTAKU_CHANNEL_INVITE_URL,contextInfo:ctx});
      job.index++;job.nextAt=Date.now()+OTAKU_RELAY_GAP_MS;job.attempts=0;
    }catch(e){
      job.attempts=Number(job.attempts||0)+1;
      if(job.attempts>=2){job.index++;job.attempts=0}
      job.nextAt=Date.now()+Math.max(OTAKU_RELAY_GAP_MS,300000);
      job.lastError=String(e?.message||e).slice(0,300);
    }
    writeJson('otaku-relay-queue.json',q);
  }finally{otakuRelayBusy=false}
}
function extractIncomingText(msg){
  const m=msg?.message||{};
  return String(
    m.conversation||
    m.extendedTextMessage?.text||
    m.imageMessage?.caption||
    m.videoMessage?.caption||
    ''
  ).trim();
}
async function forwardStickGoodQuestionResponse(msg){
  if(msg?.key?.fromMe)return;
  const qr=msg?.message?.questionResponseMessage;
  const text=String(qr?.text||'').trim();
  const questionId=String(qr?.key?.id||'').trim();
  if(!text||!questionId)return;
  const payload={
    text,questionId,
    chatId:String(msg?.key?.remoteJid||''),
    senderId:String(msg?.key?.participant||msg?.participant||msg?.key?.remoteJid||''),
    at:new Date().toISOString()
  };
  fetch(STICK_GOOD_MANAGER_URL+'/question-response',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
    signal:AbortSignal.timeout(5000)
  }).catch(()=>{});
}
async function forwardOtakuOrderCandidate(msg){
  if(msg?.key?.fromMe)return;
  const jid=String(msg?.key?.remoteJid||'');
  if(!jid||jid.endsWith('@newsletter')||jid==='status@broadcast')return;
  const text=extractIncomingText(msg);
  if(!text)return;
  const payload={
    text,
    chatId:jid,
    senderId:String(msg?.key?.participant||jid),
    fromGroup:jid.endsWith('@g.us'),
    at:new Date().toISOString()
  };
  fetch(OTAKU_MANAGER_URL+'/incoming',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
    signal:AbortSignal.timeout(5000)
  }).catch(()=>{});
}
function persistOtakuPollSummary(){
  const rows=[];
  for(const [id,r] of otakuPollRecords){
    let messageB64=null;
    try{if(r.message)messageB64=Buffer.from(proto.Message.encode(r.message).finish()).toString('base64')}catch{}
    rows.push({
      id,logicalId:r.logicalId||null,sessionId:r.sessionId||null,question:r.question||'',
      options:Array.isArray(r.options)?r.options:[],
      messageB64,
      correctAnswer:r.correctAnswer||null,quiz:Boolean(r.quiz),
      votes:r.votes||{},createdAt:r.createdAt||null
    });
  }
  writeJson('otaku-polls.json',rows.slice(-250));
}
function aggregateOtakuVotes(record){
  const options=Array.isArray(record?.options)?record.options:[];
  const byHash=new Map(options.map(name=>[
    crypto.createHash('sha256').update(Buffer.from(String(name))).digest('hex'),
    String(name)
  ]));
  const votes={...(record?.votes||{})};
  for(const update of record?.updates||[]){
    const vote=update?.vote;
    const voter=String(
      update?.pollUpdateMessageKey?.participant||
      update?.pollUpdateMessageKey?.remoteJid||
      update?.pollUpdateMessageKey?.id||
      ''
    );
    if(!voter||!Array.isArray(vote?.selectedOptions)||!vote.selectedOptions.length)continue;
    const first=vote.selectedOptions[0];
    const hex=Buffer.isBuffer(first)||first instanceof Uint8Array
      ?Buffer.from(first).toString('hex')
      :String(first);
    const option=byHash.get(hex);
    if(option)votes[voter]=option;
  }
  return votes;
}

const MENU_IMAGE_B64_PATH = path.join(DATA_DIR,'assets','nexai-menu.b64');

async function resetAuthForPairing(){
  if(pairingResetInProgress) throw new Error('Une préparation de connexion WhatsApp est déjà en cours.');
  pairingResetInProgress=true;
  try{
    clearTimeout(reconnectTimer);
    reconnectTimer=null;
    socketGeneration++;
    const old=socket;
    socket=null;
    try{old?.end?.(new Error('fresh pairing requested'));}catch{}
    try{old?.ws?.close?.();}catch{}
    await new Promise(r=>setTimeout(r,400));
    fs.rmSync(AUTH_DIR,{recursive:true,force:true});
    fs.mkdirSync(AUTH_DIR,{recursive:true});
    state.status='preparing_pairing';
    state.connectedAt=null;
    state.me=null;
    state.lastError=null;
    state.qr=null;
  }finally{
    pairingResetInProgress=false;
  }
}

async function waitForQr(timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(state.qr) return state.qr;
    if(state.status==='connected') throw new Error('Le compte est déjà connecté.');
    if(state.status==='needs_pairing'&&state.lastError) throw new Error(state.lastError);
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('WhatsApp n’a pas ouvert la fenêtre de connexion à temps. Réessaie.');
}

const f = name => path.join(DATA_DIR, name);
function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(f(name), 'utf8')); } catch { return fallback; } }
function writeJson(name, value) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f(name), JSON.stringify(value, null, 2)); }

function otakuStable(value){
  if(value==null)return null;
  if(Array.isArray(value))return value.map(otakuStable);
  if(Buffer.isBuffer(value)||value instanceof Uint8Array)return Buffer.from(value).toString('hex');
  if(typeof value==='object'){
    const out={};
    for(const key of Object.keys(value).sort()){
      if(['localPath','createdAt','at','timestamp'].includes(key))continue;
      out[key]=otakuStable(value[key]);
    }
    return out;
  }
  if(typeof value==='string')return value.trim().replace(/\s+/g,' ');
  return value;
}
function otakuActionMediaFingerprint(raw={}){
  const kind=String(raw.kind||'').toLowerCase();
  const src=kind==='pack'?raw.cover:(raw.image||{url:raw.imageUrl,localPath:raw.localPath,fileName:raw.fileName});
  if(!src)return '';
  const url=String(src.url||'').trim();
  if(url){
    const normalized=url.replace(/[?#].*$/,'').trim().toLowerCase();
    return normalized?crypto.createHash('sha256').update('url:'+normalized).digest('hex'):'';
  }
  const localPath=String(src.localPath||'').trim();
  if(localPath&&fs.existsSync(localPath)){
    try{return crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex')}catch{}
  }
  const fileName=String(src.fileName||'').trim().toLowerCase();
  return fileName?crypto.createHash('sha256').update('file:'+fileName).digest('hex'):'';
}
function otakuActionFingerprint(raw={}){
  const kind=String(raw.kind||'').toLowerCase();
  const src=kind==='pack'?raw.cover:(raw.image||{url:raw.imageUrl,fileName:raw.fileName});
  const material={
    kind,
    text:String(raw.text||raw.caption||''),
    question:String(raw.question||''),
    options:Array.isArray(raw.options)?raw.options:[],
    quiz:Boolean(raw.quiz),
    correctAnswer:raw.correctAnswer||'',
    character:raw.character||'',
    count:Number(raw.count||0),
    source:src?{url:src.url||'',fileName:src.fileName||path.basename(String(src.localPath||''))}:null
  };
  return crypto.createHash('sha256').update(JSON.stringify(otakuStable(material))).digest('hex');
}
function pruneOtakuActionLedger(now=Date.now()){
  otakuActionLedger=otakuActionLedger
    .filter(row=>row&&Number(row.at||0)>0&&now-Number(row.at||0)<=OTAKU_ACTION_ID_TTL_MS)
    .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
    .slice(-OTAKU_ACTION_LEDGER_MAX);
}
function persistOtakuActionLedger(){
  pruneOtakuActionLedger();
  writeJson(OTAKU_ACTION_LEDGER_FILE,otakuActionLedger);
}
function reserveOtakuAction(raw={}){
  const now=Date.now();
  pruneOtakuActionLedger(now);
  const id=String(raw.id||'').trim();
  const fingerprint=otakuActionFingerprint(raw);
  const mediaFingerprint=otakuActionMediaFingerprint(raw);
  const sameId=id?otakuActionLedger.find(row=>row.id===id&&now-Number(row.at||0)<=OTAKU_ACTION_ID_TTL_MS):null;
  if(sameId)return {duplicate:true,id,fingerprint,mediaFingerprint,actionId:sameId.actionId||null,reason:'id'};
  const sameContent=otakuActionLedger.find(row=>row.fingerprint===fingerprint&&now-Number(row.at||0)<=OTAKU_CONTENT_DEDUP_TTL_MS);
  if(sameContent)return {duplicate:true,id,fingerprint,mediaFingerprint,actionId:sameContent.actionId||null,reason:'content'};
  const sameMedia=mediaFingerprint?otakuActionLedger.find(row=>row.mediaFingerprint===mediaFingerprint&&now-Number(row.at||0)<=OTAKU_MEDIA_DEDUP_TTL_MS):null;
  if(sameMedia)return {duplicate:true,id,fingerprint,mediaFingerprint,actionId:sameMedia.actionId||null,reason:'media'};
  const token=crypto.randomUUID();
  otakuActionLedger.push({token,id,fingerprint,mediaFingerprint,status:'pending',at:now,actionId:null});
  persistOtakuActionLedger();
  return {duplicate:false,token,id,fingerprint,mediaFingerprint};
}
function completeOtakuAction(claim,actionId=null){
  if(!claim?.token)return;
  const row=otakuActionLedger.find(x=>x.token===claim.token);
  if(!row)return;
  row.status='sent';row.actionId=actionId||row.actionId||null;row.sentAt=Date.now();
  persistOtakuActionLedger();
}
function releaseOtakuAction(claim){
  if(!claim?.token)return;
  otakuActionLedger=otakuActionLedger.filter(x=>x.token!==claim.token);
  persistOtakuActionLedger();
}
function loadOtakuDurableState(){
  const ledger=readJson(OTAKU_ACTION_LEDGER_FILE,[]);
  otakuActionLedger=Array.isArray(ledger)?ledger:[];
  pruneOtakuActionLedger();
  const rows=readJson('otaku-polls.json',[]);
  for(const row of Array.isArray(rows)?rows:[]){
    const id=String(row?.id||'').trim();
    if(!id)continue;
    let message=null;
    if(row?.messageB64){
      try{message=proto.Message.decode(Buffer.from(String(row.messageB64),'base64'))}catch{}
    }else if(row?.message){
      try{message=proto.Message.fromObject(row.message)}catch{message=row.message}
    }
    if(message)otakuPollMessages.set(id,{message});
    otakuPollRecords.set(id,{
      message,
      logicalId:String(row?.logicalId||''),
      sessionId:String(row?.sessionId||''),
      question:String(row?.question||''),
      options:Array.isArray(row?.options)?row.options.map(String):[],
      correctAnswer:row?.correctAnswer==null?null:String(row.correctAnswer),
      quiz:Boolean(row?.quiz),
      updates:[],
      votes:row?.votes&&typeof row.votes==='object'?row.votes:{},
      createdAt:row?.createdAt||null
    });
  }
}
loadOtakuDurableState();

function collectNewsletterMessageNodes(value,out=[],depth=0){
  if(depth>10||value==null) return out;
  if(Array.isArray(value)){ for(const item of value) collectNewsletterMessageNodes(item,out,depth+1); return out; }
  if(Buffer.isBuffer(value)||value instanceof Uint8Array) return out;
  if(typeof value==='object'){
    if(value.tag==='message'){
      out.push({attrs:{...(value.attrs||{})},children:Array.isArray(value.content)?value.content.map(x=>x?.tag).filter(Boolean):[]});
    }
    for(const item of Object.values(value)) collectNewsletterMessageNodes(item,out,depth+1);
  }
  return out;
}
async function newsletterSnapshot(jid){
  if(!socket||state.status!=='connected') throw new Error('WhatsApp non connecté');
  let metadata=null;
  try{ metadata=await socket.newsletterMetadata('jid',jid); }catch(error){ metadata={error:String(error?.message||error)}; }
  let messages=[];
  try{
    const raw=await socket.newsletterFetchMessages(jid,25,0,0);
    messages=collectNewsletterMessageNodes(raw).slice(-50);
  }catch(error){
    messages=[{error:String(error?.message||error)}];
  }
  const viewer=metadata?.viewer_metadata||metadata?.viewer||null;
  return {
    jid,
    metadata: metadata&&typeof metadata==='object'?{
      id:metadata.id||null,
      name:metadata.name||null,
      invite:metadata.invite||null,
      viewer_metadata:viewer,
      keys:Object.keys(metadata).slice(0,40)
    }:metadata,
    messages
  };
}
function safeEq(a,b){ const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||'')); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function sessionToken(){ return crypto.createHmac('sha256', SESSION_SECRET || 'unsafe').update('nex-whatsapp-owner').digest('hex'); }
function cookies(req){ return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2)); }
function authed(req){ return Boolean(SESSION_SECRET && safeEq(cookies(req).nwp_owner, sessionToken())); }
function json(res, status, obj, headers={}) { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(JSON.stringify(obj)); }
async function body(req){ const chunks=[]; for await(const c of req) chunks.push(c); if(!chunks.length)return{}; try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return{};} }
function sourceName(v=''){ return String(v).replace(/^@/,'').toLowerCase().trim(); }
function flatButtons(v){ const src=Array.isArray(v)?v:[]; const flat=src.flatMap(x=>Array.isArray(x)?x:[x]); return flat.map(x=>({text:String(x?.text||x?.label||'Ouvrir').trim(),url:String(x?.url||'').trim()})).filter(x=>/^https?:\/\//i.test(x.url)).slice(0,12); }
function linksText(buttons){ return buttons.map(b=>`• ${b.text}: ${b.url}`).join('\n'); }
function isDownloadButton(button={}){
  return /(?:download|t[eé]l[eé]charg|installer|install|\bapk\b|get\s+(?:apk|app))/i.test(String(button?.text||''));
}
function orderedChannelButtons(buttons=[]){
  return [...(Array.isArray(buttons)?buttons:[])]
    .map((button,index)=>({button,index,priority:isDownloadButton(button)?1:0}))
    .sort((a,b)=>b.priority-a.priority||a.index-b.index)
    .map(x=>x.button);
}
function channelMediaCaption(text='',buttons=[],limit=1024){
  const cleanText=String(text||'').trim();
  const ordered=orderedChannelButtons(buttons);
  let linkBlock='';
  for(const button of ordered){
    let line=`• ${button.text}: ${button.url}`;
    if(line.length>limit&&String(button.url||'').length<=limit)line=String(button.url);
    const candidate=linkBlock?linkBlock+'\n'+line:line;
    if(candidate.length<=limit)linkBlock=candidate;
  }
  if(!linkBlock)return cleanText.slice(0,limit);
  const budget=Math.max(0,limit-linkBlock.length-(cleanText?2:0));
  const body=cleanText.slice(0,budget).trimEnd();
  return [body,linkBlock].filter(Boolean).join('\n\n');
}

function groupForwardContext(){
  const newsletterJid=state.channelJid||PRESENTATION_NEWSLETTER_JID;
  return {
    forwardingScore:1,
    isForwarded:true,
    forwardedNewsletterMessageInfo:{
      newsletterJid,
      newsletterName:state.channelTitle||'Nextech',
    },
  };
}

function groupActionButtons(pub){
  const out=[...(pub?.buttons||[])];
  if(CHANNEL_INVITE_URL && !out.some(b=>String(b?.url||'')===CHANNEL_INVITE_URL)){
    out.push({text:'Voir la chaîne Nextech',url:CHANNEL_INVITE_URL});
  }
  return out.filter(b=>b?.text&&/^https?:\/\//i.test(String(b?.url||''))).slice(0,10);
}
function inviteCode(url=''){ const m=String(url).match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i); return m?.[1] || String(url).trim(); }
function groupInviteCode(url=''){ const m=String(url).match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i); return m?.[1] || String(url).trim(); }
function ext(name=''){ return path.extname(String(name).split('?')[0].toLowerCase()).replace('.',''); }
function documentBlocked(item){ const e=ext(item?.fileName||''); const mime=String(item?.mimetype||'').toLowerCase(); return BLOCKED_DOC_EXT.has(e)||mime==='application/vnd.android.package-archive'; }
function isOtakuSource(source=''){ const s=sourceName(source); return s==='tresor_universe'; }

async function telegramFileUrl(fileId){
  if(!fileId) return null;
  if(!TELEGRAM_BOT_TOKEN) throw new Error('NEXCANAL__BOT_TOKEN absent');
  const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,{signal:AbortSignal.timeout(20000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j?.ok||!j?.result?.file_path) throw new Error(`Telegram getFile failed: ${j?.description||r.status}`);
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${j.result.file_path}`;
}

function mediaMeta(name='',reportedType='',reportedMime=''){
  const fileName=String(name||'').trim();
  const lower=fileName.toLowerCase();
  let type=String(reportedType||'document').toLowerCase();
  let mimetype=String(reportedMime||'').toLowerCase();

  // File extension is authoritative for files whose identity depends on it.
  // Telegram often labels APKs as application/octet-stream; passing that to
  // WhatsApp makes the client present the package as a generic BIN file.
  if(lower.endsWith('.apk')){
    type='document';
    mimetype='application/vnd.android.package-archive';
  }else if(lower.endsWith('.xapk')||lower.endsWith('.apks')||lower.endsWith('.apkm')){
    type='document';
    mimetype='application/zip';
  }else if(/\.(?:jpe?g)$/i.test(lower)){
    type='photo';
    mimetype='image/jpeg';
  }else if(lower.endsWith('.png')){
    type='photo';
    mimetype='image/png';
  }else if(lower.endsWith('.webp')){
    type='photo';
    mimetype='image/webp';
  }else if(lower.endsWith('.gif')){
    type='animation';
    mimetype='image/gif';
  }else if(lower.endsWith('.mp4')){
    if(type!=='document') type='video';
    mimetype='video/mp4';
  }else if(!mimetype){
    mimetype=type==='photo'||type==='image'?'image/jpeg':
      type==='video'||type==='animation'?'video/mp4':
      type==='audio'||type==='voice'?'audio/mpeg':
      'application/octet-stream';
  }
  return {fileName,type,mimetype};
}

function normalizeMedia(input){
  const arr = Array.isArray(input) ? input : (input ? [input] : []);
  return arr.map((m,i)=>{
    const rawLocal=String(m?.localPath||m?.local_path||'');
    const resolvedLocal=rawLocal?path.resolve(rawLocal):'';
    const localPath=resolvedLocal&&(
      resolvedLocal.startsWith('/var/lib/nex/tmp/internal-automation/')||
      resolvedLocal.startsWith('/var/lib/nex/tmp/shared-whatsapp/')
    )?resolvedLocal:'';
    const meta=mediaMeta(
      String(m?.fileName||m?.original_name||m?.filename||`media-${i+1}`),
      String(m?.type||m?.media_type||'document'),
      String(m?.mimetype||m?.mime_type||'')
    );
    return {
      type:meta.type,
      fileId:String(m?.fileId||m?.telegram_file_id||m?.telegramFileId||''),
      url:String(m?.url||''),
      localPath,
      fileName:meta.fileName,
      mimetype:meta.mimetype,
      position:Number(m?.position??i),
    };
  }).filter(m=>m.fileId||m.url||m.localPath).sort((a,b)=>a.position-b.position);
}

function normalizePublication(raw={}){
  const source=sourceName(raw.source||raw.channelUsername||raw.telegram_username);
  const id=String(raw.id||`${source}:${raw.sourceMessageId||raw.telegramMessageId||crypto.randomUUID()}`);
  const buttons=flatButtons(raw.buttons||raw.inlineButtons||raw.inline_buttons||[]);
  const media=normalizeMedia(raw.mediaItems||raw.media||[]);
  return {
    id, source,
    sourceMessageId: raw.sourceMessageId ?? raw.telegramMessageId ?? null,
    text:String(raw.text||raw.caption||'').trim(),
    buttons, media,
    createdAt:raw.createdAt||new Date().toISOString(),
  };
}

function routePublication(pub){
  const lifestyle=isOtakuSource(pub.source);
  const channelBlocked=!lifestyle&&pub.media.some(documentBlocked);
  return {
    // NexTech/NexNews => groupe + chaîne NexTech, sauf APK packages => groupe.
    // Otaku Nexus/Dark Universe => chaîne Otaku Nexus uniquement.
    group:lifestyle?false:Boolean(GROUP_JID),
    channel:lifestyle||!channelBlocked,
    channelBlocked,
    reason:channelBlocked
      ?'APK réservé au groupe NexTech'
      :lifestyle
        ?'publication Otaku/Dark Universe -> chaîne Otaku Nexus'
        :'compatible chaîne + groupe NexTech',
  };
}

function addHistory(entry){ const h=readJson('history.json',[]); h.unshift({at:new Date().toISOString(),...entry}); if(h.length>500)h.length=500; writeJson('history.json',h); }
function sameSourceMessage(a,b){
  const as=sourceName(a?.source||''),bs=sourceName(b?.source||'');
  const ai=a?.sourceMessageId,bi=b?.sourceMessageId;
  return Boolean(as&&bs&&as===bs&&ai!=null&&bi!=null&&String(ai)===String(bi));
}
function samePublication(a,b){
  return Boolean(
    String(a?.id||'')===String(b?.id||'')||
    sameSourceMessage(a,b)
  );
}
function mediaUpgrade(existing,pub){
  return Boolean(pub?.media?.length)&&!Boolean(existing?.pub?.media?.length);
}
function mergeQueueWithLatest(snapshot){
  const latest=readJson('queue.json',[]);
  const ids=new Set(snapshot.map(x=>String(x?.id||'')));
  for(const item of latest){
    const id=String(item?.id||'');
    if(id&&!ids.has(id)){snapshot.push(item);ids.add(id);}
  }
  return snapshot;
}

function enqueue(destination,jid,pub){
  const q=readJson('queue.json',[]);
  const matches=q.filter(x=>
    String(x?.destination||'')===String(destination) &&
    String(x?.jid||'')===String(jid) &&
    ['pending','done'].includes(String(x?.status||'')) &&
    samePublication(x?.pub,pub)
  );
  const rich=matches.find(x=>Boolean(x?.pub?.media?.length));
  if(rich)return {...rich,deduplicated:true};
  const pendingBare=matches.find(x=>x.status==='pending'&&!x?.pub?.media?.length);
  if(pendingBare&&pub?.media?.length){
    pendingBare.pub=pub;
    pendingBare.jid=jid;
    pendingBare.nextAttemptAt=Date.now();
    pendingBare.lastError=null;
    pendingBare.upgradedAt=new Date().toISOString();
    writeJson('queue.json',q);
    return {...pendingBare,upgraded:true};
  }
  const existing=matches[0];
  if(existing&&!mediaUpgrade(existing,pub))return {...existing,deduplicated:true};
  const item={id:crypto.randomUUID(),destination,jid,pub,status:'pending',attempts:0,nextAttemptAt:Date.now(),createdAt:new Date().toISOString(),upgradeOf:existing?.id||null};
  q.push(item);
  writeJson('queue.json',q);
  return item;
}
function dedupeSeen(pub){
  const q=readJson('queue.json',[]);
  const same=q.filter(x=>['pending','done'].includes(String(x?.status||''))&&samePublication(x?.pub,pub));
  if(same.some(x=>Boolean(x?.pub?.media?.length)))return true;
  if(same.length&&!pub?.media?.length)return true;
  // A richer retry (for example an anime video after a Bot API text fallback)
  // is intentionally allowed through so the missing media can be delivered.
  if(pub?.media?.length&&same.length)return false;
  const h=readJson('history.json',[]);
  // A planned history entry is not proof that a durable queue item survived.
  // Only a confirmed publication may suppress a replay when the queue no longer has it.
  return h.some(x=>x.type==='published'&&(x.publicationId===pub.id||sameSourceMessage(x,pub)));
}

async function resolveNewsletter({inviteUrl,cacheFile,jidKey,titleKey}){
  if(!socket||state.status!=='connected') return null;
  const expectedInvite=String(inviteUrl||'').trim();
  const persisted=readJson(cacheFile,{});
  if(
    persisted?.jid?.endsWith('@newsletter') &&
    String(persisted?.invite||'').trim()===expectedInvite
  ){
    state[jidKey]=persisted.jid;
    state[titleKey]=persisted.title||null;
    return persisted.jid;
  }
  const code=inviteCode(expectedInvite); if(!code) return null;
  const meta=await socket.newsletterMetadata('invite',code);
  const jid=String(meta?.id||meta?.jid||'');
  if(!jid.endsWith('@newsletter')) throw new Error('JID newsletter introuvable');
  state[jidKey]=jid;
  state[titleKey]=meta?.name||meta?.subject||null;
  writeJson(cacheFile,{jid,title:state[titleKey],invite:expectedInvite,resolvedAt:new Date().toISOString()});
  return jid;
}

async function resolveChannel(){
  return resolveNewsletter({
    inviteUrl:CHANNEL_INVITE_URL,
    cacheFile:'channel.json',
    jidKey:'channelJid',
    titleKey:'channelTitle',
  });
}

async function resolveOtakuChannel(){
  return resolveNewsletter({
    inviteUrl:OTAKU_CHANNEL_INVITE_URL,
    cacheFile:'otaku-channel.json',
    jidKey:'otakuChannelJid',
    titleKey:'otakuChannelTitle',
  });
}
async function resolveStickGoodChannel(){
  return resolveNewsletter({
    inviteUrl:STICK_GOOD_CHANNEL_INVITE_URL,
    cacheFile:'stick-good-channel.json',
    jidKey:'stickGoodChannelJid',
    titleKey:'stickGoodChannelTitle',
  });
}

async function resolveSecondaryApkGroup(){
  if(!socket||state.status!=='connected') return null;
  const expectedInvite=String(SECONDARY_APK_GROUP_INVITE_URL||'').trim();
  const persisted=readJson('secondary-apk-group.json',{});
  if(
    persisted?.jid?.endsWith('@g.us') &&
    String(persisted?.invite||'').trim()===expectedInvite
  ){
    state.secondaryApkGroupJid=persisted.jid;
    state.secondaryApkGroupTitle=persisted.title||null;
    return persisted.jid;
  }
  const code=groupInviteCode(expectedInvite);
  if(!code) return null;

  let meta=await socket.groupGetInviteInfo(code);
  let jid=String(meta?.id||'');
  if(!jid.endsWith('@g.us')) throw new Error('JID du groupe APK secondaire introuvable');

  try{
    await socket.groupMetadata(jid);
  }catch{
    const joined=String(await socket.groupAcceptInvite(code)||'');
    if(joined.endsWith('@g.us')) jid=joined;
    meta=await socket.groupMetadata(jid);
  }

  state.secondaryApkGroupJid=jid;
  state.secondaryApkGroupTitle=meta?.subject||meta?.name||null;
  writeJson('secondary-apk-group.json',{
    jid,
    title:state.secondaryApkGroupTitle,
    invite:expectedInvite,
    resolvedAt:new Date().toISOString()
  });
  return jid;
}

async function connectWhatsApp({freshPairing=false}={}){
  const generation=++socketGeneration;
  const socketStartedAt=Date.now();
  clearTimeout(reconnectTimer);

  if(freshPairing&&socket){
    try{socket.end?.(new Error('pairing socket refresh'));}catch{}
    socket=null;
    await new Promise(r=>setTimeout(r,250));
  }

  const {state:auth,saveCreds}=await useMultiFileAuthState(AUTH_DIR);
  const registered=Boolean(auth.creds.registered);
  state.status=registered?'connecting':'waiting_pairing';
  state.lastError=null;

  let version;
  try{
    const latest=await fetchLatestWaWebVersion();
    version=latest?.version;
    logger.info({version},'Using current WhatsApp Web version');
  }catch(e){
    logger.warn({err:e},'Unable to fetch latest WhatsApp version; using Baileys default');
  }

  const sock=makeWASocket({
    ...(version?{version}:{}),
    auth,
    logger:pino({level:process.env.BAILEYS_LOG_LEVEL||'silent'}),
    browser:Browsers.ubuntu('Chrome'),
    markOnlineOnConnect:false,
    syncFullHistory:false,
    shouldSyncHistoryMessage:()=>false,
    // A fresh companion may receive encrypted backlog created for an older
    // Signal state. Quarantine that backlog briefly, then keep ignoring only
    // direct/status traffic. Group/newsletter receipts remain available.
    shouldIgnoreJid:jid=>{
      if(!jid) return false;
      // Ignore only the initial encrypted backlog. Live private chats must stay
      // available because NexAI commands are intentionally usable in DM too.
      if(!registered && Date.now()-socketStartedAt<45000) return true;
      return /@broadcast$/.test(jid);
    },
    generateHighQualityLinkPreview:true,
    keepAliveIntervalMs:30000,
    retryRequestDelayMs:2000,
    getMessage:async key=>{
      const saved=otakuPollMessages.get(String(key?.id||''));
      return saved?.message||proto.Message.fromObject({});
    }
  });
  socket=sock;

  sock.ev.on('creds.update',saveCreds);
  try{commandEngine?.detach?.();}catch{}
  commandEngine=attachWhatsAppCommandEngine(sock,{
    state,
    dataDir:DATA_DIR,
    menuImageB64Path:MENU_IMAGE_B64_PATH,
    getNewsletterInfo:()=>({
      jid:state.channelJid||PRESENTATION_NEWSLETTER_JID,
      name:state.channelTitle||'Nextech',
    }),
  });
  logger.info({commands:commandEngine?.commandCount||0},'EliteProTech command engine attached');

  // Orders are only accepted by the manager while its order window is open.
  // Forwarding candidates is harmless outside that window; the manager rejects
  // them before AI classification or queue insertion.
  sock.ev.on('messages.upsert',({messages})=>{
    for(const msg of messages||[]){
      forwardStickGoodQuestionResponse(msg).catch(()=>{});
      forwardOtakuOrderCandidate(msg).catch(()=>{});
    }
  });
  sock.ev.on('messages.update',updates=>{
    for(const row of updates||[]){
      const id=String(row?.key?.id||'');
      const record=otakuPollRecords.get(id);
      const pollUpdates=row?.update?.pollUpdates;
      if(!record||!Array.isArray(pollUpdates)||!pollUpdates.length)continue;
      record.updates=[...(record.updates||[]),...pollUpdates].slice(-2000);
      try{
        record.votes=aggregateOtakuVotes(record);
        persistOtakuPollSummary();
      }catch(error){
        logger.warn({error:String(error?.message||error),poll:id},'Otaku poll aggregation failed');
      }
    }
  });

  sock.ev.on('connection.update',async u=>{
    if(generation!==socketGeneration)return;

    if(u.qr){
      state.qr=u.qr;
      if(!auth.creds.registered) state.status='waiting_pairing';
    }

    if(u.connection==='open'){
      state.status='connected';
      state.connectedAt=new Date().toISOString();
      state.me=sock.user||null;
      state.lastError=null;
      state.qr=null;
      try{await resolveChannel();}catch(e){state.lastError=`channel: ${e?.message||e}`;}
      try{await resolveOtakuChannel();}catch(e){state.lastError=`otaku-channel: ${e?.message||e}`;}
      try{await resolveStickGoodChannel();}catch(e){state.lastError=`stick-good-channel: ${e?.message||e}`;}
      fetch(STICK_GOOD_MANAGER_URL+'/kick',{method:'POST',signal:AbortSignal.timeout(5000)})
        .catch(error=>logger.warn({error:String(error?.message||error)},'Stick Good immediate-start kick failed'));
      processQueue().catch(()=>{});
    }

    if(u.connection==='close'){
      state.me=null;
      const code=new Boom(u.lastDisconnect?.error)?.output?.statusCode;
      const message=String(u.lastDisconnect?.error?.message||u.lastDisconnect?.error||`closed:${code||'unknown'}`);
      state.lastError=message;

      const nowRegistered=Boolean(auth.creds.registered);
      logger.warn({code,message,registered:nowRegistered},'WhatsApp connection closed');

      if(code===DisconnectReason.loggedOut || code===401){
        clearTimeout(reconnectTimer);
        reconnectTimer=null;
        state.status='needs_pairing';
        state.connectedAt=null;
        state.qr=null;
        state.lastError='Session WhatsApp refusée ou expirée. Génère une nouvelle connexion.';
        logger.warn({code},'Terminal WhatsApp auth failure; automatic reconnect stopped');
        return;
      }

      if(code===DisconnectReason.restartRequired){
        state.status='restarting_after_pair';
        clearTimeout(reconnectTimer);
        reconnectTimer=setTimeout(()=>connectWhatsApp().catch(e=>logger.error({err:e},'WhatsApp reconnect failed')),900);
        reconnectTimer.unref?.();
        return;
      }

      if(nowRegistered){
        state.status='reconnecting';
        clearTimeout(reconnectTimer);
        reconnectTimer=setTimeout(()=>connectWhatsApp().catch(e=>logger.error({err:e},'WhatsApp reconnect failed')),5000);
        reconnectTimer.unref?.();
        return;
      }

      state.status='waiting_pairing';
    }
  });

  return sock;
}

async function requestPairingCode(phone){
  const clean=String(phone||'').replace(/\D/g,'');
  if(clean.length<7||clean.length>15) throw new Error('Numéro WhatsApp invalide');
  if(state.status==='connected') throw new Error('Un compte WhatsApp est déjà connecté');

  const now=Date.now();
  if(now-lastPairRequestAt<30000) throw new Error('Patiente quelques secondes avant de demander un nouveau code.');
  // Lock before touching Baileys state: a second request can overwrite the
  // pairing secret and make the first code impossible to validate.
  lastPairRequestAt=now;

  try{
    // Explicit new pairing = discard any disconnected/401 auth state first.
    await resetAuthForPairing();
    const pairSocket=await connectWhatsApp({freshPairing:true});
    if(typeof pairSocket?.requestPairingCode!=='function'){
      throw new Error('Pairing par numéro indisponible');
    }

    // Baileys recommends requesting the code only once the QR/connecting
    // phase is reached. This avoids issuing a code from a half-open socket.
    await waitForQr(15000);

    const raw=String(await Promise.race([
      pairSocket.requestPairingCode(clean),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('La génération du code WhatsApp a expiré. Réessaie.')),20000))
    ]));
    if(!raw) throw new Error('Aucun code retourné par WhatsApp');

    state.status='pairing_code_ready';
    state.lastError=null;
    return {phone:`+${clean}`,raw,formatted:raw.match(/.{1,4}/g)?.join('-')||raw};
  }catch(error){
    state.status=state.qr?'waiting_pairing':'needs_pairing';
    state.lastError=String(error?.message||error);
    throw error;
  }
}

async function nativeButtons(jid,text,buttons,{forwarded=false}={}){
  const nativeCtas=(Array.isArray(buttons)?buttons:[])
    .map(b=>({
      text:String(b?.text||'Ouvrir').trim().slice(0,40),
      url:String(b?.url||'').trim(),
    }))
    .filter(b=>b.text&&/^https?:\/\//i.test(b.url))
    .slice(0,3);
  if(!nativeCtas.length) return false;

  try{
    const contextInfo=forwarded?groupForwardContext():undefined;
    const message=proto.Message.fromObject({
      viewOnceMessage:{
        message:{
          messageContextInfo:{
            deviceListMetadata:{},
            deviceListMetadataVersion:2
          },
          interactiveMessage:{
            header:{
              title:'Nextech',
              hasMediaAttachment:false
            },
            body:{text:String(text||'Ouvrir').slice(0,4096)},
            footer:{text:'Nextech'},
            ...(contextInfo?{contextInfo}:{}),
            nativeFlowMessage:{
              buttons:nativeCtas.map(b=>({
                name:'cta_url',
                buttonParamsJson:JSON.stringify({
                  display_text:b.text,
                  url:b.url,
                  merchant_url:b.url
                })
              })),
              messageParamsJson:'{}',
              messageVersion:1
            }
          }
        }
      }
    });

    const generated=generateWAMessageFromContent(
      jid,
      message,
      {userJid:socket.user?.id}
    );
    await socket.relayMessage(jid,generated.message,{messageId:generated.key.id});
    logger.info({jid,buttons:nativeCtas.length,messageId:generated.key.id},'WhatsApp CTA URL buttons relayed');
    return true;
  }catch(error){
    logger.warn({jid,error:String(error?.message||error)},'WhatsApp native URL buttons failed');
    return false;
  }
}

async function sendOneMedia(jid,item,caption,contextInfo){
  let source;
  if(item.localPath){
    let st;
    try{st=fs.statSync(item.localPath);}catch{throw new Error('Fichier APK local introuvable: '+item.fileName);}
    if(!st.isFile()||st.size<=0)throw new Error('Fichier APK local invalide: '+item.fileName);
    source={stream:fs.createReadStream(item.localPath)};
  }else{
    const url=item.url||await telegramFileUrl(item.fileId);
    if(!url) throw new Error('URL média introuvable');
    source={url};
  }
  const meta=mediaMeta(item.fileName,item.type,item.mimetype);
  const type=meta.type;
  const ctx=contextInfo?{contextInfo}:{};
  if(type==='photo'||type==='image') return socket.sendMessage(jid,{image:source,caption,mimetype:meta.mimetype,...ctx});
  if(type==='video'||type==='animation') return socket.sendMessage(jid,{video:source,caption,mimetype:meta.mimetype,...ctx});
  if(type==='audio'||type==='voice') return socket.sendMessage(jid,{audio:source,mimetype:meta.mimetype,...ctx});
  return socket.sendMessage(jid,{document:source,mimetype:meta.mimetype,fileName:meta.fileName||'fichier',caption,...ctx});
}

function promiseWithTimeout(promise,ms,label='operation'){
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout after '+ms+'ms')),ms);});
  return Promise.race([Promise.resolve(promise).finally(()=>clearTimeout(timer)),timeout]);
}
async function sendNewsletterTextDirect(jid,text){
  const value=String(text||'Publication Nextech').trim()||'Publication Nextech';
  // Use Baileys' normal send path for newsletter text so a successful return
  // corresponds to a real WhatsApp message object. The old raw sendNode path
  // could return without producing a visible channel update.
  const sent=await socket.sendMessage(jid,{text:value});
  const messageId=String(sent?.key?.id||'');
  if(!messageId)throw new Error('Newsletter text send returned no message id');
  state.lastPublishAt=new Date().toISOString();
  return messageId;
}

function safeOtakuLocalPath(value=''){
  const p=path.resolve(String(value||''));
  if(
    p.startsWith('/var/lib/nex/tmp/internal-automation/otaku-nexus-manager/')||
    p.startsWith('/var/lib/nex/tmp/shared-whatsapp/')
  )return p;
  return '';
}
async function otakuMediaSource(item={}){
  const local=safeOtakuLocalPath(item.localPath);
  if(local){
    const st=fs.statSync(local);
    if(!st.isFile()||st.size<=0)throw new Error('Otaku media local invalide');
    // Otaku sticker/image assets are deliberately small. A Buffer is the most
    // compatible Baileys media input, especially for sticker messages.
    return fs.readFileSync(local);
  }
  const url=String(item.url||'').trim();
  if(/^https?:\/\//i.test(url))return {url};
  throw new Error('Otaku media source absente');
}
function safeStickGoodLocalPath(value=''){
  const p=path.resolve(String(value||''));
  if(p.startsWith('/var/lib/nex/tmp/internal-automation/stick-good/'))return p;
  return '';
}
async function stickGoodMediaSource(item={}){
  const local=safeStickGoodLocalPath(item.localPath);
  if(local){
    const st=fs.statSync(local);
    if(!st.isFile()||st.size<=0)throw new Error('Stick Good media local invalide');
    return fs.readFileSync(local);
  }
  const url=String(item.url||'').trim();
  if(/^https?:\/\//i.test(url))return {url};
  throw new Error('Stick Good media source absente');
}
async function sendStickGoodQuestion(jid,raw={}){
  const text=String(raw.text||'Quel personnage veux-tu pour le prochain pack ?').slice(0,1024);
  let inner;
  if(raw.image){
    const src=await stickGoodMediaSource(raw.image);
    const prepared=await prepareWAMessageMedia(
      {image:src,caption:text},
      {upload:socket.waUploadToServer,mediaUploadTimeoutMs:120000,logger,jid}
    );
    if(!prepared?.imageMessage)throw new Error('Stick Good question image preparation failed');
    prepared.imageMessage.caption=text;
    prepared.imageMessage.contextInfo={...(prepared.imageMessage.contextInfo||{}),isQuestion:true};
    inner={imageMessage:prepared.imageMessage};
  }else{
    inner={extendedTextMessage:proto.Message.ExtendedTextMessage.create({text,contextInfo:{isQuestion:true}})};
  }
  const content=proto.Message.fromObject({
    questionMessage:proto.Message.FutureProofMessage.create({message:inner})
  });
  const generated=generateWAMessageFromContent(jid,content,{userJid:socket.user?.id});
  await socket.relayMessage(jid,generated.message,{messageId:generated.key.id});
  return String(generated.key.id||'');
}
async function prepareStickGoodPackCard(jid,raw={}){
  if(!raw.pack)throw new Error('Stick Good pack file missing');
  const packLocal=safeStickGoodLocalPath(raw.pack.localPath);
  if(!packLocal)throw new Error('Stick Good pack local path invalid');
  const packBytes=fs.readFileSync(packLocal);
  if(!packBytes.length)throw new Error('Stick Good pack empty');
  const coverBytes=raw.cover?await stickGoodMediaSource(raw.cover):null;
  if(!Buffer.isBuffer(coverBytes))throw new Error('Stick Good cover local required');
  const encrypted=await encryptedStream(packBytes,'sticker-pack',{logger});
  let uploaded;
  try{
    uploaded=await socket.waUploadToServer(encrypted.encFilePath,{
      fileEncSha256B64:encrypted.fileEncSha256.toString('base64'),
      mediaType:'sticker-pack',timeoutMs:120000
    });
  }finally{
    try{fs.unlinkSync(encrypted.encFilePath)}catch{}
    try{if(encrypted.originalFilePath)fs.unlinkSync(encrypted.originalFilePath)}catch{}
  }
  const thumbEncrypted=await encryptedStream(coverBytes,'thumbnail-sticker-pack',{logger,mediaKey:encrypted.mediaKey});
  let thumbUploaded;
  try{
    thumbUploaded=await socket.waUploadToServer(thumbEncrypted.encFilePath,{
      fileEncSha256B64:thumbEncrypted.fileEncSha256.toString('base64'),
      mediaType:'thumbnail-sticker-pack',timeoutMs:120000
    });
  }finally{
    try{fs.unlinkSync(thumbEncrypted.encFilePath)}catch{}
    try{if(thumbEncrypted.originalFilePath)fs.unlinkSync(thumbEncrypted.originalFilePath)}catch{}
  }
  if(!thumbUploaded?.directPath)throw new Error('Stick Good pack thumbnail upload failed');
  const stickerPackId='StickGood_'+crypto.randomBytes(10).toString('hex');
  const stickerFiles=(Array.isArray(raw.stickerFiles)?raw.stickerFiles:[])
    .map(x=>String(x||'').trim()).filter(Boolean).slice(0,30);
  if(stickerFiles.length<3)throw new Error('Stick Good sticker metadata incomplete');
  const message=proto.Message.fromObject({
    messageContextInfo:{messageSecret:crypto.randomBytes(32)},
    stickerPackMessage:{
      stickerPackId,
      name:String(raw.packName||raw.character||'Stick Good').slice(0,120),
      publisher:String(raw.publisher||'Trésor').slice(0,80),
      packDescription:'Stick Good · '+String(raw.character||'').slice(0,80),
      stickers:stickerFiles.map(fileName=>({
        fileName,isAnimated:false,isLottie:false,mimetype:'image/webp',emojis:[],accessibilityLabel:String(raw.character||'')
      })),
      fileLength:encrypted.fileLength,
      fileSha256:encrypted.fileSha256,
      fileEncSha256:encrypted.fileEncSha256,
      mediaKey:encrypted.mediaKey,
      directPath:uploaded?.directPath,
      mediaKeyTimestamp:Math.floor(Date.now()/1000),
      trayIconFileName:stickerFiles[0],
      thumbnailDirectPath:thumbUploaded.directPath,
      thumbnailSha256:thumbEncrypted.fileSha256,
      thumbnailEncSha256:thumbEncrypted.fileEncSha256,
      thumbnailHeight:252,
      thumbnailWidth:252,
      imageDataHash:crypto.createHash('sha256').update(coverBytes).digest('base64'),
      stickerPackSize:encrypted.fileLength,
      stickerPackOrigin:proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED
    }
  });
  return generateWAMessageFromContent(jid,message,{userJid:socket.user?.id});
}
async function runStickGoodAction(raw={}){
  if(!socket||state.status!=='connected')throw new Error('WhatsApp non connecté');
  const jid=state.stickGoodChannelJid||await resolveStickGoodChannel();
  if(!jid)throw new Error('Chaîne Stick Good non résolue');
  const kind=String(raw.kind||'').toLowerCase();
  return withStickGoodSendLock(async()=>{
    if(kind==='question'){
      const actionId=await sendStickGoodQuestion(jid,raw);
      if(!actionId)throw new Error('Stick Good question returned no id');
      return {ok:true,actionId};
    }
    if(kind==='pack'){
      const character=String(raw.character||'personnage').trim()||'personnage';
      const previews=(Array.isArray(raw.previews)?raw.previews:[]).slice(0,8);
      if(previews.length<5)throw new Error('Stick Good requires 5-8 preview stickers');
      // Prepare and upload the native card first. If that fails, publish nothing partial.
      const card=await prepareStickGoodPackCard(jid,raw);
      if(raw.cover){
        const cover=await stickGoodMediaSource(raw.cover);
        await socket.sendMessage(jid,{image:cover,caption:String(raw.caption||'').slice(0,1024)});
        await stickGoodSleep(1500);
      }
      for(const item of previews){
        const sticker=await stickGoodMediaSource(item);
        await socket.sendMessage(jid,{sticker});
        await stickGoodSleep(650);
      }
      await socket.relayMessage(jid,card.message,{messageId:card.key.id});
      return {ok:true,actionId:String(card.key.id||raw.id||''),sentCount:previews.length+2,nativePack:true,character};
    }
    throw new Error('Action Stick Good inconnue: '+kind);
  });
}

function otakuRankText(sessionId){
  const scores=new Map();
  let questionCount=0;
  for(const record of otakuPollRecords.values()){
    if(record.sessionId!==sessionId||!record.quiz||!record.correctAnswer)continue;
    questionCount++;
    for(const [voter,answer] of Object.entries(record.votes||{})){
      if(!scores.has(voter))scores.set(voter,0);
      if(String(answer)===String(record.correctAnswer))scores.set(voter,scores.get(voter)+1);
    }
  }
  const rows=[...scores.entries()].sort((a,b)=>b[1]-a[1]);
  if(!rows.length){
    return '✦ ʀᴇ́sᴜʟᴛᴀᴛs ᴅᴜ ǫᴜɪᴢ\n\nAucun vote individuel exploitable n’a été remonté par WhatsApp pour établir un classement fiable. Merci à tous ceux qui ont participé. 🔥';
  }
  const medals=['🥇','🥈','🥉'];
  const body=rows.map(([v,s],i)=>(medals[i]||String(i+1)+'.')+' '+String(v).replace(/@.*/,'')+' — '+s+'/'+questionCount).join('\n');
  return '✦ ᴄʟᴀssᴇᴍᴇɴᴛ ᴏᴛᴀᴋᴜ ɴᴇxᴜs\n\n'+body+'\n\nBien joué à tous. On remet ça bientôt. 🔥';
}
async function runOtakuAction(raw={}){
  if(!socket||state.status!=='connected')throw new Error('WhatsApp non connecté');
  const jid=state.otakuChannelJid||await resolveOtakuChannel();
  if(!jid)throw new Error('Chaîne Otaku Nexus non résolue');
  const kind=String(raw.kind||'').toLowerCase();

  return withOtakuSendLock(async()=>{
    const claim=reserveOtakuAction(raw);
    if(claim.duplicate){
      logger.warn({kind,id:String(raw.id||''),reason:claim.reason},'Otaku duplicate publication blocked');
      return {ok:true,duplicate:true,actionId:claim.actionId||null,dedupReason:claim.reason};
    }
    const done=result=>{completeOtakuAction(claim,result?.actionId||null);return result};
    try{
    if(kind==='text'){
      const id=await sendNewsletterTextDirect(jid,String(raw.text||''));
      queueOtakuRelay(raw).catch(()=>{});
      return done({ok:true,actionId:id});
    }
    if(kind==='image'){
      const src=await otakuMediaSource(raw.image||{url:raw.imageUrl,localPath:raw.localPath});
      const sent=await socket.sendMessage(jid,{image:src,caption:String(raw.text||raw.caption||'').slice(0,1024)});
      queueOtakuRelay(raw).catch(()=>{});
      return done({ok:true,actionId:sent?.key?.id||null});
    }
    if(kind==='poll'){
      const question=String(raw.question||'Question').slice(0,255);
      const options=(Array.isArray(raw.options)?raw.options:[]).map(x=>String(x).slice(0,100)).filter(Boolean).slice(0,12);
      if(options.length<2)throw new Error('Sondage Otaku: 2 options minimum');
      const poll={
        name:question,
        values:options,
        selectableCount:1,
        ...(raw.quiz&&raw.correctAnswer?{correctAnswer:String(raw.correctAnswer),pollType:1}:{})
      };
      let sent;
      try{sent=await socket.sendMessage(jid,{poll});}
      catch(firstError){
        try{
          // Newsletter/channel delivery can reject the regular single-select
          // poll shape while accepting the announcement-group variant.
          sent=await socket.sendMessage(jid,{poll:{name:question,values:options,selectableCount:1,toAnnouncementGroup:true}});
        }catch(secondError){
          logger.error({
            first:String(firstError?.message||firstError).slice(0,500),
            second:String(secondError?.message||secondError).slice(0,500),
            id:String(raw.id||'')
          },'Otaku poll delivery failed');
          throw secondError;
        }
      }
      const id=String(sent?.key?.id||'');
      if(!id)throw new Error('Sondage Otaku: envoi sans identifiant WhatsApp');
      if(id){
        const message=sent?.message||{pollCreationMessage:{name:question,options:options.map(optionName=>({optionName}))}};
        otakuPollMessages.set(id,{message});
        otakuPollRecords.set(id,{
          message,logicalId:String(raw.id||''),sessionId:String(raw.sessionId||''),question,options,
          correctAnswer:raw.quiz?String(raw.correctAnswer||''):null,
          quiz:Boolean(raw.quiz),updates:[],votes:{},createdAt:new Date().toISOString()
        });
        persistOtakuPollSummary();
      }
      return done({ok:true,actionId:id});
    }
    if(kind==='pack'){
      if(!raw.pack)throw new Error('Pack Otaku sans fichier .wastickers');
      const character=String(raw.character||'personnage').trim()||'personnage';
      const count=Math.max(0,Number(raw.count||0));
      if(raw.cover){
        const cover=await otakuMediaSource(raw.cover);
        await socket.sendMessage(jid,{image:cover,caption:String(raw.caption||'').slice(0,1024)});
        await otakuSleep(1800);
      }
      const src=await otakuMediaSource(raw.pack);
      const fileName=String(raw.pack.fileName||character.replace(/\s+/g,'-')+'.wastickers').slice(0,120);
      const mimetype=String(raw.pack.mimetype||'application/zip');
      const sent=await socket.sendMessage(jid,{
        document:src,
        mimetype,
        fileName,
        caption:'📦 '+character+(count?' · '+count+' stickers':'')+'\n💜 Otaku Nexus · pack complet'
      });
      queueOtakuRelay(raw).catch(()=>{});
      return done({ok:true,actionId:sent?.key?.id||String(raw.id||''),sentCount:1});
    }
    if(kind==='quiz_results'){
      const text=otakuRankText(String(raw.sessionId||''));
      const id=await sendNewsletterTextDirect(jid,text);
      return done({ok:true,actionId:id});
    }
    throw new Error('Action Otaku inconnue: '+kind);
    }catch(error){
      releaseOtakuAction(claim);
      throw error;
    }
  });
}

async function sendPublication(jid,destination,pub){
  if(!socket||state.status!=='connected') throw new Error('WhatsApp non connecté');

  const isGroup=destination==='group';
  const forwardContext=isGroup?groupForwardContext():undefined;
  const channelButtons=orderedChannelButtons(pub.buttons||[]);
  const buttons=isGroup?groupActionButtons(pub):channelButtons;
  const channelText=[pub.text,linksText(channelButtons)].filter(Boolean).join('\n\n');
  const channelCaption=channelMediaCaption(pub.text,channelButtons,1024);
  const groupFallback=[pub.text,linksText(buttons)].filter(Boolean).join('\n\n');

  if(!pub.media.length){
    // WhatsApp newsletters/channels do not reliably render Baileys native-flow
    // interactive messages. A successful relay can still appear to followers
    // as “channel update unsupported”. Keep channel updates strictly to
    // standard text/media payloads and flatten Telegram buttons into links.
    if(!isGroup){
      await sendNewsletterTextDirect(jid,channelText||'Publication Nextech');
      return;
    }

    if(buttons.length){
      const ok=await nativeButtons(
        jid,
        pub.text||'Publication Nextech',
        buttons,
        {forwarded:true}
      );
      if(ok){
        if(buttons.length>3){
          await socket.sendMessage(
            jid,
            {text:linksText(buttons.slice(3)),...(forwardContext?{contextInfo:forwardContext}:{})}
          );
        }
        return;
      }
      await socket.sendMessage(
        jid,
        {text:groupFallback||'Publication Nextech',...(forwardContext?{contextInfo:forwardContext}:{})}
      );
      return;
    }

    await socket.sendMessage(
      jid,
      {text:pub.text||'Publication Nextech',...(forwardContext?{contextInfo:forwardContext}:{})}
    );
    return;
  }

  // Channels/newsletters receive only standard media updates. Telegram URL
  // buttons are flattened into the first media caption so followers never get
  // an unsupported interactive channel-update placeholder. Groups keep the
  // richer native CTA flow with a plain-text fallback.
  for(let i=0;i<pub.media.length;i++){
    const caption=i===0?((isGroup?pub.text:channelCaption)||undefined):undefined;
    await sendOneMedia(jid,pub.media[i],caption,isGroup?forwardContext:undefined);
  }

  if(isGroup&&buttons.length){
    const ok=await nativeButtons(
      jid,
      'Liens de la publication',
      buttons,
      {forwarded:isGroup}
    );
    if(!ok){
      await socket.sendMessage(
        jid,
        {text:linksText(buttons),...(forwardContext?{contextInfo:forwardContext}:{})}
      );
    }else if(buttons.length>3){
      await socket.sendMessage(
        jid,
        {text:linksText(buttons.slice(3)),...(forwardContext?{contextInfo:forwardContext}:{})}
      );
    }
  }
}

async function processQueue(){
  if(processing||state.status!=='connected') return;
  processing=true;
  try{
    const q=readJson('queue.json',[]);
    for(const job of q){
      if(job.status!=='pending'||Number(job.nextAttemptAt||0)>Date.now()) continue;
      try{
        job.attempts=Number(job.attempts||0)+1;
        job.inFlightAt=new Date().toISOString();
        mergeQueueWithLatest(q);
        writeJson('queue.json',q);
        if(job.destination==='channel'&&(!job.jid||job.jid==='__CHANNEL__'||job.jid==='__OTAKU_CHANNEL__')){
          const lifestyle=isOtakuSource(job.pub?.source)||job.jid==='__OTAKU_CHANNEL__';
          const resolved=lifestyle?await promiseWithTimeout(resolveOtakuChannel(),10000,'resolve Otaku channel'):await promiseWithTimeout(resolveChannel(),10000,'resolve NexTech channel');
          if(!resolved) throw new Error(lifestyle?'Chaîne WhatsApp Otaku non résolue':'Chaîne WhatsApp non résolue');
          job.jid=resolved;
        }
        if(job.destination==='group'&&job.jid==='__SECONDARY_APK_GROUP__'){
          const resolved=await promiseWithTimeout(resolveSecondaryApkGroup(),15000,'resolve secondary APK group');
          if(!resolved) throw new Error('Groupe WhatsApp APK secondaire non résolu');
          job.jid=resolved;
        }
        const sendJob=()=>sendPublication(job.jid,job.destination,job.pub);
        const sendPromise=isOtakuSource(job.pub?.source)
          ?withOtakuSendLock(sendJob)
          :sendJob();
        await promiseWithTimeout(sendPromise,120000,'WhatsApp publication');
        job.status='done'; job.completedAt=new Date().toISOString(); delete job.inFlightAt; state.lastPublishAt=job.completedAt;
        addHistory({type:'published',publicationId:job.pub.id,source:job.pub.source,destination:job.destination,attempts:job.attempts});
        // Otaku/Dark media staged by NexAnime has a single WhatsApp destination.
        // Delete it only after the newsletter send succeeds; failed jobs retain
        // the file for retries.
        if(isOtakuSource(job.pub?.source)){
          for(const media of job.pub?.media||[]){
            const local=String(media?.localPath||'');
            if(local&&path.resolve(local).startsWith('/var/lib/nex/tmp/shared-whatsapp/')){
              try{fs.rmSync(local,{force:true});}catch{}
            }
          }
        }
      }catch(e){
        job.lastError=String(e?.message||e); delete job.inFlightAt;
        const delay=Math.min(300000,5000*(2**Math.min(6,job.attempts-1)));
        job.nextAttemptAt=Date.now()+delay;
        if(job.attempts>=50){ job.status='failed'; addHistory({type:'failed',publicationId:job.pub.id,destination:job.destination,error:job.lastError}); }
      }
      mergeQueueWithLatest(q);
      writeJson('queue.json',q);
    }
  }finally{processing=false;}
}
setInterval(()=>processQueue().catch(()=>{}),3000).unref();
setInterval(()=>processOtakuRelay().catch(()=>{}),5000).unref();

function plan(raw){
  const pub=normalizePublication(raw);
  if(!SOURCES.has(pub.source)) throw new Error(`source non autorisée: ${pub.source||'vide'}`);
  const bareApk=!pub.media.length&&/\.(?:apk|xapk|apks|apkm)(?:\s|$)/i.test(pub.text.trim());
  if(bareApk) throw new Error('APK sans fichier média: publication refusée pour éviter un nom de fichier vide');
  if(dedupeSeen(pub)) return {duplicate:true,pub,route:routePublication(pub)};
  const route=routePublication(pub);
  if(route.group) enqueue('group',GROUP_JID,pub);
  if(route.channelBlocked&&SECONDARY_APK_GROUP_INVITE_URL) enqueue('group','__SECONDARY_APK_GROUP__',pub);
  if(route.channel){
    const lifestyle=isOtakuSource(pub.source);
    enqueue('channel',lifestyle?(state.otakuChannelJid||'__OTAKU_CHANNEL__'):(state.channelJid||'__CHANNEL__'),pub);
  }
  addHistory({type:'planned',publicationId:pub.id,source:pub.source,sourceMessageId:pub.sourceMessageId,route,textPreview:pub.text.slice(0,180)});
  processQueue().catch(()=>{});
  return {duplicate:false,pub,route};
}

function publisherReadiness(){
  const queue=readJson('queue.json',[]);
  const pending=queue.filter(x=>x.status==='pending');
  const pendingOtaku=pending.filter(x=>isOtakuSource(x?.pub?.source)||x?.jid==='__OTAKU_CHANNEL__');
  const connected=state.status==='connected';
  const otakuResolved=Boolean(state.otakuChannelJid);
  return {
    ready:connected&&otakuResolved,
    connected,
    otakuResolved,
    status:state.status,
    otakuChannelJid:state.otakuChannelJid,
    pending:pending.length,
    pendingOtaku:pendingOtaku.length,
    lastPublishAt:state.lastPublishAt,
    lastError:state.lastError
  };
}

const html=`
<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#07110d"><title>NexAI · EliteProTech</title><style>
:root{--bg:#06100c;--panel:#0b1712;--panel2:#0f2119;--line:#1a3529;--soft:#91a89d;--text:#f3fbf7;--green:#25d366;--green2:#5cf28f;--danger:#ff6b6b;--amber:#ffc96b;--shadow:0 22px 70px #0008}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}body:before{content:"";position:fixed;inset:-30%;pointer-events:none;background:radial-gradient(circle at 20% 15%,#1c613b55,transparent 25%),radial-gradient(circle at 80% 10%,#113b2a66,transparent 23%),radial-gradient(circle at 55% 85%,#0e3d2b55,transparent 27%);filter:blur(18px)}
button,input,select,textarea{font:inherit}button{cursor:pointer}.app{position:relative;max-width:1180px;margin:auto;min-height:100vh;padding:18px 18px 106px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:20px}.identity{display:flex;align-items:center;gap:12px}.logo{width:46px;height:46px;border-radius:16px;display:grid;place-items:center;font-weight:1000;background:linear-gradient(145deg,#1c3f2e,#10281d);border:1px solid #28553d;box-shadow:inset 0 0 22px #49e58b16,0 12px 35px #0005}.identity b{display:block;font-size:16px}.identity small{display:block;color:var(--soft);margin-top:3px}.statuspill{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:#0c1813cc;padding:9px 12px;border-radius:999px;color:#bed0c7;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:#748b80;box-shadow:0 0 0 4px #748b801a}.statuspill.on .dot{background:var(--green);box-shadow:0 0 0 4px #25d3661d,0 0 16px #25d36688}.page{display:none}.page.active{display:block}.hero{display:grid;grid-template-columns:1.35fr .65fr;gap:16px}.card{background:linear-gradient(180deg,#0e1d17ee,#09140fee);border:1px solid var(--line);border-radius:25px;padding:20px;box-shadow:var(--shadow);backdrop-filter:blur(18px)}.heroCard{min-height:270px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;position:relative}.heroCard:after{content:"";position:absolute;width:260px;height:260px;border-radius:50%;right:-90px;top:-100px;background:radial-gradient(circle,#25d36633,transparent 65%)}.eyebrow{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--green2);font-weight:900}.heroTitle{font-size:clamp(36px,7vw,72px);line-height:.9;letter-spacing:-.055em;margin:18px 0 12px;max-width:700px}.muted{color:var(--soft);line-height:1.55}.quick{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}.btn{border:1px solid transparent;border-radius:14px;padding:12px 15px;background:var(--green);color:#04130b;font-weight:900;min-height:44px}.btn.ghost{background:#10251b;color:#e6f4ec;border-color:#244536}.btn.danger{background:#331718;color:#ffc8c8;border-color:#5c292b}.btn.small{padding:9px 12px;min-height:auto;font-size:12px}.stats{display:grid;gap:10px}.stat{padding:15px;border-radius:18px;background:#0d1a15;border:1px solid #193426}.stat span{display:block;color:#789084;font-size:11px;text-transform:uppercase;letter-spacing:.1em}.stat b{font-size:25px;display:block;margin-top:4px}.sectionHead{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:24px 2px 12px}.sectionHead h2{margin:0;font-size:22px}.sectionHead p{margin:4px 0 0;color:var(--soft);font-size:13px}.grid2,.grid3{display:grid;gap:14px}.grid2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid3{grid-template-columns:repeat(3,minmax(0,1fr))}.mini{background:#0b1712;border:1px solid var(--line);border-radius:20px;padding:16px}.miniTop{display:flex;align-items:center;justify-content:space-between;gap:10px}.mini h3{margin:7px 0 4px;font-size:16px}.tag{font-size:10px;font-weight:900;padding:6px 8px;border-radius:999px;background:#143122;color:#80eca9;border:1px solid #245239}.tag.warn{background:#302411;color:#ffd28a;border-color:#5c4721}.tag.bad{background:#33181a;color:#ffb2b2;border-color:#60292c}.route{display:grid;grid-template-columns:70px 1fr;gap:12px;align-items:center;margin-top:13px;padding-top:13px;border-top:1px solid #173125}.routeIcon{width:54px;height:54px;border-radius:17px;display:grid;place-items:center;background:#11261c;border:1px solid #274b39;font-weight:1000}.route b{font-size:14px}.route small{color:var(--soft);display:block;margin-top:4px;line-height:1.45}.field{display:grid;gap:7px;margin-top:12px}.field label{font-size:11px;color:#8fa69b;text-transform:uppercase;letter-spacing:.09em}.input{width:100%;border:1px solid #274638;background:#08130f;color:white;border-radius:14px;padding:13px 14px;outline:none}.input:focus{border-color:#32d978;box-shadow:0 0 0 4px #25d36614}textarea.input{min-height:120px;resize:vertical}.formRow{display:grid;grid-template-columns:1fr 1fr;gap:10px}.timeline{display:grid;gap:9px}.event{display:grid;grid-template-columns:12px 1fr auto;gap:10px;align-items:start;padding:12px;border-radius:16px;background:#0a1511;border:1px solid #173125}.eventDot{width:9px;height:9px;border-radius:50%;margin-top:5px;background:#6c8177}.event.published .eventDot{background:var(--green)}.event.failed .eventDot{background:var(--danger)}.event.planned .eventDot{background:var(--amber)}.event b{font-size:13px}.event small{display:block;color:var(--soft);margin-top:3px}.event time{font-size:10px;color:#71867c}.queueItem{display:grid;grid-template-columns:1fr auto;gap:10px;padding:13px 0;border-bottom:1px solid #173125}.queueItem:last-child{border-bottom:0}.queueItem b{font-size:13px}.queueItem small{display:block;color:var(--soft);margin-top:3px}.empty{padding:24px;text-align:center;color:#7f968b;border:1px dashed #244536;border-radius:18px}.pairCode{display:none;margin-top:14px;border-radius:18px;padding:17px;background:#0d2b1c;border:1px solid #256342}.pairCode.show{display:block}.pairCode strong{display:block;font-size:32px;letter-spacing:.12em;margin:8px 0 12px}.nav{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(720px,calc(100% - 24px));background:#0a1511ee;border:1px solid #1c382b;border-radius:24px;padding:8px;display:grid;grid-template-columns:repeat(6,1fr);gap:4px;backdrop-filter:blur(22px);box-shadow:0 18px 50px #000a;z-index:20}.nav button{border:0;background:transparent;color:#789084;border-radius:16px;padding:9px 4px;font-size:10px;font-weight:800}.nav button span{display:block;font-size:18px;margin-bottom:3px}.nav button.active{background:#153523;color:#eaffeF}.toast{position:fixed;right:18px;top:18px;max-width:360px;background:#10261b;border:1px solid #2b5a40;border-radius:16px;padding:13px 15px;box-shadow:var(--shadow);z-index:80;display:none}.toast.show{display:block}.login{position:fixed;inset:0;z-index:100;background:#06100cf2;display:grid;place-items:center;padding:20px;backdrop-filter:blur(25px)}.login.hide{display:none}.loginBox{width:min(430px,100%)}.loginBox h1{font-size:40px;margin:12px 0 6px;letter-spacing:-.04em}.loginBox .logo{width:58px;height:58px}.errorText{color:#ff9d9d;font-size:13px;margin-top:9px}.divider{height:1px;background:#173125;margin:16px 0}.kv{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid #173125}.kv:last-child{border-bottom:0}.kv span{color:var(--soft);font-size:12px}.kv b{font-size:12px;text-align:right;word-break:break-all}.mobileOnly{display:none}
@media(max-width:860px){.hero{grid-template-columns:1fr}.grid3{grid-template-columns:1fr 1fr}.app{padding:14px 14px 104px}.card{border-radius:22px}.heroCard{min-height:245px}.statuspill{padding:8px 10px}.identity small{max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
@media(max-width:620px){.grid2,.grid3,.formRow{grid-template-columns:1fr}.nav{grid-template-columns:repeat(6,1fr)}.nav button{font-size:9px}.nav button span{font-size:17px}.heroTitle{font-size:49px}.topbar{align-items:flex-start}.statuspill{max-width:130px;white-space:nowrap;overflow:hidden}.mobileOnly{display:block}}
</style></head><body>
<div id="toast" class="toast"></div>
<div id="login" class="login"><form id="lf" class="card loginBox"><div class="logo">N</div><div class="eyebrow" style="margin-top:18px">NEXAI · ELITEPROTECH</div><h1>Control.</h1><p class="muted">Interface privée de gestion du bot WhatsApp, des publications et du routage.</p><div class="field"><label>Mot de passe</label><input id="pw" class="input" type="password" autocomplete="current-password" required></div><button class="btn" style="width:100%;margin-top:14px">Entrer</button><div id="le" class="errorText"></div></form></div>
<main class="app">
<header class="topbar"><div class="identity"><div class="logo">N</div><div><b>NexAI · WhatsApp</b><small>EliteProTech Control Layer</small></div></div><div id="statuspill" class="statuspill"><i class="dot"></i><span id="statusText">Synchronisation</span></div></header>

<section id="p-home" class="page active">
<div class="hero"><article class="card heroCard"><div><div class="eyebrow">AUTOMATION HUB</div><h1 class="heroTitle">Publish.<br>Route. Control.</h1><p class="muted">NexAI garde son moteur actuel. EliteProTech ajoute la couche visuelle pour piloter les sources Telegram, les chaînes WhatsApp, les groupes, les fichiers et les erreurs sans mémoriser des commandes.</p></div><div class="quick"><button class="btn" data-go="connect">Connexion WhatsApp</button><button class="btn ghost" data-go="publish">Nouvelle publication</button><button class="btn ghost" id="homeRetry">Relancer les échecs</button></div></article><aside class="card stats"><div class="stat"><span>WhatsApp</span><b id="homeWa">—</b></div><div class="stat"><span>En attente</span><b id="statPending">0</b></div><div class="stat"><span>Publiées</span><b id="statPublished">0</b></div><div class="stat"><span>Échecs</span><b id="statFailed">0</b></div></aside></div>
<div class="sectionHead"><div><h2>Activité</h2><p>Événements récents du publisher.</p></div><button class="btn ghost small" id="refreshHome">Actualiser</button></div><div id="homeHistory" class="timeline"></div>
</section>

<section id="p-publish" class="page">
<div class="sectionHead"><div><h2>Publications</h2><p>Composer et router une publication sans commande texte.</p></div><span class="tag">ELITE MODE</span></div>
<div class="grid2"><form id="manualForm" class="card"><div class="eyebrow">COMPOSER</div><div class="field"><label>Source</label><select id="manualSource" class="input"><option value="thenexusorigin">Nextech</option><option value="thenexnews">NexNews</option><option value="tresor_universe">Tresor Universe</option></select></div><div class="field"><label>Texte / caption</label><textarea id="manualText" class="input" placeholder="Contenu de la publication…" required></textarea></div><div class="formRow"><div class="field"><label>Nom du lien</label><input id="manualButtonText" class="input" placeholder="Source"></div><div class="field"><label>URL</label><input id="manualButtonUrl" class="input" type="url" placeholder="https://…"></div></div><button class="btn" style="width:100%;margin-top:14px">Mettre en file</button></form>
<aside class="card"><div class="eyebrow">RÈGLES ACTIVES</div><div class="route"><div class="routeIcon">NX</div><div><b>Nextech & NexNews</b><small>Contenus compatibles → chaîne WhatsApp + groupe. APK/documents → groupe uniquement.</small></div></div><div class="route"><div class="routeIcon">OT</div><div><b>Tresor Universe</b><small>Publications lifestyle → chaîne Otaku Nexus uniquement.</small></div></div><div class="route"><div class="routeIcon">URL</div><div><b>Boutons Telegram</b><small>Chaînes : liens standards dans la caption. Groupes : CTA natifs avec fallback texte.</small></div></div></aside></div>
<div class="sectionHead"><div><h2>Dernières publications</h2><p>Planifiées, publiées et erreurs.</p></div></div><div id="publishHistory" class="timeline"></div>
</section>

<section id="p-sources" class="page">
<div class="sectionHead"><div><h2>Sources</h2><p>Entrées surveillées et destinations appliquées.</p></div></div>
<div class="grid3"><article class="mini"><div class="miniTop"><span class="tag">ACTIF</span><span>Telegram</span></div><h3>@thenexusorigin</h3><p class="muted">Nextech · APK, outils, astuces et publications tech.</p><div class="route"><div class="routeIcon">WA</div><div><b>Chaîne + groupe</b><small>Fichiers incompatibles conservés au groupe.</small></div></div></article>
<article class="mini"><div class="miniTop"><span class="tag">ACTIF</span><span>Telegram</span></div><h3>@thenexnews</h3><p class="muted">NexNews · actualités et mises à jour.</p><div class="route"><div class="routeIcon">WA</div><div><b>Chaîne + groupe</b><small>Texte, image, vidéo et liens compatibles.</small></div></div></article>
<article class="mini"><div class="miniTop"><span class="tag">ACTIF</span><span>Telegram</span></div><h3>@tresor_universe</h3><p class="muted">Lifestyle, edits et publications Otaku.</p><div class="route"><div class="routeIcon">OT</div><div><b>Otaku Nexus</b><small>Routage chaîne uniquement.</small></div></div></article></div>
</section>

<section id="p-route" class="page">
<div class="sectionHead"><div><h2>Routage</h2><p>Chaînes, groupe et règles de format.</p></div></div>
<div class="grid2"><article class="card"><div class="eyebrow">DESTINATIONS</div><div class="kv"><span>Nextech Newsletter</span><b id="routeChannel">—</b></div><div class="kv"><span>Otaku Newsletter</span><b id="routeOtaku">—</b></div><div class="kv"><span>Groupe WhatsApp</span><b>${GROUP_JID}</b></div><div class="kv"><span>Dernière publication</span><b id="routeLast">—</b></div></article>
<article class="card"><div class="eyebrow">FORMAT POLICY</div><div class="route"><div class="routeIcon">IMG</div><div><b>Images / vidéos</b><small>Media-first avec caption standard sur les chaînes.</small></div></div><div class="route"><div class="routeIcon">APK</div><div><b>APK / XAPK / fichiers</b><small>Conservation du nom et MIME ; groupe uniquement si la chaîne ne les accepte pas.</small></div></div><div class="route"><div class="routeIcon">CTA</div><div><b>Actions</b><small>Plus de Native Flow incompatible dans les newsletters.</small></div></div></article></div>
</section>

<section id="p-queue" class="page">
<div class="sectionHead"><div><h2>File & erreurs</h2><p>État réel des jobs, retries et échecs.</p></div><button id="retryFailed" class="btn ghost small">Relancer les échecs</button></div>
<div class="grid3"><div class="stat"><span>Pending</span><b id="qPending">0</b></div><div class="stat"><span>Done</span><b id="qDone">0</b></div><div class="stat"><span>Failed</span><b id="qFailed">0</b></div></div>
<div class="card" style="margin-top:14px"><div id="queueList"></div></div>
</section>

<section id="p-connect" class="page">
<div class="sectionHead"><div><h2>Connexion</h2><p>Pairing et état de la session WhatsApp.</p></div></div>
<div class="grid2"><article class="card"><div class="eyebrow">PAIRING PAR NUMÉRO</div><p class="muted">Génère un code à entrer dans WhatsApp → Appareils connectés → Connecter avec un numéro de téléphone.</p><div class="field"><label>Numéro</label><input id="phone" class="input" type="tel" placeholder="+229…"></div><button id="pair" class="btn" style="width:100%;margin-top:12px">Générer le code</button><div id="codeBox" class="pairCode"><span class="muted">CODE DE CONNEXION</span><strong id="code">—</strong><button id="copy" class="btn ghost small">Copier</button></div></article>
<article class="card"><div class="eyebrow">SESSION</div><div class="kv"><span>État</span><b id="wa">—</b></div><div class="kv"><span>Connecté depuis</span><b id="connectedAt">—</b></div><div class="kv"><span>Erreur</span><b id="lastError">Aucune</b></div><div class="quick"><button id="resolve" class="btn ghost">Résoudre Nextech</button><button id="resolveOtaku" class="btn ghost">Résoudre Otaku</button><button id="reset" class="btn danger">Réinitialiser la session</button></div></article></div>
</section>
</main>
<nav class="nav"><button class="active" data-page="home"><span>⌂</span>Accueil</button><button data-page="publish"><span>＋</span>Publier</button><button data-page="sources"><span>◈</span>Sources</button><button data-page="route"><span>⇄</span>Routage</button><button data-page="queue"><span>≡</span>File</button><button data-page="connect"><span>●</span>Connexion</button></nav>
<script>
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function toast(msg,bad){const t=$('#toast');t.textContent=msg;t.style.borderColor=bad?'#6b2a2e':'#2b5a40';t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2600)}
async function api(u,o){o=o||{};const r=await fetch(u,Object.assign({},o,{headers:Object.assign({'content-type':'application/json'},o.headers||{})}));const j=await r.json().catch(function(){return{}});if(!r.ok){const e=new Error(j.error||('HTTP '+r.status));e.status=r.status;throw e}return j}
function go(name){$$('.page').forEach(function(x){x.classList.toggle('active',x.id==='p-'+name)});$$('.nav button').forEach(function(x){x.classList.toggle('active',x.dataset.page===name)});scrollTo({top:0,behavior:'smooth'})}
$$('[data-page]').forEach(function(b){b.onclick=function(){go(b.dataset.page)}});$$('[data-go]').forEach(function(b){b.onclick=function(){go(b.dataset.go)}})
function when(v){if(!v)return'—';try{return new Date(v).toLocaleString()}catch{return String(v)}}
function eventHtml(x){const type=String(x.type||'event');return '<div class="event '+esc(type)+'"><i class="eventDot"></i><div><b>'+esc(type.toUpperCase())+' · '+esc(x.destination||x.source||'NexAI')+'</b><small>'+esc(x.textPreview||x.error||x.publicationId||'')+'</small></div><time>'+esc(when(x.at))+'</time></div>'}
function queueHtml(x){return '<div class="queueItem"><div><b>'+esc((x.destination||'job').toUpperCase())+' · '+esc(x.pub&&x.pub.source||'NexAI')+'</b><small>'+esc(x.lastError||x.pub&&x.pub.text||x.id||'')+'</small></div><span class="tag '+(x.status==='failed'?'bad':x.status==='pending'?'warn':'')+'">'+esc(x.status||'unknown')+'</span></div>'}
async function refresh(){
 try{
  const d=await api('/api/status');
  $('#login').classList.add('hide');
  const w=d.whatsapp||{},s=d.stats||{},h=d.history||[],q=d.queue||[];
  const connected=w.status==='connected';
  $('#statuspill').classList.toggle('on',connected);$('#statusText').textContent='WhatsApp · '+(w.status||'unknown');$('#homeWa').textContent=w.status||'—';$('#wa').textContent=w.status||'—';
  $('#statPending').textContent=s.pending||0;$('#statPublished').textContent=s.published||0;$('#statFailed').textContent=s.failed||0;
  $('#qPending').textContent=s.pending||0;$('#qDone').textContent=s.done||0;$('#qFailed').textContent=s.failed||0;
  $('#routeChannel').textContent=w.channelJid||'À résoudre';$('#routeOtaku').textContent=w.otakuChannelJid||'À résoudre';$('#routeLast').textContent=when(w.lastPublishAt);
  $('#connectedAt').textContent=when(w.connectedAt);$('#lastError').textContent=w.lastError||'Aucune';
  const recent=h.slice(0,18).map(eventHtml).join('')||'<div class="empty">Aucune activité enregistrée.</div>';
  $('#homeHistory').innerHTML=recent;$('#publishHistory').innerHTML=recent;
  $('#queueList').innerHTML=q.slice(0,35).map(queueHtml).join('')||'<div class="empty">File vide.</div>';
 }catch(e){if(e.status===401){$('#login').classList.remove('hide')}else toast(e.message,true)}
}
$('#lf').onsubmit=async function(e){e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('#pw').value})});$('#le').textContent='';await refresh()}catch(e){$('#le').textContent=e.message}}
$('#pair').onclick=async function(){try{$('#pair').disabled=true;const d=await api('/api/pair',{method:'POST',body:JSON.stringify({phone:$('#phone').value})});$('#code').textContent=d.formatted||d.code||'—';$('#codeBox').classList.add('show');toast('Code de connexion généré')}catch(e){toast(e.message,true)}finally{$('#pair').disabled=false}}
$('#copy').onclick=async function(){try{await navigator.clipboard.writeText($('#code').textContent.replace(/-/g,''));toast('Code copié')}catch{toast('Copie impossible',true)}}
$('#resolve').onclick=async function(){try{await api('/api/resolve-channel',{method:'POST'});toast('Chaîne Nextech résolue');refresh()}catch(e){toast(e.message,true)}}
$('#resolveOtaku').onclick=async function(){try{await api('/api/resolve-otaku-channel',{method:'POST'});toast('Chaîne Otaku résolue');refresh()}catch(e){toast(e.message,true)}}
$('#reset').onclick=async function(){if(!confirm('Réinitialiser la session WhatsApp ?'))return;try{await api('/api/reset',{method:'POST'});toast('Session réinitialisée');setTimeout(refresh,1200)}catch(e){toast(e.message,true)}}
async function retryFailed(){try{const d=await api('/api/retry-failed',{method:'POST'});toast((d.retried||0)+' job(s) relancé(s)');refresh()}catch(e){toast(e.message,true)}}
$('#retryFailed').onclick=retryFailed;$('#homeRetry').onclick=retryFailed;$('#refreshHome').onclick=refresh;
$('#manualForm').onsubmit=async function(e){e.preventDefault();const url=$('#manualButtonUrl').value.trim(),label=$('#manualButtonText').value.trim();const payload={source:$('#manualSource').value,text:$('#manualText').value.trim(),buttonText:label,buttonUrl:url};try{const d=await api('/api/manual-publish',{method:'POST',body:JSON.stringify(payload)});toast(d.duplicate?'Publication déjà connue':'Publication mise en file');$('#manualText').value='';$('#manualButtonText').value='';$('#manualButtonUrl').value='';refresh()}catch(e){toast(e.message,true)}}
refresh();setInterval(refresh,7000);
</script></body></html>`;

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/healthz') return json(res,200,{ok:true,...publisherReadiness()});
    if(req.method==='GET'&&url.pathname==='/readyz'){
      const r=publisherReadiness();
      return json(res,r.ready?200:503,{ok:r.ready,...r});
    }
    if(req.method==='GET'&&url.pathname==='/newsletterz'){
      const nextech=await newsletterSnapshot(state.channelJid||PRESENTATION_NEWSLETTER_JID);
      const otaku=await newsletterSnapshot(state.otakuChannelJid||await resolveOtakuChannel());
      return json(res,200,{ok:true,nextech,otaku});
    }
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/app')) { res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}); const ui=new URL('./nexai-ui.html',import.meta.url); return res.end(fs.existsSync(ui)?fs.readFileSync(ui,'utf8'):html); }
    if(req.method==='POST'&&url.pathname==='/api/login'){
      const q=await body(req); if(!DASHBOARD_PASSWORD||!safeEq(q.password,DASHBOARD_PASSWORD)) return json(res,401,{error:'Mot de passe incorrect'});
      return json(res,200,{ok:true},{'set-cookie':`nwp_owner=${sessionToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`});
    }
    if(req.method==='POST'&&url.pathname==='/api/nexcanal/publish'){
      const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); if(!WEBHOOK_TOKEN||!safeEq(token,WEBHOOK_TOKEN)) return json(res,401,{error:'unauthorized'});
      const q=await body(req); const out=plan(q); return json(res,202,{ok:true,duplicate:out.duplicate,route:out.route});
    }
    if(!authed(req)) return json(res,401,{error:'unauthorized'});
    if(req.method==='GET'&&url.pathname==='/api/status'){
      const history=readJson('history.json',[]).slice(0,120);
      const queue=readJson('queue.json',[]).slice().reverse().slice(0,120);
      const stats={
        pending:queue.filter(x=>x.status==='pending').length,
        done:queue.filter(x=>x.status==='done').length,
        failed:queue.filter(x=>x.status==='failed').length,
        published:history.filter(x=>x.type==='published').length,
      };
      return json(res,200,{whatsapp:{status:state.status,connectedAt:state.connectedAt,channelJid:state.channelJid,channelTitle:state.channelTitle,otakuChannelJid:state.otakuChannelJid,otakuChannelTitle:state.otakuChannelTitle,lastError:state.lastError,lastPublishAt:state.lastPublishAt,presentationNewsletterJid:PRESENTATION_NEWSLETTER_JID},stats,history,queue});
    }
    if(req.method==='POST'&&url.pathname==='/api/manual-publish'){
      const q=await body(req);
      const source=sourceName(q.source);
      const text=String(q.text||'').trim();
      if(!text) return json(res,400,{error:'Texte requis'});
      const buttonUrl=String(q.buttonUrl||'').trim();
      const buttons=buttonUrl?[{text:String(q.buttonText||'Ouvrir').trim()||'Ouvrir',url:buttonUrl}]:[];
      const out=plan({id:'manual:'+Date.now()+':'+crypto.randomUUID(),source,text,buttons,createdAt:new Date().toISOString()});
      return json(res,202,{ok:true,duplicate:out.duplicate,route:out.route});
    }
    if(req.method==='POST'&&url.pathname==='/api/retry-failed'){
      const queue=readJson('queue.json',[]);
      let retried=0;
      for(const job of queue){
        if(job.status==='failed'){
          job.status='pending';job.attempts=0;job.nextAttemptAt=Date.now();delete job.lastError;delete job.completedAt;retried++;
        }
      }
      writeJson('queue.json',queue);
      if(retried) processQueue().catch(()=>{});
      addHistory({type:'retry',destination:'queue',textPreview:retried+' job(s) relancé(s)'});
      return json(res,200,{ok:true,retried});
    }
    if(req.method==='POST'&&url.pathname==='/api/pair'){ const q=await body(req); return json(res,200,{ok:true,...await requestPairingCode(q.phone)}); }
    if(req.method==='POST'&&url.pathname==='/api/resolve-channel'){ const jid=await resolveChannel(); return json(res,200,{ok:true,jid,title:state.channelTitle}); }
    if(req.method==='POST'&&url.pathname==='/api/resolve-otaku-channel'){ const jid=await resolveOtakuChannel(); return json(res,200,{ok:true,jid,title:state.otakuChannelTitle}); }
    if(req.method==='POST'&&url.pathname==='/api/reset'){
      await resetAuthForPairing(); state.channelJid=null;state.channelTitle=null;state.otakuChannelJid=null;state.otakuChannelTitle=null;state.stickGoodChannelJid=null;state.stickGoodChannelTitle=null;fs.rmSync(f('channel.json'),{force:true});fs.rmSync(f('otaku-channel.json'),{force:true});fs.rmSync(f('stick-good-channel.json'),{force:true}); await connectWhatsApp(); return json(res,200,{ok:true});
    }
    return json(res,404,{error:'not_found'});
  }catch(e){ logger.error({err:e},'request failed'); return json(res,500,{error:String(e?.message||e)}); }
});

const bridgeServer=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/healthz') return json(res,200,{ok:true,...publisherReadiness()});
    if(req.method==='GET'&&url.pathname==='/readyz'){
      const r=publisherReadiness();
      return json(res,r.ready?200:503,{ok:r.ready,...r});
    }
    if(req.method==='POST'&&url.pathname==='/publish'){
      const q=await body(req);
      const out=plan(q);
      return json(res,202,{ok:true,duplicate:out.duplicate,route:out.route});
    }
    if(req.method==='POST'&&url.pathname==='/otaku/action'){
      const q=await body(req);
      const out=await runOtakuAction(q);
      return json(res,200,out);
    }
    if(req.method==='GET'&&url.pathname==='/otaku/status'){
      return json(res,200,{ok:true,polls:otakuPollRecords.size,lastSendAt:otakuLastSendAt,minGapMs:OTAKU_MIN_GAP_MS});
    }
    if(req.method==='POST'&&url.pathname==='/stick-good/action'){
      const q=await body(req);
      const out=await runStickGoodAction(q);
      return json(res,200,out);
    }
    if(req.method==='GET'&&url.pathname==='/stick-good/status'){
      let jid=state.stickGoodChannelJid;
      if(!jid&&state.status==='connected')try{jid=await resolveStickGoodChannel()}catch{}
      return json(res,200,{ok:true,connected:state.status==='connected',channelResolved:Boolean(jid),lastSendAt:stickGoodLastSendAt,minGapMs:STICK_GOOD_MIN_GAP_MS});
    }
    if(req.method==='POST'&&url.pathname==='/kickz'){
      const wasProcessing=processing;
      processQueue().catch(error=>logger.error({err:error},'manual queue kick failed'));
      return json(res,202,{ok:true,wasProcessing,status:state.status});
    }
    return json(res,404,{error:'not_found'});
  }catch(e){ logger.error({err:e},'bridge request failed'); return json(res,500,{error:String(e?.message||e)}); }
});
bridgeServer.listen(BRIDGE_PORT,'127.0.0.1',()=>logger.info({port:BRIDGE_PORT},'Nex WhatsApp Publisher bridge ready'));

server.listen(PORT,HOST,async()=>{ logger.info({host:HOST,port:PORT},'Nex WhatsApp Publisher ready'); try{await connectWhatsApp();}catch(e){state.lastError=String(e?.message||e);logger.error({err:e},'WhatsApp startup failed');} });
