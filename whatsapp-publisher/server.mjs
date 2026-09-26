import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import { Boom } from '@hapi/boom';
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
const PRESENTATION_NEWSLETTER_JID = process.env.PRESENTATION_NEWSLETTER_JID || '120363411005383995@newsletter';
const WEBHOOK_TOKEN = process.env.NEX_WHATSAPP_PUBLISHER_TOKEN || process.env.NEXCANAL__WEBHOOK_SECRET || '';
const DASHBOARD_PASSWORD = process.env.NEX_WHATSAPP_DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.NEX_WHATSAPP_SESSION_SECRET || '';
const TELEGRAM_BOT_TOKEN = process.env.NEXCANAL__BOT_TOKEN || '';
const SOURCES = new Set(['thenexusorigin', 'thenexnews']);
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
  lastPublishAt: null,
};
let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let processing = false;
let lastPairRequestAt = 0;
let pairingResetInProgress = false;

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

function normalizeMedia(input){
  const arr = Array.isArray(input) ? input : (input ? [input] : []);
  return arr.map((m,i)=>({
    type:String(m?.type||m?.media_type||'document').toLowerCase(),
    fileId:String(m?.fileId||m?.telegram_file_id||m?.telegramFileId||''),
    url:String(m?.url||''),
    fileName:String(m?.fileName||m?.original_name||m?.filename||`media-${i+1}`),
    mimetype:String(m?.mimetype||m?.mime_type||''),
    position:Number(m?.position??i),
  })).filter(m=>m.fileId||m.url).sort((a,b)=>a.position-b.position);
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
  return {
    group:Boolean(GROUP_JID),
    channel:!channelBlocked,
    channelBlocked,
    reason:channelBlocked?'fichier/document réservé au groupe':'compatible chaîne + groupe',
  };
}

function addHistory(entry){ const h=readJson('history.json',[]); h.unshift({at:new Date().toISOString(),...entry}); if(h.length>500)h.length=500; writeJson('history.json',h); }
function enqueue(destination,jid,pub){ const q=readJson('queue.json',[]); q.push({id:crypto.randomUUID(),destination,jid,pub,status:'pending',attempts:0,nextAttemptAt:Date.now(),createdAt:new Date().toISOString()}); writeJson('queue.json',q); }
function dedupeSeen(pub){ const h=readJson('history.json',[]); return h.some(x=>x.type==='planned'&&x.publicationId===pub.id); }

async function resolveChannel(){
  if(!socket||state.status!=='connected') return null;
  const persisted=readJson('channel.json',{});
  if(persisted?.jid?.endsWith('@newsletter')){ state.channelJid=persisted.jid; state.channelTitle=persisted.title||null; return persisted.jid; }
  const code=inviteCode(CHANNEL_INVITE_URL); if(!code) return null;
  const meta=await socket.newsletterMetadata('invite',code);
  const jid=String(meta?.id||meta?.jid||'');
  if(!jid.endsWith('@newsletter')) throw new Error('JID newsletter introuvable');
  state.channelJid=jid; state.channelTitle=meta?.name||meta?.subject||null;
  writeJson('channel.json',{jid,title:state.channelTitle,invite:CHANNEL_INVITE_URL,resolvedAt:new Date().toISOString()});
  return jid;
}

async function connectWhatsApp({freshPairing=false}={}){
  const generation=++socketGeneration;
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
    generateHighQualityLinkPreview:true,
    keepAliveIntervalMs:30000,
    retryRequestDelayMs:2000
  });
  socket=sock;

  sock.ev.on('creds.update',saveCreds);
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

async function nativeButtons(jid,text,buttons){
  if(!buttons.length) return false;
  try{
    const content=proto.Message.InteractiveMessage.create({
      body:proto.Message.InteractiveMessage.Body.create({text:text||'Ouvrir'}),
      footer:proto.Message.InteractiveMessage.Footer.create({text:'Nextech'}),
      nativeFlowMessage:proto.Message.InteractiveMessage.NativeFlowMessage.create({buttons:buttons.slice(0,3).map(b=>({name:'cta_url',buttonParamsJson:JSON.stringify({display_text:b.text,url:b.url,merchant_url:b.url})}))})
    });
    const msg=generateWAMessageFromContent(jid,{interactiveMessage:content},{userJid:socket.user?.id});
    await socket.relayMessage(jid,msg.message,{messageId:msg.key.id}); return true;
  }catch{return false;}
}

async function sendOneMedia(jid,item,caption){
  const url=item.url||await telegramFileUrl(item.fileId);
  if(!url) throw new Error('URL média introuvable');
  const source={url};
  const type=String(item.type||'').toLowerCase();
  if(type==='photo'||type==='image') return socket.sendMessage(jid,{image:source,caption});
  if(type==='video'||type==='animation') return socket.sendMessage(jid,{video:source,caption});
  if(type==='audio'||type==='voice') return socket.sendMessage(jid,{audio:source,mimetype:item.mimetype||'audio/mpeg'});
  return socket.sendMessage(jid,{document:source,mimetype:item.mimetype||'application/octet-stream',fileName:item.fileName||'fichier',caption});
}

