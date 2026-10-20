/**
 * Otaku Nexus editorial feed. All factual data comes from AniList or the
 * source RSS item; no invented premiere dates or ratings.
 * API: https://docs.anilist.co/guide/graphql/
 */
const ANILIST='https://graphql.anilist.co';
const RSS='https://www.animenewsnetwork.com/all/rss.xml';
const safe=v=>String(v??'').trim();
const cap=(text,n=530)=>Array.from(safe(text)).slice(0,n).join('').trim();
const norm=v=>safe(v).replace(/\s+/g,' ');
const decode=v=>String(v).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n))));
export const stripMarkup=html=>norm(decode(String(html||'').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]*>/g,' ')));
export const EDITORIAL_KINDS=['anime','manga','manhwa','webtoon','trend_anime','trend_manga'];

const QUERY=`query($type:MediaType,$sort:[MediaSort]) {
  Page(page:1,perPage:50) {
    media(type:$type,sort:$sort,isAdult:false) {
      id title { romaji english native }
      description(asHtml:false)
      countryOfOrigin
      genres tags { name }
      episodes chapters
      status seasonYear
      coverImage { large extraLarge }
      siteUrl
    }
  }
}`;

export function editorialKind(day,mode='recommendation'){
  const n=Math.floor(new Date(day+'T12:00:00Z').getTime()/86400000);
  if(!Number.isFinite(n))throw new Error('Date éditoriale invalide.');
  const order=mode==='trending'?['trend_anime','trend_manga']:['anime','manga','manhwa','webtoon'];
  return order[((n%order.length)+order.length)%order.length];
}

export function chooseEditorial(rows,kind,{day='2026-10-19',recent=[]}={}){
  const input=(Array.isArray(rows)?rows:[]).filter(x=>x&&Number.isInteger(x.id)&&!x.isAdult&&
    (kind==='manhwa'?x.countryOfOrigin==='KR':
      kind==='webtoon'?x.countryOfOrigin==='KR'&&(x.tags||[]).some(t=>/webtoon/i.test(String(t?.name||''))):true));
  if(!input.length)return null;
  const blocked=new Set(recent.map(Number));
  const fresh=input.filter(x=>!blocked.has(x.id));
  const pool=fresh.length?fresh:input;
  const key=day.replace(/-/g,'')+kind;
  let hash=0;for(const ch of key)hash=((hash*31)+ch.charCodeAt(0))>>>0;
  return pool[hash%Math.min(pool.length,25)];
}

export function formatOtakuEditorial(media,kind){
  if(!media?.id)throw new Error('Publication éditoriale sans œuvre.');
  const title=cap(media.title?.english||media.title?.romaji||media.title?.native,120);
  if(!title)throw new Error('Titre vérifié manquant.');
  const summary=cap(stripMarkup(media.description),650);
  if(!summary)throw new Error('Synopsis source indisponible.');
  const labels={
    anime:'🌸🔥 UNE PÉPITE ANIME À DÉCOUVRIR ! 🎬✨',
    manga:'📚💥 CE MANGA MÉRITE TON ATTENTION ! 📖🔥',
    manhwa:'👑⚔️ UNE PÉPITE CORÉENNE À DÉCOUVRIR ! 🇰🇷🔥',
    webtoon:'📱🌈 UN WEBTOON À DÉCOUVRIR ! 🇰🇷📚',
    trend_anime:'📈🔥 ANIME EN TENDANCE SUR ANILIST ! 🎌👀',
    trend_manga:'📈📚 MANGA EN TENDANCE SUR ANILIST ! 🔥'
  };
  const genre=(Array.isArray(media.genres)?media.genres:[]).slice(0,4).join(' • ');
  const isManga=kind==='manga'||kind==='manhwa'||kind==='webtoon'||kind==='trend_manga';
  const where=kind==='webtoon'?'#Webtoon #Manhwa #OtakuNexus':kind==='manhwa'?'#Manhwa #OtakuNexus':isManga?'#Manga #OtakuNexus':'#Anime #OtakuNexus';
  const facts=[genre?'🎭 Genres : '+genre:'',!isManga&&media.episodes?'🎞️ Épisodes : '+media.episodes:'',isManga&&media.chapters?'📖 Chapitres : '+media.chapters:'',media.status?'📌 Statut : '+media.status:''].filter(Boolean);
  const url=String(media.siteUrl||'');
  if(!/^https:\/\/anilist\.co\/(anime|manga)\/\d+/.test(url))throw new Error('Lien AniList non fiable.');
  const lines=[
    labels[kind]||labels.anime,
    '',
    '🎬 '+title,
    '',
    '✨ '+summary,
    '',
    '╭──────── FICHE OTAKU ────────╮',
    ...facts,
    '╰────────────────────────────╯',
    '',
    kind.startsWith('trend')?'🔥 Une œuvre qui attire l’attention dans les tendances AniList !':'🔥 Une nouvelle découverte pour ta liste Otaku !',
    '💬 Tu la connais déjà ou tu comptes la découvrir ?',
    '',
    '🔎 Fiche et source : '+url,
    where
  ];
  return {title,text:lines.join('\n'),image:media.coverImage?.extraLarge||media.coverImage?.large||'',source:url,id:'anilist:'+media.id};
}

