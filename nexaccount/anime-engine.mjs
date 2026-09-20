import { settingsFor, patchSettings } from './store.mjs';

const UA='NexAi/1.0 (+https://github.com/Nexus-tech-01)';
const CACHE=new Map();
const AMV=[
  'https://www.youtube.com/watch?v=GMbgj9bwlMA',
  'https://www.youtube.com/watch?v=m2u3OkqZhkM',
  'https://www.youtube.com/watch?v=V-2bFKrIz-4',
  'https://www.youtube.com/watch?v=4_Jt2VnJ_xU',
  'https://www.youtube.com/watch?v=XZzZUXnFnm8'
];
const AMV_HD=[
  'https://www.youtube.com/watch?v=6YB8UqF-Cl8',
  'https://www.youtube.com/watch?v=Q6CaTpfGRDo',
  'https://www.youtube.com/watch?v=Rk2pFMi0DBY',
  'https://www.youtube.com/watch?v=0Jb2JyYL_YI'
];
const OPENINGS=[
  ['Gurenge — LiSA (Demon Slayer)','https://www.youtube.com/watch?v=CwkzK-F0Y4k'],
  ['Unravel — TK (Tokyo Ghoul)','https://www.youtube.com/watch?v=fFOSMqR9a64'],
  ['Blue Bird — Ikimono Gakari (Naruto Shippuden)','https://www.youtube.com/watch?v=s3vosGJLqtI'],
  ['Cry Baby — Official HIGE DANdism (Tokyo Revengers)','https://www.youtube.com/watch?v=KlexUOwBqaA'],
  ['Homura — LiSA (Demon Slayer)','https://www.youtube.com/watch?v=EaQ5-Jmno_Q']
];
const OPENINGS_VIP=[
  ['Bling-Bang-Bang-Born — Creepy Nuts (Mashle)','https://www.youtube.com/watch?v=mLW35YMzELE'],
  ['Idol — YOASOBI (Oshi no Ko)','https://www.youtube.com/watch?v=ZRtdQ81jPUQ'],
  ['SPECIALZ — King Gnu (Jujutsu Kaisen)','https://www.youtube.com/watch?v=5yb2N3pnztU']
];
const FALLBACK_QUOTES=[
  {quote:'People die if they are killed.',character:'Shirou Emiya',anime:'Fate/stay night'},
  {quote:'I am gonna be the Pirate King!',character:'Monkey D. Luffy',anime:'One Piece'},
  {quote:'Believe it!',character:'Naruto Uzumaki',anime:'Naruto'}
];

const clean=v=>String(v??'').trim();
const oneLine=v=>clean(v).replace(/<[^>]*>/g,'').replace(/\s+/g,' ');
const clip=(v,n=500)=>{const s=oneLine(v);return s.length>n?s.slice(0,n-1)+'…':s};
const titleOf=m=>m?.title?.english||m?.title?.romaji||m?.title?.native||m?.title||'Inconnu';
const nameOf=x=>x?.name?.full||[x?.name?.first,x?.name?.last].filter(Boolean).join(' ')||x?.name||'Inconnu';
const random=a=>a?.length?a[Math.floor(Math.random()*a.length)]:null;
const fmtDate=d=>[d?.year,d?.month,d?.day].filter(Boolean).join('-')||'?';
const fmtDateTime=ts=>new Date(Number(ts)*1000).toLocaleString('fr-FR',{timeZone:'Africa/Porto-Novo'});
const normalize=s=>clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

