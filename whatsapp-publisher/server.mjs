import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { attachWhatsAppCommandEngine } from './command-engine.mjs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateWAMessageFromContent,
  proto,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';

const PORT = Number(process.env.WA_PUBLISHER_PORT || 8787);
const BRIDGE_PORT = Number(process.env.WA_PUBLISHER_BRIDGE_PORT || 18787);
const HOST = process.env.WA_PUBLISHER_HOST || '127.0.0.1';
const DATA_DIR = process.env.WA_PUBLISHER_DATA_DIR || '/var/lib/nex/data/internal/whatsapp-publisher';
const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const GROUP_JID = process.env.WHATSAPP_GROUP_JID || '120363426961054070@g.us';
const CHANNEL_INVITE_URL = process.env.WHATSAPP_CHANNEL_INVITE_URL || 'https://whatsapp.com/channel/0029VbCKhnq7j6gEhuUKMP1V';
const OTAKU_CHANNEL_INVITE_URL = process.env.OTAKU_WHATSAPP_CHANNEL_INVITE_URL || 'https://whatsapp.com/channel/0029VbCKhnq7j6gEhuUKMP1V';
const PRESENTATION_NEWSLETTER_JID = process.env.PRESENTATION_NEWSLETTER_JID || '120363411005383995@newsletter';
const WEBHOOK_TOKEN = process.env.NEX_WHATSAPP_PUBLISHER_TOKEN || process.env.NEXCANAL__WEBHOOK_SECRET || '';
const DASHBOARD_PASSWORD = process.env.NEX_WHATSAPP_DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.NEX_WHATSAPP_SESSION_SECRET || '';
const TELEGRAM_BOT_TOKEN = process.env.NEXCANAL__BOT_TOKEN || '';
const SOURCES = new Set(['thenexusorigin', 'thenexnews', 'tresor_universe']);
const BLOCKED_DOC_EXT = new Set(['apk','xapk','apks','zip','rar','7z','exe','dmg','deb','rpm']);
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
  lastPublishAt: null,
};
let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let processing = false;
let lastPairRequestAt = 0;
let pairingResetInProgress = false;
let commandEngine = null;
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
function ext(name=''){ return path.extname(String(name).split('?')[0].toLowerCase()).replace('.',''); }
function documentBlocked(item){ const type=String(item?.type||'').toLowerCase(); const e=ext(item?.fileName||''); return type==='document'||type==='file'||BLOCKED_DOC_EXT.has(e); }

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
    const localPath=rawLocal&&path.resolve(rawLocal).startsWith('/var/lib/nex/tmp/internal-automation/')?path.resolve(rawLocal):'';
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
  const channelBlocked=pub.media.some(documentBlocked);
  const lifestyle=pub.source==='tresor_universe';
  return {
    // Lifestyle/Otaku/Luxury social posts mirror to the Otaku Nexus
    // newsletter only. Nextech/NexNews preserve their existing group relay.
    group:lifestyle?false:Boolean(GROUP_JID),
    channel:!channelBlocked,
    channelBlocked,
    reason:channelBlocked
      ?'fichier/document réservé au groupe'
      :lifestyle
        ?'publication lifestyle -> chaîne Otaku Nexus'
        :'compatible chaîne + groupe',
  };
}

