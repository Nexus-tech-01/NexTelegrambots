import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {TelegramClient} from 'teleproto';
import {StringSession} from 'teleproto/sessions/index.js';

const run=promisify(execFile);
const SELF=fileURLToPath(import.meta.url);
const MODE_WORKER=process.argv.includes('--worker');
const MODE_SUPERVISE=process.argv.includes('--supervise');
const MODE_RESTART=process.argv.includes('--restart-supervisor');
const TZ=String(process.env.OTAKU_MANAGER_TIMEZONE||'Africa/Porto-Novo');
const STATE_DIR=String(process.env.OTAKU_MANAGER_STATE_DIR||'/var/lib/nex/state/internal-automation/otaku-nexus-manager');
const TMP_DIR=String(process.env.OTAKU_MANAGER_TMP_DIR||'/var/lib/nex/tmp/internal-automation/otaku-nexus-manager');
const STATE_FILE=path.join(STATE_DIR,'state.json');
const HEALTH_FILE=path.join(STATE_DIR,'health.json');
const PID_FILE=path.join(STATE_DIR,'supervisor.pid');
const LOG_DIR=path.join(STATE_DIR,'logs');
const OUT_LOG=path.join(LOG_DIR,'worker.log');
const ERR_LOG=path.join(LOG_DIR,'worker.err.log');
const PORT=Math.max(1024,Number(process.env.OTAKU_MANAGER_PORT||18812));
const WA=String(process.env.OTAKU_MANAGER_WA_BRIDGE||'http://127.0.0.1:18787').replace(/\/$/,'');
const AI_BRIDGE=String(process.env.OTAKU_AI_BRIDGE||'http://127.0.0.1:3220/v1/chat/completions').trim();
const BOT_TOKEN=String(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const API_ID=Number(process.env.NEXCANAL__WATCHER_API_ID||process.env.NEXGROUP__TELEGRAM_API_ID||0);
const API_HASH=String(process.env.NEXCANAL__WATCHER_API_HASH||process.env.NEXGROUP__TELEGRAM_API_HASH||'').trim();
const USER_SESSION=String(process.env.NEXCANAL__WATCHER_SESSION||'').trim();
const SESSION_FILE=String(process.env.NEXCANAL__WATCHER_SESSION_FILE||'/var/lib/nex/sessions/system/nexcanal-reader-session.txt');
const PACK_INTERVAL=Math.max(60*60_000,Number(process.env.OTAKU_PACK_INTERVAL_MS||15*60*60_000));
const ORDER_WINDOW=Math.max(60*60_000,Number(process.env.OTAKU_ORDER_WINDOW_MS||18*60*60_000));
const MAX_STICKERS=Math.max(1,Math.min(30,Number(process.env.OTAKU_MAX_STICKERS||30)));
const MIN_STICKERS=Math.max(4,Math.min(MAX_STICKERS,Number(process.env.OTAKU_MIN_STICKERS||12)));
const QUIZ_GAP=Math.max(60_000,Number(process.env.OTAKU_QUIZ_GAP_MS||3*60_000));
const CHOICE_GAP=Math.max(5*60_000,Number(process.env.OTAKU_CHOICE_GAP_MS||15*60_000));
const TELEGRAM_CHANNEL_URL=String(process.env.OTAKU_TELEGRAM_CHANNEL_URL||'https://t.me/theotaku_nexus').trim();
const PROMO_MIN_GAP=Math.max(20_000,Number(process.env.OTAKU_PROMO_MIN_GAP_MS||35_000));
const PROMO_MAX_GAP=Math.max(PROMO_MIN_GAP,Number(process.env.OTAKU_PROMO_MAX_GAP_MS||65_000));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const STICKER_SOURCES=['fr3dc','anime_stickerr','supremacy_sticks','Leonild'];
const CHARACTERS=['Naruto Uzumaki','Sasuke Uchiha','Itachi Uchiha','Gojo Satoru','Sukuna','Monkey D. Luffy','Roronoa Zoro','Levi Ackerman','Eren Yeager','Tanjiro Kamado','Nezuko Kamado','Kakashi Hatake','Madara Uchiha','Obito Uchiha','Killua Zoldyck','Gon Freecss'];
const DUELS=[['Naruto','Sasuke'],['Gojo','Sukuna'],['Luffy','Zoro'],['Itachi','Madara'],['Levi','Eren'],['Tanjiro','Rengoku'],['Killua','Gon'],['Kakashi','Obito'],['Goku','Vegeta'],['Light','L']];
const LIFE=[['TikTok 📱','YouTube 🎬'],['Anime 🎌','Manga 📚'],['Nuit 🌙','Matin ☀️'],['Pouvoir ⚡','Intelligence 🧠'],['Voyage ✈️','Gaming 🎮']];
const QUIZ={
  easy:[
    ['Quel est le village de Naruto ?',['Konoha','Suna','Kiri','Iwa'],'Konoha'],
    ['Qui est le frère de Sasuke ?',['Itachi','Shisui','Madara','Obito'],'Itachi'],
    ['Quel est le rêve de Luffy ?',['Devenir Hokage','Devenir Roi des Pirates','Devenir Shinigami','Trouver les Dragon Balls'],'Devenir Roi des Pirates']
  ],
  intermediate:[
    ['Quel Titan Eren possède-t-il au début de son pouvoir révélé ?',['Titan Assaillant','Titan Colossal','Titan Bestial','Titan Cuirassé'],'Titan Assaillant'],
    ['Quel est le domaine de Gojo ?',['Unlimited Void','Malevolent Shrine','Chimera Shadow Garden','Idle Death Gamble'],'Unlimited Void'],
    ['Quel membre de l Akatsuki utilise des marionnettes ?',['Sasori','Deidara','Kisame','Hidan'],'Sasori']
  ],
  hard:[
    ['Quel était le nom du père de Kakashi ?',['Sakumo Hatake','Fugaku Uchiha','Minato Namikaze','Dan Kato'],'Sakumo Hatake'],
    ['Dans Death Note, quel est le vrai nom de L ?',['L Lawliet','Light Lawliet','Louis Ryuzaki','Lind L Tailor'],'L Lawliet'],
    ['Qui commandait le Bataillon d exploration avant Hange ?',['Erwin Smith','Keith Shadis','Dot Pixis','Levi Ackerman'],'Erwin Smith']
  ]
};

const clean=v=>String(v??'').trim();
const rand=a=>a[Math.floor(Math.random()*a.length)];
const nowIso=()=>new Date().toISOString();
const digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex');

function localParts(){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>Number(p.find(x=>x.type===t)?.value||0);
  return {y:g('year'),m:g('month'),d:g('day'),h:g('hour')===24?0:g('hour'),min:g('minute')};
}
function dayKey(){const p=localParts();return [p.y,String(p.m).padStart(2,'0'),String(p.d).padStart(2,'0')].join('-');}

async function loadState(){
  try{
    const x=JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    return {
      nextPackAt:Number(x.nextPackAt)||Date.now()+10*60_000,
      orderWindowUntil:Number(x.orderWindowUntil)||0,
      autoPacks:Number(x.autoPacks)||0,
      queue:Array.isArray(x.queue)?x.queue:[],
      seen:Array.isArray(x.seen)?x.seen.slice(-1000):[],
      recent:Array.isArray(x.recent)?x.recent.slice(-12):[],
      lastQuizDay:clean(x.lastQuizDay),
      lastChoiceDay:clean(x.lastChoiceDay),
      history:Array.isArray(x.history)?x.history.slice(-250):[]
    };
  }catch{
    return {nextPackAt:Date.now()+10*60_000,orderWindowUntil:0,autoPacks:0,queue:[],seen:[],recent:[],lastQuizDay:'',lastChoiceDay:'',history:[]};
  }
}
async function saveState(s){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const tmp=STATE_FILE+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(s,null,2),{mode:0o600});
  await fs.rename(tmp,STATE_FILE);
}
async function writeHealth(extra={}){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const tmp=HEALTH_FILE+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify({ok:true,pid:process.pid,updatedAt:nowIso(),...extra},null,2),{mode:0o600});
  await fs.rename(tmp,HEALTH_FILE);
}
async function action(payload,timeout=120000){
  const r=await fetch(WA+'/otaku/action',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j?.ok===false)throw new Error('otaku_action_'+r.status+': '+clean(j?.error||'failed'));
  return j;
}

