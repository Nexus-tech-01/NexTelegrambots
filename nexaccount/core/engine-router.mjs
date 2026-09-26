import { canHandleAnimeCommand, handleAnimeCommand } from '../anime-engine.mjs';
import { canHandleDownloadCommand, handleDownloadCommand } from '../dipper-fallback.mjs';
import { canHandleAiCommand, handleAiCommand } from '../ai-engine.mjs';
import { canHandleStickerCommand, handleStickerCommand } from '../sticker-engine.mjs';
import { canHandleGameCommand, handleGameCommand } from '../game-engine.mjs';

const ENGINE_LABELS={
  anime:'Anime',
  ai:'IA',
  download:'Download',
  sticker:'Sticker',
  game:'Game'
};

function canonicalName(cmd){
  return String(cmd?.aliasFor||cmd?.name||cmd?.handler||'').toLowerCase();
}

async function guarded({label,name,sendText,peer,run}){
  try{
    await run();
  }catch(error){
    await sendText(peer,label+' · '+name+' : '+String(error?.message||error).slice(0,500));
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
      label:ENGINE_LABELS[engine],name,peer,sendText:(p,t)=>sendText(runtime.client,p,t),
      run:()=>handleAnimeCommand({runtime,event,name,args})
    });
  }

  if(engine==='ai'){
    if(!canHandleAiCommand(name)){
      await reply('Erreur interne : route IA inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,peer,sendText:(p,t)=>sendText(runtime.client,p,t),
      run:()=>handleAiCommand({runtime,event,name,args})
    });
  }

  if(engine==='download'){
    if(!canHandleDownloadCommand(name)){
      await reply('Erreur interne : route Download inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,peer,sendText:(p,t)=>sendText(runtime.client,p,t),
      run:()=>handleDownloadCommand({client:runtime.client,peer,name,args,event})
    });
  }

  if(engine==='sticker'){
    if(!canHandleStickerCommand(name)){
      await reply('Erreur interne : route Sticker inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,peer,sendText:(p,t)=>sendText(runtime.client,p,t),
      run:()=>handleStickerCommand({runtime,event,name,args})
    });
  }

  if(engine==='game'){
    if(!canHandleGameCommand(name)){
      await reply('Erreur interne : route Game inconnue pour .'+name);
      return true;
    }
    return guarded({
      label:ENGINE_LABELS[engine],name,peer,sendText:(p,t)=>sendText(runtime.client,p,t),
      run:()=>handleGameCommand({runtime,event,name,args})
    });
  }

  return false;
}

export function routedEngineNames(){
  return Object.keys(ENGINE_LABELS);
}