async function cached(key,ttl,fn){
  const now=Date.now(),hit=CACHE.get(key);
  if(hit&&hit.expires>now)return hit.value;
  const value=await fn();CACHE.set(key,{value,expires:now+ttl});return value;
}
async function res(url,options={},timeout=22000){
  const r=await fetch(url,{...options,headers:{'user-agent':UA,accept:'application/json',...(options.headers||{})},signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error('HTTP '+r.status+' · '+new URL(url).hostname);
  return r;
}
async function json(url,options={},timeout=22000){return (await res(url,options,timeout)).json()}
async function jikan(path){
  return cached('jikan:'+path,90_000,async()=>{
    const d=await json('https://api.jikan.moe/v4'+path);
    return d?.data??d;
  });
}
async function anilist(query,variables={}){
  const r=await res('https://graphql.anilist.co',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({query,variables})
  },25000);
  const d=await r.json();
  if(d?.errors?.length)throw new Error(d.errors[0]?.message||'AniList error');
  return d?.data;
}
async function sendText(client,peer,text){return client.sendMessage(peer,{message:String(text)})}
async function sendImage(client,peer,url,caption=''){
  if(!url)return sendText(client,peer,caption);
  const r=await res(url,{headers:{accept:'image/*'}},25000);
  const b=Buffer.from(await r.arrayBuffer());
  if(b.length>15*1024*1024)throw new Error('image trop volumineuse');
  return client.sendFile(peer,{file:b,fileName:'nexai-anime.jpg',caption});
}
async function sendAudio(client,peer,buffer,name='anime-voice.wav'){
  return client.sendFile(peer,{file:Buffer.from(buffer),fileName:name,voiceNote:true});
}
async function remember(accountId,type,query){
  if(!query)return;
  const s=await settingsFor(accountId),lib=s.animeLibrary||{};
  const history=[{type,query:String(query).slice(0,120),at:Date.now()},...(lib.history||[])]
    .filter((x,i,a)=>a.findIndex(y=>y.type===x.type&&normalize(y.query)===normalize(x.query))===i)
    .slice(0,30);
  await patchSettings(accountId,{animeLibrary:{...lib,history}});
}
async function mediaSearch(query,type='ANIME'){
  const q=`query($search:String,$type:MediaType){Media(search:$search,type:$type){id idMal type format status episodes chapters volumes duration season seasonYear description(asHtml:false) genres averageScore popularity favourites trending siteUrl title{romaji english native} coverImage{large extraLarge} bannerImage trailer{id site thumbnail} nextAiringEpisode{airingAt episode timeUntilAiring} studios(isMain:true){nodes{name siteUrl}} externalLinks{site url} characters(perPage:10,sort:[ROLE,FAVOURITES_DESC]){nodes{id name{full} image{large} gender dateOfBirth{year month day} favourites}} recommendations(perPage:8,sort:RATING_DESC){nodes{rating mediaRecommendation{id title{romaji english} siteUrl coverImage{large}}}}}}`;
  const d=await anilist(q,{search:query,type});
  if(!d?.Media)throw new Error((type==='MANGA'?'Manga':'Anime')+' introuvable');
  return d.Media;
}
async function mediaPage({type='ANIME',sort='TRENDING_DESC',season=null,year=null,status=null,genre=null,page=1,perPage=8}={}){
  const q=`query($page:Int,$perPage:Int,$type:MediaType,$sort:[MediaSort],$season:MediaSeason,$year:Int,$status:MediaStatus,$genre:String){Page(page:$page,perPage:$perPage){media(type:$type,sort:$sort,season:$season,seasonYear:$year,status:$status,genre:$genre,isAdult:false){id idMal type format status episodes chapters volumes season seasonYear genres averageScore popularity trending siteUrl title{romaji english native} coverImage{large} nextAiringEpisode{airingAt episode timeUntilAiring}}}}`;
  const d=await anilist(q,{page,perPage,type,sort:[sort],season,year,status,genre});
  return d?.Page?.media||[];
}
function mediaCard(m){
  return [
    titleOf(m),
    m?.format?'Format : '+m.format:'',
    m?.status?'Statut : '+m.status:'',
    m?.episodes?'Épisodes : '+m.episodes:'',
    m?.chapters?'Chapitres : '+m.chapters:'',
    m?.volumes?'Volumes : '+m.volumes:'',
    m?.seasonYear?'Saison : '+(m.season||'')+' '+m.seasonYear:'',
    m?.averageScore!=null?'Score : '+m.averageScore+'/100':'',
    m?.popularity!=null?'Popularité : '+m.popularity:'',
    m?.genres?.length?'Genres : '+m.genres.slice(0,6).join(', '):'',
    m?.studios?.nodes?.length?'Studio : '+m.studios.nodes.map(x=>x.name).join(', '):'',
    m?.nextAiringEpisode?'Prochain épisode : '+m.nextAiringEpisode.episode+' · '+fmtDateTime(m.nextAiringEpisode.airingAt):'',
    clip(m?.description,650),
    m?.siteUrl||''
  ].filter(Boolean).join('\n');
}
function listMedia(title,items){
  if(!items.length)return title+'\nAucun résultat.';
  return title+'\n\n'+items.map((m,i)=>(i+1)+'. '+titleOf(m)+(m.averageScore!=null?' · '+m.averageScore+'/100':'')+(m.episodes?' · '+m.episodes+' ep':'')+(m.siteUrl?'\n'+m.siteUrl:'')).join('\n\n');
}
async function jikanAnime(name){
  const rows=await jikan('/anime?q='+encodeURIComponent(name)+'&limit=1&sfw=true');
  const a=rows?.[0];if(!a)throw new Error('Anime introuvable');return a;
}
async function jikanManga(name,type=''){
  const suffix=type?'&type='+encodeURIComponent(type):'';
  const rows=await jikan('/manga?q='+encodeURIComponent(name)+'&limit=1'+suffix);
  const a=rows?.[0];if(!a)throw new Error('Manga introuvable');return a;
}
async function jikanFullAnime(name){
  const a=await jikanAnime(name);
  const d=await jikan('/anime/'+a.mal_id+'/full');
  return d||a;
}
async function animeQuote(filter=''){
  try{
    const d=await json('https://animechan.io/api/v1/quotes/random');
    const row=d?.data||d;
    const quote=clip(row?.content||row?.quote,180);
    if(quote)return {quote,character:row?.character?.name||row?.character||'?',anime:row?.anime?.name||row?.anime||filter||'?'};
  }catch{}
  return random(FALLBACK_QUOTES);
}
async function waifuImage(kind='waifu'){
  if(kind==='neko'){
    try{const d=await json('https://nekos.best/api/v2/neko');const u=d?.results?.[0]?.url;if(u)return u}catch{}
  }
  const tag=kind==='cosplay'?'uniform':'waifu';
  try{
    const d=await json('https://api.waifu.im/images?IncludedTags='+encodeURIComponent(tag)+'&IsNsfw=False',{headers:{'Accept-Version':'v7'}});
    const u=d?.items?.[0]?.url;if(u)return u;
  }catch{}
  const d=await json('https://api.waifu.pics/sfw/'+(kind==='neko'?'neko':'waifu'));
  if(!d?.url)throw new Error('service image anime indisponible');
  return d.url;
}
async function characterSearch(name){
  const q=`query($search:String){Character(search:$search){id name{full native alternative} image{large} description(asHtml:false) gender age dateOfBirth{year month day} favourites siteUrl media(perPage:8,sort:[POPULARITY_DESC]){nodes{title{romaji english} type siteUrl}}}}`;
  const d=await anilist(q,{search:name});if(!d?.Character)throw new Error('Personnage introuvable');return d.Character;
}
async function staffSearch(name){
  const q=`query($search:String){Staff(search:$search){id name{full native} image{large} description(asHtml:false) languageV2 primaryOccupations dateOfBirth{year month day} age yearsActive siteUrl characters(perPage:8,sort:[FAVOURITES_DESC]){nodes{name{full} siteUrl}} staffMedia(perPage:8,sort:[POPULARITY_DESC]){nodes{title{romaji english} type siteUrl}}}}`;
  const d=await anilist(q,{search:name});if(!d?.Staff)throw new Error('Personne introuvable');return d.Staff;
}
async function studioSearch(name){
  const rows=await jikan('/producers?q='+encodeURIComponent(name)+'&limit=5');
  if(!rows?.length)throw new Error('Studio introuvable');
  return rows;
}
function currentSeason(){
  const d=new Date(),m=d.getUTCMonth()+1;
  return {season:m<=3?'WINTER':m<=6?'SPRING':m<=9?'SUMMER':'FALL',year:d.getUTCFullYear()};
}
function splitTwo(raw){
  const s=clean(raw);
  if(s.includes('|'))return s.split('|').map(clean).filter(Boolean).slice(0,2);
  const m=s.split(/\s+vs\s+/i).map(clean).filter(Boolean);
  return m.slice(0,2);
}
function hashPercent(a,b){
  const s=normalize(a)+'|'+normalize(b);let h=2166136261;
  for(const ch of s){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}
  return Math.abs(h)%101;
}
async function patchLibrary(accountId,mutate){
  const s=await settingsFor(accountId),lib=s.animeLibrary||{};
  const next=mutate(structuredClone(lib))||lib;
  await patchSettings(accountId,{animeLibrary:next});
  return next;
}
function listBucket(lib,key){
  const arr=Array.isArray(lib?.[key])?lib[key]:[];
  return arr.length?arr.map((x,i)=>(i+1)+'. '+(x.title||x.name||x)).join('\n'):'Aucun élément.';
}
async function setStatus(accountId,status,name,type='ANIME'){
  const item=type==='MANGA'?await mediaSearch(name,'MANGA'):await mediaSearch(name,'ANIME');
  return patchLibrary(accountId,lib=>{
    for(const k of ['watching','completed','planned','dropped'])lib[k]=(lib[k]||[]).filter(x=>x.id!==item.id);
    lib[status]=[...(lib[status]||[]),{id:item.id,title:titleOf(item),type,siteUrl:item.siteUrl}];
    return lib;
  });
}
async function gameState(accountId,next){
  const s=await settingsFor(accountId),lib=s.animeLibrary||{};
  await patchSettings(accountId,{animeLibrary:{...lib,game:next}});
}
async function checkGame(accountId,kind,answer){
  const s=await settingsFor(accountId),g=s.animeLibrary?.game;
  if(!g||g.kind!==kind)return null;
  const ok=normalize(answer)===normalize(g.answer)||normalize(g.answer).includes(normalize(answer));
  await gameState(accountId,null);
  return {ok,answer:g.answer};
}
async function randomQuiz(type='ANIME'){
  const items=await mediaPage({type,sort:'POPULARITY_DESC',page:1+Math.floor(Math.random()*3),perPage:20});
  const target=random(items);if(!target)throw new Error('quiz indisponible');
  const others=items.filter(x=>x.id!==target.id).sort(()=>Math.random()-.5).slice(0,3);
  const choices=[target,...others].sort(()=>Math.random()-.5);
  const question=type==='ANIME'
    ?'Quel titre correspond à '+(target.episodes?target.episodes+' épisodes':'cette fiche')+' et au score '+(target.averageScore||'?')+'/100 ?'
    :'Quel manga correspond au score '+(target.averageScore||'?')+'/100 ?';
  return {answer:titleOf(target),question,choices:choices.map(titleOf)};
}
async function birthdayPopular(month,day){
  const q=`query($page:Int){Page(page:$page,perPage:50){characters(sort:[FAVOURITES_DESC]){name{full} image{large} siteUrl dateOfBirth{year month day} favourites}}}`;
  const out=[];
  for(let p=1;p<=4&&out.length<10;p++){
    const d=await anilist(q,{page:p});
    out.push(...(d?.Page?.characters||[]).filter(x=>x.dateOfBirth?.month===month&&x.dateOfBirth?.day===day));
  }
  return out.slice(0,10);
}
async function voicevox(textValue,voice){
  const endpoint=clean(process.env.NEXAI_VOICEVOX_ENDPOINT||'').replace(/\/$/,'');
  if(!endpoint)return null;
  const speakers=await json(endpoint+'/speakers',{},10000);
  const styles=(speakers||[]).flatMap(s=>(s.styles||[]).map(st=>({id:st.id,name:s.name+' '+st.name,speaker:s.name,style:st.name})));
  if(!styles.length)throw new Error('VOICEVOX sans voix');
  if(voice==='voices')return {voices:styles.slice(0,40)};
  const wanted=normalize(voice);
  const style=styles.find(x=>String(x.id)===wanted)||styles.find(x=>normalize(x.name).includes(wanted))||styles[0];
  const qres=await res(endpoint+'/audio_query?text='+encodeURIComponent(textValue)+'&speaker='+style.id,{method:'POST'},20000);
  const query=await qres.json();
  const wav=await res(endpoint+'/synthesis?speaker='+style.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(query)},45000);
  return {buffer:Buffer.from(await wav.arrayBuffer()),voice:style.name};
}
async function googleTts(textValue,lang='ja'){
  const u='https://translate.google.com/translate_tts?ie=UTF-8&q='+encodeURIComponent(textValue.slice(0,190))+'&tl='+encodeURIComponent(lang)+'&client=tw-ob';
  const r=await res(u,{headers:{accept:'audio/mpeg'}},20000);
  return Buffer.from(await r.arrayBuffer());
}
async function animeTts(client,peer,args){
  const first=clean(args[0]||'');
  if(!first||first==='voices'){
    const vv=await voicevox('', 'voices').catch(()=>null);
    const base=['Usage : .anitts <voix> <texte>','Exemples : .anitts kawaii Bonjour · .anitts villain Tu es en retard'];
    if(vv?.voices?.length)base.push('', 'Voix VOICEVOX disponibles :',...vv.voices.map(v=>v.id+' · '+v.name));
    else base.push('', 'VOICEVOX local non configuré : TTS standard de secours actif.');
    await sendText(client,peer,base.join('\n'));return true;
  }
  const textValue=args.slice(1).join(' ').trim();
  if(!textValue){await sendText(client,peer,'Usage : .anitts <voix> <texte>');return true}
  const vv=await voicevox(textValue,first).catch(()=>null);
  if(vv?.buffer){await sendAudio(client,peer,vv.buffer,'anime-voice.wav');return true}
  const lang=/^[\u3040-\u30ff\u3400-\u9fff]/u.test(textValue)?'ja':'fr';
  const audio=await googleTts(textValue,lang);
  await sendAudio(client,peer,audio,'anime-voice.mp3');
  return true;
}

