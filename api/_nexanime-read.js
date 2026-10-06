import crypto from 'node:crypto';
import {getDb} from './_nexanime-db.js';
import {tg,keyboard} from './_nexanime-telegram.js';
import {activeEpisodeJob,queueReadIndex} from './_nexanime-jobs.js';

const MODE_TTL_MS=24*60*60_000;
const INDEX_FRESH_MS=20*60_000;
const PER_PAGE=30;
const clean=v=>String(v??'').trim();
const esc=s=>String(s??'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const norm=v=>clean(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export function readSeriesId(title){
  return crypto.createHash('sha256').update(norm(title)||clean(title).toLowerCase()).digest('hex').slice(0,16);
}

export function canonicalChapter(value){
  const n=Number(String(value??'').replace(',','.'));
  if(!Number.isFinite(n)||n<0)return '';
  return String(n);
}

export async function setMediaMode(chatId,mode){
  const d=await getDb(),now=new Date();
  const safe=mode==='read'?'read':'anime';
  await d.collection('nexanime_bot_sessions').updateOne(
    {_id:String(chatId)},
    {$set:{mode:safe,updatedAt:now,expiresAt:new Date(now.getTime()+MODE_TTL_MS)},$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
  return safe;
}

export async function getMediaMode(chatId){
  const d=await getDb(),now=new Date();
  const row=await d.collection('nexanime_bot_sessions').findOne({_id:String(chatId),expiresAt:{$gt:now}});
  return row?.mode==='read'?'read':'anime';
}

export async function ensureReadSeries(title){
  const q=clean(title).slice(0,180);
  if(!q)throw new Error('Titre requis');
  const d=await getDb(),_id=readSeriesId(q),now=new Date();
  await d.collection('nexanime_read_series').updateOne(
    {_id},
    {$setOnInsert:{_id,title:q,query:q,chapters:[],missing:[],sourcesChecked:0,createdAt:now},$set:{query:q,requestedAt:now}},
    {upsert:true}
  );
  return d.collection('nexanime_read_series').findOne({_id});
}

export async function readSeriesById(id){
  const d=await getDb();
  return d.collection('nexanime_read_series').findOne({_id:String(id)});
}

export async function readChapterEntry(id,chapter){
  const series=await readSeriesById(id);
  const wanted=canonicalChapter(chapter);
  const row=(Array.isArray(series?.chapters)?series.chapters:[]).find(x=>canonicalChapter(x?.number)===wanted);
  return row?{series,chapter:row}:null;
}

function sortedChapters(series){
  return (Array.isArray(series?.chapters)?series.chapters:[])
    .filter(x=>canonicalChapter(x?.number))
    .sort((a,b)=>Number(b.number)-Number(a.number));
}

function catalogKeyboard(series,page=0){
  const chapters=sortedChapters(series);
  const pages=Math.max(1,Math.ceil(chapters.length/PER_PAGE));
  const safePage=Math.max(0,Math.min(Number(page)||0,pages-1));
  const part=chapters.slice(safePage*PER_PAGE,(safePage+1)*PER_PAGE);
  const rows=[];
  let row=[];
  for(const ch of part){
    const n=canonicalChapter(ch.number);
    row.push({text:'Ch. '+n,callback_data:'rc:'+series._id+':'+n.replace('.','_')});
    if(row.length===5){rows.push(row);row=[]}
  }
  if(row.length)rows.push(row);
  const nav=[];
  if(safePage>0)nav.push({text:'◀️',callback_data:'rp:'+series._id+':'+(safePage-1)});
  nav.push({text:(safePage+1)+'/'+pages,callback_data:'noop'});
  if(safePage<pages-1)nav.push({text:'▶️',callback_data:'rp:'+series._id+':'+(safePage+1)});
  rows.push(nav);
  rows.push([
    {text:'🔄 Revérifier',callback_data:'rr:'+series._id},
    {text:'🎬 Anime',callback_data:'home:anime'}
  ]);
  return keyboard(rows);
}

function catalogText(series){
  const chapters=sortedChapters(series);
  const gaps=Array.isArray(series?.missing)?series.missing:[];
  let text='<b>'+esc(series?.title||series?.query||'Lecture')+'</b>\n\n';
  text+='📚 '+chapters.length+' chapitre(s) trouvé(s).';
  if(gaps.length){
    text+='\n🧩 '+gaps.length+' numéro(s) encore absent(s) après fusion. NexAnime continuera les fallbacks au téléchargement.';
  }else if(chapters.length){
    text+='\n✅ Aucun trou entier détecté dans la plage trouvée.';
  }
  text+='\n\nChoisis un chapitre :';
  return text;
}

export async function renderReadCatalog(chatId,seriesId,{messageId=0,page=0}={}){
  const series=await readSeriesById(seriesId);
  if(!series)throw new Error('Catalogue introuvable');
  const chapters=sortedChapters(series);
  if(!chapters.length){
    const text='❌ Aucun chapitre vérifié pour <b>'+esc(series.title||series.query||'ce titre')+'</b>.\nEssaie un titre alternatif ou relance la vérification.';
    if(messageId)return tg('editMessageText',{chat_id:chatId,message_id:messageId,text,parse_mode:'HTML',reply_markup:keyboard([[{text:'🔄 Revérifier',callback_data:'rr:'+series._id}]])});
    return tg('sendMessage',{chat_id:chatId,text,parse_mode:'HTML'});
  }
  const payload={chat_id:chatId,text:catalogText(series),parse_mode:'HTML',reply_markup:catalogKeyboard(series,page)};
  if(messageId)return tg('editMessageText',{...payload,message_id:messageId});
  return tg('sendMessage',payload);
}

export async function beginReadLookup(chatId,title,{messageId=0,force=false}={}){
  await setMediaMode(chatId,'read');
  const series=await ensureReadSeries(title);
  const indexedAt=series?.indexedAt?new Date(series.indexedAt).getTime():0;
  const fresh=Array.isArray(series?.chapters)&&series.chapters.length>0&&(Date.now()-indexedAt)<INDEX_FRESH_MS;
  if(fresh&&!force)return renderReadCatalog(chatId,series._id,{messageId,page:0});

  const statusText='⏳ <b>'+esc(series.title||title)+'</b>\nIndexation complète des chapitres et fusion des catalogues…';
  let statusMessageId=Number(messageId)||0;
  if(statusMessageId){
    await tg('editMessageText',{chat_id:chatId,message_id:statusMessageId,text:statusText,parse_mode:'HTML'}).catch(()=>{});
  }else{
    const status=await tg('sendMessage',{chat_id:chatId,text:statusText,parse_mode:'HTML'});
    statusMessageId=Number(status?.message_id)||0;
  }

  const key='read-index:'+series._id+':'+String(chatId);
  const active=await activeEpisodeJob(key);
  if(active){
    if(String(active.chatId)===String(chatId)&&active.statusMessageId&&active.statusMessageId!==statusMessageId){
      await tg('deleteMessage',{chat_id:chatId,message_id:statusMessageId}).catch(()=>{});
    }
    return active;
  }
  return queueReadIndex({
    key,
    chatId,
    statusMessageId,
    seriesId:series._id,
    title:series.title||title
  });
}
