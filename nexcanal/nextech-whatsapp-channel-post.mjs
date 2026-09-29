import fs from 'node:fs/promises';
import path from 'node:path';

const interrouteUrl=String(process.env.NEX_INTERROUTE_URL||'http://127.0.0.1:18130').replace(/\/$/,'');
const stageDir=String(process.env.NEXTECH_WHATSAPP_BOTAPI_STAGE_DIR||'/var/lib/nex/state/nexcanal/wa-media');

function buttons(msg){
  const out=[],seen=new Set();
  const add=(text,url)=>{
    const u=String(url||'').trim();
    if(!/^https?:\/\//i.test(u)||seen.has(u))return;
    seen.add(u);
    out.push({text:(String(text||'Ouvrir').trim().slice(0,64)||'Ouvrir'),url:u});
  };
  for(const row of msg?.reply_markup?.inline_keyboard||[])for(const b of row||[])add(b?.text,b?.url);
  const body=String(msg?.text??msg?.caption??'');
  for(const e of [...(msg?.entities||[]),...(msg?.caption_entities||[])]){
    const off=Math.max(0,Number(e?.offset)||0),len=Math.max(0,Number(e?.length)||0);
    const label=len?body.slice(off,off+len):'Ouvrir';
    if(e?.type==='text_link')add(label,e?.url);
    else if(e?.type==='url'&&len)add(label,body.slice(off,off+len));
  }
  return out.slice(0,12);
}

async function media(api,msg){
  let type=null,fileId=null,fileName=null,mimetype=null;
  const photos=Array.isArray(msg?.photo)?msg.photo:[];
  if(photos.length){
    const p=photos[photos.length-1];
    type='photo';fileId=p?.file_id;fileName='nextech-'+String(msg.message_id)+'.jpg';mimetype='image/jpeg';
  }else if(msg?.video){
    type='video';fileId=msg.video.file_id;fileName=msg.video.file_name||('nextech-'+msg.message_id+'.mp4');mimetype=msg.video.mime_type||'video/mp4';
  }else if(msg?.animation){
    type='animation';fileId=msg.animation.file_id;fileName=msg.animation.file_name||('nextech-'+msg.message_id+'.gif');mimetype=msg.animation.mime_type||'image/gif';
  }else if(msg?.audio){
    type='audio';fileId=msg.audio.file_id;fileName=msg.audio.file_name||('nextech-'+msg.message_id+'.mp3');mimetype=msg.audio.mime_type||'audio/mpeg';
  }else if(msg?.document){
    type='document';fileId=msg.document.file_id;fileName=msg.document.file_name||('nextech-'+msg.message_id+'.bin');mimetype=msg.document.mime_type||'application/octet-stream';
  }
  if(!fileId)return [];
  const meta=await api.getFile(fileId);
  if(!meta?.file_path)throw new Error('Telegram getFile returned no file_path');
  const bytes=await api.downloadFile(meta.file_path);
  if(!bytes?.byteLength)throw new Error('Telegram media download was empty');
  await fs.mkdir(stageDir,{recursive:true});
  const safe=String(fileName).replace(/[^A-Za-z0-9._ -]+/g,'_').slice(-180);
  const target=path.join(stageDir,String(msg.message_id)+'-'+safe);
  await fs.writeFile(target,bytes,{mode:0o640});
  return [{type,localPath:target,fileName:safe,mimetype,position:0}];
}

export async function mirrorNextechChannelPostToWhatsApp(api,update){
  const msg=update?.channel_post;
  if(!msg||msg?.chat?.type!=='channel')return {skipped:true};
  const username=String(msg?.chat?.username||'').replace(/^@/,'').toLowerCase();
  if(username!=='thenexusorigin')return {skipped:true};
  const id=Number(msg?.message_id||0);
  if(!id)return {skipped:true};

  const text=String(msg?.text??msg?.caption??'').trim();
  const links=buttons(msg);
  if(!links.length)links.push({text:'Voir sur Telegram',url:'https://t.me/thenexusorigin/'+String(id)});

  let items=[];
  try{items=await media(api,msg);}
  catch(error){console.warn('[NexTech/WhatsApp] media degraded #'+id,String(error?.message||error).slice(0,220));}

  const response=await fetch(interrouteUrl+'/events',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      ownerDomain:'system',
      idempotencyKey:'nextech-channel:'+String(id)+':v2-download-links',
      source:{platform:'telegram',name:'thenexusorigin',messageId:String(id),accountRole:'bot-channel-post'},
      content:{text,media:items,buttons:links},
      routes:[{platform:'whatsapp'}]
    }),
    signal:AbortSignal.timeout(15000)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('interroute '+response.status+': '+String(result?.error||'enqueue failed'));
  console.log('[NexTech/WhatsApp] queued channel_post #'+id,result?.duplicate?'duplicate':'ok');
  return result;
}