export const ANIME_ENGINE_COMMANDS=new Set([
  'animeinfo','anisearch','manga','studio','seiyuu','animecalendar','airing','season','upcoming','topanime','topmanga','trendinganime',
  'randomanime','randommanga','recommendanime','genre','animebyyear','animebyseason','episode','episodes','openingsearch','endingsearch',
  'anisong','ost','trailer','animequote','characterquote','animeimage','wallpaperanime','avataranime','banneranime','waifu','waifuhd','husbando',
  'neko','cosplay','cosplayvip','amv','amvhd','opening','openingvip','character','ship','guessanime','guesscharacter','guessopening','animequiz',
  'mangaquiz','animeriddle','whosaid','powerbattle','animeprofile','animelist','mangalist','watching','completed','planned','dropped','rateanime',
  'favoriteanime','favoritechar','animehistory','mal','anilist','anidb','webtoon','manhwa','manhua','lightnovel','mangaauthor','publisher',
  'animecompare','charcompare','animefacts','characterfacts','birthdayanime','birthdaychar','animecountdown','anitts'
]);

export function canHandleAnimeCommand(name){return ANIME_ENGINE_COMMANDS.has(String(name||'').toLowerCase())}

export async function handleAnimeCommand({runtime,event,name,args=[]}){
  const {client,account}=runtime,peer=event.message.peerId,raw=args.join(' ').trim();
  const say=t=>sendText(client,peer,t);
  const image=(u,c)=>sendImage(client,peer,u,c);
  const need=()=>{if(!raw)throw new Error('argument manquant pour .'+name)};

  if(name==='anitts')return animeTts(client,peer,args);

  if(name==='animeinfo'||name==='anisearch'){
    need();const m=await mediaSearch(raw,'ANIME');await remember(account.telegramUserId,'anime',raw);
    await image(m.coverImage?.extraLarge||m.coverImage?.large,mediaCard(m));return true;
  }
  if(name==='manga'){
    need();const m=await mediaSearch(raw,'MANGA');await remember(account.telegramUserId,'manga',raw);
    await image(m.coverImage?.extraLarge||m.coverImage?.large,mediaCard(m));return true;
  }
  if(name==='character'){
    need();const c=await characterSearch(raw);await remember(account.telegramUserId,'character',raw);
    await image(c.image?.large,[nameOf(c),'Genre : '+(c.gender||'?'),'Âge : '+(c.age||'?'),'Anniversaire : '+fmtDate(c.dateOfBirth),'Favoris : '+(c.favourites||0),clip(c.description,700),c.siteUrl].filter(Boolean).join('\n'));return true;
  }
  if(name==='studio'){
    need();const rows=await studioSearch(raw);await say('Studios\n\n'+rows.map((x,i)=>(i+1)+'. '+x.titles?.[0]?.title+(x.count?' · '+x.count+' œuvres':'')+'\n'+(x.url||'')).join('\n\n'));return true;
  }
  if(name==='seiyuu'){
    need();const s=await staffSearch(raw);await image(s.image?.large,[nameOf(s),s.languageV2?'Langue : '+s.languageV2:'',s.primaryOccupations?.length?'Activités : '+s.primaryOccupations.join(', '):'',s.characters?.nodes?.length?'Personnages : '+s.characters.nodes.map(nameOf).join(', '):'',clip(s.description,650),s.siteUrl].filter(Boolean).join('\n'));return true;
  }
  if(name==='animecalendar'){
    const day=clean(args[0]||new Intl.DateTimeFormat('en-US',{weekday:'long',timeZone:'Africa/Porto-Novo'}).format(new Date())).toLowerCase();
    const rows=await jikan('/schedules?filter='+encodeURIComponent(day)+'&sfw=true&limit=15');
    await say('Anime calendar · '+day+'\n\n'+(rows||[]).map((x,i)=>(i+1)+'. '+(x.title_english||x.title)+' · '+(x.broadcast?.time||'?')+' '+(x.broadcast?.timezone||'')).join('\n'));return true;
  }
  if(name==='airing'||name==='animecountdown'){
    need();const m=await mediaSearch(raw,'ANIME');const a=m.nextAiringEpisode;
    await say(a?titleOf(m)+'\nÉpisode '+a.episode+'\nDiffusion : '+fmtDateTime(a.airingAt)+'\nDans : '+Math.max(0,Math.floor(a.timeUntilAiring/86400))+' j '+Math.floor((a.timeUntilAiring%86400)/3600)+' h':'Aucun prochain épisode annoncé pour '+titleOf(m)+'.');return true;
  }
  if(name==='season'){
    const cs=currentSeason(),items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',season:cs.season,year:cs.year,perPage:12});
    await say(listMedia('Saison '+cs.season+' '+cs.year,items));return true;
  }
  if(name==='upcoming'){
    const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',status:'NOT_YET_RELEASED',perPage:12});await say(listMedia('Anime à venir',items));return true;
  }
  if(name==='topanime'||name==='topmanga'||name==='trendinganime'){
    const type=name==='topmanga'?'MANGA':'ANIME',sort=name==='trendinganime'?'TRENDING_DESC':'SCORE_DESC';
    const items=await mediaPage({type,sort,perPage:12});await say(listMedia(name==='trendinganime'?'Anime tendances':type==='ANIME'?'Top anime':'Top manga',items));return true;
  }
  if(name==='randomanime'||name==='randommanga'){
    const type=name==='randomanime'?'anime':'manga',m=await jikan('/random/'+type);
    await image(m?.images?.jpg?.large_image_url||m?.images?.jpg?.image_url,[m?.title_english||m?.title,m?.score?'Score : '+m.score+'/10':'',clip(m?.synopsis,650),m?.url].filter(Boolean).join('\n'));return true;
  }
  if(name==='recommendanime'){
    need();const m=await mediaSearch(raw,'ANIME'),rows=(m.recommendations?.nodes||[]).map(x=>x.mediaRecommendation).filter(Boolean);
    await say(listMedia('Similaires à '+titleOf(m),rows));return true;
  }
  if(name==='genre'){
    need();const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',genre:raw,perPage:12});await say(listMedia('Genre · '+raw,items));return true;
  }
  if(name==='animebyyear'){
    const year=Number(args[0]);if(year<1950||year>2100)throw new Error('année invalide');
    const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',year,perPage:12});await say(listMedia('Anime · '+year,items));return true;
  }
  if(name==='animebyseason'){
    const season=String(args[0]||'').toUpperCase(),year=Number(args[1]||new Date().getFullYear());
    if(!['WINTER','SPRING','SUMMER','FALL'].includes(season))throw new Error('usage : .animebyseason summer 2026');
    const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',season,year,perPage:12});await say(listMedia(season+' '+year,items));return true;
  }
  if(name==='episode'||name==='episodes'){
    const num=name==='episode'?Number(args.at(-1)):0;
    const q=name==='episode'?args.slice(0,-1).join(' '):raw;if(!q)throw new Error('nom anime manquant');
    const a=await jikanAnime(q);
    if(name==='episode'){
      if(!num)throw new Error('numéro épisode manquant');
      const e=await jikan('/anime/'+a.mal_id+'/episodes/'+num);
      await say([a.title,'Épisode '+num+' · '+(e?.title||'?'),e?.aired?'Diffusion : '+e.aired:'',e?.filler?'Filler : oui':'',e?.recap?'Récap : oui':'',e?.url||''].filter(Boolean).join('\n'));
    }else{
      const rows=await jikan('/anime/'+a.mal_id+'/episodes?page=1');
      await say(a.title+' · épisodes\n\n'+(rows||[]).slice(0,20).map(x=>x.mal_id+'. '+(x.title||'?')+(x.aired?' · '+x.aired.slice(0,10):'')).join('\n'));
    }return true;
  }
  if(['openingsearch','endingsearch','anisong'].includes(name)){
    need();const a=await jikanFullAnime(raw),open=a?.theme?.openings||[],end=a?.theme?.endings||[];
    if(name==='openingsearch')await say(a.title+' · Openings\n'+(open.join('\n')||'Aucun opening référencé.'));
    else if(name==='endingsearch')await say(a.title+' · Endings\n'+(end.join('\n')||'Aucun ending référencé.'));
    else await say(a.title+' · Anime songs\n\nOpenings\n'+(open.join('\n')||'—')+'\n\nEndings\n'+(end.join('\n')||'—'));
    return true;
  }
  if(name==='ost'){
    need();const m=await mediaSearch(raw,'ANIME');await say('OST · '+titleOf(m)+'\nhttps://www.youtube.com/results?search_query='+encodeURIComponent(titleOf(m)+' anime OST'));return true;
  }
  if(name==='trailer'){
    need();const m=await mediaSearch(raw,'ANIME'),t=m.trailer;
    const u=t?.site==='youtube'&&t.id?'https://www.youtube.com/watch?v='+t.id:(t?.id||'');
    await say(u?titleOf(m)+' · Trailer\n'+u:'Aucun trailer référencé pour '+titleOf(m)+'.');return true;
  }
  if(name==='animequote'||name==='characterquote'){
    const q=await animeQuote(raw);await say('“'+q.quote+'”\n— '+q.character+' · '+q.anime);return true;
  }
  if(['animeimage','wallpaperanime','banneranime'].includes(name)){
    need();const m=await mediaSearch(raw,'ANIME');
    const u=name==='animeimage'?m.coverImage?.extraLarge||m.coverImage?.large:m.bannerImage||m.coverImage?.extraLarge||m.coverImage?.large;
    await image(u,titleOf(m)+' · '+name);return true;
  }
  if(name==='avataranime'){
    need();const c=await characterSearch(raw);await image(c.image?.large,nameOf(c)+' · avatar');return true;
  }
  if(['waifu','waifuhd','neko','cosplay','cosplayvip'].includes(name)){
    const kind=name.startsWith('neko')?'neko':name.startsWith('cosplay')?'cosplay':'waifu';
    const u=await waifuImage(kind);await image(u,'NexAi · '+name+' · SFW');return true;
  }
  if(name==='husbando'){
    const q=`query{Page(page:1,perPage:50){characters(sort:[FAVOURITES_DESC]){name{full} gender image{large} siteUrl}}}`;
    const d=await anilist(q),rows=(d?.Page?.characters||[]).filter(x=>String(x.gender).toLowerCase()==='male'),c=random(rows);
    if(!c)throw new Error('aucun personnage disponible');await image(c.image?.large,nameOf(c)+'\n'+c.siteUrl);return true;
  }
  if(name==='amv'||name==='amvhd'){await say('NexAi · '+name+'\n'+random(name==='amvhd'?AMV_HD:AMV));return true}
  if(name==='opening'||name==='openingvip'){const row=random(name==='openingvip'?OPENINGS_VIP:OPENINGS);await say(row[0]+'\n'+row[1]);return true}
  if(name==='ship'){
    const p=splitTwo(raw);if(p.length<2)throw new Error('usage : .ship personnage1 | personnage2');
    await say('Ship fictif · '+p[0]+' × '+p[1]+'\nCompatibilité fun : '+hashPercent(p[0],p[1])+'%');return true;
  }
  if(name==='guessanime'||name==='animeriddle'){
    if(raw){const checked=await checkGame(account.telegramUserId,name,raw);if(checked){await say((checked.ok?'Correct.':'Raté.')+' Réponse : '+checked.answer);return true}}
    const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',page:1+Math.floor(Math.random()*4),perPage:20}),m=random(items);
    const full=await mediaSearch(titleOf(m),'ANIME');await gameState(account.telegramUserId,{kind:name,answer:titleOf(full),at:Date.now()});
    await say((name==='guessanime'?'Devine l’anime':'Devinette anime')+'\n\n'+clip(full.description,600)+'\n\nRéponds : .'+name+' <titre>');return true;
  }
  if(name==='guesscharacter'){
    if(raw){const checked=await checkGame(account.telegramUserId,name,raw);if(checked){await say((checked.ok?'Correct.':'Raté.')+' Réponse : '+checked.answer);return true}}
    const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',perPage:20}),m=random(items),full=await mediaSearch(titleOf(m),'ANIME'),c=random(full.characters?.nodes||[]);
    if(!c)throw new Error('personnage indisponible');await gameState(account.telegramUserId,{kind:name,answer:nameOf(c),at:Date.now()});
    await image(c.image?.large,'Devine le personnage\nAnime : '+titleOf(full)+'\nRéponds : .guesscharacter <nom>');return true;
  }
  if(name==='guessopening'){
    if(raw){const checked=await checkGame(account.telegramUserId,name,raw);if(checked){await say((checked.ok?'Correct.':'Raté.')+' Réponse : '+checked.answer);return true}}
    const items=await mediaPage({type:'ANIME',sort:'POPULARITY_DESC',perPage:20});
    for(const m of items.sort(()=>Math.random()-.5)){
      try{const a=await jikanFullAnime(titleOf(m)),op=random(a?.theme?.openings||[]);if(op){await gameState(account.telegramUserId,{kind:name,answer:titleOf(m),at:Date.now()});await say('Quel anime utilise cet opening ?\n'+op+'\n\nRéponds : .guessopening <anime>');return true}}catch{}
    }
    throw new Error('opening quiz indisponible');
  }
  if(name==='animequiz'||name==='mangaquiz'){
    if(raw){const checked=await checkGame(account.telegramUserId,name,raw);if(checked){await say((checked.ok?'Correct.':'Raté.')+' Réponse : '+checked.answer);return true}}
    const q=await randomQuiz(name==='animequiz'?'ANIME':'MANGA');await gameState(account.telegramUserId,{kind:name,answer:q.answer,at:Date.now()});
    await say(q.question+'\n\n'+q.choices.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n\nRéponds : .'+name+' <titre>');return true;
  }
  if(name==='whosaid'){
    if(raw){const checked=await checkGame(account.telegramUserId,name,raw);if(checked){await say((checked.ok?'Correct.':'Raté.')+' Réponse : '+checked.answer);return true}}
    const q=await animeQuote();await gameState(account.telegramUserId,{kind:name,answer:q.character,at:Date.now()});
    await say('Qui a dit : “'+q.quote+'” ?\nAnime : '+q.anime+'\nRéponds : .whosaid <personnage>');return true;
  }
  if(name==='powerbattle'||name==='animecompare'||name==='charcompare'){
    const p=splitTwo(raw);if(p.length<2)throw new Error('sépare les deux noms avec |');
    if(name==='charcompare'){
      const [a,b]=await Promise.all(p.map(characterSearch));
      await say([nameOf(a)+' vs '+nameOf(b),'Favoris : '+(a.favourites||0)+' vs '+(b.favourites||0),'Genre : '+(a.gender||'?')+' vs '+(b.gender||'?'),'Aucun vainqueur canonique n’est déduit de ces données.'].join('\n'));
    }else{
      const [a,b]=await Promise.all(p.map(x=>mediaSearch(x,'ANIME')));
      await say([titleOf(a)+' vs '+titleOf(b),'Score : '+(a.averageScore||'?')+' vs '+(b.averageScore||'?'),'Popularité : '+(a.popularity||'?')+' vs '+(b.popularity||'?'),'Favoris : '+(a.favourites||'?')+' vs '+(b.favourites||'?'),name==='powerbattle'?'Ces statistiques ne déterminent pas un vainqueur canonique.':''].filter(Boolean).join('\n'));
    }return true;
  }
  if(name==='animeprofile'){
    const s=await settingsFor(account.telegramUserId),lib=s.animeLibrary||{};
    await say(['Anime profile','Watching : '+(lib.watching?.length||0),'Completed : '+(lib.completed?.length||0),'Planned : '+(lib.planned?.length||0),'Dropped : '+(lib.dropped?.length||0),'Anime favoris : '+(lib.favoriteAnime?.length||0),'Personnages favoris : '+(lib.favoriteChar?.length||0),'Notes : '+Object.keys(lib.ratings||{}).length].join('\n'));return true;
  }
  if(name==='animelist'){
    const s=await settingsFor(account.telegramUserId),lib=s.animeLibrary||{};
    await say('Watching\n'+listBucket(lib,'watching')+'\n\nCompleted\n'+listBucket(lib,'completed')+'\n\nPlanned\n'+listBucket(lib,'planned')+'\n\nDropped\n'+listBucket(lib,'dropped'));return true;
  }
  if(name==='mangalist'){
    if(raw){
      const m=await mediaSearch(raw,'MANGA');
      const lib=await patchLibrary(account.telegramUserId,lib=>{
        lib.manga=[...(lib.manga||[]).filter(x=>x.id!==m.id),{id:m.id,title:titleOf(m),siteUrl:m.siteUrl}];
        return lib;
      });
      await say(titleOf(m)+' ajouté à la manga list.\nTotal : '+(lib.manga?.length||0));
      return true;
    }
    const s=await settingsFor(account.telegramUserId),lib=s.animeLibrary||{};await say('Manga list\n'+listBucket(lib,'manga'));return true;
  }
  if(['watching','completed','planned','dropped'].includes(name)){
    if(!raw){const s=await settingsFor(account.telegramUserId);await say(name+'\n'+listBucket(s.animeLibrary||{},name));return true}
    const lib=await setStatus(account.telegramUserId,name,raw,'ANIME');await say(titleOf(await mediaSearch(raw,'ANIME'))+' → '+name+'\nTotal : '+(lib[name]?.length||0));return true;
  }
  if(name==='rateanime'){
    const parts=raw.split('|').map(clean);const score=Number(parts.pop());const query=parts.join('|');if(!query||score<0||score>10)throw new Error('usage : .rateanime Naruto | 9');
    const m=await mediaSearch(query,'ANIME');await patchLibrary(account.telegramUserId,lib=>{lib.ratings={...(lib.ratings||{}),[m.id]:{title:titleOf(m),score}};return lib});await say(titleOf(m)+' noté '+score+'/10.');return true;
  }
  if(name==='favoriteanime'){
    need();const m=await mediaSearch(raw,'ANIME');await patchLibrary(account.telegramUserId,lib=>{lib.favoriteAnime=[...(lib.favoriteAnime||[]).filter(x=>x.id!==m.id),{id:m.id,title:titleOf(m),siteUrl:m.siteUrl}];return lib});await say(titleOf(m)+' ajouté aux favoris.');return true;
  }
  if(name==='favoritechar'){
    need();const c=await characterSearch(raw);await patchLibrary(account.telegramUserId,lib=>{lib.favoriteChar=[...(lib.favoriteChar||[]).filter(x=>x.id!==c.id),{id:c.id,name:nameOf(c),siteUrl:c.siteUrl}];return lib});await say(nameOf(c)+' ajouté aux personnages favoris.');return true;
  }
  if(name==='animehistory'){
    const s=await settingsFor(account.telegramUserId),h=s.animeLibrary?.history||[];await say('Historique anime\n'+(h.length?h.map((x,i)=>(i+1)+'. '+x.type+' · '+x.query).join('\n'):'Vide.'));return true;
  }
  if(name==='mal'||name==='anilist'||name==='anidb'){
    need();
    if(name==='mal'){const a=await jikanAnime(raw);await say((a.title_english||a.title)+'\n'+(a.url||('https://myanimelist.net/anime/'+a.mal_id)));return true}
    const m=await mediaSearch(raw,'ANIME');
    if(name==='anilist'){await say(titleOf(m)+'\n'+m.siteUrl);return true}
    const link=(m.externalLinks||[]).find(x=>/anidb/i.test(x.site||''));
    await say(titleOf(m)+'\n'+(link?.url||'Aucun lien AniDB référencé dans AniList.'));return true;
  }
  if(['webtoon','manhwa','manhua','lightnovel'].includes(name)){
    need();const type=name==='lightnovel'?'lightnovel':name==='webtoon'?'manhwa':name;
    const m=await jikanManga(raw,type);
    await image(m?.images?.jpg?.large_image_url||m?.images?.jpg?.image_url,[m?.title_english||m?.title,'Type : '+(m?.type||name),m?.chapters?'Chapitres : '+m.chapters:'',m?.volumes?'Volumes : '+m.volumes:'',m?.score?'Score : '+m.score+'/10':'',clip(m?.synopsis,650),m?.url].filter(Boolean).join('\n'));return true;
  }
  if(name==='mangaauthor'){
    need();const rows=await jikan('/people?q='+encodeURIComponent(raw)+'&limit=1');const p=rows?.[0];if(!p)throw new Error('Auteur introuvable');
    const full=await jikan('/people/'+p.mal_id+'/full');
    await image(full?.images?.jpg?.image_url,[full?.name,'Anniversaire : '+(full?.birthday||'?'),'Manga : '+(full?.manga||[]).slice(0,12).map(x=>x.manga?.title).filter(Boolean).join(', '),clip(full?.about,650),full?.url].filter(Boolean).join('\n'));return true;
  }
  if(name==='publisher'){
    need();const m=await jikanManga(raw);
    await say([m.title,'Sérialisation : '+(m.serializations||[]).map(x=>x.name).join(', '),'Auteurs : '+(m.authors||[]).map(x=>x.name).join(', '),m.url].filter(Boolean).join('\n'));return true;
  }
  if(name==='animefacts'){
    need();const m=await mediaSearch(raw,'ANIME');
    await say(['Facts · '+titleOf(m),'Format : '+(m.format||'?'),'Statut : '+(m.status||'?'),'Épisodes : '+(m.episodes||'?'),'Durée : '+(m.duration||'?')+' min','Score : '+(m.averageScore||'?')+'/100','Popularité : '+(m.popularity||'?'),'Trending : '+(m.trending||'?'),'Favoris : '+(m.favourites||'?'),'Studio : '+(m.studios?.nodes?.map(x=>x.name).join(', ')||'?')].join('\n'));return true;
  }
  if(name==='characterfacts'){
    need();const c=await characterSearch(raw);
    await say(['Facts · '+nameOf(c),'Genre : '+(c.gender||'?'),'Âge : '+(c.age||'?'),'Anniversaire : '+fmtDate(c.dateOfBirth),'Favoris AniList : '+(c.favourites||0),'Œuvres : '+(c.media?.nodes||[]).slice(0,8).map(titleOf).join(', ')].join('\n'));return true;
  }
  if(name==='birthdayanime'||name==='birthdaychar'){
    let month,day;
    if(raw&&/^\d{1,2}[\/-]\d{1,2}$/.test(raw)){[day,month]=raw.split(/[\/-]/).map(Number)}
    else {const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Porto-Novo',day:'2-digit',month:'2-digit'}).format(new Date()).split('/');day=Number(parts[0]);month=Number(parts[1])}
    const rows=await birthdayPopular(month,day);
    await say('Anniversaires '+String(day).padStart(2,'0')+'/'+String(month).padStart(2,'0')+' · personnages populaires\n\n'+(rows.length?rows.map(x=>nameOf(x)+(x.dateOfBirth?.year?' · '+x.dateOfBirth.year:'')).join('\n'):'Aucun résultat dans les personnages populaires scannés.'));return true;
  }
  throw new Error('commande Anime non routée : '+name);
}
