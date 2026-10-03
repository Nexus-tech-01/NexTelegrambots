import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
  canonicalDisplayName,
  fallbackWishlistCandidate,
  packLooksCharacterSpecific,
  STICK_GOOD_MOODS,
  stickGoodPackName,
  stickGoodPresentation,
  wishlistText
} from './stick-good-core.mjs';

const run=promisify(execFile);
const SELF=fileURLToPath(import.meta.url);
const MODE_WORKER=process.argv.includes('--worker');
const MODE_SUPERVISE=process.argv.includes('--supervise');
const MODE_RESTART=process.argv.includes('--restart-supervisor');
const PORT=Math.max(1024,Number(process.env.STICK_GOOD_PORT||18815));
const STATE_DIR=String(process.env.STICK_GOOD_STATE_DIR||'/var/lib/nex/state/internal-automation/stick-good');
const TMP_DIR=String(process.env.STICK_GOOD_TMP_DIR||'/var/lib/nex/tmp/internal-automation/stick-good');
const STATE_FILE=path.join(STATE_DIR,'state.json');
const HEALTH_FILE=path.join(STATE_DIR,'health.json');
const PID_FILE=path.join(STATE_DIR,'supervisor.pid');
const LOG_DIR=path.join(STATE_DIR,'logs');
const OUT_LOG=path.join(LOG_DIR,'worker.log');
const ERR_LOG=path.join(LOG_DIR,'worker.err.log');
const WA=String(process.env.STICK_GOOD_WA_BRIDGE||'http://127.0.0.1:18787').replace(/\/$/,'');
const AI_BRIDGE=String(process.env.STICK_GOOD_AI_BRIDGE||process.env.OTAKU_AI_BRIDGE||'http://127.0.0.1:3220/v1/chat/completions').trim();
const BOT_TOKEN=String(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const PACK_INTERVAL=Math.max(60*60_000,Number(process.env.STICK_GOOD_PACK_INTERVAL_MS||2*60*60_000));
const WISHLIST_WINDOW=Math.max(60*60_000,Number(process.env.STICK_GOOD_WISHLIST_WINDOW_MS||12*60*60_000));
const AUTOS_BEFORE_WISHLIST=Math.max(1,Math.min(12,Number(process.env.STICK_GOOD_AUTOS_BEFORE_WISHLIST||3)));
const MAX_STICKERS=30;
const MIN_TELEGRAM_STICKERS=Math.max(5,Math.min(30,Number(process.env.STICK_GOOD_MIN_TELEGRAM_STICKERS||12)));
const FIRST_RUN_DELAY=Math.max(60_000,Number(process.env.STICK_GOOD_FIRST_RUN_DELAY_MS||10*60_000));
const ENABLED=!/^(0|false|no)$/i.test(String(process.env.STICK_GOOD_ENABLED||'1'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const STICKER_SOURCES=[
  'fr3dc','anime_stickerr','supremacy_sticks','Leonild',
  'stickerspackanime','stickeranimepack','Sticker_San','stickersChannel',
  'stickersofanime','anak_kucing_stiker','line_stickers'
];
const AUTO_CHARACTERS=[
  {name:'Satoru Gojo',medium:'anime'},{name:'Naruto Uzumaki',medium:'anime'},
  {name:'Monkey D. Luffy',medium:'anime'},{name:'Itachi Uchiha',medium:'anime'},
  {name:'Levi Ackerman',medium:'anime'},{name:'Mikasa Ackerman',medium:'anime'},
  {name:'Sukuna',medium:'anime'},{name:'Megumi Fushiguro',medium:'anime'},
  {name:'Yuji Itadori',medium:'anime'},{name:'Kakashi Hatake',medium:'anime'},
  {name:'Sasuke Uchiha',medium:'anime'},{name:'Hinata Hyuga',medium:'anime'},
  {name:'Nezuko Kamado',medium:'anime'},{name:'Tanjiro Kamado',medium:'anime'},
  {name:'Kyojuro Rengoku',medium:'anime'},{name:'Killua Zoldyck',medium:'anime'},
  {name:'Gon Freecss',medium:'anime'},{name:'Kurapika',medium:'anime'},
  {name:'Hisoka Morow',medium:'anime'},{name:'Eren Yeager',medium:'anime'},
  {name:'Power',medium:'anime'},{name:'Makima',medium:'anime'},
  {name:'Denji',medium:'anime'},{name:'Aki Hayakawa',medium:'anime'},
  {name:'Frieren',medium:'anime'},{name:'Fern',medium:'anime'},
  {name:'Sung Jinwoo',medium:'anime'},{name:'Cha Hae-In',medium:'anime'},
  {name:'Marin Kitagawa',medium:'anime'},{name:'Zero Two',medium:'anime'},
  {name:'Anya Forger',medium:'anime'},{name:'Yor Forger',medium:'anime'},
  {name:'Loid Forger',medium:'anime'},{name:'Light Yagami',medium:'anime'},
  {name:'L Lawliet',medium:'anime'},{name:'Ichigo Kurosaki',medium:'anime'},
  {name:'Rukia Kuchiki',medium:'anime'},{name:'Goku',medium:'anime'},
  {name:'Vegeta',medium:'anime'},{name:'Bulma',medium:'anime'},
  {name:'Katherine Pierce',medium:'series'},{name:'Damon Salvatore',medium:'series'},
  {name:'Stefan Salvatore',medium:'series'},{name:'Elena Gilbert',medium:'series'},
  {name:'Wednesday Addams',medium:'series'},{name:'Eleven',medium:'series'},
  {name:'Thomas Shelby',medium:'series'},{name:'Homelander',medium:'series'},
  {name:'Daenerys Targaryen',medium:'series'},{name:'Jon Snow',medium:'series'},
  {name:'Darth Vader',medium:'film'},{name:'Spider-Man',medium:'film'},
  {name:'Deadpool',medium:'film'},{name:'Harley Quinn',medium:'film'},
  {name:'Batman',medium:'film'},{name:'Joker',medium:'film'},
  {name:'Hermione Granger',medium:'film'},{name:'Harry Potter',medium:'film'}
];

const clean=v=>String(v??'').trim();
const nowIso=()=>new Date().toISOString();
const digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const rand=a=>a[Math.floor(Math.random()*a.length)];

async function loadState(){
  try{
    const x=JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    return {
      nextPackAt:Number(x.nextPackAt)||Date.now()+FIRST_RUN_DELAY,
      autoPacks:Number(x.autoPacks)||0,
      queue:Array.isArray(x.queue)?x.queue.slice(-300):[],
      seen:Array.isArray(x.seen)?x.seen.slice(-2500):[],
      recent:Array.isArray(x.recent)?x.recent.slice(-30):[],
      activeWishlist:x.activeWishlist&&typeof x.activeWishlist==='object'?x.activeWishlist:null,
      history:Array.isArray(x.history)?x.history.slice(-500):[]
    };
  }catch{
    return {nextPackAt:Date.now()+FIRST_RUN_DELAY,autoPacks:0,queue:[],seen:[],recent:[],activeWishlist:null,history:[]};
  }
}
async function saveState(s){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const tmp=STATE_FILE+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(s,null,2),{mode:0o600});
  await fs.rename(tmp,STATE_FILE);
}
async function writeHealth(state,extra={}){
  await fs.mkdir(STATE_DIR,{recursive:true});
  const payload={
    ok:true,pid:process.pid,enabled:ENABLED,updatedAt:nowIso(),
    nextPackAt:state.nextPackAt,autoPacks:state.autoPacks,
    pending:state.queue.filter(x=>x.status==='pending').length,
    wishlist:state.activeWishlist?{
      openedAt:state.activeWishlist.openedAt,
      expiresAt:state.activeWishlist.expiresAt,
      validRequests:Number(state.activeWishlist.validRequests||0)
    }:null,
    ...extra
  };
  const tmp=HEALTH_FILE+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(payload,null,2),{mode:0o600});
  await fs.rename(tmp,HEALTH_FILE);
}

async function action(payload,timeout=10*60_000){
  const r=await fetch(WA+'/stick-good/action',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j?.ok===false)throw new Error('stick_good_action_'+r.status+': '+clean(j?.error||'failed'));
  return j;
}

function parseJson(text){
  const raw=clean(text),i=raw.indexOf('{'),j=raw.lastIndexOf('}');
  if(i<0||j<=i)throw new Error('ai_json_missing');
  return JSON.parse(raw.slice(i,j+1));
}
function providers(){
  const out=[];
  const g=clean(process.env.GEMINI_API_KEY||process.env.GOOGLE_AI_API_KEY||process.env.NEXAI_GEMINI_API_KEY);
  if(g)out.push({kind:'gemini',key:g,model:clean(process.env.NEXAI_GEMINI_MODEL)||'gemini-2.5-flash'});
  const o=clean(process.env.OPENAI_API_KEY||process.env.NEXAI_OPENAI_API_KEY);
  if(o)out.push({kind:'openai',key:o,model:clean(process.env.NEXAI_OPENAI_MODEL)||'gpt-4o-mini'});
  return out;
}
async function aiJson(prompt){
  try{
    const r=await fetch(AI_BRIDGE,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({
        model:'openrouter/free',messages:[{role:'user',content:prompt}],
        response_format:{type:'json_object'},temperature:.2,max_tokens:700
      }),signal:AbortSignal.timeout(45000)
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
          body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:.2,maxOutputTokens:700}}),
          signal:AbortSignal.timeout(45000)
        });
        const j=await r.json();if(!r.ok)continue;
        return parseJson(clean((j?.candidates?.[0]?.content?.parts||[]).map(x=>x?.text||'').join('')));
      }
      const r=await fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+p.key},
        body:JSON.stringify({model:p.model,messages:[{role:'user',content:prompt}],response_format:{type:'json_object'},temperature:.2,max_tokens:700}),
        signal:AbortSignal.timeout(45000)
      });
      const j=await r.json();if(!r.ok)continue;
      return parseJson(clean(j?.choices?.[0]?.message?.content));
    }catch{}
  }
  return null;
}
async function visionJson(prompt,filePath){
  let bytes;try{bytes=await fs.readFile(filePath)}catch{return null}
  if(!bytes?.length||bytes.length>4*1024*1024)return null;
  const data='data:image/webp;base64,'+bytes.toString('base64');
  try{
    const r=await fetch(AI_BRIDGE,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({
        model:'openrouter/free',
        messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:data}}]}],
        response_format:{type:'json_object'},temperature:0,max_tokens:300
      }),signal:AbortSignal.timeout(60000)
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
          body:JSON.stringify({contents:[{role:'user',parts:[
            {text:prompt},{inlineData:{mimeType:'image/webp',data:bytes.toString('base64')}}
          ]}],generationConfig:{responseMimeType:'application/json',temperature:0,maxOutputTokens:300}}),
          signal:AbortSignal.timeout(60000)
        });
        const j=await r.json();if(!r.ok)continue;
        return parseJson(clean((j?.candidates?.[0]?.content?.parts||[]).map(x=>x?.text||'').join('')));
      }
      const r=await fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+p.key},
        body:JSON.stringify({model:p.model,messages:[{role:'user',content:[
          {type:'text',text:prompt},{type:'image_url',image_url:{url:data}}
        ]}],response_format:{type:'json_object'},temperature:0,max_tokens:300}),
        signal:AbortSignal.timeout(60000)
      });
      const j=await r.json();if(!r.ok)continue;
      return parseJson(clean(j?.choices?.[0]?.message?.content));
    }catch{}
  }
  return null;
}
async function visuallyMatches(character,filePath){
  const j=await visionJson(
    'Inspecte cette image pour un pack de stickers mono-personnage. Le personnage cible est "'+character+'". '+
    'Réponds JSON uniquement: {"match":true|false,"singleCharacter":true|false,"confidence":0..1,"otherCharacter":true|false}. '+
    'match=true seulement si le personnage principal est clairement '+character+'. singleCharacter=false si un autre personnage identifiable apparaît aussi.',
    filePath
  );
  if(!j)return false;
  return j.match===true&&j.singleCharacter===true&&j.otherCharacter!==true&&Number(j.confidence)>=0.72;
}

