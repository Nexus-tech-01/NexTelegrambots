import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ENABLED=String(process.env.NEXSOCIAL__ENABLED||'true').toLowerCase()!=='false';
const DEST=String(process.env.NEXSOCIAL__DESTINATION||process.env.NEXCANAL__LIFESTYLE_DESTINATION||'tresor_universe').replace(/^@/,'').trim();
const WA_BRIDGE=String(process.env.NEXSOCIAL__WHATSAPP_BRIDGE||'http://127.0.0.1:18787/publish').trim();
const STATE_FILE=String(process.env.NEXSOCIAL__STATE_FILE||'/home/container/.nexcontrol/nexsocial-feed-state.json');
const TZ=String(process.env.NEXSOCIAL__TIMEZONE||'Africa/Porto-Novo');
const ACTIVE_START=Math.max(0,Math.min(23,Number(process.env.NEXSOCIAL__ACTIVE_START_HOUR||7)));
const ACTIVE_END=Math.max(0,Math.min(24,Number(process.env.NEXSOCIAL__ACTIVE_END_HOUR||23)));
const MIN_INTERVAL=Math.max(20*60_000,Number(process.env.NEXSOCIAL__MIN_INTERVAL_MS||45*60_000));
const MAX_INTERVAL=Math.max(MIN_INTERVAL,Number(process.env.NEXSOCIAL__MAX_INTERVAL_MS||75*60_000));
const IMAGE_RETRY=Math.max(2*60_000,Number(process.env.NEXSOCIAL__IMAGE_RETRY_MS||10*60_000));
const WA_RETRY=Math.max(60_000,Number(process.env.NEXSOCIAL__WA_RETRY_MS||5*60_000));
const PINTEREST_TIMEOUT=Math.max(5000,Number(process.env.NEXSOCIAL__PINTEREST_TIMEOUT_MS||15000));

const luxuryIdeas=[
  {
    query:'luxury supercar night cinematic',
    text:'Une vie élégante ne commence pas par ce que tu montres, mais par ce que tu construis quand personne ne regarde.',
    concepts:['supercar','sports car','luxury car','night','cinematic'],
    fallback:[
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1400&q=88',
      'https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&w=1400&q=88'
    ]
  },
  {
    query:'private jet cabin luxury cinematic',
    text:'Le luxe le plus rare reste la liberté : choisir son temps, ses projets et les personnes qui méritent ton énergie.',
    concepts:['private jet','jet','aircraft cabin','luxury aviation'],
    fallback:[]
  },
  {
    query:'penthouse city night luxury interior',
    text:'Travaille jusqu’à ce que la vue depuis ta fenêtre ressemble à celle que tu sauvegardais autrefois.',
    concepts:['penthouse','city skyline','luxury interior','night view'],
    fallback:['https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=88']
  },
  {
    query:'luxury watch suit close up',
    text:'Le vrai niveau supérieur, c’est la discipline qui finit par ressembler à de la chance.',
    concepts:['luxury watch','wristwatch','suit','timepiece'],
    fallback:[]
  },
  {
    query:'luxury mansion pool night architecture',
    text:'Ne cours pas seulement après l’argent. Construis une vie qui te donne envie de rester éveillé pour la vivre.',
    concepts:['mansion','luxury house','pool','night architecture'],
    fallback:['https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1400&q=88']
  },
  {
    query:'black luxury car rolls royce night',
    text:'Silence, constance, résultats. Tout n’a pas besoin d’être annoncé avant d’être accompli.',
    concepts:['black luxury car','rolls royce','luxury sedan','night'],
    fallback:['https://images.unsplash.com/photo-1542362567-b07e54358753?auto=format&fit=crop&w=1400&q=88']
  }
];

const moodIdeas=[
  {
    query:'sad alone night rain window aesthetic',
    text:'Parfois, être fort signifie simplement continuer doucement, sans faire semblant que tout va bien.',
    concepts:['sad','alone','rain','night','window','melancholy'],
    fallback:[]
  },
  {
    query:'happy warm sunset peaceful aesthetic',
    text:'Profite aussi des petites victoires. Une vie réussie n’est pas faite uniquement de grands moments.',
    concepts:['happy','sunset','warm light','peaceful','joy'],
    fallback:['https://images.unsplash.com/photo-1490730141103-6cac27aaab94?auto=format&fit=crop&w=1400&q=88']
  },
  {
    query:'lonely person city night aesthetic',
    text:'Il y a des périodes où tu grandis loin du bruit. Ce sont souvent celles qui changent le plus ta vie.',
    concepts:['lonely','person','city night','solitude','street'],
    fallback:[]
  },
  {
    query:'peaceful sky clouds calm aesthetic',
    text:'Tu n’as pas besoin d’aller vite tous les jours. Tu as surtout besoin de ne pas abandonner ta direction.',
    concepts:['peaceful sky','clouds','calm','serene','horizon'],
    fallback:['https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1400&q=88']
  }
];