export async function fetchAniListEditorial(kind,{day='2026-10-19',recent=[],fetcher=fetch}={}){
  const mediaType=['manga','manhwa','webtoon','trend_manga'].includes(kind)?'MANGA':'ANIME';
  const sort=kind.startsWith('trend')?'TRENDING_DESC':'POPULARITY_DESC';
  const response=await fetcher(ANILIST,{
    method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'OtakuNexusBot/1.0'},
    body:JSON.stringify({query:QUERY,variables:{type:mediaType,sort:[sort]}}),
    signal:AbortSignal.timeout(16000)
  });
  if(!response.ok)throw new Error('AniList HTTP '+response.status);
  const data=await response.json();
  if(data.errors?.length)throw new Error('AniList query error');
  const chosen=chooseEditorial(data?.data?.Page?.media,kind,{day,recent});
  if(!chosen)throw new Error('Aucune œuvre vérifiée disponible pour '+kind);
  return formatOtakuEditorial(chosen,kind);
}

function getTag(chunk,name){
  const match=chunk.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));
  return match?decode(match[1].replace(/^<!\[CDATA\[/,'').replace(/\]\]>$/,'')).trim():'';
}
export function parseAnnFeed(xml,{now=Date.now()}={}){
  const items=[...String(xml||'').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  return items.map(m=>{
    const c=m[1],title=stripMarkup(getTag(c,'title')),url=safe(getTag(c,'link'));
    const publishedAt=Date.parse(getTag(c,'pubDate'));
    const mediaMatch=c.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*url=["'](https:\/\/[^"'<>]+)["'][^>]*>/i);
    const image=mediaMatch?decode(mediaMatch[1]):'';
    return {title,url,publishedAt,image,summary:cap(stripMarkup(getTag(c,'description')),250)};
  }).filter(x=>x.title&&/^https:\/\/(?:www\.)?animenewsnetwork\.com\//i.test(x.url)&&Number.isFinite(x.publishedAt)&&
    x.publishedAt<=now+5*60_000 && now-x.publishedAt<4*86400000);
}

export function formatAnnNews(article){
  if(!article?.title||!article?.url)throw new Error('Article source manquant.');
  const headline=cap(article.title,150);
  const short=cap(article.summary,320);
  return [
    '🚨🔥 ACTUALITÉ OTAKU — UNE NOUVELLE ANNONCE ! 🎌',
    '',
    '🗞️ '+headline,
    '',
    short||'Une nouvelle information vient d’être publiée. Découvre tous les détails auprès de la source.',
    '',
    '📅 '+new Date(article.publishedAt).toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'}),
    '📰 Source : Anime News Network',
    '🔗 '+article.url,
    '',
    '💬 Que penses-tu de cette actualité ?',
    '#AnimeNews #MangaNews #OtakuNexus'
  ].join('\n');
}

export async function fetchLatestAnn({seen=[],fetcher=fetch,now=Date.now()}={}){
  const r=await fetcher(RSS,{headers:{'user-agent':'OtakuNexusBot/1.0'},signal:AbortSignal.timeout(16000)});
  if(!r.ok)throw new Error('ANN RSS HTTP '+r.status);
  const articles=parseAnnFeed(await r.text(),{now});
  return articles.find(x=>!seen.includes(x.url))||null;
}
