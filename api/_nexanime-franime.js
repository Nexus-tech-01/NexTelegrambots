const API='https://api.franime.fr';
const SITE='https://franime.fr';
let memo={at:0,items:[]};
const clean=v=>String(v??'').trim();
const norm=v=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export const titleOf=a=>{
  const t=a?.titles||{};
  return clean(t.fr_fr||t.en||t.en_us||a?.titleO||a?.title||('Anime '+a?.id));
};
export const posterOf=a=>{
  const raw=clean(a?.affiche||a?.poster||a?.image);
  if(!raw)return '';
  try{return new URL(raw,SITE+'/').href}catch{return ''}
};
export const seasonCount=a=>Array.isArray(a?.saisons)?a.saisons.length:0;
export const episodeCount=(a,s)=>Array.isArray(a?.saisons?.[s]?.episodes)?a.saisons[s].episodes.length:0;

export async function catalog(){
  if(memo.items.length&&Date.now()-memo.at<600000)return memo.items;
  const r=await fetch(API+'/api/animes/',{headers:{'user-agent':'NexAnime/1.0','referer':SITE+'/'},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('FRAnime HTTP '+r.status);
  const data=await r.json();
  const items=Array.isArray(data)?data:(data?.animes||data?.data||[]);
  if(!Array.isArray(items)||!items.length)throw new Error('Catalogue vide');
  memo={at:Date.now(),items};
  return items;
}
export async function byId(id){
  return (await catalog()).find(a=>String(a?.id)===String(id))||null;
}
export async function searchAnime(input){
  let q=norm(input).replace(/\b(je|veux|cherche|recherche|voir|telecharger|anime|episode|svp|stp)\b/g,' ').replace(/\s+/g,' ').trim();
  if(!q)q=norm(input);
  const words=q.split(' ').filter(Boolean);
  return (await catalog()).map(a=>{
    const names=[...Object.values(a?.titles||{}),a?.titleO,a?.title].map(norm).filter(Boolean);
    let score=0;
    for(const n of names){
      if(n===q)score=Math.max(score,1000);
      else if(n.startsWith(q))score=Math.max(score,700);
      else if(n.includes(q))score=Math.max(score,500);
      score=Math.max(score,words.filter(w=>n.includes(w)).length*100);
    }
    return {a,score};
  }).sort((x,y)=>y.score-x.score).slice(0,6).map(x=>x.a);
}
