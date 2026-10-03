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
const USE_SHARED_TELEGRAM_SESSION=/^(1|true|yes)$/i.test(String(process.env.OTAKU_SHARED_TELEGRAM_SOURCE_ENABLED||'0'));
const PROMOTE_TELEGRAM_GROUPS=/^(1|true|yes)$/i.test(String(process.env.OTAKU_TELEGRAM_GROUP_PROMO_ENABLED||'0'));
const DAILY_MIN_GAP=Math.max(5*60_000,Number(process.env.OTAKU_DAILY_MIN_GAP_MS||20*60_000));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const STICKER_SOURCES=['fr3dc','anime_stickerr','supremacy_sticks','Leonild'];
const CHARACTERS=['Naruto Uzumaki','Sasuke Uchiha','Itachi Uchiha','Gojo Satoru','Sukuna','Monkey D. Luffy','Roronoa Zoro','Levi Ackerman','Eren Yeager','Tanjiro Kamado','Nezuko Kamado','Kakashi Hatake','Madara Uchiha','Obito Uchiha','Killua Zoldyck','Gon Freecss'];
const DUELS=[['Naruto','Sasuke'],['Gojo','Sukuna'],['Luffy','Zoro'],['Itachi','Madara'],['Levi','Eren'],['Tanjiro','Rengoku'],['Killua','Gon'],['Kakashi','Obito'],['Goku','Vegeta'],['Light','L']];
const LIFE=[['TikTok 📱','YouTube 🎬'],['Anime 🎌','Manga 📚'],['Nuit 🌙','Matin ☀️'],['Pouvoir ⚡','Intelligence 🧠'],['Voyage ✈️','Gaming 🎮']];
const RECOMMENDATIONS=[
  {title:'Frieren',query:'Frieren Beyond Journey End anime wallpaper',why:'fantasy calme, émotions fines et personnages qui prennent le temps d’exister'},
  {title:'Vinland Saga',query:'Vinland Saga anime wallpaper',why:'une histoire de vengeance qui devient une vraie réflexion sur la force et la paix'},
  {title:'Mob Psycho 100',query:'Mob Psycho 100 anime wallpaper',why:'animation folle, humour et développement personnel beaucoup plus profond qu’il n’y paraît'},
  {title:'86 EIGHTY-SIX',query:'86 Eighty Six anime wallpaper',why:'guerre, tension, émotion et une réalisation qui sait frapper au bon moment'},
  {title:'Violet Evergarden',query:'Violet Evergarden anime wallpaper',why:'une claque visuelle avec des épisodes capables de faire très mal sans forcer'},
  {title:'Erased',query:'Erased Boku dake ga Inai Machi anime wallpaper',why:'mystère, voyage temporel et suspense compact qui se binge très bien'},
  {title:'Cyberpunk Edgerunners',query:'Cyberpunk Edgerunners anime wallpaper',why:'court, brutal, stylé et émotionnellement dangereux'},
  {title:'Monster',query:'Monster anime Johan Tenma wallpaper',why:'thriller psychologique lent mais redoutable si tu aimes les histoires qui te travaillent'},
  {title:'Blue Lock',query:'Blue Lock anime wallpaper',why:'compétition, ego et énergie pure quand tu veux quelque chose de nerveux'},
  {title:'Jujutsu Kaisen',query:'Jujutsu Kaisen anime wallpaper',why:'combats propres, cast mémorable et énergie sombre très facile à accrocher'}
];
const MYSTERIES=[
  {name:'Itachi Uchiha',query:'Itachi Uchiha anime wallpaper',clues:['J’ai porté la haine de mon clan presque seul.','Mes yeux ont raconté une histoire que peu ont comprise.','Mon petit frère était au centre de presque tous mes choix.']},
  {name:'Gojo Satoru',query:'Gojo Satoru anime wallpaper',clues:['On me présente souvent comme le plus fort.','Mes yeux sont aussi célèbres que mon sourire.','Une barrière invisible suffit parfois à arrêter ce qui veut me toucher.']},
  {name:'Levi Ackerman',query:'Levi Ackerman anime wallpaper',clues:['Je ne suis pas grand, mais ça n’a jamais rassuré mes ennemis.','La propreté est presque une obsession.','Face aux Titans, ma vitesse parle avant moi.']},
  {name:'Light Yagami',query:'Light Yagami Death Note wallpaper',clues:['J’ai trouvé un carnet qui a changé ma vision de la justice.','Je voulais créer un monde parfait selon mes propres règles.','Un détective à une seule lettre est devenu mon plus grand obstacle.']},
  {name:'Roronoa Zoro',query:'Roronoa Zoro anime wallpaper',clues:['Je me perds même quand le chemin paraît évident.','Trois sabres me vont mieux qu’un.','Mon rêve passe par le sommet des épéistes.']}
];
const DAILY_SLOTS=[
  {key:'morning',hour:7,minute:30,catchUpMinutes:90},
  {key:'programme',hour:9,minute:30,catchUpMinutes:720},
  {key:'recommendation',hour:12,minute:30,catchUpMinutes:600},
  {key:'mystery',hour:15,minute:0,catchUpMinutes:180},
  {key:'wallpaper',hour:18,minute:0,catchUpMinutes:180},
  {key:'night',hour:22,minute:15,catchUpMinutes:120}
];
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
function normalizeKey(value){
  return clean(value).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\u0400-\u04ff]+/g,' ')
    .trim();
}
function isMixedPackMeta(value){
  const raw=clean(value).toLowerCase();
  const norm=normalizeKey(raw);
  return /(?:смешан|микс|разн)/i.test(raw)||
    /\b(?:mixed|mix pack|anime mix|random|assorted|various|multi character|multicharacter|crossover|all anime)\b/i.test(norm);
}
function characterTokens(character){
  const norm=normalizeKey(character);
  const stop=new Set(['anime','the','and','from','chan','kun','san']);
  const strong=norm.split(/\s+/).filter(x=>x.length>=4&&!stop.has(x));
  const compact=norm.replace(/\s+/g,'');
  return [...new Set([compact,...strong].filter(x=>x.length>=4))];
}
function packLooksCharacterSpecific(character,{title='',setName=''}={}){
  const raw=[title,setName].filter(Boolean).join(' ');
  if(!raw||isMixedPackMeta(raw))return false;
  const norm=normalizeKey(raw);
  const compact=norm.replace(/\s+/g,'');
  const tokens=characterTokens(character);
  if(!tokens.length)return false;
  return tokens.some(token=>compact.includes(token.replace(/\s+/g,''))||norm.split(/\s+/).includes(token));
}
function safePackFileBase(value){
  return normalizeKey(value).replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').slice(0,48)||'otaku-pack';
}
function unicodeUnderline(value){
  return Array.from(String(value??'')).map(ch=>/\s/.test(ch)?ch:ch+'\u0332').join('');
}
const rand=a=>a[Math.floor(Math.random()*a.length)];
const nowIso=()=>new Date().toISOString();
const digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
function stablePick(list,key){
  if(!Array.isArray(list)||!list.length)return null;
  const n=parseInt(digest(key).slice(0,8),16);
  return list[n%list.length];
}
function stableShuffle(list,key){
  return [...list].sort((a,b)=>digest(key+'|'+String(a)).localeCompare(digest(key+'|'+String(b))));
}

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
      dailyDone:x.dailyDone&&typeof x.dailyDone==='object'?x.dailyDone:{},
      lastDailyPostAt:Number(x.lastDailyPostAt)||0,
      choiceSession:x.choiceSession&&typeof x.choiceSession==='object'?x.choiceSession:null,
      history:Array.isArray(x.history)?x.history.slice(-250):[]
    };
  }catch{
    return {nextPackAt:Date.now()+10*60_000,orderWindowUntil:0,autoPacks:0,queue:[],seen:[],recent:[],lastQuizDay:'',lastChoiceDay:'',dailyDone:{},lastDailyPostAt:0,choiceSession:null,history:[]};
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
function otakuBold(value){
  return String(value??'').normalize('NFD').replace(/[A-Za-z0-9]/g,ch=>{
    const code=ch.codePointAt(0);
    if(code>=65&&code<=90)return String.fromCodePoint(0x1D5D4+(code-65));
    if(code>=97&&code<=122)return String.fromCodePoint(0x1D5EE+(code-97));
    return String.fromCodePoint(0x1D7EC+(code-48));
  });
}
async function packCaption(character,count){
  const prompt=[
    'Tu prépares le texte central d une annonce Otaku Nexus pour un pack WhatsApp de '+count+' stickers sur '+character+'.',
    'Le cadre visuel est imposé ailleurs: ne fournis AUCUN emoji, aucune décoration Unicode, aucun hashtag, aucun crédit et aucun markdown.',
    'Le texte doit être spécifique au personnage et à son anime, jamais générique.',
    'JSON uniquement: {"intro":"une phrase française de 12 à 28 mots qui présente le personnage, son anime et son aura","traits":["trait 1","trait 2","trait 3"],"share":"une courte phrase de 7 à 18 mots qui donne envie à un fan de partager le pack"}.',
    'traits doit contenir exactement trois expressions courtes adaptées au personnage.'
  ].join(' ');
  const j=await aiJson(prompt);
  const intro=clean(j?.intro)||('Le charisme de '+character+' débarque dans vos conversations');
  const traits=Array.isArray(j?.traits)?j.traits.map(clean).filter(Boolean).slice(0,3):[];
  while(traits.length<3)traits.push(['son style','son énergie','son aura'][traits.length]);
  const share=clean(j?.share)||('un personnage pareil, ça ne se garde pas pour soi.');
  const name=otakuBold(character.toUpperCase());
  const first=otakuBold(intro.replace(/[.!…]+$/,'')+'… le pack '+character+' est enfin là.');
  const second=otakuBold('Ajoute-les à ton WhatsApp et ramène un peu de '+traits[0]+', de '+traits[1]+' et de '+traits[2]+' dans tes messages.');
  const third=otakuBold('Tu connais un fan de '+character+' ? Partage-lui le pack… '+share.replace(/^[.!…\s]+/,''));
  return [
    'ㅤㅤㅤㅤ︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤׄ💜ㅤ᷼︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤ',
    'ׄ       ׄ ⭐ᩧꫬ   𝗢𝗧𝗔𝗞𝗨   𝗡𝗘𝗫𝗨𝗦   𝗦𝗧𝗜𝗖𝗞𝗘𝗥   𝗣𝗔𝗖𝗞   —   '+name+'   💜✨   ׅ   ꒱ ꒱',
    '☁️ׄ ︵ ׅ 🌸 '+first+' ⭐🖤',
    '꒰ ꒰  ּ 🎴 '+second+' 💜✨',
    '☁️ׄ ︵ ׅ 🔁 '+third+' 😭⭐',
    'ׄ       ׄ 💜ᩧꫬ   𝗢𝗧𝗔𝗞𝗨   𝗡𝗘𝗫𝗨𝗦   ×   '+name+'   —   𝗟𝗘   𝗣𝗔𝗖𝗞   𝗘𝗦𝗧   𝗔̀   𝗩𝗢𝗨𝗦   ⭐🔥   ׅ',
    '©ׄ 🦇゙᷼ ‌ 『 ᴏᴛᴀᴋᴜ ɴᴇxᴜs 🖤 』 ᰍ'
  ].join('\n\n');
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
async function stickerSetFiles(name,dir,start,limit,expectedCharacter=''){
  if(limit<=0||!BOT_TOKEN)return [];
  const set=await botApi('getStickerSet',{name});
  if(expectedCharacter&&!packLooksCharacterSpecific(expectedCharacter,{title:clean(set?.title),setName:name}))return [];
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
  for(const quality of [64,52,40,30,22]){
    await run('/usr/bin/ffmpeg',[
      '-hide_banner','-loglevel','error','-i',input,
      '-vf','scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
      '-frames:v','1','-vcodec','libwebp','-lossless','0','-compression_level','6','-q:v',String(quality),'-an','-y',out
    ],{timeout:45000,maxBuffer:1024*1024});
    const st=await fs.stat(out);
    if(st.isFile()&&st.size>=500&&st.size<=100*1024)return out;
  }
  throw new Error('invalid_sticker_whatsapp_size');
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
  return {
    time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),
    day:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()
  };
}
function makeZip(files){
  const locals=[],centrals=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name),data=Buffer.from(file.data);
    const crc=crc32(data),stamp=dosTimeDate();
    const local=Buffer.alloc(30+name.length);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(stamp.time,10);local.writeUInt16LE(stamp.day,12);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);name.copy(local,30);
    locals.push(local,data);
    const central=Buffer.alloc(46+name.length);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);
    central.writeUInt16LE(stamp.time,12);central.writeUInt16LE(stamp.day,14);central.writeUInt32LE(crc,16);
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
async function buildWastickersFile(character,stickers,dir){
  const rows=Array.isArray(stickers)?stickers.slice(0,30):[];
  if(rows.length<3)throw new Error('wastickers_not_enough_stickers');
  const tray=path.join(dir,'cover.png');
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',rows[0].localPath,
    '-vf','scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
    '-frames:v','1','-compression_level','9','-y',tray
  ],{timeout:30000,maxBuffer:1024*1024});
  const trayBytes=await fs.readFile(tray);
  if(trayBytes.length>50*1024)throw new Error('wastickers_cover_too_large');
  const files=[
    {name:'title.txt',data:Buffer.from('Otaku Nexus · '+character,'utf8')},
    {name:'author.txt',data:Buffer.from('Otaku Nexus','utf8')},
    {name:'cover.png',data:trayBytes}
  ];
  for(let i=0;i<rows.length;i++){
    const b=await fs.readFile(rows[i].localPath);
    if(!isWebp(b)||b.length>100*1024)throw new Error('wastickers_invalid_sticker_'+(i+1));
    files.push({name:'sticker_'+String(i+1).padStart(2,'0')+'.webp',data:b});
  }
  const out=path.join(dir,safePackFileBase(character)+'.wastickers');
  await fs.writeFile(out,makeZip(files));
  return out;
}
async function telegramStickers(character,dir,limit){
  const c=await telegramClient();if(!c)return [];
  const out=[];let n=0;
  const tokens=characterTokens(character);
  try{
    for(const source of STICKER_SOURCES){
      if(out.length>=limit)break;
      let entity;try{entity=await c.getEntity('@'+source)}catch{continue}
      let rows=[];try{rows=await c.getMessages(entity,{limit:180})}catch{continue}
      rows.sort((a,b)=>Number(tokens.some(t=>normalizeKey(clean(b?.message)).includes(t)))-Number(tokens.some(t=>normalizeKey(clean(a?.message)).includes(t))));
      const usedSets=new Set();
      for(const message of rows){
        if(out.length>=limit)break;
        const messageText=normalizeKey(clean(message?.message));
        const messageHit=tokens.some(t=>messageText.includes(t));

        for(const setName of stickerSetNames(message)){
          if(out.length>=limit||usedSets.has(setName))break;
          usedSets.add(setName);
          try{
            const setRows=await stickerSetFiles(setName,dir,n,limit-out.length,character);
            n+=setRows.length;
            out.push(...setRows);
          }catch{}
        }
        if(out.length>=limit)break;
        if(!messageHit||!isSticker(message))continue;

        const ext=clean(message.document?.mimeType).includes('webm')?'.webm':'.webp';
        const raw=path.join(dir,'tg-'+source+'-'+String(message.id)+ext);
        try{
          const dl=await c.downloadMedia(message.media,{outputFile:raw,workers:1});
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
async function publicStickerSetNames(query=''){
  const names=[];
  for(const source of [...STICKER_SOURCES].sort(()=>Math.random()-.5)){
    try{
      const url='https://t.me/s/'+encodeURIComponent(source)+(query?'?q='+encodeURIComponent(query):'');
      const r=await fetch(url,{
        headers:{'user-agent':'Mozilla/5.0 Chrome/136','accept-language':'en-US,en;q=0.9'},
        signal:AbortSignal.timeout(18_000)
      });
      if(!r.ok)continue;
      const html=await r.text();
      const re=/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]{3,})/g;
      let m;
      while((m=re.exec(html))&&names.length<24){
        if(!names.includes(m[1]))names.push(m[1]);
      }
    }catch{}
    if(names.length>=24)break;
  }
  return names;
}
async function publicTelegramStickerPack(character,dir,limit){
  const names=await publicStickerSetNames(character);
  for(const setName of names.slice(0,24)){
    try{
      const set=await botApi('getStickerSet',{name:setName});
      if(!Array.isArray(set?.stickers)||!set.stickers.length)continue;
      if(!packLooksCharacterSpecific(character,{title:clean(set.title),setName}))continue;
      const stickers=await stickerSetFiles(setName,dir,0,limit,character);
      if(stickers.length>=MIN_STICKERS){
        return {stickers,title:character,sourceTitle:clean(set.title),setName};
      }
    }catch{}
  }
  return {stickers:[],title:character,sourceTitle:'',setName:''};
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
  const canonical=clean(character);
  if(!canonical)throw new Error('character_required');
  const dir=path.join(TMP_DIR,'pack-'+Date.now()+'-'+digest(canonical).slice(0,6));
  await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});

  const publicPack=await publicTelegramStickerPack(canonical,dir,MAX_STICKERS);
  let fromTelegram=[...(publicPack.stickers||[])];
  if(fromTelegram.length<MIN_STICKERS&&USE_SHARED_TELEGRAM_SESSION){
    try{fromTelegram.push(...await telegramStickers(canonical,dir,MAX_STICKERS-fromTelegram.length))}catch{}
  }
  const stickers=fromTelegram.slice(0,MAX_STICKERS);
  if(stickers.length<MIN_STICKERS)throw new Error('no_character_specific_pack_'+safePackFileBase(canonical)+'_'+stickers.length);

  const cover=path.join(dir,'cover.jpg');
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',stickers[0].localPath,
    '-vf','scale=900:900:force_original_aspect_ratio=decrease,pad=900:900:(ow-iw)/2:(oh-ih)/2:color=black',
    '-frames:v','1','-q:v','2','-y',cover
  ],{timeout:30000,maxBuffer:1024*1024});
  const packFile=await buildWastickersFile(canonical,stickers,dir);
  return {dir,stickers,cover,packFile,title:canonical,setName:publicPack.setName||'',sourceTitle:publicPack.sourceTitle||''};
}
async function publishPack(character,state,reason){
  const canonical=clean(character);
  const pack=await buildPack(canonical);
  const caption=await packCaption(canonical,pack.stickers.length);
  await action({
    kind:'pack',
    id:'otaku-pack:'+Date.now()+':'+digest(canonical).slice(0,6),
    character:canonical,
    caption,
    cover:{localPath:pack.cover,fileName:'cover.jpg'},
    pack:{localPath:pack.packFile,fileName:safePackFileBase(canonical)+'.wastickers',mimetype:'application/zip'},
    count:pack.stickers.length
  },10*60_000);
  state.recent.push(canonical);state.recent=state.recent.slice(-12);
  state.history.push({at:nowIso(),type:'pack',reason,character:canonical,count:pack.stickers.length,setName:pack.setName||'',sourceTitle:pack.sourceTitle||''});
  state.history=state.history.slice(-250);

  if(PROMOTE_TELEGRAM_GROUPS){
    void promotePackToManagedGroups(canonical,pack.cover,pack.stickers.length)
      .then(x=>{state.history.push({at:nowIso(),type:'promo',character:canonical,sent:Number(x?.sent||0)});state.history=state.history.slice(-250);return saveState(state)})
      .catch(()=>{});
  }
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
async function jikanImage(kind,name){
  const endpoint=kind==='character'?'characters':'anime';
  const r=await fetch('https://api.jikan.moe/v4/'+endpoint+'?q='+encodeURIComponent(clean(name))+'&limit=1',{
    headers:{'user-agent':'OtakuNexus/1.0'},signal:AbortSignal.timeout(15000)
  }).catch(()=>null);
  if(!r?.ok)return '';
  const j=await r.json().catch(()=>null);
  const row=Array.isArray(j?.data)?j.data[0]:null;
  return clean(row?.images?.webp?.large_image_url||row?.images?.jpg?.large_image_url||row?.images?.webp?.image_url||row?.images?.jpg?.image_url);
}
async function imagePost(id,query,text,fallback=null){
  let urls=[];
  try{urls=await pinterestImages(query,20)}catch{}
  const candidates=[...new Set(urls.map(clean).filter(Boolean))].slice(0,10);
  if(fallback?.name){
    const fb=await jikanImage(fallback.kind||'anime',fallback.name);
    if(fb&&!candidates.includes(fb))candidates.push(fb);
  }
  if(!candidates.length)throw new Error('otaku_image_required:'+id);
  for(const imageUrl of candidates){
    const out=await action({kind:'image',id,imageUrl,text});
    if(!out?.duplicate)return imageUrl;
    // Same logical id means this exact slot was already published: do not
    // replace it with another image and accidentally create a second post.
    if(out?.dedupReason==='id'||out?.dedupReason==='content')return imageUrl;
    // Exact media duplicate from an older publication: try the next candidate.
    if(out?.dedupReason!=='media')return imageUrl;
  }
  throw new Error('otaku_fresh_image_required:'+id);
}
async function runQuiz(state,slot){
  const id='quiz-'+dayKey()+'-'+slot;
  await imagePost(id+':intro','anime quiz characters collage wallpaper','✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs · ǫᴜɪᴢ\n\n3 blocs : facile → intermédiaire → difficile.\nChaque bonne réponse compte pour le classement final.\n\nDépart dans 5 minutes. 🔥',{kind:'anime',name:'Jujutsu Kaisen'});
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
async function startChoices(state){
  const id='choice-'+dayKey();
  await action({kind:'text',id:id+':intro',text:'✦ ᴏᴛᴀᴋᴜ ɴᴇxᴜs · ᴛᴜ ᴘʀᴇ́ғᴇ̀ʀᴇs ?\n\n15 choix. Un nouveau duel toutes les 15 minutes. 👀'});
  state.choiceSession={id,index:0,nextAt:Date.now()+60_000,day:dayKey()};
  state.history.push({at:nowIso(),type:'choice-marathon-start',id});
}
async function advanceChoices(state){
  const s=state.choiceSession;
  if(!s||Date.now()<Number(s.nextAt||0))return false;
  const i=Number(s.index||0);
  if(i>=15){
    await action({kind:'text',id:s.id+':end',text:'✦ ғɪɴ ᴅᴜ ᴊᴇᴜ\n\n15 choix terminés. Quel duel tu veux revoir ?'});
    state.lastChoiceDay=s.day||dayKey();
    state.history.push({at:nowIso(),type:'choice-marathon-done',id:s.id});
    state.choiceSession=null;
    return true;
  }
  const pool=i%3===2?LIFE:DUELS;
  const pair=stablePick(pool,s.id+':pair:'+i);
  if(i%3!==2)await imagePost(s.id+':img:'+i,pair[0]+' '+pair[1]+' anime wallpaper together','✦ '+pair[0]+'  VS  '+pair[1],{kind:'anime',name:pair[0]});
  await action({kind:'poll',id:s.id+':poll:'+i,question:'Tu préfères ?',options:pair,quiz:false});
  s.index=i+1;
  s.nextAt=Date.now()+CHOICE_GAP;
  return true;
}
function slotStamp(slot,day=dayKey()){return day+':'+slot.key}
function minutesNow(){const p=localParts();return p.h*60+p.min}
function timeWindowDue(hour,minute,catchUpMinutes){
  const elapsed=minutesNow()-(hour*60+minute);
  return elapsed>=0&&elapsed<=catchUpMinutes;
}
function slotDue(slot,state){
  const stamp=slotStamp(slot);
  if(state.dailyDone?.[stamp])return false;
  const now=minutesNow(),target=slot.hour*60+slot.minute,elapsed=now-target;
  return elapsed>=0&&elapsed<=slot.catchUpMinutes;
}
function markDaily(state,slot,status='sent'){
  const stamp=slotStamp(slot);
  state.dailyDone={...(state.dailyDone||{}),[stamp]:{at:nowIso(),status}};
  const keys=Object.keys(state.dailyDone).sort();
  for(const k of keys.slice(0,Math.max(0,keys.length-24)))delete state.dailyDone[k];
  state.lastDailyPostAt=Date.now();
}
function programmeText(){
  const p=localParts();
  const today=p.d%2===0?'Quiz Otaku':'Tu préfères + Quiz Otaku';
  return [
    '【🗞️】𝗣𝗥𝗢𝗚𝗥𝗔𝗠𝗠𝗘 𝗢𝗧𝗔𝗞𝗨 𝗡𝗘𝗫𝗨𝗦',
    '',
    '☁️ 07:30 · ᴍᴏʀɴɪɴɢ ᴠɪʙᴇ',
    '🎴 09:30 · programme du jour',
    '🍿 12:30 · recommandation anime',
    '🧩 15:00 · personnage mystère',
    '🖼️ 18:00 · wallpaper drop',
    '🎮 '+today,
    '💜 stickers · drop automatique + commandes communauté',
    '🌙 22:15 · ɴɪɢʜᴛ ᴠɪʙᴇ',
    '',
    'Les horaires peuvent légèrement bouger si un jeu est déjà en cours.'
  ].join('\n');
}
async function runDailySlot(state,slot){
  if(slot.key==='morning'){
    const texts=[
      '☁️ׄ ︵ ׅ ɢᴏᴏᴅ ᴍᴏʀɴɪɴɢ ᴏᴛᴀᴋᴜѕ 𖹭\n\nEncore une journée à faire semblant d’être productif avant de rentrer regarder des animes 😭\n\nㅤㅤׄ 🌼 bonne journée la team.',
      '𓂃 ࣪˖ ᴍᴏʀɴɪɴɢ ᴄʜᴇᴄᴋ ☀️\n\nObjectif du jour : survivre, manger, avancer un peu… et garder au moins un épisode pour ce soir. 😭'
    ];
    await action({kind:'text',id:'daily:'+slotStamp(slot),text:rand(texts)});
  }else if(slot.key==='programme'){
    await action({kind:'text',id:'daily:'+slotStamp(slot),text:programmeText()});
  }else if(slot.key==='recommendation'){
    const id='daily:'+slotStamp(slot);
    const r=stablePick(RECOMMENDATIONS,id);
    const text=[
      'ㅤ︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤׄ💜ㅤ᷼︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤ',
      '𓂃 ࣪˖ 🍿  𝗥𝗘𝗖𝗢  𝗢𝗧𝗔𝗞𝗨  𖹭',
      '',
      '✦ '+otakuBold(r.title.toUpperCase()),
      '╰─ '+unicodeUnderline('À VOIR / À GARDER'),
      '',
      '💜 '+otakuBold('POURQUOI LE TENTER ?'),
      '☁️ '+r.why+'.',
      '',
      '✨ Vote juste en dessous — pas de question laissée sans choix.'
    ].join('\n');
    await imagePost(id,r.query,text,{kind:'anime',name:r.title});
    await action({kind:'poll',id:id+':poll',question:'💜 '+r.title+' — tu choisis quoi ?',options:['✅ Déjà vu','📌 Dans ma liste','👀 Pas encore'],quiz:false});
  }else if(slot.key==='mystery'){
    const id='daily:'+slotStamp(slot);
    const m=stablePick(MYSTERIES,id);
    const wrong=stableShuffle(MYSTERIES.filter(x=>x.name!==m.name),id+':wrong').slice(0,3).map(x=>x.name);
    const options=stableShuffle([m.name,...wrong],id+':options');
    const text=[
      'ㅤ︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤׄ🖤ㅤ᷼︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤ',
      '𖦹  𝐏𝐄𝐑𝐒𝐎𝐍𝐍𝐀𝐆𝐄  𝐌𝐘𝐒𝐓È𝐑𝐄  🧩',
      '',
      '☁️ '+otakuBold('INDICE 01')+' — '+m.clues[0],
      '☁️ '+otakuBold('INDICE 02')+' — '+m.clues[1],
      '☁️ '+otakuBold('INDICE 03')+' — '+m.clues[2],
      '',
      '💜 '+unicodeUnderline('TA RÉPONSE DANS LE SONDAGE')
    ].join('\n');
    await imagePost(id,m.query+' silhouette dark',text,{kind:'character',name:m.name});
    await action({kind:'poll',id:id+':poll',question:'🧩 Qui se cache derrière les indices ?',options,quiz:true,correctAnswer:m.name,sessionId:id});
  }else if(slot.key==='wallpaper'){
    const r=stablePick(RECOMMENDATIONS,'daily:'+slotStamp(slot));
    const text=[
      '☾ ׄ  𝗪𝗔𝗟𝗟𝗣𝗔𝗣𝗘𝗥  𝗗𝗥𝗢𝗣  𓏼',
      '',
      '💜 '+otakuBold(r.title.toUpperCase()),
      '╰─ '+unicodeUnderline('SAVE IT • SET IT • KEEP THE VIBE'),
      '',
      '☁️ Un écran propre, une vibe anime, zéro post vide. 🖤✨'
    ].join('\n');
    await imagePost('daily:'+slotStamp(slot),r.query+' 4k vertical phone wallpaper',text,{kind:'anime',name:r.title});
  }else if(slot.key==='night'){
    const texts=[
      'ㅤ︵︵ ׄ 🌙 ׅ ︵︵\n\nׄ      ɴɪɢʜᴛ ᴠɪʙᴇѕ 𓏼\n\nLes écouteurs. Une OST. La lumière éteinte.\n\nEt soudain, la journée fait un peu moins de bruit.\n\nBonne nuit Otaku Nexus.',
      '𓂃 ࣪˖ ɴɪɢʜᴛ ᴄʜᴇᴄᴋ 🌙\n\nPour ce soir : choisis l’anime que tu pourrais recommencer sans hésiter, lance l’OST et coupe le bruit. 🖤'
    ];
    await action({kind:'text',id:'daily:'+slotStamp(slot),text:rand(texts)});
  }
  markDaily(state,slot);
  state.history.push({at:nowIso(),type:'daily',slot:slot.key});
  state.history=state.history.slice(-250);
  return true;
}
async function maybeDaily(state){
  if(Date.now()-Number(state.lastDailyPostAt||0)<DAILY_MIN_GAP)return false;
  const due=DAILY_SLOTS.filter(slot=>slotDue(slot,state));
  if(!due.length)return false;
  // Programme and recommendation are the two editorial pillars the channel
  // must catch up on after downtime; then continue with the most recent slot.
  due.sort((a,b)=>{
    const priority={programme:0,recommendation:1};
    const pa=priority[a.key]??2,pb=priority[b.key]??2;
    if(pa!==pb)return pa-pb;
    return (b.hour*60+b.minute)-(a.hour*60+a.minute);
  });
  await runDailySlot(state,due[0]);
  return true;
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
  if(await advanceChoices(state)){await saveState(state);return}
  // Interactive sessions must survive restarts and temporary downtime.
  // Catch up for hours instead of requiring the worker to be alive during
  // the first eight minutes of one exact clock hour.
  if(state.lastChoiceDay!==day&&p.d%2===1&&timeWindowDue(16,0,4*60)&&!state.choiceSession){
    await startChoices(state);await saveState(state);return;
  }
  if(state.lastQuizDay!==day&&timeWindowDue(quizHour,0,3*60)){
    await runQuiz(state,String(quizHour));await saveState(state);return;
  }
  if(await maybeDaily(state)){await saveState(state);return}
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
        return res.end(JSON.stringify({ok:true,pid:process.pid,nextPackAt:state.nextPackAt,orderWindowUntil:state.orderWindowUntil,pending:state.queue.filter(x=>x.status==='pending').length,lastDailyPostAt:state.lastDailyPostAt||0,choiceSession:state.choiceSession||null,dailyDone:Object.keys(state.dailyDone||{}).slice(-12)}));
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
