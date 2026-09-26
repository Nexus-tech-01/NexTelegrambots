import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, delay, fetchLatestWaWebVersion, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

const PORT = Number(process.env.PORT || 8790);
const DATA = process.env.DATA_DIR || '/var/lib/nex/whatsapp-publisher';
const AUTH = path.join(DATA, 'wa-auth');
const CFG = path.join(DATA, 'config.json');
const HISTORY = path.join(DATA, 'history.json');
const QUEUE = path.join(DATA, 'queue.json');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || '';
const WEBHOOK_TOKEN = process.env.NEXCANAL_WEBHOOK_TOKEN || '';
const DEFAULT_GROUP = process.env.WHATSAPP_GROUP_JID || '120363426961054070@g.us';
const DEFAULT_INVITE = process.env.WHATSAPP_CHANNEL_INVITE_URL || 'https://whatsapp.com/channel/0029VbCKhnq7j6gEhuUKMP1V';
const BLOCKED_EXT = new Set((process.env.CHANNEL_BLOCKED_EXTENSIONS || 'apk,zip,rar,7z,exe,dmg,deb,rpm,xapk,apks').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const SOURCE_NAMES = new Set(['thenexusorigin','thenexnews']);

fs.mkdirSync(AUTH, { recursive:true });
const readJson=(f,fb)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return fb}};
const writeJson=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2));
const cfg=()=>({ whatsappGroupJid:DEFAULT_GROUP, whatsappChannelJid:'', whatsappChannelInviteUrl:DEFAULT_INVITE, ...readJson(CFG,{}) });
const saveCfg=(patch)=>{ const n={...readJson(CFG,{}),...patch}; writeJson(CFG,n); return cfg(); };
const hist=(e)=>{const a=readJson(HISTORY,[]);a.unshift({id:crypto.randomUUID(),at:new Date().toISOString(),...e});a.length=Math.min(a.length,500);writeJson(HISTORY,a)};
const safeEq=(a,b)=>{const A=Buffer.from(String(a||'')),B=Buffer.from(String(b||''));return A.length===B.length&&crypto.timingSafeEqual(A,B)};
const sess=()=>crypto.createHmac('sha256',DASHBOARD_SECRET||'unsafe').update('owner').digest('hex');
const cookies=(req)=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));
const authorized=(req)=>safeEq(cookies(req).nex_owner,sess());
const body=async req=>{let s='';for await(const c of req){s+=c;if(s.length>5_000_000)throw Error('payload_too_large')}return s?JSON.parse(s):{}};
const json=(res,code,obj)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj))};

let sock=null;
let wa={status:'disconnected',me:null,lastError:null,connectedAt:null};
let reconnectTimer=null;
let pairLock=0;

function inviteCode(v=''){const m=String(v).trim().match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);return m?m[1]:String(v).trim()}
async function resolveChannel(invite=cfg().whatsappChannelInviteUrl){
  if(!sock||wa.status!=='connected')throw Error('WhatsApp non connecté');
  const meta=await sock.newsletterMetadata('invite',inviteCode(invite));
  const jid=meta?.id||meta?.jid;
  if(!jid||!String(jid).endsWith('@newsletter'))throw Error('JID newsletter introuvable');
  saveCfg({whatsappChannelJid:String(jid),whatsappChannelInviteUrl:invite});
  return {jid:String(jid),name:meta?.name||meta?.subject||''};
}

let waVersionCache=null;
let waVersionFetchedAt=0;
const WA_VERSION_TTL_MS=6*60*60*1000;
let socketGeneration=0;
let pairingReadyPromise=null;

async function currentWaVersion(strict=false){
  const now=Date.now();
  if(waVersionCache&&now-waVersionFetchedAt<WA_VERSION_TTL_MS)return waVersionCache;
  try{
    const latest=await fetchLatestWaWebVersion({});
    if(!Array.isArray(latest?.version)||latest.version.length!==3)throw Error(latest?.error?.message||'version WhatsApp Web invalide');
    waVersionCache=latest.version;
    waVersionFetchedAt=now;
    hist({type:'wa_web_version',version:waVersionCache.join('.'),source:'web.whatsapp.com'});
    return waVersionCache;
  }catch(e){
    if(strict)throw Error('Impossible de récupérer la version WhatsApp Web actuelle : '+String(e.message||e));
    const fallback=await fetchLatestBaileysVersion();
    waVersionCache=fallback.version;
    waVersionFetchedAt=now;
    hist({type:'wa_web_version_fallback',version:waVersionCache.join('.'),error:String(e.message||e)});
    return waVersionCache;
  }
}