function providers(){
  const a=[];
  const g=clean(process.env.GEMINI_API_KEY||process.env.GOOGLE_AI_API_KEY||process.env.NEXAI_GEMINI_API_KEY);
  if(g)a.push({kind:'gemini',key:g,model:clean(process.env.NEXAI_GEMINI_MODEL)||'gemini-2.5-flash'});
  const o=clean(process.env.OPENAI_API_KEY||process.env.NEXAI_OPENAI_API_KEY);
  if(o)a.push({kind:'openai',key:o,model:clean(process.env.NEXAI_OPENAI_MODEL)||'gpt-4o-mini'});
  return a;
}
function parseJson(text){
  const raw=clean(text);
  const i=raw.indexOf('{'),j=raw.lastIndexOf('}');
  if(i<0||j<=i)throw new Error('ai_json_missing');
  return JSON.parse(raw.slice(i,j+1));
}
async function aiJson(prompt){
  // Prefer the local Nexus provider bridge. It owns the upstream credential,
  // so this worker never needs to duplicate or expose an AI key.
  try{
    const r=await fetch(AI_BRIDGE,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({
        model:'openrouter/free',
        messages:[{role:'user',content:prompt}],
        response_format:{type:'json_object'},
        temperature:.5,max_tokens:700
      }),
      signal:AbortSignal.timeout(45000)
    });
    const j=await r.json().catch(()=>null);
    if(r.ok){
      const parsed=parseJson(clean(j?.choices?.[0]?.message?.content));
      if(parsed&&typeof parsed==='object')return parsed;
    }
  }catch{}
  for(const p of providers()){
    try{
      if(p.kind==='gemini'){
        const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(p.model)+':generateContent',{
          method:'POST',headers:{'content-type':'application/json','x-goog-api-key':p.key},
          body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:.5,maxOutputTokens:700}}),
          signal:AbortSignal.timeout(45000)
        });
        const j=await r.json();if(!r.ok)throw new Error(clean(j?.error?.message||r.status));
        return parseJson(clean((j?.candidates?.[0]?.content?.parts||[]).map(x=>x?.text||'').join('')));
      }
      const r=await fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+p.key},
        body:JSON.stringify({model:p.model,messages:[{role:'user',content:prompt}],response_format:{type:'json_object'},temperature:.5,max_tokens:700}),
        signal:AbortSignal.timeout(45000)
      });
      const j=await r.json();if(!r.ok)throw new Error(clean(j?.error?.message||r.status));
      return parseJson(clean(j?.choices?.[0]?.message?.content));
    }catch{}
  }
  return null;
}
async function classify(text){
  const raw=clean(text).slice(0,1000);if(!raw)return {valid:false};
  const j=await aiJson('Classe cette réponse pour une commande de pack stickers anime. Une vraie commande demande clairement des stickers ou un pack et un personnage précis. Ignore salutations, emojis seuls et réponses vagues. JSON uniquement: {"valid":true|false,"character":"...","confidence":0..1}. Message: '+raw);
  if(j)return {valid:j.valid===true&&clean(j.character).length>1,character:clean(j.character).slice(0,80),confidence:Number(j.confidence)||0};
  const m=raw.match(/(?:sticker|stickers|pack).{0,30}(?:de|du|pour)?\s*([A-Za-zÀ-ÿ0-9 .'-]{2,50})/i);
  return m?{valid:true,character:clean(m[1]).replace(/[?.!,]+$/,''),confidence:.5}:{valid:false};
}
async function packCaption(character,count){
  const j=await aiJson('Écris une caption française courte et stylée pour Otaku Nexus annonçant un pack WhatsApp de '+count+' stickers sur '+character+'. Style small caps/otaku élégant, maximum 500 caractères. Invite à commander le prochain personnage. Aucun crédit source. JSON {"caption":"..."}');
  return clean(j?.caption)||('✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs · sᴛɪᴄᴋᴇʀ ᴘᴀᴄᴋ\n\n'+character+' — '+count+' stickers prêts pour WhatsApp.\n\nQuel personnage pour le prochain pack ?');
}

async function telegramClient(){
  let session=USER_SESSION;
  if(!session)try{session=clean(await fs.readFile(SESSION_FILE,'utf8'))}catch{}
  if(!session||!API_ID||!API_HASH)return null;
  const c=new TelegramClient(new StringSession(session),API_ID,API_HASH,{connectionRetries:8,autoReconnect:true,floodSleepThreshold:60});
  await c.connect();
  return c;
}
function stickerSetNames(message){
  const out=new Set();
  const add=value=>{
    const text=String(value||'');
    for(const m of text.matchAll(/https?:\/\/(?:t|telegram)\.me\/addstickers\/([A-Za-z0-9_]{2,128})/ig))out.add(m[1]);
  };
  add(message?.message);
  const body=String(message?.message||'');
  for(const e of Array.isArray(message?.entities)?message.entities:[]){
    if(e?.url)add(e.url);
    const offset=Math.max(0,Number(e?.offset)||0),length=Math.max(0,Number(e?.length)||0);
    if(length)add(body.slice(offset,offset+length));
  }
  return [...out];
}
async function botApi(method,body={}){
  if(!BOT_TOKEN)throw new Error('telegram_bot_token_missing');
  const r=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(30000)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j?.ok)throw new Error(method+': '+clean(j?.description||r.status));
  return j.result;
}
async function stickerSetFiles(name,dir,start,limit){
  if(limit<=0||!BOT_TOKEN)return [];
  const set=await botApi('getStickerSet',{name});
  const out=[];let n=start;
  for(const sticker of Array.isArray(set?.stickers)?set.stickers:[]){
    if(out.length>=limit)break;
    try{
      const meta=await botApi('getFile',{file_id:sticker.file_id});
      if(!meta?.file_path)continue;
      const r=await fetch('https://api.telegram.org/file/bot'+BOT_TOKEN+'/'+meta.file_path,{signal:AbortSignal.timeout(30000)});
      if(!r.ok)continue;
      const bytes=Buffer.from(await r.arrayBuffer());
      if(bytes.length<300||bytes.length>10*1024*1024)continue;
      const ext=String(meta.file_path).split('.').pop()?.toLowerCase()||'bin';
      if(ext==='tgs')continue;
      const raw=path.join(dir,'set-'+name+'-'+n+'.'+ext);
      await fs.writeFile(raw,bytes);
      const target=path.join(dir,'sticker-'+String(n++).padStart(2,'0')+'.webp');
      await normalizeSticker(raw,target);
      out.push({localPath:target,source:'telegram-pack:'+name});
    }catch{}
  }
  return out;
}

function isSticker(m){
  const d=m?.document;if(!d)return false;
  const mime=clean(d.mimeType).toLowerCase();
  return (d.attributes||[]).some(x=>/Sticker/i.test(String(x?.className||x?.constructor?.name||'')))||['image/webp','video/webm'].includes(mime);
}
async function normalizeSticker(input,out){
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',input,
    '-vf','scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-vcodec','libwebp','-lossless','0','-q:v','70','-preset','picture','-an','-y',out
  ],{timeout:45000,maxBuffer:1024*1024});
  const st=await fs.stat(out);
  if(!st.isFile()||st.size<500||st.size>600*1024)throw new Error('invalid_sticker');
  return out;
}
async function telegramStickers(character,dir,limit){
  const c=await telegramClient();if(!c)return [];
  const out=[];let n=0;
  try{
    for(const source of STICKER_SOURCES){
      if(out.length>=limit)break;
      let entity;try{entity=await c.getEntity('@'+source)}catch{continue}
      let rows=[];try{rows=await c.getMessages(entity,{limit:180})}catch{continue}
      rows.sort((a,b)=>Number(clean(b?.message).toLowerCase().includes(character.toLowerCase()))-Number(clean(a?.message).toLowerCase().includes(character.toLowerCase())));
      const usedSets=new Set();
      for(const m of rows){
        if(out.length>=limit)break;

        // Source posts often hide an addstickers URL behind a word. Resolve
        // those packs through the Telegram Bot API and convert their members.
        for(const setName of stickerSetNames(m)){
          if(out.length>=limit||usedSets.has(setName))break;
          usedSets.add(setName);
          try{
            const rows=await stickerSetFiles(setName,dir,n,limit-out.length);
            n+=rows.length;
            out.push(...rows);
          }catch{}
        }
        if(out.length>=limit)break;

        if(!isSticker(m))continue;
        const ext=clean(m.document?.mimeType).includes('webm')?'.webm':'.webp';
        const raw=path.join(dir,'tg-'+source+'-'+String(m.id)+ext);
        try{
          const dl=await c.downloadMedia(m.media,{outputFile:raw,workers:1});
          const file=typeof dl==='string'&&dl?dl:raw;
          const sticker=path.join(dir,'sticker-'+String(n++).padStart(2,'0')+'.webp');
          await normalizeSticker(file,sticker);
          out.push({localPath:sticker,source:'telegram:@'+source});
        }catch{}
      }
    }
  }finally{await c.disconnect().catch(()=>{})}
  return out;
}
function pinterestUrls(html){
  const found=[];const seen=new Set();
  const patterns=[/https:\/\/i\.pinimg\.com\/[^"'<>\\\s]+/g,/https:\\\/\\\/i\.pinimg\.com\\\/[^"'<>\s]+/g];
  for(const re of patterns){
    for(const m of String(html).matchAll(re)){
      const u=clean(m[0]).replace(/\\u002F/gi,'/').replace(/\\\//g,'/').replace(/["')},;]+$/,'');
      if(!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(u)||/\/60x60\//.test(u)||seen.has(u))continue;
      seen.add(u);found.push(u);
    }
  }
  return found;
}
async function pinterestImages(query,limit=40){
  const r=await fetch('https://www.pinterest.com/search/pins/?q='+encodeURIComponent(query),{
    headers:{'user-agent':'Mozilla/5.0 Chrome/136','accept-language':'en-US,en;q=0.9'},
    signal:AbortSignal.timeout(20000)
  });
  if(!r.ok)return [];
  return pinterestUrls(await r.text()).slice(0,limit);
}
async function pinterestStickers(character,dir,start,limit){
  if(limit<=0)return [];
  const urls=await pinterestImages(character+' anime sticker 1:1',70);
  const out=[];let n=start;
  for(const url of urls){
    if(out.length>=limit)break;
    try{
      const x=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
      if(!x.ok)continue;
      const b=Buffer.from(await x.arrayBuffer());
      if(b.length<5000||b.length>12*1024*1024)continue;
      const raw=path.join(dir,'pin-'+n+'.img');
      await fs.writeFile(raw,b);
      const sticker=path.join(dir,'sticker-'+String(n++).padStart(2,'0')+'.webp');
      await normalizeSticker(raw,sticker);
      out.push({localPath:sticker,source:'pinterest'});
    }catch{}
  }
  return out;
}
function isManagedTelegramGroup(entity){
  const name=String(entity?.className||entity?.constructor?.name||'');
  const isGroup=name==='Chat'||(name==='Channel'&&entity?.megagroup===true);
  const managed=entity?.creator===true||Boolean(entity?.adminRights);
  return isGroup&&managed;
}
async function promotePackToManagedGroups(character,cover,count){
  const client=await telegramClient();
  if(!client)return {sent:0,skipped:'no_user_session'};
  let sent=0;
  try{
    const dialogs=await client.getDialogs({limit:500});
    for(const dialog of dialogs||[]){
      const entity=dialog?.entity;
      if(!isManagedTelegramGroup(entity))continue;
      const username=clean(entity?.username).replace(/^@/,'').toLowerCase();
      if(username==='theotaku_nexus'||STICKER_SOURCES.map(x=>x.toLowerCase()).includes(username))continue;
      try{
        const caption='✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs\n\nNouveau pack '+character+' — '+count+' stickers.\n\nRejoins la chaîne pour les prochains packs : '+TELEGRAM_CHANNEL_URL;
        await client.sendFile(entity,{file:cover,caption,buttons:[[{text:'Otaku Nexus',url:TELEGRAM_CHANNEL_URL}]]});
        sent++;
      }catch{}
      const gap=PROMO_MIN_GAP+Math.floor(Math.random()*(PROMO_MAX_GAP-PROMO_MIN_GAP+1));
      await sleep(gap);
    }
  }finally{await client.disconnect().catch(()=>{})}
  return {sent};
}

async function buildPack(character){
  const dir=path.join(TMP_DIR,'pack-'+Date.now()+'-'+digest(character).slice(0,6));
  await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});
  const fromTelegram=await telegramStickers(character,dir,Math.min(20,MAX_STICKERS));
  const fromPinterest=await pinterestStickers(character,dir,fromTelegram.length,MAX_STICKERS-fromTelegram.length);
  const stickers=[...fromTelegram,...fromPinterest].slice(0,MAX_STICKERS);
  if(stickers.length<MIN_STICKERS)throw new Error('not_enough_valid_stickers_'+stickers.length);
  const cover=path.join(dir,'cover.jpg');
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',stickers[0].localPath,
    '-vf','scale=900:900:force_original_aspect_ratio=decrease,pad=900:900:(ow-iw)/2:(oh-ih)/2:color=black',
    '-q:v','2','-y',cover
  ],{timeout:30000,maxBuffer:1024*1024});
  return {dir,stickers,cover};
}
async function publishPack(character,state,reason){
  const pack=await buildPack(character);
  const caption=await packCaption(character,pack.stickers.length);
  await action({
    kind:'pack',
    id:'otaku-pack:'+Date.now()+':'+digest(character).slice(0,6),
    character,caption,
    cover:{localPath:pack.cover,fileName:'cover.jpg'},
    stickers:pack.stickers.map((x,i)=>({localPath:x.localPath,fileName:character.replace(/\s+/g,'-')+'-'+String(i+1)+'.webp'}))
  },10*60_000);
  state.recent.push(character);state.recent=state.recent.slice(-12);
  state.history.push({at:nowIso(),type:'pack',reason,character,count:pack.stickers.length});
  state.history=state.history.slice(-250);
  // Promotion is intentionally asynchronous and limited to groups where the
  // Telegram account is creator/admin. It never blocks WhatsApp pack delivery.
  void promotePackToManagedGroups(character,pack.cover,pack.stickers.length)
    .then(x=>{state.history.push({at:nowIso(),type:'promo',character,sent:Number(x?.sent||0)});state.history=state.history.slice(-250);return saveState(state)})
    .catch(()=>{});
  setTimeout(()=>fs.rm(pack.dir,{recursive:true,force:true}).catch(()=>{}),Math.max(2*60*60_000,PROMO_MAX_GAP*120)).unref?.();
  return pack.stickers.length;
}
async function openOrders(state){
  await action({
    kind:'text',id:'orders:'+Date.now(),
    text:'✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs · ᴄᴏᴍᴍᴀɴᴅᴇs\n\nQuel personnage veux-tu pour le prochain pack ?\nÉcris clairement « pack stickers + nom du personnage ».\n\nLes vraies commandes reconnues seront ajoutées à la file.'
  });
  state.orderWindowUntil=Date.now()+ORDER_WINDOW;
  state.autoPacks=0;
  state.history.push({at:nowIso(),type:'order-window',until:new Date(state.orderWindowUntil).toISOString()});
}
async function imagePost(id,query,text){
  const urls=await pinterestImages(query,20);
  if(!urls.length){await action({kind:'text',id,text});return}
  await action({kind:'image',id,imageUrl:urls[0],text});
}
async function runQuiz(state,slot){
  const id='quiz-'+dayKey()+'-'+slot;
  await imagePost(id+':intro','anime quiz characters collage wallpaper','✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs · ǫᴜɪᴢ\n\n3 blocs : facile → intermédiaire → difficile.\nChaque bonne réponse compte pour le classement final.\n\nDépart dans 5 minutes. 🔥');
  await sleep(5*60_000);
  for(const level of ['easy','intermediate','hard']){
    await action({kind:'text',id:id+':'+level,text:'✦ '+(level==='easy'?'ɴɪᴠᴇᴀᴜ ғᴀᴄɪʟᴇ':level==='intermediate'?'ɴɪᴠᴇᴀᴜ ɪɴᴛᴇʀᴍᴇ́ᴅɪᴀɪʀᴇ':'ɴɪᴠᴇᴀᴜ ᴅɪғғɪᴄɪʟᴇ')});
    for(let i=0;i<QUIZ[level].length;i++){
      const q=QUIZ[level][i];
      await action({kind:'poll',id:id+':'+level+':'+i,sessionId:id,quiz:true,question:q[0],options:q[1],correctAnswer:q[2]});
      await sleep(QUIZ_GAP);
    }
  }
  await action({kind:'quiz_results',id:id+':results',sessionId:id});
  state.lastQuizDay=dayKey();
  state.history.push({at:nowIso(),type:'quiz',sessionId:id});
}
async function runChoices(state){
  const id='choice-'+dayKey()+'-'+Date.now();
  await action({kind:'text',id:id+':intro',text:'✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs · ᴛᴜ ᴘʀᴇ́ғᴇ̀ʀᴇs ?\n\n15 choix. Un nouveau duel toutes les 15 minutes. 👀'});
  for(let i=0;i<15;i++){
    const pair=i%3===2?rand(LIFE):rand(DUELS);
    if(i%3!==2)await imagePost(id+':img:'+i,pair[0]+' '+pair[1]+' anime wallpaper together','✦ '+pair[0]+'  VS  '+pair[1]);
    await action({kind:'poll',id:id+':poll:'+i,question:'Tu préfères ?',options:pair,quiz:false});
    if(i<14)await sleep(CHOICE_GAP);
  }
  await action({kind:'text',id:id+':end',text:'✦ ғɪɴ ᴅᴜ ᴊᴇᴜ\n\n15 choix terminés. Quel duel tu veux revoir ?'});
  state.lastChoiceDay=dayKey();
  state.history.push({at:nowIso(),type:'choice-marathon',id});
}
function autoCharacter(state){
  const recent=new Set(state.recent.slice(-8));
  const pool=CHARACTERS.filter(x=>!recent.has(x));
  return rand(pool.length?pool:CHARACTERS);
}
async function receiveOrder(state,payload){
  if(Date.now()>state.orderWindowUntil)return {accepted:false,reason:'window_closed'};
  const text=clean(payload?.text);if(!text)return {accepted:false,reason:'empty'};
  const id=digest([payload?.chatId,payload?.senderId,text].join('|'));
  if(state.seen.includes(id))return {accepted:false,reason:'duplicate'};
  state.seen.push(id);state.seen=state.seen.slice(-1000);
  const c=await classify(text);
  if(c.valid&&c.character&&!state.queue.some(x=>x.status==='pending'&&x.character.toLowerCase()===c.character.toLowerCase())){
    state.queue.push({id:crypto.randomUUID(),character:c.character,status:'pending',requestedAt:nowIso(),confidence:c.confidence});
    state.queue=state.queue.slice(-100);
    state.history.push({at:nowIso(),type:'order-accepted',character:c.character,confidence:c.confidence});
  }
  await saveState(state);
  return {accepted:Boolean(c.valid),character:c.character||null,confidence:c.confidence||0};
}
async function tick(state){
  const p=localParts(),day=dayKey(),quizHour=p.d%2===0?10:19;
  if(state.lastQuizDay!==day&&p.h===quizHour&&p.min<8){
    await runQuiz(state,String(quizHour));await saveState(state);return;
  }
  if(state.lastChoiceDay!==day&&p.d%2===1&&p.h===16&&p.min<8){
    await runChoices(state);await saveState(state);return;
  }
  if(Date.now()<state.nextPackAt)return;
  const job=state.queue.find(x=>x.status==='pending');
  const character=job?.character||autoCharacter(state);
  try{
    const count=await publishPack(character,state,job?'request':'auto');
    if(job){job.status='done';job.completedAt=nowIso();job.count=count}
    else state.autoPacks++;
    state.nextPackAt=Date.now()+PACK_INTERVAL;
    if(!job&&state.autoPacks>=3)await openOrders(state);
  }catch(error){
    if(job){
      job.attempts=Number(job.attempts||0)+1;
      job.lastError=clean(error?.message||error).slice(0,300);
      if(job.attempts>=4)job.status='failed';
    }
    state.nextPackAt=Date.now()+60*60_000;
    state.history.push({at:nowIso(),type:'pack-error',character,error:clean(error?.message||error).slice(0,300)});
  }
  await saveState(state);
}
async function serve(state){
  const http=await import('node:http');
  const server=http.createServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&u.pathname==='/healthz'){
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:true,pid:process.pid,nextPackAt:state.nextPackAt,orderWindowUntil:state.orderWindowUntil,pending:state.queue.filter(x=>x.status==='pending').length}));
      }
      if(req.method==='POST'&&u.pathname==='/incoming'){
        const chunks=[];for await(const c of req)chunks.push(c);
        let body={};try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}
        const out=await receiveOrder(state,body);
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:true,...out}));
      }
      res.writeHead(404);res.end();
    }catch(error){
      res.writeHead(500,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:clean(error?.message||error)}));
    }
  });
  await new Promise((resolve,reject)=>server.listen(PORT,'127.0.0.1',resolve).once('error',reject));
}
async function worker(){
  await fs.mkdir(LOG_DIR,{recursive:true});
  const state=await loadState();
  await serve(state);
  for(;;){
    try{
      await tick(state);
      await writeHealth({nextPackAt:state.nextPackAt,orderWindowUntil:state.orderWindowUntil,pending:state.queue.filter(x=>x.status==='pending').length});
    }catch(error){
      await writeHealth({ok:false,error:clean(error?.message||error).slice(0,400)}).catch(()=>{});
    }
    await sleep(60_000);
  }
}
async function alive(pid){try{if(!pid||pid<2)return false;process.kill(pid,0);return true}catch{return false}}
async function stop(pid){
  if(!(await alive(pid)))return;
  try{process.kill(pid,'SIGTERM')}catch{}
  for(let i=0;i<30;i++){if(!(await alive(pid)))return;await sleep(200)}
  try{process.kill(pid,'SIGKILL')}catch{}
}
async function supervise(){
  await fs.mkdir(LOG_DIR,{recursive:true});
  let child=null,closing=false,backoff=2000;
  const close=async()=>{
    if(closing)return;closing=true;
    if(child&&child.exitCode==null)try{child.kill('SIGTERM')}catch{}
    await fs.rm(PID_FILE,{force:true}).catch(()=>{});
    process.exit(0);
  };
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
  while(!closing){
    const out=fsSync.openSync(OUT_LOG,'a'),err=fsSync.openSync(ERR_LOG,'a');
    child=spawn(process.execPath,[SELF,'--worker'],{cwd:path.dirname(SELF),env:process.env,stdio:['ignore',out,err]});
    await new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve)});
    try{fsSync.closeSync(out)}catch{}try{fsSync.closeSync(err)}catch{}
    child=null;
    if(!closing){await sleep(backoff);backoff=Math.min(60_000,backoff*2)}
  }
}
async function ensureSupervisor(restart=false){
  await fs.mkdir(LOG_DIR,{recursive:true});
  let old=null;try{old=Number(clean(await fs.readFile(PID_FILE,'utf8')))||null}catch{}
  if(old&&await alive(old)){if(!restart)return {ok:true,pid:old,alreadyRunning:true};await stop(old)}
  const out=fsSync.openSync(OUT_LOG,'a'),err=fsSync.openSync(ERR_LOG,'a');
  const child=spawn(process.execPath,[SELF,'--supervise'],{cwd:path.dirname(SELF),env:process.env,detached:true,stdio:['ignore',out,err]});
  child.unref();try{fsSync.closeSync(out)}catch{}try{fsSync.closeSync(err)}catch{}
  await fs.writeFile(PID_FILE,String(child.pid),{mode:0o600});
  await sleep(600);
  if(!(await alive(child.pid)))throw new Error('otaku_manager_supervisor_failed');
  return {ok:true,pid:child.pid,restarted:restart};
}

if(MODE_WORKER)await worker();
else if(MODE_SUPERVISE)await supervise();
else if(MODE_RESTART)console.log(JSON.stringify(await ensureSupervisor(true)));
else console.log(JSON.stringify(await ensureSupervisor(false)));