const phraseIdeas=[
  {
    query:'sunrise new beginning aesthetic landscape',
    text:'« Tu n’as pas besoin d’être prêt à cent pour cent. Tu as besoin de commencer assez longtemps pour devenir prêt. »',
    concepts:['sunrise','new beginning','dawn','horizon'],
    fallback:['https://images.unsplash.com/photo-1490730141103-6cac27aaab94?auto=format&fit=crop&w=1400&q=88']
  },
  {
    query:'minimal dark quiet room aesthetic',
    text:'« Ce que tu répètes en silence finit par devenir visible dans ta vie. »',
    concepts:['minimal dark','quiet','silence','shadow'],
    fallback:[]
  },
  {
    query:'mountain climb discipline aesthetic',
    text:'« Les objectifs impressionnent. Les habitudes transforment. »',
    concepts:['mountain','climb','discipline','summit'],
    fallback:['https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1400&q=88']
  },
  {
    query:'city lights night future aesthetic',
    text:'« Ton futur dépend moins de ton humeur du jour que de ce que tu choisis de répéter. »',
    concepts:['city lights','night city','future','urban'],
    fallback:[]
  }
];

const otakuCharacters=[
  {name:'Naruto',query:'Naruto Uzumaki emotional anime wallpaper',concepts:['naruto','uzumaki'],lines:['Même rejeté, il a gardé son rêve debout.','Il a changé ses blessures en force,','ses échecs en promesses,','et sa solitude en lumière.']},
  {name:'Itachi',query:'Itachi Uchiha dark emotional anime wallpaper',concepts:['itachi','uchiha'],lines:['Il portait un silence trop lourd pour être expliqué.','Certains sacrifices ne demandent pas d’applaudissements,','seulement la force de rester fidèle','à ce qu’on croit juste.']},
  {name:'Gojo',query:'Gojo Satoru emotional anime wallpaper',concepts:['gojo','satoru'],lines:['Sourire léger, puissance immense.','Parfois les plus forts cachent leurs tempêtes','derrière une blague,','comme si rien ne pouvait les atteindre.']},
  {name:'Luffy',query:'Monkey D Luffy dream anime wallpaper',concepts:['luffy','monkey d luffy'],lines:['Il avance parce que son rêve vaut plus que la peur.','Pas besoin de tout connaître du chemin','quand ton cœur sait déjà','pourquoi tu refuses de t’arrêter.']},
  {name:'Levi',query:'Levi Ackerman dark anime wallpaper',concepts:['levi','ackerman'],lines:['Quand le monde devient chaotique,','il choisit encore d’avancer proprement,','avec peu de mots,','mais aucune hésitation inutile.']},
  {name:'Sasuke',query:'Sasuke Uchiha emotional anime wallpaper',concepts:['sasuke','uchiha'],lines:['On peut courir très loin pour échapper au passé,','et découvrir un jour','que la vraie victoire','était de décider qui devenir ensuite.']}
];

const duels=[
  {a:'Naruto',b:'Sasuke',query:'Naruto Sasuke together anime wallpaper',concepts:['naruto','sasuke']},
  {a:'Gojo',b:'Sukuna',query:'Gojo Sukuna together wallpaper',concepts:['gojo','sukuna']},
  {a:'Luffy',b:'Zoro',query:'Luffy Zoro together anime wallpaper',concepts:['luffy','zoro']},
  {a:'Itachi',b:'Madara',query:'Itachi Madara together anime wallpaper',concepts:['itachi','madara']},
  {a:'Levi',b:'Eren',query:'Levi Eren together anime wallpaper',concepts:['levi','eren']},
  {a:'Light',b:'L',query:'Light Yagami L together Death Note wallpaper',concepts:['light yagami','death note','lawliet']}
];

