const normalizeSource=value=>String(value??'')
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export const NEXANIME_PRIORITY_SOURCES=Object.freeze([
  Object.freeze({
    id:'scan-manga',
    name:'Scan Manga',
    priority:1000,
    capabilities:Object.freeze(['manga','scan']),
    aliases:Object.freeze(['scan manga','scanmanga'])
  }),
  Object.freeze({
    id:'anime-sama',
    name:'Anime Sama',
    priority:1000,
    capabilities:Object.freeze(['anime']),
    aliases:Object.freeze(['anime sama','animesama'])
  }),
  Object.freeze({
    id:'scantrad',
    name:'Scantrad',
    priority:990,
    capabilities:Object.freeze(['manga','scan','manhwa','webtoon']),
    aliases:Object.freeze(['scantrad','scan trad'])
  }),
  Object.freeze({
    id:'epsilon-scan',
    name:'Epsilon Scan',
    priority:980,
    capabilities:Object.freeze(['manga','scan','manhwa','webtoon']),
    aliases:Object.freeze(['epsilon scan','epsilonscan'])
  }),
  Object.freeze({
    id:'toonmic',
    name:'Toonmic',
    priority:970,
    capabilities:Object.freeze(['webtoon','manhwa']),
    aliases:Object.freeze(['toonmic','toon mic'])
  }),
  Object.freeze({
    id:'lelmanga',
    name:'Lelmanga',
    priority:960,
    capabilities:Object.freeze(['manga','scan','manhwa','webtoon']),
    aliases:Object.freeze(['lelmanga','lel manga'])
  })
]);

export function sourceRegistryMatch(value,capability=''){
  const raw=normalizeSource(value);
  if(!raw)return null;
  const wanted=normalizeSource(capability);
  let best=null;
  for(const source of NEXANIME_PRIORITY_SOURCES){
    if(wanted&&!source.capabilities.includes(wanted))continue;
    for(const alias of source.aliases){
      const a=normalizeSource(alias);
      if(!a)continue;
      if(raw===a||raw.includes(a)||a.includes(raw)){
        if(!best||source.priority>best.priority)best=source;
      }
    }
  }
  return best;
}

export function sourcePriority(input={},capability=''){
  const text=[
    input?.name,input?.title,input?.username,input?.channelTitle,input?.channelUsername,
    input?.url,input?.host,input?.domain
  ].filter(Boolean).join(' ');
  return sourceRegistryMatch(text,capability)?.priority||0;
}

export function sourceRegistrySummary(){
  return NEXANIME_PRIORITY_SOURCES.map(source=>({
    id:source.id,
    capabilities:[...source.capabilities],
    priority:source.priority
  }));
}
