const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NexAi/1.0';
const MAX_MEDIA_BYTES=100*1024*1024;

function clean(value){return String(value??'').trim()}
function isHttp(value){return /^https?:\/\//i.test(clean(value))}
function youtubeUrl(value){return /(?:youtube\.com|youtu\.be)\//i.test(clean(value))}
function safeName(value,fallback='media.bin'){
  const out=String(value||fallback).replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').replace(/\s+/g,' ').trim();
  return (out||fallback).slice(0,120);
}
function extFromType(type,url=''){
  const t=String(type||'').toLowerCase();
  if(t.includes('audio'))return 'mp3';
  if(t.includes('video'))return 'mp4';
  if(t.includes('png'))return 'png';
  if(t.includes('webp'))return 'webp';
  if(t.includes('jpeg')||t.includes('jpg'))return 'jpg';
  const m=String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return m?.[1]?.toLowerCase()||'bin';
}
async function response(url,options={},timeout=30000){
  const r=await fetch(url,{
    ...options,
    headers:{'user-agent':UA,...(options.headers||{})},
    signal:AbortSignal.timeout(timeout)
  });
  if(!r.ok)throw new Error('HTTP '+r.status+' · '+new URL(url).hostname);
  return r;
}
async function json(url,options={},timeout=30000){
  return response(url,options,timeout).then(r=>r.json());
}
async function text(url,options={},timeout=30000){
  return response(url,options,timeout).then(r=>r.text());
}
async function postJson(url,body,headers={}){
  return json(url,{method:'POST',headers:{accept:'application/json','content-type':'application/json',...headers},body:JSON.stringify(body)},35000);
}
async function postForm(url,params,headers={}){
  const body=new URLSearchParams(params).toString();
  return response(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body},35000);
}
function firstUrl(value,predicate=()=>true){
  const seen=new Set();
  function walk(v){
    if(v==null)return '';
    if(typeof v==='string'){
      if(/^https?:\/\//i.test(v)&&predicate(v)&&!seen.has(v)){seen.add(v);return v}
      return '';
    }
    if(Array.isArray(v)){
      for(const x of v){const hit=walk(x);if(hit)return hit}
      return '';
    }
    if(typeof v==='object'){
      for(const [k,x] of Object.entries(v)){
        if(/thumb|avatar|cover|author|profile/i.test(k))continue;
        const hit=walk(x);if(hit)return hit;
      }
    }
    return '';
  }
  return walk(value);
}
function cobaltUrl(d){
  if(!d)return '';
  if((d.status==='tunnel'||d.status==='redirect')&&isHttp(d.url))return d.url;
  if(d.status==='picker'&&Array.isArray(d.picker)){
    const item=d.picker.find(x=>x?.type==='video')||d.picker.find(x=>x?.type==='audio')||d.picker[0];
    if(isHttp(item?.url))return item.url;
  }
  return isHttp(d.url)?d.url:'';
}
async function cascade(label,attempts){
  const errors=[];
  for(const [name,fn] of attempts){
    try{
      const value=await fn();
      if(value)return {...value,source:name};
      errors.push(name+': empty');
    }catch(e){errors.push(name+': '+String(e.message||e))}
  }
  throw new Error(label+' indisponible · '+errors.slice(-4).join(' | '));
}
async function sendRemote(client,peer,url,{caption='',fileName='media.bin',maxBytes=MAX_MEDIA_BYTES}={}){
  const r=await response(url,{headers:{accept:'*/*'}},120000);
  const declared=Number(r.headers.get('content-length')||0);
  if(declared&&declared>maxBytes)throw new Error('fichier trop volumineux ('+Math.round(declared/1024/1024)+' Mo)');
  const buf=Buffer.from(await r.arrayBuffer());
  if(!buf.length)throw new Error('média vide');
  if(buf.length>maxBytes)throw new Error('fichier trop volumineux ('+Math.round(buf.length/1024/1024)+' Mo)');
  const type=r.headers.get('content-type')||'';
  const ext=extFromType(type,url);
  const finalName=fileName.includes('.')?fileName:(fileName+'.'+ext);
  return client.sendFile(peer,{file:buf,fileName:finalName,caption});
}
async function resolveYoutube(input){
  const raw=clean(input);
  if(!raw)throw new Error('indique un titre ou un lien YouTube');
  if(youtubeUrl(raw))return {url:raw,title:'YouTube'};
  const mod=await import('yt-search');
  const yts=mod.default||mod;
  const result=await yts(raw);
  const item=result?.videos?.[0];
  if(!item?.url)throw new Error('aucun résultat YouTube');
  return {url:item.url,title:item.title||raw,thumbnail:item.thumbnail||''};
}
async function youtubeAudio(input){
  const raw=clean(input);
  const target=await resolveYoutube(raw);
  const u=encodeURIComponent(target.url);
  const result=await cascade('audio YouTube',[
    ['EliteProTech',async()=>{
      const d=await json('https://eliteprotech-apis.zone.id/ytdown?url='+u+'&format=mp3');
      return d?.success&&d?.downloadURL?{url:d.downloadURL,title:d.title||target.title}:null;
    }],
    ['Yupra',async()=>{
      const d=await json('https://api.yupra.my.id/api/downloader/ytmp3?url='+u);
      return d?.success&&d?.data?.download_url?{url:d.data.download_url,title:d.data.title||target.title}:null;
    }],
    ['Okatsu',async()=>{
      const d=await json('https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url='+u);
      return d?.dl?{url:d.dl,title:d.title||target.title}:null;
    }],
    ['Izumi',async()=>{
      const d=await json('https://izumiiiiiiii.dpdns.org/downloader/youtube?url='+u+'&format=mp3',{},60000);
      return d?.result?.download?{url:d.result.download,title:d.result.title||target.title}:null;
    }],
    ['IzumiQuery',async()=>{
      if(isHttp(raw))return null;
      const d=await json('https://izumiiiiiiii.dpdns.org/downloader/youtube-play?query='+encodeURIComponent(raw),{},60000);
      return d?.result?.download?{url:d.result.download,title:d.result.title||target.title}:null;
    }]
  ]);
  return {...result,target};
}
async function youtubeVideo(input){
  const target=await resolveYoutube(input);
  const u=encodeURIComponent(target.url);
  const result=await cascade('vidéo YouTube',[
    ['EliteProTech',async()=>{
      const d=await json('https://eliteprotech-apis.zone.id/ytdown?url='+u+'&format=mp4');
      return d?.success&&d?.downloadURL?{url:d.downloadURL,title:d.title||target.title}:null;
    }],
    ['Yupra',async()=>{
      const d=await json('https://api.yupra.my.id/api/downloader/ytmp4?url='+u);
      return d?.success&&d?.data?.download_url?{url:d.data.download_url,title:d.data.title||target.title}:null;
    }],
    ['Okatsu',async()=>{
      const d=await json('https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url='+u);
      return d?.result?.mp4?{url:d.result.mp4,title:d.result.title||target.title}:null;
    }]
  ]);
  return {...result,target};
}
async function tiktokMedia(url){
  if(!/tiktok\.com\//i.test(url))throw new Error('lien TikTok invalide');
  return cascade('TikTok',[
    ['Siputzx',async()=>{
      const d=await json('https://api.siputzx.my.id/api/d/tiktok?url='+encodeURIComponent(url));
      const v=d?.data?.urls?.[0]||d?.data?.video_url||d?.data?.url||d?.data?.download_url;
      return isHttp(v)?{url:v,title:d?.data?.metadata?.title||'TikTok'}:null;
    }],
    ['TikWM',async()=>{
      const r=await postForm('https://www.tikwm.com/api/',{url,hd:'1'});
      const d=await r.json();
      const v=d?.data?.hdplay||d?.data?.play;
      return isHttp(v)?{url:v,title:d?.data?.title||'TikTok'}:null;
    }],
    ['Cobalt',async()=>{
      const d=await postJson('https://api.cobalt.tools/',{url,downloadMode:'auto',videoQuality:'max',tiktokH265:false});
      const v=cobaltUrl(d);
      return v?{url:v,title:'TikTok'}:null;
    }]
  ]);
}
async function instagramMedia(url){
  if(!/instagram\.com\//i.test(url)&&!/instagr\.am\//i.test(url))throw new Error('lien Instagram invalide');
  return cascade('Instagram',[
    ['Siputzx',async()=>{
      const d=await json('https://api.siputzx.my.id/api/d/igdl?url='+encodeURIComponent(url));
      const arr=Array.isArray(d?.data)?d.data:Array.isArray(d?.result)?d.result:[];
      const urls=arr.map(x=>x?.url||x?.download_url||x).filter(isHttp);
      const generic=firstUrl(d,u=>!/thumbnail|profile/i.test(u));
      const all=[...new Set([...urls,generic].filter(Boolean))];
      return all.length?{urls:all,title:'Instagram'}:null;
    }],
    ['Cobalt',async()=>{
      const d=await postJson('https://api.cobalt.tools/',{url,downloadMode:'auto',videoQuality:'max'});
      if(d?.status==='picker'&&Array.isArray(d.picker)){
        const urls=d.picker.map(x=>x?.url).filter(isHttp);
        return urls.length?{urls,title:'Instagram'}:null;
      }
      const v=cobaltUrl(d);
      return v?{urls:[v],title:'Instagram'}:null;
    }]
  ]);
}
async function facebookMedia(url){
  if(!/(?:facebook\.com|fb\.watch)\//i.test(url))throw new Error('lien Facebook invalide');
  const cobaltHosts=['https://api.cobalt.tools/','https://cobalt.drgns.space/','https://cobalt.api.timelessnesses.me/'];
  const attempts=cobaltHosts.map(host=>['Cobalt '+new URL(host).hostname,async()=>{
    const d=await postJson(host,{url,downloadMode:'auto',videoQuality:'max'});
    const v=cobaltUrl(d);
    return v?{url:v,title:'Facebook'}:null;
  }]);
  attempts.push(['SaveFrom',async()=>{
    const d=await json('https://savefrom.net/api/convert?url='+encodeURIComponent(url)+'&lang=fr',{},35000);
    const v=firstUrl(d,u=>/\.mp4(?:[?#]|$)|video/i.test(u));
    return v?{url:v,title:d?.meta?.title||d?.title||'Facebook'}:null;
  }]);
  return cascade('Facebook',attempts);
}
async function pinterestMedia(url){
  if(!/(?:pinterest\.|pin\.it\/)/i.test(url))throw new Error('lien Pinterest invalide');
  const d=await json('https://api.nexray.web.id/downloader/pinterest?url='+encodeURIComponent(url),{},35000);
  if(!d?.status||!d?.result)throw new Error('Pinterest API sans résultat');
  const p=d.result;
  const media=p.video||p.image||p.url;
  if(!isHttp(media))throw new Error('aucun média Pinterest');
  return {url:media,title:p.title||'Pinterest',author:p.author||'',video:!!p.video,source:'Nexray'};
}
async function lyricsSearch(raw){
  const value=clean(raw);
  if(!value)throw new Error('usage : .lyrics artiste - titre');
  let artist='',title=value;
  if(value.includes(' - ')){const parts=value.split(' - ');artist=parts.shift().trim();title=parts.join(' - ').trim()}
  const attempts=[
    ['lyrics.ovh',async()=>{
      if(!artist)return null;
      const d=await json('https://api.lyrics.ovh/v1/'+encodeURIComponent(artist)+'/'+encodeURIComponent(title),{},12000);
      return d?.lyrics?{lyrics:String(d.lyrics).trim(),artist,title}:null;
    }],
    ['lrclib',async()=>{
      const qs=artist
        ?new URLSearchParams({artist_name:artist,track_name:title})
        :new URLSearchParams({q:value});
      const d=await json('https://lrclib.net/api/search?'+qs.toString(),{},12000);
      const item=Array.isArray(d)?d.find(x=>x?.plainLyrics):null;
      return item?.plainLyrics?{lyrics:String(item.plainLyrics).trim(),artist:item.artistName||artist,title:item.trackName||title,duration:item.duration}:null;
    }]
  ];
  return cascade('paroles',attempts);
}
function replyId(message){
  return Number(message?.replyTo?.replyToMsgId||message?.replyToMsgId||message?.replyTo?.msgId||0);
}
async function repliedOrCurrentMedia(client,peer,message){
  if(message?.media)return message;
  const id=replyId(message);
  if(!id)return null;
  const rows=await client.getMessages(peer,{ids:[id]});
  return Array.isArray(rows)?rows[0]:rows;
}
async function identifyAudio(client,peer,message){
  const source=await repliedOrCurrentMedia(client,peer,message);
  if(!source?.media)throw new Error('réponds à un audio ou une vidéo');
  const buffer=await client.downloadMedia(source);
  if(!buffer?.length)throw new Error('média vide');
  if(buffer.length>20*1024*1024)throw new Error('extrait supérieur à 20 Mo');
  const form=new FormData();
  form.append('file',new Blob([buffer]),'audio.ogg');
  form.append('return','apple_music,spotify');
  form.append('api_token','test');
  const r=await response('https://api.audd.io/',{method:'POST',body:form},30000);
  const d=await r.json();
  if(!d?.result)throw new Error('musique non identifiée');
  return d.result;
}
async function apkSearch(raw){
  const q=clean(raw);
  if(!q)throw new Error('indique le nom ou package Android');
  const search=await json('https://search.f-droid.org/api/search_apps?q='+encodeURIComponent(q),{},25000);
  const app=Array.isArray(search?.apps)?search.apps[0]:null;
  const pkg=app?.packageName||app?.package_name||(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(q)?q:'');
  if(!pkg)throw new Error('application F-Droid introuvable');
  const info=await json('https://f-droid.org/api/v1/packages/'+encodeURIComponent(pkg),{},25000);
  const packs=Array.isArray(info?.packages)?info.packages:[];
  const version=packs.find(x=>Number(x.versionCode)===Number(info.suggestedVersionCode))||packs[0];
  if(!version)throw new Error('aucune version APK publiée');
  return {
    url:'https://f-droid.org/repo/'+encodeURIComponent(pkg)+'_'+encodeURIComponent(version.versionCode)+'.apk',
    title:app?.name||info?.name||pkg,
    pkg,
    version:version.versionName||String(version.versionCode)
  };
}

export const DIPPER_FALLBACK_COMMANDS=new Set([
  'song','video','tiktok','instagram','facebook','pinterest','lyrics','shazam','apk'
]);

export function canUseDipperFallback(name){
  return DIPPER_FALLBACK_COMMANDS.has(String(name||'').toLowerCase());
}

export async function executeDipperFallback({client,peer,name,args=[],event}){
  const command=String(name||'').toLowerCase();
  const input=args.join(' ').trim();

  if(command==='song'){
    const r=await youtubeAudio(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Dipper fallback\n'+r.title+'\nSource : '+r.source,fileName:safeName(r.title||'audio')+'.mp3'});
    return true;
  }
  if(command==='video'){
    const r=await youtubeVideo(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Dipper fallback\n'+r.title+'\nSource : '+r.source,fileName:safeName(r.title||'video')+'.mp4'});
    return true;
  }
  if(command==='tiktok'){
    const r=await tiktokMedia(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Dipper fallback\n'+(r.title||'TikTok')+'\nSource : '+r.source,fileName:'tiktok.mp4'});
    return true;
  }
  if(command==='instagram'){
    const r=await instagramMedia(input);
    const urls=(r.urls||[]).slice(0,10);
    if(!urls.length)throw new Error('aucun média Instagram');
    for(let i=0;i<urls.length;i++){
      await sendRemote(client,peer,urls[i],{caption:i===0?'NexAi · Dipper fallback\nInstagram · '+r.source:'',fileName:'instagram-'+(i+1)});
    }
    return true;
  }
  if(command==='facebook'){
    const r=await facebookMedia(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Dipper fallback\nFacebook · '+r.source,fileName:'facebook.mp4'});
    return true;
  }
  if(command==='pinterest'){
    const r=await pinterestMedia(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Dipper fallback\n'+r.title+(r.author?'\nAuteur : '+r.author:'')+'\nSource : '+r.source,fileName:'pinterest'});
    return true;
  }
  if(command==='lyrics'){
    const r=await lyricsSearch(input);
    const body=String(r.lyrics||'');
    const clipped=body.length>3500?body.slice(0,3500)+'\n…':body;
    await client.sendMessage(peer,{message:[
      'NexAi · Dipper fallback',
      r.artist?('Artiste : '+r.artist):'',
      'Titre : '+r.title,
      'Source : '+r.source,
      '',
      clipped
    ].filter(Boolean).join('\n')});
    return true;
  }
  if(command==='shazam'){
    const r=await identifyAudio(client,peer,event?.message);
    const links=[r.spotify?.external_urls?.spotify,r.apple_music?.url].filter(Boolean);
    await client.sendMessage(peer,{message:[
      'NexAi · Dipper fallback',
      'Titre : '+(r.title||'?'),
      'Artiste : '+(r.artist||'?'),
      'Album : '+(r.album||'?'),
      r.release_date?('Date : '+r.release_date):'',
      'Source : AudD',
      ...links
    ].filter(Boolean).join('\n')});
    return true;
  }
  if(command==='apk'){
    const r=await apkSearch(input);
    await sendRemote(client,peer,r.url,{caption:'NexAi · Dipper fallback\n'+r.title+'\n'+r.pkg+' · '+r.version+'\nSource : F-Droid',fileName:safeName(r.pkg+'_'+r.version)+'.apk',maxBytes:MAX_MEDIA_BYTES});
    return true;
  }
  return false;
}