async function classifyWishlist(text){
  const raw=clean(text).slice(0,500);
  if(!raw)return {valid:false};
  const j=await aiJson([
    'Tu analyses une réponse à une question WhatsApp "Quel personnage veux-tu pour le prochain pack de stickers ?".',
    'Comme le contexte est déjà une Wishlist, une réponse courte comme "Gojo stp" ou "Katherine Pierce" est une vraie commande.',
    'Rejette le hors-sujet, les débats, salutations, insultes, spam, URL, demandes sans personnage précis et les phrases qui parlent juste du personnage sans le demander.',
    'S il y a plusieurs personnages, valid=false car chaque pack doit contenir un seul personnage.',
    'Donne le NOM CANONIQUE exact du personnage (ex: "Gojo" -> "Satoru Gojo") et la franchise si connue.',
    'JSON uniquement: {"valid":true|false,"character":"","franchise":"","medium":"anime|film|series|unknown","confidence":0..1}.',
    'Réponse: '+raw
  ].join(' '));
  if(j){
    return {
      valid:j.valid===true&&clean(j.character).length>1&&Number(j.confidence)>=.65,
      character:canonicalDisplayName(j.character).slice(0,90),
      franchise:canonicalDisplayName(j.franchise).slice(0,100),
      medium:['anime','film','series'].includes(clean(j.medium).toLowerCase())?clean(j.medium).toLowerCase():'unknown',
      confidence:Number(j.confidence)||0
    };
  }
  const f=fallbackWishlistCandidate(raw);
  return {...f,franchise:'',medium:'unknown'};
}

