import {tg} from './_nexanime-telegram.js';
import {byId,titleOf,seasonCount} from './_nexanime-franime.js';
import {esc,languageKeyboard,seasonsKeyboard,episodesKeyboard,qualityKeyboard} from './_nexanime-ui.js';
import {cacheKey,cachedEpisode,activeEpisodeJob,queueEpisode} from './_nexanime-jobs.js';

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
  if(data==='r:search')return edit(cq,'Envoie le nom de l’anime que tu recherches.');

  let m=data.match(/^a:(\d+)$/);
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