function addHistory(entry){ const h=readJson('history.json',[]); h.unshift({at:new Date().toISOString(),...entry}); if(h.length>500)h.length=500; writeJson('history.json',h); }
function sameSourceMessage(a,b){
  const as=sourceName(a?.source||''),bs=sourceName(b?.source||'');
  const ai=a?.sourceMessageId,bi=b?.sourceMessageId;
  return Boolean(as&&bs&&as===bs&&ai!=null&&bi!=null&&String(ai)===String(bi));
}
function enqueue(destination,jid,pub){
  const q=readJson('queue.json',[]);
  const existing=q.find(x=>
    String(x?.destination||'')===String(destination) &&
    ['pending','done'].includes(String(x?.status||'')) &&
    (String(x?.pub?.id||'')===String(pub?.id||'')||sameSourceMessage(x?.pub,pub))
  );
  if(existing)return {...existing,deduplicated:true};
  const item={id:crypto.randomUUID(),destination,jid,pub,status:'pending',attempts:0,nextAttemptAt:Date.now(),createdAt:new Date().toISOString()};
  q.push(item);
  writeJson('queue.json',q);
  return item;
}
function dedupeSeen(pub){
  const q=readJson('queue.json',[]);
  if(q.some(x=>['pending','done'].includes(String(x?.status||''))&&(String(x?.pub?.id||'')===String(pub?.id||'')||sameSourceMessage(x?.pub,pub))))return true;
  const h=readJson('history.json',[]);
  return h.some(x=>x.type==='planned'&&(x.publicationId===pub.id||sameSourceMessage(x,pub)));
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
    retryRequestDelayMs:2000
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
      await socket.sendMessage(
        jid,
        {text:channelText||'Publication Nextech'}
      );
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
        if(job.destination==='channel'&&(!job.jid||job.jid==='__CHANNEL__'||job.jid==='__OTAKU_CHANNEL__')){
          const lifestyle=job.pub?.source==='tresor_universe'||job.jid==='__OTAKU_CHANNEL__';
          const resolved=lifestyle?await resolveOtakuChannel():await resolveChannel();
          if(!resolved) throw new Error(lifestyle?'Chaîne WhatsApp Otaku non résolue':'Chaîne WhatsApp non résolue');
          job.jid=resolved;
        }
        await sendPublication(job.jid,job.destination,job.pub);
        job.status='done'; job.completedAt=new Date().toISOString(); state.lastPublishAt=job.completedAt;
        addHistory({type:'published',publicationId:job.pub.id,source:job.pub.source,destination:job.destination,attempts:job.attempts});
      }catch(e){
        job.lastError=String(e?.message||e);
        const delay=Math.min(300000,5000*(2**Math.min(6,job.attempts-1)));
        job.nextAttemptAt=Date.now()+delay;
        if(job.attempts>=50){ job.status='failed'; addHistory({type:'failed',publicationId:job.pub.id,destination:job.destination,error:job.lastError}); }
      }
      writeJson('queue.json',q);
    }
  }finally{processing=false;}
}
setInterval(()=>processQueue().catch(()=>{}),3000).unref();

function plan(raw){
  const pub=normalizePublication(raw);
  if(!SOURCES.has(pub.source)) throw new Error(`source non autorisée: ${pub.source||'vide'}`);
  const bareApk=!pub.media.length&&/\.(?:apk|xapk|apks|apkm)(?:\s|$)/i.test(pub.text.trim());
  if(bareApk) throw new Error('APK sans fichier média: publication refusée pour éviter un nom de fichier vide');
  if(dedupeSeen(pub)) return {duplicate:true,pub,route:routePublication(pub)};
  const route=routePublication(pub);
  if(route.group) enqueue('group',GROUP_JID,pub);
  if(route.channel){
    const lifestyle=pub.source==='tresor_universe';
    enqueue('channel',lifestyle?(state.otakuChannelJid||'__OTAKU_CHANNEL__'):(state.channelJid||'__CHANNEL__'),pub);
  }
  addHistory({type:'planned',publicationId:pub.id,source:pub.source,sourceMessageId:pub.sourceMessageId,route,textPreview:pub.text.slice(0,180)});
  processQueue().catch(()=>{});
  return {duplicate:false,pub,route};
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
    if(req.method==='GET'&&url.pathname==='/healthz') return json(res,200,{ok:true,status:state.status,channelJid:state.channelJid});
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
      await resetAuthForPairing(); state.channelJid=null;state.channelTitle=null;state.otakuChannelJid=null;state.otakuChannelTitle=null;fs.rmSync(f('channel.json'),{force:true});fs.rmSync(f('otaku-channel.json'),{force:true}); await connectWhatsApp(); return json(res,200,{ok:true});
    }
    return json(res,404,{error:'not_found'});
  }catch(e){ logger.error({err:e},'request failed'); return json(res,500,{error:String(e?.message||e)}); }
});

const bridgeServer=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/healthz') return json(res,200,{ok:true});
    if(req.method==='POST'&&url.pathname==='/publish'){
      const q=await body(req);
      const out=plan(q);
      return json(res,202,{ok:true,duplicate:out.duplicate,route:out.route});
    }
    return json(res,404,{error:'not_found'});
  }catch(e){ logger.error({err:e},'bridge request failed'); return json(res,500,{error:String(e?.message||e)}); }
});
bridgeServer.listen(BRIDGE_PORT,'127.0.0.1',()=>logger.info({port:BRIDGE_PORT},'Nex WhatsApp Publisher bridge ready'));

server.listen(PORT,HOST,async()=>{ logger.info({host:HOST,port:PORT},'Nex WhatsApp Publisher ready'); try{await connectWhatsApp();}catch(e){state.lastError=String(e?.message||e);logger.error({err:e},'WhatsApp startup failed');} });