async function canonicalAutoChoice(state){
  const recent=new Set(state.recent.slice(-18).map(x=>String(x).toLowerCase()));
  const mood=rand(STICK_GOOD_MOODS);
  const j=await aiJson([
    'Choisis UN personnage très célèbre avec beaucoup de fanarts/images carrées disponibles en ligne pour un pack de stickers.',
    'Il peut venir d un anime, film ou série. Évite ceux-ci récemment publiés: '+[...recent].join(', ')+'.',
    'Ambiance visuelle souhaitée: '+mood+'.',
    'JSON uniquement: {"character":"nom canonique exact","franchise":"oeuvre","medium":"anime|film|series","mood":"'+mood+'"}'
  ].join(' '));
  if(j&&clean(j.character)&&!recent.has(clean(j.character).toLowerCase())){
    return {character:canonicalDisplayName(j.character),franchise:canonicalDisplayName(j.franchise),medium:clean(j.medium)||'unknown',mood};
  }
  const pool=AUTO_CHARACTERS.filter(x=>!recent.has(x.name.toLowerCase()));
  const x=rand(pool.length?pool:AUTO_CHARACTERS);
  return {character:x.name,franchise:'',medium:x.medium,mood};
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
async function normalizeSticker(input,out){
  for(const quality of [68,56,44,34,26,20]){
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
async function imageDimensions(file){
  try{
    const {stdout}=await run('/usr/bin/ffprobe',[
      '-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file
    ],{timeout:15000,maxBuffer:1024*1024});
    const s=JSON.parse(stdout)?.streams?.[0]||{};
    return {width:Number(s.width)||0,height:Number(s.height)||0};
  }catch{return {width:0,height:0}}
}
function pinterestUrls(html){
  const found=[],seen=new Set();
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
async function pinterestImages(query,limit=100){
  const r=await fetch('https://www.pinterest.com/search/pins/?q='+encodeURIComponent(query),{
    headers:{'user-agent':'Mozilla/5.0 Chrome/136','accept-language':'en-US,en;q=0.9'},
    signal:AbortSignal.timeout(25000)
  });
  if(!r.ok)return [];
  return pinterestUrls(await r.text()).slice(0,limit);
}
async function publicStickerSetCandidates(character){
  const out=[],seen=new Set();
  for(const source of [...STICKER_SOURCES].sort(()=>Math.random()-.5)){
    const queries=[character,character.split(/\s+/)[0]].filter(Boolean);
    for(const q of queries){
      try{
        const r=await fetch('https://t.me/s/'+encodeURIComponent(source)+'?q='+encodeURIComponent(q),{
          headers:{'user-agent':'Mozilla/5.0 Chrome/136','accept-language':'en-US,en;q=0.9'},
          signal:AbortSignal.timeout(18000)
        });
        if(!r.ok)continue;
        const html=await r.text();
        const re=/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]{3,})/g;
        let m;
        while((m=re.exec(html))&&out.length<80){
          if(!seen.has(m[1])){seen.add(m[1]);out.push({setName:m[1],source,sourceText:q})}
        }
      }catch{}
      if(out.length>=80)break;
    }
    if(out.length>=80)break;
  }
  return out;
}
async function downloadTelegramSet(character,dir,limit=30){
  if(!BOT_TOKEN)return null;
  const candidates=await publicStickerSetCandidates(character);
  for(const c of candidates){
    try{
      const set=await botApi('getStickerSet',{name:c.setName});
      if(!Array.isArray(set?.stickers)||!set.stickers.length)continue;
      if(!packLooksCharacterSpecific(character,{title:clean(set.title),setName:c.setName,sourceText:c.sourceText}))continue;
      const rows=[];let n=0;
      for(const sticker of set.stickers){
        if(rows.length>=limit)break;
        try{
          const meta=await botApi('getFile',{file_id:sticker.file_id});
          if(!meta?.file_path||/\.tgs$/i.test(meta.file_path))continue;
          const rr=await fetch('https://api.telegram.org/file/bot'+BOT_TOKEN+'/'+meta.file_path,{signal:AbortSignal.timeout(30000)});
          if(!rr.ok)continue;
          const bytes=Buffer.from(await rr.arrayBuffer());
          if(bytes.length<300||bytes.length>10*1024*1024)continue;
          const ext=(meta.file_path.split('.').pop()||'bin').toLowerCase();
          const raw=path.join(dir,'tg-'+safeBase(c.setName)+'-'+n+'.'+ext);
          await fs.writeFile(raw,bytes);
          const target=path.join(dir,'sticker-'+String(n+1).padStart(2,'0')+'.webp');
          await normalizeSticker(raw,target);
          if(!(await visuallyMatches(character,target)))continue;
          rows.push({localPath:target,source:'telegram:@'+c.source,setName:c.setName});
          n++;
        }catch{}
      }
      if(rows.length>=MIN_TELEGRAM_STICKERS){
        return {stickers:rows,source:'telegram',setName:c.setName,sourceTitle:clean(set.title)};
      }
    }catch{}
  }
  return null;
}
async function buildPinterestPack(character,medium,mood,dir){
  const queries=[
    character+' '+mood+' pfp icon 1:1',
    character+' '+mood+' square aesthetic',
    character+' sticker pfp 1:1',
    character+' icon square',
    (medium==='anime'?character+' anime ':character+' ')+'kawaii pfp 1:1'
  ];
  const urls=[],seenUrl=new Set();
  for(const q of queries){
    try{
      for(const u of await pinterestImages(q,120)){
        if(!seenUrl.has(u)){seenUrl.add(u);urls.push(u)}
      }
    }catch{}
    if(urls.length>=260)break;
  }
  const out=[],seenHash=new Set();let seq=0;
  for(const url of urls){
    if(out.length>=MAX_STICKERS)break;
    try{
      const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(18000)});
      if(!r.ok)continue;
      const b=Buffer.from(await r.arrayBuffer());
      if(b.length<5000||b.length>12*1024*1024)continue;
      const h=digest(b);if(seenHash.has(h))continue;seenHash.add(h);
      const raw=path.join(dir,'pin-'+seq+'.img');await fs.writeFile(raw,b);
      const dim=await imageDimensions(raw);
      if(!dim.width||!dim.height)continue;
      const ratio=dim.width/dim.height;
      if(ratio<.86||ratio>1.14||Math.min(dim.width,dim.height)<250)continue;
      const target=path.join(dir,'sticker-'+String(out.length+1).padStart(2,'0')+'.webp');
      await normalizeSticker(raw,target);
      if(!(await visuallyMatches(character,target)))continue;
      out.push({localPath:target,source:'pinterest',sourceUrl:url});
      seq++;
    }catch{}
  }
  if(out.length!==MAX_STICKERS)throw new Error('pinterest_verified_stickers_'+out.length+'_of_30');
  return {stickers:out,source:'pinterest',setName:'',sourceTitle:''};
}
function safeBase(value){
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||'stick-good-pack';
}

