import {tg} from './_nexanime-telegram.js';
import {searchAnime,posterOf} from './_nexanime-franime.js';
import {resultKeyboard,esc} from './_nexanime-ui.js';
import {jobByClaim,completeJob,failJob} from './_nexanime-jobs.js';

const clean=v=>String(v??'').trim();

async function sendSearch(chatId,q){
  const items=await searchAnime(q);
  if(!items.length)return tg('sendMessage',{chat_id:chatId,text:'Aucun anime trouvé. Essaie avec un autre titre.'});
  const text='<b>Résultats pour :</b> '+esc(q)+'\n\nChoisis l’anime que tu veux :';
  const photo=posterOf(items[0]);
  if(photo){
    try{return await tg('sendPhoto',{chat_id:chatId,photo,caption:text,parse_mode:'HTML',reply_markup:resultKeyboard(items)})}catch{}
  }
  return tg('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',reply_markup:resultKeyboard(items)});
}

async function handleUploaderMessage(message){
  const caption=clean(message?.caption||message?.text);
  let m=caption.match(/^#NXA_CACHE:([0-9a-f-]{20,})/i);
  if(m){
    const job=await jobByClaim(m[1]);
    if(!job)return true;
    const video=message?.video,doc=message?.document;
    const fileId=clean(video?.file_id||doc?.file_id);
    if(!fileId)return true;
    const kind=video?'video':'document';
    await completeJob(job,{fileId,kind,size:video?.file_size||doc?.file_size||0});
    if(kind==='video'){
      await tg('sendVideo',{chat_id:job.chatId,video:fileId,caption:job.caption,supports_streaming:true});
    }else{
      await tg('sendDocument',{chat_id:job.chatId,document:fileId,caption:job.caption});
    }
    if(job.statusMessageId)await tg('deleteMessage',{chat_id:job.chatId,message_id:job.statusMessageId}).catch(()=>{});
    await tg('deleteMessage',{chat_id:message.chat.id,message_id:message.message_id}).catch(()=>{});
    return true;
  }
  m=caption.match(/^#NXA_FAIL:([0-9a-f-]{20,})\s*\n?([\s\S]*)/i);
  if(m){
    const job=await jobByClaim(m[1]);
    if(job){
      const why=clean(m[2]).slice(0,300)||'Téléchargement impossible';
      await failJob(job,why);
      if(job.statusMessageId)await tg('editMessageText',{chat_id:job.chatId,message_id:job.statusMessageId,text:'❌ '+why}).catch(()=>{});
    }
    await tg('deleteMessage',{chat_id:message.chat.id,message_id:message.message_id}).catch(()=>{});
    return true;
  }
  return false;
}

export async function handleMessage(message){
  if(await handleUploaderMessage(message))return;
  const chatId=message?.chat?.id,text=clean(message?.text);
  if(!chatId||!text)return;
  if(text==='/start'){
    return tg('sendMessage',{
      chat_id:chatId,
      parse_mode:'HTML',
      text:'🎬 <b>NexAnime</b>\n\nEnvoie simplement le nom d’un anime. Je chercherai sur FRAnime et te proposerai les titres les plus proches.\n\nExemple : <code>Blue Lock</code>'
    });
  }
  if(text.startsWith('/search '))return sendSearch(chatId,text.slice(8));
  if(text.startsWith('/'))return;
  return sendSearch(chatId,text);
}