async function sendPublication(jid,destination,pub){
  if(!socket||state.status!=='connected') throw new Error('WhatsApp non connecté');
  const combined=[pub.text,linksText(pub.buttons)].filter(Boolean).join('\n\n');
  if(!pub.media.length){
    if(destination==='group'&&pub.buttons.length&&await nativeButtons(jid,pub.text,pub.buttons)) return;
    await socket.sendMessage(jid,{text:combined||'Publication Nextech'}); return;
  }
  for(let i=0;i<pub.media.length;i++) await sendOneMedia(jid,pub.media[i],i===0?combined:undefined);
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
        if(job.destination==='channel'&&(!job.jid||job.jid==='__CHANNEL__')){
          const resolved=await resolveChannel();
          if(!resolved) throw new Error('Chaîne WhatsApp non résolue');
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
  if(dedupeSeen(pub)) return {duplicate:true,pub,route:routePublication(pub)};
  const route=routePublication(pub);
  if(route.group) enqueue('group',GROUP_JID,pub);
  if(route.channel) enqueue('channel',state.channelJid||'__CHANNEL__',pub);
  addHistory({type:'planned',publicationId:pub.id,source:pub.source,route,textPreview:pub.text.slice(0,180)});
  processQueue().catch(()=>{});
  return {duplicate:false,pub,route};
}

const html=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#071015"><title>Nex WhatsApp Publisher</title><style>
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#12352d,transparent 35%),#071015;color:#eef7f3;font-family:Inter,system-ui,-apple-system,sans-serif;min-height:100vh}.wrap{max-width:1040px;margin:auto;padding:28px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}.brand{font-weight:900;letter-spacing:.03em}.badge{padding:8px 12px;border-radius:999px;border:1px solid #29414b;color:#9fb2bb;background:#0e1a20}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:18px}.card{background:#0f1a20e8;border:1px solid #20323c;border-radius:24px;padding:22px;box-shadow:0 22px 60px #0004}.hero h1{font-size:clamp(36px,8vw,72px);line-height:.92;margin:12px 0 18px;letter-spacing:-.05em}.muted{color:#93a5ae;line-height:1.6}.eyebrow{font-size:11px;letter-spacing:.18em;color:#25d366;font-weight:900}.row{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:14px}input,button{font:inherit;border-radius:14px;padding:14px}input{width:100%;border:1px solid #29414b;background:#091319;color:white;outline:none}button{border:0;background:#25d366;color:#05120c;font-weight:850;cursor:pointer}.ghost{background:#122129;color:#d9e6e0;border:1px solid #29414b}.code{display:none;margin-top:18px;border:1px solid #2a6e51;background:#0a281b;border-radius:18px;padding:18px}.code.show{display:block}.code strong{font-size:34px;letter-spacing:.12em;display:block;margin:8px 0 14px}.steps{font-size:14px;color:#c2d2cb;line-height:1.7}.metric{padding:14px 0;border-bottom:1px solid #20323c}.metric:last-child{border:0}.metric span{display:block;color:#82949e;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.metric b{display:block;font-size:20px;margin-top:5px;word-break:break-word}.login{position:fixed;inset:0;display:grid;place-items:center;background:#071015;padding:20px;z-index:5}.login.hide{display:none}.login .card{width:min(400px,100%)}.login h2{margin:8px 0 4px}.login p{margin:0 0 14px}.log{margin-top:18px;max-height:260px;overflow:auto}.item{border-top:1px solid #20323c;padding:10px 0;font-size:13px}.item b{color:#baf5ce}.warn{color:#ffcf8b}@media(max-width:760px){.grid{grid-template-columns:1fr}.wrap{padding:18px}.row{grid-template-columns:1fr}.code strong{font-size:28px}.hero h1{font-size:48px}}
</style></head><body><div id="login" class="login hide"><form id="lf" class="card"><div class="eyebrow">NEXTECH · PRIVÉ</div><h2>Nex Publisher</h2><p class="muted">Console WhatsApp privée.</p><input id="pw" type="password" placeholder="Mot de passe" required><button style="width:100%;margin-top:10px">Connexion</button><p id="le" class="warn"></p></form></div><main class="wrap"><div class="top"><div class="brand">NEX / WHATSAPP PUBLISHER</div><div id="badge" class="badge">Chargement…</div></div><div class="grid"><section class="card hero"><div class="eyebrow">CONNEXION PAR NUMÉRO</div><h1>Pair.<br>Publish.</h1><p class="muted">Entre le numéro du compte qui administrera ta chaîne et ton groupe WhatsApp. Le serveur génère un code à coller directement dans WhatsApp.</p><div class="row"><input id="phone" type="tel" placeholder="+229…"><button id="pair">Recevoir le code</button></div><div id="codeBox" class="code"><span class="muted">CODE DE CONNEXION</span><strong id="code">—</strong><button id="copy" class="ghost">Copier</button><ol class="steps"><li>Ouvre WhatsApp.</li><li>Paramètres → Appareils connectés.</li><li>Choisis « Connecter avec un numéro de téléphone ».</li><li>Colle le code.</li></ol></div></section><aside class="card"><div class="eyebrow">ÉTAT</div><div class="metric"><span>WhatsApp</span><b id="wa">—</b></div><div class="metric"><span>Groupe</span><b>${GROUP_JID}</b></div><div class="metric"><span>Chaîne</span><b id="channel">Résolution après connexion</b></div><div class="metric"><span>Sources</span><b>Nextech + NexNews</b></div><button id="resolve" class="ghost" style="width:100%;margin-top:14px">Résoudre la chaîne</button></aside></div><section class="card log"><div class="eyebrow">ACTIVITÉ RÉCENTE</div><div id="history"></div></section></main><script>
const $=s=>document.querySelector(s);async function api(u,o={}){const r=await fetch(u,{headers:{'content-type':'application/json',...(o.headers||{})},...o});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||('HTTP '+r.status)),{status:r.status});return j}async function refresh(){try{const d=await api('/api/status');$('#login').classList.add('hide');$('#wa').textContent=d.whatsapp.status;$('#badge').textContent='WhatsApp · '+d.whatsapp.status;$('#channel').textContent=d.whatsapp.channelJid||'À résoudre';$('#history').innerHTML=(d.history||[]).slice(0,20).map(x=>'<div class="item"><b>'+String(x.type||'event')+'</b> · '+String(x.destination||x.source||'')+'<br><span class="muted">'+String(x.at||'')+'</span></div>').join('')||'<p class="muted">Aucune activité.</p>'}catch(e){if(e.status===401)$('#login').classList.remove('hide')}}$('#lf').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('#pw').value})});$('#le').textContent='';refresh()}catch(e){$('#le').textContent=e.message}};$('#pair').onclick=async()=>{try{$('#pair').disabled=true;const d=await api('/api/pair',{method:'POST',body:JSON.stringify({phone:$('#phone').value})});$('#code').textContent=d.formatted;$('#codeBox').classList.add('show')}catch(e){alert(e.message)}finally{$('#pair').disabled=false}};$('#copy').onclick=async()=>{await navigator.clipboard.writeText($('#code').textContent.replace(/-/g,''));$('#copy').textContent='Copié';setTimeout(()=>$('#copy').textContent='Copier',1200)};$('#resolve').onclick=async()=>{try{const d=await api('/api/resolve-channel',{method:'POST'});alert('Chaîne: '+d.jid);refresh()}catch(e){alert(e.message)}};const reset=$('#reset');if(reset)reset.onclick=async()=>{if(!confirm('Réinitialiser la session WhatsApp ?'))return;try{await api('/api/reset',{method:'POST'});location.reload()}catch(e){alert(e.message)}};refresh();setInterval(refresh,8000);
</script></body></html>`;

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/healthz') return json(res,200,{ok:true,status:state.status,channelJid:state.channelJid});
    if(req.method==='GET'&&url.pathname==='/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}); return res.end(html); }
    if(req.method==='POST'&&url.pathname==='/api/login'){
      const q=await body(req); if(!DASHBOARD_PASSWORD||!safeEq(q.password,DASHBOARD_PASSWORD)) return json(res,401,{error:'Mot de passe incorrect'});
      return json(res,200,{ok:true},{'set-cookie':`nwp_owner=${sessionToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`});
    }
    if(req.method==='POST'&&url.pathname==='/api/nexcanal/publish'){
      const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); if(!WEBHOOK_TOKEN||!safeEq(token,WEBHOOK_TOKEN)) return json(res,401,{error:'unauthorized'});
      const q=await body(req); const out=plan(q); return json(res,202,{ok:true,duplicate:out.duplicate,route:out.route});
    }
    if(req.method==='GET'&&url.pathname==='/api/status') return json(res,200,{whatsapp:{status:state.status,connectedAt:state.connectedAt,channelJid:state.channelJid,channelTitle:state.channelTitle,lastError:state.lastError,presentationNewsletterJid:PRESENTATION_NEWSLETTER_JID},history:[]});
    if(req.method==='POST'&&url.pathname==='/api/pair'){ const q=await body(req); return json(res,200,{ok:true,...await requestPairingCode(q.phone)}); }
    if(req.method==='POST'&&url.pathname==='/api/resolve-channel'){ const jid=await resolveChannel(); return json(res,200,{ok:true,jid,title:state.channelTitle}); }
    if(!authed(req)) return json(res,401,{error:'unauthorized'});
    if(req.method==='POST'&&url.pathname==='/api/reset'){
      await resetAuthForPairing(); state.channelJid=null;state.channelTitle=null;fs.rmSync(f('channel.json'),{force:true}); await connectWhatsApp(); return json(res,200,{ok:true});
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