const CRC_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}
  return table;
})();
function crc32(buf){let c=0xffffffff;for(const b of buf)c=CRC_TABLE[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0}
function dosTimeDate(date=new Date()){
  const year=Math.max(1980,date.getFullYear());
  return {time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),day:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()};
}
function makeZip(files){
  const locals=[],centrals=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name),data=Buffer.from(file.data),crc=crc32(data),stamp=dosTimeDate();
    const local=Buffer.alloc(30+name.length);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(stamp.time,10);local.writeUInt16LE(stamp.day,12);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(0,28);name.copy(local,30);
    locals.push(local,data);
    const central=Buffer.alloc(46+name.length);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);
    central.writeUInt16LE(stamp.time,12);central.writeUInt16LE(stamp.day,14);central.writeUInt32LE(crc,16);
    central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
    central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);
    central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);name.copy(central,46);
    centrals.push(central);offset+=local.length+data.length;
  }
  const centralSize=centrals.reduce((n,b)=>n+b.length,0),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);
  end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
  return Buffer.concat([...locals,...centrals,end]);
}
async function buildWastickersFile(character,stickers,dir){
  const rows=stickers.slice(0,30);
  const tray=path.join(dir,'cover.png');
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',rows[0].localPath,
    '-vf','scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
    '-frames:v','1','-compression_level','9','-y',tray
  ],{timeout:30000,maxBuffer:1024*1024});
  const files=[
    {name:'title.txt',data:Buffer.from(stickGoodPackName(character),'utf8')},
    {name:'author.txt',data:Buffer.from('Trésor','utf8')},
    {name:'cover.png',data:await fs.readFile(tray)}
  ];
  for(let i=0;i<rows.length;i++){
    const b=await fs.readFile(rows[i].localPath);
    files.push({name:'sticker_'+String(i+1).padStart(2,'0')+'.webp',data:b});
  }
  const out=path.join(dir,safeBase(character)+'.wastickers');
  await fs.writeFile(out,makeZip(files));
  return out;
}
async function makeCover(stickers,dir){
  const out=path.join(dir,'presentation.jpg');
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',stickers[0].localPath,
    '-vf','scale=900:900:force_original_aspect_ratio=decrease,pad=900:900:(ow-iw)/2:(oh-ih)/2:color=black',
    '-frames:v','1','-q:v','2','-y',out
  ],{timeout:30000,maxBuffer:1024*1024});
  return out;
}
async function buildPack(character,medium,mood){
  const dir=path.join(TMP_DIR,'pack-'+Date.now()+'-'+digest(character).slice(0,8));
  await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});
  let built=null;
  try{built=await downloadTelegramSet(character,dir,MAX_STICKERS)}catch{}
  if(!built){
    await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});
    built=await buildPinterestPack(character,medium,mood,dir);
  }
  const cover=await makeCover(built.stickers,dir);
  const packFile=await buildWastickersFile(character,built.stickers,dir);
  return {...built,dir,cover,packFile};
}
async function publishPack(choice,state,reason){
  const character=canonicalDisplayName(choice.character);
  const pack=await buildPack(character,choice.medium||'unknown',choice.mood||rand(STICK_GOOD_MOODS));
  const previewCount=Math.min(pack.stickers.length,5+Math.floor(Math.random()*4));
  const packName=stickGoodPackName(character);
  const out=await action({
    kind:'pack',
    id:'stick-good:'+Date.now()+':'+digest(character).slice(0,8),
    character,packName,publisher:'Trésor',
    caption:stickGoodPresentation(character),
    cover:{localPath:pack.cover,fileName:'presentation.jpg'},
    previews:pack.stickers.slice(0,previewCount).map((x,i)=>({localPath:x.localPath,fileName:'preview-'+String(i+1)+'.webp'})),
    pack:{localPath:pack.packFile,fileName:safeBase(character)+'.wastickers',mimetype:'application/zip'},
    stickerFiles:pack.stickers.map((_,i)=>'sticker_'+String(i+1).padStart(2,'0')+'.webp'),
    count:pack.stickers.length
  });
  state.recent.push(character);state.recent=state.recent.slice(-30);
  state.history.push({at:nowIso(),type:'pack',reason,character,medium:choice.medium||'unknown',count:pack.stickers.length,source:pack.source,setName:pack.setName||'',nativePack:out?.nativePack===true});
  state.history=state.history.slice(-500);
  setTimeout(()=>fs.rm(pack.dir,{recursive:true,force:true}).catch(()=>{}),4*60*60_000).unref?.();
  return {count:pack.stickers.length,nativePack:out?.nativePack===true};
}