async function connect({pairing=false}={}){
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}
  const {state,saveCreds}=await useMultiFileAuthState(AUTH);

  // Une session vierge ne doit pas rester ouverte depuis le démarrage du
  // service : le handshake d'appairage expire avant que l'utilisateur ne
  // demande son code. On crée le socket de pairing uniquement à la demande.
  if(!state.creds.registered&&!pairing){
    try{sock?.ws?.close?.()}catch{}
    sock=null;
    wa={status:'needs_pairing',me:null,lastError:null,connectedAt:null};
    return null;
  }

  const generation=++socketGeneration;
  try{sock?.ws?.close?.()}catch{}
  sock=null;

  const version=await currentWaVersion(pairing);
  wa.status=pairing?'pairing':'connecting';
  wa.lastError=null;

  let readyResolve,readyReject;
  pairingReadyPromise=pairing?new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject}):null;
  let readyTimer=null;
  if(pairing){
    readyTimer=setTimeout(()=>readyReject?.(Error('WhatsApp n’a pas ouvert la fenêtre d’appairage à temps')),15000);
    readyTimer.unref?.();
  }

  const localSock=makeWASocket({
    version,
    auth:state,
    logger:pino({level:process.env.BAILEYS_LOG_LEVEL||'silent'}),
    // Pour requestPairingCode, garder une identité navigateur canonique.
    // Un libellé personnalisé peut produire un code de 8 caractères que
    // WhatsApp refuse ensuite avec "Couldn't link device".
    browser:Browsers.ubuntu('Chrome'),
    printQRInTerminal:false,
    markOnlineOnConnect:false,
    syncFullHistory:false,
    generateHighQualityLinkPreview:true,
    connectTimeoutMs:60000,
    keepAliveIntervalMs:30000
  });
  sock=localSock;

  localSock.ev.on('creds.update',saveCreds);
  localSock.ev.on('connection.update',async u=>{
    if(generation!==socketGeneration)return;

    if(pairing&&u.qr){
      if(readyTimer){clearTimeout(readyTimer);readyTimer=null}
      readyResolve?.(true);
    }

    if(u.connection==='open'){
      if(readyTimer){clearTimeout(readyTimer);readyTimer=null}
      readyResolve?.(true);
      wa={status:'connected',me:localSock.user||null,lastError:null,connectedAt:new Date().toISOString()};
      hist({type:'whatsapp_connected',me:localSock.user?.id||null});
      if(!cfg().whatsappChannelJid){
        try{await resolveChannel()}catch(e){hist({type:'channel_resolve_failed',error:String(e.message||e)})}
      }
    }

    if(u.connection==='close'){
      const code=new Boom(u.lastDisconnect?.error)?.output?.statusCode;
      const err=String(u.lastDisconnect?.error?.message||u.lastDisconnect?.error||code||'closed');

      if(readyTimer){clearTimeout(readyTimer);readyTimer=null}
      if(pairing&&code!==DisconnectReason.restartRequired)readyReject?.(Error(err));

      wa.status='disconnected';
      wa.me=null;
      wa.lastError=err;
      hist({type:'whatsapp_disconnected',code,error:err});

      if(code!==DisconnectReason.loggedOut){
        const wait=code===DisconnectReason.restartRequired?750:5000;
        reconnectTimer=setTimeout(()=>connect().catch(e=>{
          wa.lastError=String(e.message||e);
          hist({type:'whatsapp_reconnect_failed',error:wa.lastError});
        }),wait);
        reconnectTimer.unref?.();
      }
    }
  });

  return localSock;
}

async function requestPair(phone){
  const clean=String(phone||'').replace(/\D/g,'');
  if(clean.length<7||clean.length>15)throw Error('Numéro WhatsApp invalide');
  if(wa.status==='connected')throw Error('Un compte est déjà connecté. Réinitialise la session pour changer de compte.');
  if(Date.now()-pairLock<10000)throw Error('Attends quelques secondes avant de demander un autre code.');
  pairLock=Date.now();

  const {state}=await useMultiFileAuthState(AUTH);
  if(state.creds.registered){
    await connect();
    throw Error('Une session WhatsApp existe déjà. Si elle ne se reconnecte pas, utilise « Réinitialiser la session WhatsApp » puis génère un nouveau code.');
  }

  const pairSock=await connect({pairing:true});
  if(!pairSock)throw Error('Socket d’appairage indisponible');

  try{
    // Attendre le QR interne signifie que le handshake de registration est
    // réellement prêt. Cela évite les codes générés trop tôt puis refusés.
    await pairingReadyPromise;
  }catch(e){
    try{pairSock?.ws?.close?.()}catch{}
    throw e;
  }

  if(pairSock!==sock||wa.status==='disconnected')throw Error('La connexion WhatsApp a été interrompue avant la génération du code.');

  const raw=await pairSock.requestPairingCode(clean);
  const code=String(raw||'').replace(/\s+/g,'');
  if(!code)throw Error('WhatsApp n’a retourné aucun code');

  hist({
    type:'pairing_code_requested',
    phone:'+'+clean.slice(0,3)+'***'+clean.slice(-2),
    version:Array.isArray(waVersionCache)?waVersionCache.join('.'):null,
    browser:'Ubuntu/Chrome'
  });
  return {phone:'+'+clean,code,formatted:code.match(/.{1,4}/g)?.join('-')||code};
}
async function resetSession(){
  try{sock?.ws?.close?.()}catch{}
  fs.rmSync(AUTH,{recursive:true,force:true});
  fs.mkdirSync(AUTH,{recursive:true});
  sock=null;
  wa={status:'disconnected',me:null,lastError:null,connectedAt:null};
  await connect();
}

