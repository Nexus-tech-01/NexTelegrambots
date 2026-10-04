import { canHandleAnimeCommand, handleAnimeCommand } from '../anime-engine.mjs';
import { canHandleDownloadCommand, handleDownloadCommand } from '../dipper-fallback.mjs';
import { canHandleAiCommand, handleAiCommand } from '../ai-engine.mjs';
import { canHandleStickerCommand, handleStickerCommand } from '../sticker-engine.mjs';
import { canHandleGameCommand, handleGameCommand } from '../game-engine.mjs';
import { canHandlePremiumCommand, handlePremiumCommand } from '../premium-engine.mjs';
import { createProgress, ensurePremiumEmojiPalette } from '../response-ui.mjs';
import { settingsFor } from '../store.mjs';

const ENGINE_LABELS={
  anime:'Anime',
  ai:'IA',
  download:'Download',
  sticker:'Sticker',
  game:'Game',
  premium:'NexAI Premium'
};
const STICKER_PROGRESS=new Set(['sticker','clonepack','createpack','exportwhatsapp','ultratake','delfilig','filitake','noteclone']);
function needsProgress(engine,name){
  if(engine==='download'||engine==='ai'||engine==='anime'||engine==='premium')return true;
  if(engine==='sticker')return STICKER_PROGRESS.has(String(name||''));
  return false;
}

function canonicalName(cmd){
  return String(cmd?.aliasFor||cmd?.name||cmd?.handler||'').toLowerCase();
}

async function guarded({label,name,sendText,client,peer,run,progressEnabled=true,runtimeAccount=null,onNexAiPremiumRequired=null}){
  let progress=null;
  if(progressEnabled){
    try{
      const account=runtimeAccount;
      let customEmojiIds={};
      if(account?.telegramUserId){
        const settings=await settingsFor(account.telegramUserId).catch(()=>null);
        customEmojiIds=settings?.customEmojiIds||{};
      }
      if(account?.premium===true){
        // Refresh in the background; the persistent emoji library is already
        // sufficient to animate this progress message immediately.
        ensurePremiumEmojiPalette(client,account.telegramUserId,{
          premium:true,
          keys:['WAIT','CHECK','ERROR']
        }).catch(error=>{
          console.warn('[NexAccount premium-emoji async]',String(error?.message||error).slice(0,220));
        });
      }
      progress=await createProgress(client,peer,label+' · '+name,{
        customEmojiIds,
        emojiLibrary:Boolean(account)
      });
    }catch(error){
      console.warn('[NexAccount progress]',String(error?.message||error).slice(0,220));
      try{progress=await createProgress(client,peer,label+' · '+name)}catch{}
    }
  }
  try{
    const outcome=await run(progress);
    if(progress&&!progress.finished&&outcome?.deferred!==true)await progress.done(label+' · '+name+' terminé');
  }catch(error){
    const reason=String(error?.message||error).replace(/\s+/g,' ').slice(0,500);
    if(error?.code==='NEXAI_PREMIUM_REQUIRED'&&typeof onNexAiPremiumRequired==='function'){
      if(progress&&!progress.finished)await progress.fail(label+' · quota Free atteint');
      await onNexAiPremiumRequired(error);
      return true;
    }
    if(progress&&!progress.finished)await progress.fail(label+' · '+reason);
    else await sendText(peer,label+' · '+name+' : '+reason);
  }
  return true;
}

export async function routeEngineCommand({cmd,runtime,event,args=[],sendText,onNexAiPremiumRequired=null}){
  const engine=String(cmd?.engine||'').toLowerCase();
  if(!ENGINE_LABELS[engine])return false;

  const name=canonicalName(cmd);
  const peer=event?.message?.peerId;
  const reply=text=>sendText(runtime.client,peer,text);

  if(engine==='anime'){
    if(!canHandleAnimeCommand(name)){
      await reply('Erreur interne : route Anime inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),runtimeAccount:runtime.account,
      run:progress=>handleAnimeCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='ai'){
    if(!canHandleAiCommand(name)){
      await reply('Erreur interne : route IA inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),runtimeAccount:runtime.account,
      run:progress=>handleAiCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='download'){
    if(!canHandleDownloadCommand(name)){
      await reply('Erreur interne : route Download inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),runtimeAccount:runtime.account,
      run:progress=>handleDownloadCommand({client:runtime.client,peer,name,args,event,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='sticker'){
    if(!canHandleStickerCommand(name)){
      await reply('Erreur interne : route Sticker inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),runtimeAccount:runtime.account,onNexAiPremiumRequired,
      run:progress=>handleStickerCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='premium'){
    if(!canHandlePremiumCommand(name)){
      await reply('Erreur interne : route Premium inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),runtimeAccount:runtime.account,
      run:progress=>handlePremiumCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='game'){
    if(!canHandleGameCommand(name)){
      await reply('Erreur interne : route Game inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),runtimeAccount:runtime.account,
      run:progress=>handleGameCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  return false;
}

export function routedEngineNames(){
  return Object.keys(ENGINE_LABELS);
}