async function wishlistImage(){
  for(const q of ['kawaii anime stickers pastel square 1:1','cute anime sticker collage pink purple square','kawaii sticker aesthetic pfp 1:1']){
    try{
      const urls=await pinterestImages(q,30);
      if(urls[0])return urls[0];
    }catch{}
  }
  return '';
}
async function openWishlist(state){
  const imageUrl=await wishlistImage();
  const out=await action({
    kind:'question',
    id:'stick-good-wishlist:'+Date.now(),
    text:wishlistText(),
    ...(imageUrl?{image:{url:imageUrl}}:{})
  },120000);
  const questionId=clean(out?.actionId);
  if(!questionId)throw new Error('wishlist_question_missing_id');
  state.activeWishlist={
    questionId,openedAt:nowIso(),expiresAt:new Date(Date.now()+WISHLIST_WINDOW).toISOString(),
    validRequests:0
  };
  state.autoPacks=0;
  state.history.push({at:nowIso(),type:'wishlist-opened',expiresAt:state.activeWishlist.expiresAt});
  state.history=state.history.slice(-500);
}
async function receiveQuestionResponse(state,payload){
  const w=state.activeWishlist;
  if(!w)return {accepted:false,reason:'no_active_wishlist'};
  if(Date.now()>Date.parse(w.expiresAt||0))return {accepted:false,reason:'wishlist_expired'};
  const questionId=clean(payload?.questionId);
  if(!questionId||questionId!==clean(w.questionId))return {accepted:false,reason:'wrong_question'};
  const text=clean(payload?.text);
  if(!text)return {accepted:false,reason:'empty'};
  const seenId=digest([questionId,payload?.senderId,text].join('|'));
  if(state.seen.includes(seenId))return {accepted:false,reason:'duplicate_response'};
  state.seen.push(seenId);state.seen=state.seen.slice(-2500);
  const c=await classifyWishlist(text);
  if(!c.valid||!c.character){await saveState(state);return {accepted:false,reason:'not_a_pack_request'}}

  const key=c.character.toLowerCase();
  let job=state.queue.find(x=>x.status==='pending'&&String(x.character).toLowerCase()===key);
  if(job){
    job.requestCount=Number(job.requestCount||1)+1;
    job.lastRequestedAt=nowIso();
  }else{
    job={
      id:crypto.randomUUID(),status:'pending',character:c.character,franchise:c.franchise||'',
      medium:c.medium||'unknown',mood:rand(STICK_GOOD_MOODS),confidence:c.confidence,
      requestedAt:nowIso(),lastRequestedAt:nowIso(),requestCount:1,attempts:0
    };
    state.queue.push(job);state.queue=state.queue.slice(-300);
  }
  w.validRequests=Number(w.validRequests||0)+1;
  state.history.push({at:nowIso(),type:'wishlist-request',character:c.character,requestCount:job.requestCount,confidence:c.confidence});
  state.history=state.history.slice(-500);
  await saveState(state);
  return {accepted:true,character:c.character,requestCount:job.requestCount};
}

