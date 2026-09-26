import { canHandleAnimeCommand, handleAnimeCommand } from '../anime-engine.mjs';
import { canHandleDownloadCommand, handleDownloadCommand } from '../dipper-fallback.mjs';
import { canHandleAiCommand, handleAiCommand } from '../ai-engine.mjs';
import { canHandleStickerCommand, handleStickerCommand } from '../sticker-engine.mjs';
import { canHandleGameCommand, handleGameCommand } from '../game-engine.mjs';
import { createProgress } from '../response-ui.mjs';

const ENGINE_LABELS={
  anime:'Anime',
  ai:'IA',
  download:'Download',
  sticker:'Sticker',
  game:'Game'
};
const STICKER_PROGRESS=new Set(['sticker','clonepack','createpack','exportwhatsapp']);
function needsProgress(engine,name){
  if(engine==='download'||engine==='ai'||engine==='anime')return true;
  if(engine==='sticker')return STICKER_PROGRESS.has(String(name||''));
  return false;
}

function canonicalName(cmd){
  return String(cmd?.aliasFor||cmd?.name||cmd?.handler||'').toLowerCase();
}

async function guarded({label,name,sendText,client,peer,run,progressEnabled=true}){
  let progress=null;
  if(progressEnabled){
    try{progress=await createProgress(client,peer,label+' · '+name)}catch{}
  }
  try{
    await run(progress);
    if(progress&&!progress.finished)await progress.done(label+' · '+name+' terminé');
  }catch(error){
    const reason=String(error?.message||error).replace(/\s+/g,' ').slice(0,500);
    if(progress&&!progress.finished)await progress.fail(label+' · '+reason);
    else await sendText(peer,label+' · '+name+' : '+reason);
  }
  return true;
}

export async function routeEngineCommand({cmd,runtime,event,args=[],sendText}){
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
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),
      run:progress=>handleAnimeCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='ai'){
    if(!canHandleAiCommand(name)){
      await reply('Erreur interne : route IA inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),
      run:progress=>handleAiCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='download'){
    if(!canHandleDownloadCommand(name)){
      await reply('Erreur interne : route Download inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),
      run:progress=>handleDownloadCommand({client:runtime.client,peer,name,args,event,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='sticker'){
    if(!canHandleStickerCommand(name)){
      await reply('Erreur interne : route Sticker inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),
      run:progress=>handleStickerCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  if(engine==='game'){
    if(!canHandleGameCommand(name)){
      await reply('Erreur interne : route Game inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,client:runtime.client,peer,sendText:(p,t)=>sendText(runtime.client,p,t),progressEnabled:needsProgress(engine,name),
      run:progress=>handleGameCommand({runtime,event,name,args,progress,reply:text=>sendText(runtime.client,peer,text)})
    });
  }

  return false;
}

export function routedEngineNames(){
  return Object.keys(ENGINE_LABELS);
}
