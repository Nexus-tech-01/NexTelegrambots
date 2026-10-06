import {tg} from './_nexanime-telegram.js';
import {byId,titleOf,seasonCount} from './_nexanime-franime.js';
import {esc,languageKeyboard,seasonsKeyboard,episodesKeyboard,qualityKeyboard} from './_nexanime-ui.js';
import {cacheKey,readCacheKey,cachedEpisode,activeEpisodeJob,queueEpisode,queueReadChapter} from './_nexanime-jobs.js';
import {beginReadLookup,readChapterEntry,readSeriesById,renderReadCatalog,setMediaMode} from './_nexanime-read.js';

async function edit(cq,text,reply_markup){
  const m=cq?.message,chatId=m?.chat?.id,messageId=m?.message_id;
  if(!chatId||!messageId)return;
  if(m?.photo){
    return tg('editMessageCaption',{chat_id:chatId,message_id:messageId,caption:text,parse_mode:'HTML',reply_markup});
  }
  return tg('editMessageText',{chat_id:chatId,message_id:messageId,text,parse_mode:'HTML',reply_markup});
}

export async function handleCallback(cq){
  const data=String(cq?.data||''),chatId=cq?.message?.chat?.id;
  await tg('answerCallbackQuery',{callback_query_id:cq.id}).catch(()=>{});
  if(!chatId)return;
  if(data==='noop')return;
  if(data==='home:anime'){
    await setMediaMode(chatId,'anime');
    return edit(cq,'🎬 <b>Anime</b>\n\nEnvoie le titre de l’anime que tu recherches.');
  }
  if(data==='home:read'){
    await setMediaMode(chatId,'read');
    return edit(cq,'📚 <b>Manga · Scan · Webtoon · Manhwa</b>\n\nEnvoie le titre. NexAnime fusionnera les catalogues avant d’afficher les chapitres.');
  }
  if(data==='r:search'){
    await setMediaMode(chatId,'anime');
    return edit(cq,'Envoie le nom de l’anime que tu recherches.');
  }

  let m=data.match(/^rr:([a-f0-9]{16})$/i);
  if(m){
    const series=await readSeriesById(m[1]); if(!series)return;
    return beginReadLookup(chatId,series.title||series.query,{messageId:cq.message.message_id,force:true});
  }

  m=data.match(/^rp:([a-f0-9]{16}):(\d+)$/i);
  if(m)return renderReadCatalog(chatId,m[1],{messageId:cq.message.message_id,page:Number(m[2])});

  m=data.match(/^rc:([a-f0-9]{16}):([0-9_]+)$/i);
  if(m){
    const chapterNumber=m[2].replace('_','.');
    const entry=await readChapterEntry(m[1],chapterNumber);
    if(!entry)return edit(cq,'❌ Chapitre introuvable. Relance la vérification du catalogue.');
    const series=entry.series,ch=entry.chapter;
    const key=readCacheKey(series._id,chapterNumber);
    const caption=String(series.title||series.query||'Lecture')+' · Chapitre '+chapterNumber;
    const cached=await cachedEpisode(key);
    if(cached?.fileId){
      return tg('sendDocument',{chat_id:chatId,document:cached.fileId,caption});
    }
    const active=await activeEpisodeJob(key);
    if(active){
      const text='⏳ '+caption+'\n'+String(active.progress||'Téléchargement déjà en cours…').slice(0,500);
      if(String(active.chatId)===String(chatId)&&active.statusMessageId){
        await tg('editMessageText',{chat_id:chatId,message_id:active.statusMessageId,text}).catch(()=>{});
        return;
      }
      return tg('sendMessage',{chat_id:chatId,text});
    }
    const status=await tg('sendMessage',{chat_id:chatId,text:'⏳ '+caption+'\nRecherche sur toutes les méthodes disponibles…'});
    const alternatives=(Array.isArray(ch.sources)?ch.sources:[]).map(source=>({
      kind:String(source?.kind||''),
      url:String(source?.url||''),
      referer:String(source?.referer||''),
      chapterId:String(source?.chapterId||'')
    })).filter(source=>source.kind==='mangadex'||/^https?:\/\//i.test(source.url));
    return queueReadChapter({
      key,
      chatId,
      statusMessageId:status.message_id,
      seriesId:series._id,
      title:series.canonicalTitle||series.title||series.query,
      chapter:chapterNumber,
      aliases:Array.isArray(series.aliases)?series.aliases:[],
      alternatives,
      caption
    });
  }

  m=data.match(/^a:(\d+)$/);
  if(m){
    const a=await byId(m[1]); if(!a)return;
    return edit(cq,'<b>'+esc(titleOf(a))+'</b>\n'+seasonCount(a)+' saison(s) disponible(s).\n\nChoisis la langue :',languageKeyboard(a.id));
  }

  m=data.match(/^l:(\d+):(vf|vo)$/);
  if(m){
    const a=await byId(m[1]); if(!a)return;
    return edit(cq,'<b>'+esc(titleOf(a))+'</b> · '+(m[2]==='vf'?'VF':'VOSTFR')+'\nChoisis une saison :',seasonsKeyboard(a,m[2]));
  }

  m=data.match(/^s:(\d+):(vf|vo):(\d+)$/);
  if(m){
    const a=await byId(m[1]),s=Number(m[3]); if(!a)return;
    return edit(cq,'<b>'+esc(titleOf(a))+'</b> · S'+(s+1)+' · '+(m[2]==='vf'?'VF':'VOSTFR')+'\nChoisis un épisode :',episodesKeyboard(a,m[2],s,0));
  }

  m=data.match(/^p:(\d+):(vf|vo):(\d+):(\d+)$/);
  if(m){
    const a=await byId(m[1]); if(!a)return;
    return tg('editMessageReplyMarkup',{
      chat_id:chatId,
      message_id:cq.message.message_id,
      reply_markup:episodesKeyboard(a,m[2],Number(m[3]),Number(m[4]))
    });
  }

  m=data.match(/^e:(\d+):(vf|vo):(\d+):(\d+)$/);
  if(m){
    const a=await byId(m[1]),s=Number(m[3]),e=Number(m[4]); if(!a)return;
    return edit(cq,'<b>'+esc(titleOf(a))+'</b> · S'+(s+1)+'E'+(e+1)+'\nChoisis la qualité :',qualityKeyboard(a.id,m[2],s,e));
  }

  m=data.match(/^q:(\d+):(vf|vo):(\d+):(\d+):(360|480|720)$/);
  if(!m)return;
  const a=await byId(m[1]),lang=m[2],s=Number(m[3]),e=Number(m[4]),q=Number(m[5]);
  if(!a)return;
  const key=cacheKey(a.id,lang,s,e,q);
  const caption=titleOf(a)+' · S'+(s+1)+'E'+(e+1)+' · '+(lang==='vf'?'VF':'VOSTFR')+' · '+q+'p';
  const cached=await cachedEpisode(key);
  if(cached?.fileId){
    if(cached.kind==='video')return tg('sendVideo',{chat_id:chatId,video:cached.fileId,caption,supports_streaming:true});
    return tg('sendDocument',{chat_id:chatId,document:cached.fileId,caption});
  }

  const active=await activeEpisodeJob(key);
  if(active){
    const progress=String(active.progress||'Téléchargement déjà en cours…').slice(0,500);
    const text='⏳ '+caption+'\n'+progress;
    if(String(active.chatId)===String(chatId)&&active.statusMessageId){
      await tg('editMessageText',{chat_id:chatId,message_id:active.statusMessageId,text}).catch(()=>{});
      return;
    }
    return tg('sendMessage',{chat_id:chatId,text});
  }

  const status=await tg('sendMessage',{chat_id:chatId,text:'⏳ '+caption+'\nAjouté à la file de téléchargement…'});
  const queued=await queueEpisode({
    key,
    chatId,
    statusMessageId:status.message_id,
    animeId:a.id,
    lang,
    season:s,
    episode:e,
    quality:q,
    caption
  });
  if(queued?.reused&&queued.statusMessageId&&queued.statusMessageId!==status.message_id){
    await tg('deleteMessage',{chat_id:chatId,message_id:status.message_id}).catch(()=>{});
    await tg('editMessageText',{chat_id:queued.chatId,message_id:queued.statusMessageId,text:'⏳ '+caption+'\n'+String(queued.progress||'Téléchargement déjà en cours…').slice(0,500)}).catch(()=>{});
  }
}