async function tick(state){
  if(!ENABLED)return;
  if(state.activeWishlist&&Date.now()>Date.parse(state.activeWishlist.expiresAt||0)){
    state.history.push({at:nowIso(),type:'wishlist-closed',validRequests:Number(state.activeWishlist.validRequests||0)});
    state.activeWishlist=null;
    state.nextPackAt=Math.min(Number(state.nextPackAt)||Date.now(),Date.now()+60_000);
    await saveState(state);
  }
  if(Date.now()<state.nextPackAt)return;

  const job=state.queue.find(x=>x.status==='pending');
  if(!job&&state.activeWishlist)return;

  const choice=job?{
    character:job.character,franchise:job.franchise||'',medium:job.medium||'unknown',mood:job.mood||rand(STICK_GOOD_MOODS)
  }:await canonicalAutoChoice(state);

  try{
    const result=await publishPack(choice,state,job?'wishlist':'auto');
    if(job){job.status='done';job.completedAt=nowIso();job.count=result.count;job.nativePack=result.nativePack}
    else state.autoPacks++;
    state.nextPackAt=Date.now()+PACK_INTERVAL;
    if(!job&&state.autoPacks>=AUTOS_BEFORE_WISHLIST)await openWishlist(state);
  }catch(error){
    const msg=clean(error?.message||error).slice(0,400);
    if(job){
      job.attempts=Number(job.attempts||0)+1;job.lastError=msg;
      if(job.attempts>=4)job.status='failed';
    }
    state.history.push({at:nowIso(),type:'pack-error',character:choice.character,error:msg});
    state.history=state.history.slice(-500);
    state.nextPackAt=Date.now()+60*60_000;
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
        return res.end(JSON.stringify({
          ok:true,enabled:ENABLED,pid:process.pid,nextPackAt:state.nextPackAt,
          pending:state.queue.filter(x=>x.status==='pending').length,
          autoPacks:state.autoPacks,
          wishlist:state.activeWishlist?{
            active:true,openedAt:state.activeWishlist.openedAt,expiresAt:state.activeWishlist.expiresAt,
            validRequests:Number(state.activeWishlist.validRequests||0)
          }:{active:false}
        }));
      }
      if(req.method==='POST'&&u.pathname==='/question-response'){
        const chunks=[];for await(const c of req)chunks.push(c);
        let body={};try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}
        const out=await receiveQuestionResponse(state,body);
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:true,...out}));
      }
      if(req.method==='POST'&&u.pathname==='/kick'){
        state.nextPackAt=Date.now();
        await saveState(state);
        res.writeHead(202,{'content-type':'application/json'});
        return res.end(JSON.stringify({ok:true}));
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
      await writeHealth(state);
    }catch(error){
      await writeHealth(state,{ok:false,error:clean(error?.message||error).slice(0,400)}).catch(()=>{});
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
  await sleep(700);
  if(!(await alive(child.pid)))throw new Error('stick_good_supervisor_failed');
  return {ok:true,pid:child.pid,restarted:restart};
}

if(MODE_WORKER)await worker();
else if(MODE_SUPERVISE)await supervise();
else if(MODE_RESTART)console.log(JSON.stringify(await ensureSupervisor(true)));
else console.log(JSON.stringify(await ensureSupervisor(false)));