function rand(arr){return arr[Math.floor(Math.random()*arr.length)];}
function randomInterval(){return Math.round(MIN_INTERVAL+Math.random()*(MAX_INTERVAL-MIN_INTERVAL));}
function nowIso(){return new Date().toISOString();}
function cleanUrl(v=''){try{const u=new URL(String(v));return /^https?:$/.test(u.protocol)?u.toString():'';}catch{return'';}}
function hourInZone(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',hour12:false}).formatToParts(now);
  const h=Number(parts.find(x=>x.type==='hour')?.value||0);
  return h===24?0:h;
}
function isActiveHour(now=new Date()){
  const h=hourInZone(now);
  return ACTIVE_START<=ACTIVE_END ? h>=ACTIVE_START&&h<ACTIVE_END : (h>=ACTIVE_START||h<ACTIVE_END);
}
async function loadState(){
  try{
    const raw=JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    return {
      version:1,
      nextAt:Number(raw?.nextAt)||0,
      recentImages:Array.isArray(raw?.recentImages)?raw.recentImages.slice(-80):[],
      recentKinds:Array.isArray(raw?.recentKinds)?raw.recentKinds.slice(-12):[],
      pendingWhatsApp:Array.isArray(raw?.pendingWhatsApp)?raw.pendingWhatsApp.slice(-50):[],
      history:Array.isArray(raw?.history)?raw.history.slice(-100):[]
    };
  }catch{return {version:1,nextAt:0,recentImages:[],recentKinds:[],pendingWhatsApp:[],history:[]};}
}
async function saveState(state){
  await fs.mkdir(path.dirname(STATE_FILE),{recursive:true});
  const tmp=STATE_FILE+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(state,null,2),{mode:0o600});
  await fs.rename(tmp,STATE_FILE);
}
function pickKind(state){
  const kinds=['luxury','otaku','mood','luxury','choice','phrase','otaku','luxury','mood','choice'];
  const recent=new Set(state.recentKinds.slice(-2));
  const choices=kinds.filter(k=>!recent.has(k));
  return rand(choices.length?choices:kinds);
}
function compose(kind){
  if(kind==='luxury'){
    const idea=rand(luxuryIdeas);
    return {kind,query:idea.query,concepts:idea.concepts,fallback:idea.fallback,strictEntity:false,caption:'✦ 𝗟𝗨𝗫𝗨𝗥𝗬 𝗟𝗜𝗙𝗘\n\n'+idea.text+'\n\n— 𝑻𝒓𝒆𝒔𝒐𝒓 𝑼𝒏𝒊𝒗𝒆𝒓𝒔𝒆'};
  }
  if(kind==='mood'){
    const idea=rand(moodIdeas);
    return {kind,query:idea.query,concepts:idea.concepts,fallback:idea.fallback,strictEntity:false,caption:'✦ 𝗠𝗢𝗢𝗗\n\n'+idea.text+'\n\nDis-moi juste un mot : comment tu te sens aujourd’hui ?'};
  }
  if(kind==='phrase'){
    const idea=rand(phraseIdeas);
    return {kind,query:idea.query,concepts:idea.concepts,fallback:idea.fallback,strictEntity:false,caption:'✦ 𝗣𝗛𝗥𝗔𝗦𝗘 𝗗𝗨 𝗝𝗢𝗨𝗥\n\n'+idea.text+'\n\nGarde-la quelque part si elle te parle.'};
  }
  if(kind==='otaku'){
    const ch=rand(otakuCharacters);
    return {kind,query:ch.query,concepts:ch.concepts,fallback:[],strictEntity:true,caption:'✦ 𝗢𝗧𝗔𝗞𝗨 𝗣𝗢𝗘𝗠 · '+ch.name.toUpperCase()+'\n\n'+ch.lines.join('\n')+'\n\nQuel personnage tu veux pour le prochain ?'};
  }
  const d=rand(duels);
  return {kind:'choice',query:d.query,concepts:d.concepts,fallback:[],strictEntity:true,requireAllConcepts:true,caption:'✦ 𝗢𝗧𝗔𝗞𝗨 𝗖𝗛𝗢𝗜𝗖𝗘\n\n'+d.a+'  VS  '+d.b+'\n\nTu dois en garder un seul. Tu choisis qui ?\n\nA — '+d.a+'\nB — '+d.b+'\n\nRéponds avec A ou B.'};
}
function normalizeSemanticText(v=''){
  return String(v)
    .replace(/\\u002f/gi,'/')
    .replace(/\\u0026/gi,'&')
    .replace(/\\\//g,'/')
    .replace(/&quot;|&#34;/gi,'"')
    .replace(/&amp;|&#38;/gi,'&')
    .replace(/<[^>]+>/g,' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function semanticPhrasePresent(haystack,phrase=''){
  const p=normalizeSemanticText(phrase);
  if(!p)return false;
  const h=' '+normalizeSemanticText(haystack)+' ';
  if(h.includes(' '+p+' '))return true;
  const parts=p.split(' ').filter(Boolean);
  return parts.length>1&&parts.every(x=>h.includes(' '+x+' '));
}
function semanticScore(post,candidate){
  const concepts=(post?.concepts||[]).map(normalizeSemanticText).filter(Boolean);
  if(!concepts.length)return 0;
  const context=candidate?.context||'';
  const hits=concepts.filter(x=>semanticPhrasePresent(context,x));
  if(post?.requireAllConcepts&&hits.length<concepts.length)return -1;
  if(post?.strictEntity&&hits.length<1)return -1;
  if(!post?.strictEntity&&hits.length<1)return -1;
  return hits.reduce((score,x)=>score+Math.max(1,x.split(' ').length),0);
}
function pinterestCandidates(html=''){
  const source=String(html);
  const found=new Map();
  const patterns=[
    /https:\/\/i\.pinimg\.com\/[^"'<>\\\s]+/g,
    /https:\\\/\\\/i\.pinimg\.com\\\/[^"'<>\s]+/g
  ];
  for(const re of patterns){
    for(const match of source.matchAll(re)){
      const raw=String(match[0]||'');
      let u=raw.replace(/\\u002F/gi,'/').replace(/\\\//g,'/').replace(/\\u0026/gi,'&').replace(/&amp;/g,'&');
      u=u.replace(/\\+"/g,'"').replace(/["')},;]+$/,'');
      try{
        const x=new URL(u);
        x.search='';
        const out=x.toString();
        if(!/\.(?:jpe?g|png|webp)$/i.test(x.pathname)||/\/60x60\//.test(x.pathname))continue;
        const i=Number(match.index||0);
        const around=source.slice(Math.max(0,i-1800),Math.min(source.length,i+1800));
        const previous=found.get(out);
        found.set(out,{
          url:out,
          context:(previous?.context||'')+' '+normalizeSemanticText(around)
        });
      }catch{}
    }
  }
  return [...found.values()].sort((a,b)=>{
    const rank=u=>(/\/originals\//.test(u)?4:/\/736x\//.test(u)?3:/\/564x\//.test(u)?2:1);
    return rank(b.url)-rank(a.url);
  });
}
async function validateImage(url){
  try{
    const r=await fetch(url,{method:'GET',headers:{Range:'bytes=0-1023','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(8000)});
    const type=String(r.headers.get('content-type')||'').toLowerCase();
    const len=Number(r.headers.get('content-length')||0);
    try{await r.body?.cancel();}catch{}
    return r.ok&&type.startsWith('image/')&&(len===0||len>=12000);
  }catch{return false;}
}
async function findPinterestImage(post,recent){
  const url='https://www.pinterest.com/search/pins/?q='+encodeURIComponent(post.query);
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(PINTEREST_TIMEOUT)});
  if(!r.ok)throw new Error('Pinterest HTTP '+r.status);
  const html=await r.text();
  const candidates=pinterestCandidates(html)
    .filter(x=>!recent.has(x.url))
    .map(x=>({...x,score:semanticScore(post,x)}))
    .filter(x=>x.score>=0)
    .sort((a,b)=>b.score-a.score);
  for(const item of candidates.slice(0,24)){
    if(await validateImage(item.url))return item.url;
  }
  return '';
}
async function findImage(post,state){
  const recent=new Set(state.recentImages||[]);
  try{
    const pin=await findPinterestImage(post,recent);
    if(pin)return pin;
  }catch{}
  const pool=(post.fallback||[]).filter(Boolean);
  const fresh=pool.filter(x=>!recent.has(x));
  for(const url of (fresh.length?fresh:pool)){
    if(await validateImage(url))return url;
  }
  // Fail closed: publishing without a semantically verified image is worse
  // than postponing the post. The next scheduler pass will try again.
  return '';
}
async function sendWhatsApp(payload){
  const r=await fetch(WA_BRIDGE,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
  const out=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(out?.error||('WhatsApp bridge HTTP '+r.status));
  return out;
}
function waPayload(entry){
  return {
    id:entry.id,
    source:DEST,
    sourceMessageId:entry.telegramMessageId||null,
    text:entry.caption,
    mediaItems:[{type:'photo',url:entry.imageUrl,fileName:'social-'+entry.id.replace(/[^a-z0-9_-]+/gi,'-')+'.jpg',mimetype:'image/jpeg',position:0}],
    buttons:[],
    createdAt:entry.createdAt
  };
}

export function createSocialFeed({bot,log=console.log,warn=console.warn}={}){
  if(typeof bot!=='function')throw new Error('social feed requires bot() helper');
  let statePromise=loadState();
  let running=false;
  const flush=async state=>{await saveState(state);return state;};
  async function retryWhatsApp(state){
    const now=Date.now();
    for(const item of state.pendingWhatsApp){
      if(Number(item.nextRetryAt||0)>now)continue;
      try{
        await sendWhatsApp(waPayload(item));
        item.status='done';item.completedAt=nowIso();item.lastError=null;
      }catch(error){
        item.attempts=Number(item.attempts||0)+1;
        item.lastError=String(error?.message||error).slice(0,500);
        item.nextRetryAt=Date.now()+Math.min(60*60_000,WA_RETRY*2**Math.min(5,item.attempts));
      }
    }
    state.pendingWhatsApp=state.pendingWhatsApp.filter(x=>x.status!=='done'&&Number(x.attempts||0)<30).slice(-50);
  }
  async function tick({force=false}={}){
    if(!ENABLED||running)return;
    running=true;
    try{
      const state=await statePromise;
      await retryWhatsApp(state);
      const now=Date.now();
      if(!force){
        if(!isActiveHour()){await flush(state);return;}
        if(Number(state.nextAt||0)>now){await flush(state);return;}
      }
      const kind=pickKind(state);
      const post=compose(kind);
      const imageUrl=cleanUrl(await findImage(post,state));
      if(!imageUrl){
        state.nextAt=now+IMAGE_RETRY;
        state.history.push({at:nowIso(),type:'image-miss',kind,query:post.query});
        state.history=state.history.slice(-100);
        await flush(state);
        warn('[NexSocial] no image found for',post.query);
        return;
      }
      const publicationId='social-'+crypto.randomUUID();
      const msg=await bot('sendPhoto',{
        chat_id:'@'+DEST,
        photo:imageUrl,
        caption:post.caption.slice(0,1024)
      });
      const entry={
        id:publicationId,
        telegramMessageId:Number(msg?.message_id||0)||null,
        imageUrl,
        caption:post.caption,
        kind:post.kind,
        createdAt:nowIso(),
        attempts:0,
        nextRetryAt:0,
        status:'pending'
      };
      try{
        await sendWhatsApp(waPayload(entry));
        entry.status='done';
      }catch(error){
        entry.lastError=String(error?.message||error).slice(0,500);
        entry.attempts=1;
        entry.nextRetryAt=Date.now()+WA_RETRY;
        state.pendingWhatsApp.push(entry);
        warn('[NexSocial] WhatsApp relay queued:',entry.lastError);
      }
      state.recentImages.push(imageUrl);
      state.recentImages=state.recentImages.slice(-80);
      state.recentKinds.push(post.kind);
      state.recentKinds=state.recentKinds.slice(-12);
      state.nextAt=Date.now()+randomInterval();
      state.history.push({at:nowIso(),type:'published',kind:post.kind,imageUrl,telegramMessageId:entry.telegramMessageId,whatsapp:entry.status});
      state.history=state.history.slice(-100);
      await flush(state);
      log('[NexSocial] published',post.kind,'to @'+DEST,'next in',Math.round((state.nextAt-Date.now())/60000)+'m');
    }catch(error){
      const state=await statePromise.catch(()=>null);
      if(state){
        state.nextAt=Date.now()+IMAGE_RETRY;
        state.history.push({at:nowIso(),type:'error',error:String(error?.message||error).slice(0,500)});
        state.history=state.history.slice(-100);
        await saveState(state).catch(()=>{});
      }
      warn('[NexSocial] tick failed',error?.message||error);
    }finally{running=false;}
  }
  return {
    async init(){
      const state=await statePromise;
      if(!state.nextAt)state.nextAt=Date.now()+Math.min(5*60_000,Math.floor(MIN_INTERVAL/4));
      await saveState(state);
      log('[NexSocial] enabled='+ENABLED,'destination=@'+DEST,'window='+ACTIVE_START+'-'+ACTIVE_END,'interval='+Math.round(MIN_INTERVAL/60000)+'-'+Math.round(MAX_INTERVAL/60000)+'m');
      return state;
    },
    tick
  };
}