function ext(pub){
  const n=pub.media?.fileName||pub.media?.url||'';
  const m=String(n).toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/);
  return m?.[1]||'';
}
function normalize(input={}){
  const buttons=(Array.isArray(input.buttons)?input.buttons:[])
    .map(b=>({text:String(b?.text||b?.label||'Ouvrir').trim(),url:String(b?.url||'').trim()}))
    .filter(b=>/^https?:\/\//i.test(b.url)).slice(0,10);
  const m=input.media&&input.media.url?{
    type:String(input.media.type||'document').toLowerCase(),
    url:String(input.media.url),
    fileName:String(input.media.fileName||input.media.filename||''),
    mimetype:String(input.media.mimetype||'')
  }:null;
  const source=String(input.source||'manual');
  const sourceMessageId=input.sourceMessageId||null;
  const deterministicId=sourceMessageId!=null
    ? crypto.createHash('sha256').update(source+':'+String(sourceMessageId)).digest('hex').slice(0,32)
    : crypto.randomUUID();
  return {
    id:input.id||deterministicId,
    source,
    sourceMessageId,
    text:String(input.text||input.caption||'').trim(),
    media:m,
    buttons,
    createdAt:input.createdAt||new Date().toISOString()
  };
}
function route(pub){
  const c=cfg(),x=ext(pub);
  const document=pub.media&&['document','file'].includes(pub.media.type);
  const blocked=BLOCKED_EXT.has(x);
  const channelBlocked=blocked||document;
  return {
    extension:x,channelBlocked,
    reason:channelBlocked?(blocked?'.'+x+' réservé au groupe':'fichier réservé au groupe'):'compatible chaîne + groupe',
    destinations:{group:Boolean(c.whatsappGroupJid),channel:Boolean(c.whatsappChannelJid)&&!channelBlocked}
  };
}
function textWithLinks(pub){
  const links=pub.buttons.map(b=>'• '+b.text+': '+b.url).join('\n');
  return [pub.text,links].filter(Boolean).join('\n\n');
}
async function send(jid,pub){
  if(!sock||wa.status!=='connected')throw Error('WhatsApp non connecté');
  const text=textWithLinks(pub);
  if(!pub.media)return sock.sendMessage(jid,{text});
  const source={url:pub.media.url},t=pub.media.type;
  if(t==='image'||t==='photo')return sock.sendMessage(jid,{image:source,caption:text});
  if(t==='video')return sock.sendMessage(jid,{video:source,caption:text});
  if(t==='audio')return sock.sendMessage(jid,{audio:source,mimetype:pub.media.mimetype||'audio/mpeg'});
  return sock.sendMessage(jid,{
    document:source,
    mimetype:pub.media.mimetype||'application/octet-stream',
    fileName:pub.media.fileName||'fichier',
    caption:text
  });
}

let queueRunning=false;
function enqueue(publication,destination,jid){
  const q=readJson(QUEUE,[]);
  const existing=q.find(x=>
    String(x?.publication?.id||'')===String(publication?.id||'') &&
    String(x?.destination||'')===String(destination||'') &&
    ['pending','done'].includes(String(x?.status||''))
  );
  if(existing)return {...existing,deduplicated:true};
  const item={
    id:crypto.randomUUID(),
    status:'pending',
    attempts:0,
    nextAttemptAt:Date.now(),
    createdAt:new Date().toISOString(),
    publication,destination,jid
  };
  q.push(item);writeJson(QUEUE,q);processQueue();return item;
}
async function processQueue(){
  if(queueRunning)return;
  queueRunning=true;
  try{
    const q=readJson(QUEUE,[]);
    for(const item of q){
      if(item.status!=='pending'||item.nextAttemptAt>Date.now())continue;
      try{
        item.attempts++;
        await send(item.jid,item.publication);
        item.status='done';
        item.completedAt=new Date().toISOString();
        hist({type:'published',source:item.publication.source,destination:item.destination,publicationId:item.publication.id});
      }catch(e){
        item.lastError=String(e.message||e);
        if(item.attempts>=5){
          item.status='failed';
          item.failedAt=new Date().toISOString();
          hist({type:'publish_failed',destination:item.destination,error:item.lastError});
        }else{
          item.nextAttemptAt=Date.now()+5000*(2**(item.attempts-1));
        }
      }
      writeJson(QUEUE,q);
    }
  }finally{queueRunning=false}
}
setInterval(()=>processQueue().catch(()=>{}),5000).unref();

function plan(input){
  const pub=normalize(input),r=route(pub),c=cfg(),jobs=[];
  if(r.destinations.group)jobs.push(enqueue(pub,'group',c.whatsappGroupJid));
  if(r.destinations.channel)jobs.push(enqueue(pub,'channel',c.whatsappChannelJid));
  hist({type:'publication_planned',source:pub.source,publicationId:pub.id,route:r,textPreview:pub.text.slice(0,160)});
  return {publication:pub,route,jobs:jobs.map(x=>({id:x.id,destination:x.destination}))};
}

const page=fs.readFileSync(new URL('./public/index.html',import.meta.url),'utf8');
const loginHits=new Map();
function loginAllowed(ip){
  const now=Date.now(),a=(loginHits.get(ip)||[]).filter(t=>now-t<60000);
  if(a.length>=10)return false;
  a.push(now);loginHits.set(ip,a);return true;
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&u.pathname==='/healthz')return json(res,200,{ok:true,whatsapp:wa.status});
    if(req.method==='GET'&&u.pathname==='/'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      return res.end(page);
    }
    if(req.method==='POST'&&u.pathname==='/api/login'){
      const ip=req.socket.remoteAddress||'';
      if(!loginAllowed(ip))return json(res,429,{error:'Trop de tentatives'});
      const b=await body(req);
      if(!DASHBOARD_PASSWORD||!safeEq(b.password,DASHBOARD_PASSWORD))return json(res,401,{error:'Mot de passe incorrect'});
      res.setHeader('set-cookie','nex_owner='+encodeURIComponent(sess())+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800');
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&u.pathname==='/api/logout'){
      res.setHeader('set-cookie','nex_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&u.pathname==='/api/nexcanal/publish'){
      const got=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
      if(!WEBHOOK_TOKEN||!safeEq(got,WEBHOOK_TOKEN))return json(res,401,{error:'token invalide'});
      const b=await body(req),src=String(b.source||'').replace(/^@/,'').toLowerCase();
      if(!SOURCE_NAMES.has(src))return json(res,400,{error:'source non autorisée'});
      return json(res,202,{ok:true,...plan({...b,source:'nexcanal:@'+src})});
    }
    if(!authorized(req))return json(res,401,{error:'unauthorized'});
    if(req.method==='GET'&&u.pathname==='/api/status'){
      return json(res,200,{whatsapp:wa,config:cfg(),queue:readJson(QUEUE,[]).slice(-50),history:readJson(HISTORY,[]).slice(0,100)});
    }
    if(req.method==='POST'&&u.pathname==='/api/wa/pair-code'){
      return json(res,200,{ok:true,...await requestPair((await body(req)).phone)});
    }
    if(req.method==='POST'&&u.pathname==='/api/wa/reset'){
      await resetSession();return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&u.pathname==='/api/wa/resolve-channel'){
      const b=await body(req);
      return json(res,200,{ok:true,...await resolveChannel(b.invite||cfg().whatsappChannelInviteUrl),config:cfg()});
    }
    if(req.method==='POST'&&u.pathname==='/api/config'){
      const b=await body(req);
      return json(res,200,{ok:true,config:saveCfg({
        whatsappGroupJid:String(b.whatsappGroupJid||DEFAULT_GROUP),
        whatsappChannelJid:String(b.whatsappChannelJid||''),
        whatsappChannelInviteUrl:String(b.whatsappChannelInviteUrl||DEFAULT_INVITE)
      })});
    }
    if(req.method==='POST'&&u.pathname==='/api/publish'){
      return json(res,200,{ok:true,...plan({...await body(req),source:'dashboard'})});
    }
    if(req.method==='GET'&&u.pathname==='/api/history')return json(res,200,{items:readJson(HISTORY,[]).slice(0,150)});
    if(req.method==='GET'&&u.pathname==='/api/queue')return json(res,200,{items:readJson(QUEUE,[])});
    return json(res,404,{error:'not_found'});
  }catch(e){
    console.error(e);
    return json(res,400,{error:String(e.message||e)});
  }
});

server.listen(PORT,'127.0.0.1',()=>console.log('[nex-whatsapp-publisher] 127.0.0.1:'+PORT));
connect().catch(e=>{wa.lastError=String(e.message||e);console.error(e)});
