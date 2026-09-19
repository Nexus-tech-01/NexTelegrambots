import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const C=(name,category,options={})=>({name,category,...options});

export const CORE_COMMANDS=[
  C('menu','GENERAL',{description:'Menu NexAI',native:true}),
  C('commands','GENERAL',{description:'Résumé du registre de commandes',native:true}),
  C('creator','GENERAL',{description:'Origine et créateur de NexAI',native:true}),
  C('about','GENERAL',{aliasFor:'creator',hidden:true,native:true}),
  C('founder','GENERAL',{aliasFor:'creator',hidden:true,native:true}),
  C('ceo','GENERAL',{aliasFor:'creator',hidden:true,native:true}),
  C('style','GENERAL',{description:'Afficher/changer le style',native:true}),
  C('ping','GENERAL',{description:'Latence du moteur',native:true}),
  C('alive','GENERAL',{description:'État de NexAccount',native:true}),
  C('account','GENERAL',{description:'Informations du compte connecté',native:true}),
  C('help','GENERAL',{description:'Aide rapide',native:true}),

  C('join','GROUP',{description:'Rejoindre un groupe ou canal par lien/username',native:true}),
  C('leave','GROUP',{description:'Quitter le chat courant',native:true}),
  C('promote','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('demote','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('kick','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('ban','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('unban','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('mute','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('unmute','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('warn','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('tagall','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('hidetag','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('welcome','GROUP',{proxyService:'group',proxyMode:'contextual'}),
  C('goodbye','GROUP',{proxyService:'group',proxyMode:'contextual'}),

  C('antilink','PROTECTION',{proxyService:'group',proxyMode:'contextual'}),
  C('antispam','PROTECTION',{proxyService:'group',proxyMode:'contextual'}),
  C('antiraid','PROTECTION',{proxyService:'group',proxyMode:'contextual'}),
  C('clean','PROTECTION',{proxyService:'group',proxyMode:'contextual'}),

  C('song','DOWNLOAD',{proxyService:'downloader'}),
  C('video','DOWNLOAD',{proxyService:'downloader'}),
  C('tiktok','DOWNLOAD',{proxyService:'downloader'}),
  C('instagram','DOWNLOAD',{proxyService:'downloader'}),
  C('facebook','DOWNLOAD',{proxyService:'downloader'}),
  C('pinterest','DOWNLOAD',{proxyService:'downloader'}),
  C('tomp3','DOWNLOAD',{proxyService:'downloader'}),
  C('lyrics','DOWNLOAD',{proxyService:'downloader'}),
  C('shazam','DOWNLOAD',{proxyService:'downloader'}),
  C('apk','DOWNLOAD',{proxyService:'downloader'}),

  C('sticker','STICKERS',{proxyService:'stick'}),
  C('stickerinfo','STICKERS',{proxyService:'stick'}),
  C('clonepack','STICKERS',{proxyService:'stick'}),

  C('game','GAMES',{proxyService:'game',proxyMode:'contextual'}),
  C('riddle','GAMES',{proxyService:'game',proxyMode:'contextual'}),
  C('tictactoe','GAMES',{proxyService:'game',proxyMode:'contextual'}),
  C('quiz','GAMES',{proxyService:'game',proxyMode:'contextual'}),

  C('whisper','WHISPER',{proxyService:'whisper',proxyMode:'contextual'}),
  C('nexwhisper','WHISPER',{aliasFor:'whisper',hidden:true,proxyService:'whisper',proxyMode:'contextual'}),

  C('ai','AI',{proxyService:'dipper'}),C('code','AI',{proxyService:'dipper'}),C('deepseek','AI',{proxyService:'dipper'}),C('image','AI',{proxyService:'dipper'}),
  C('translate','TOOLS',{proxyService:'dipper'}),C('tts','TOOLS',{proxyService:'dipper'}),C('qr','TOOLS',{proxyService:'dipper'}),C('tinyurl','TOOLS',{proxyService:'dipper'}),
  C('texttopdf','TOOLS',{proxyService:'dipper'}),C('toimage','TOOLS',{proxyService:'dipper'}),C('genpass','TOOLS',{proxyService:'dipper'}),C('fliptext','TOOLS',{proxyService:'dipper'}),
  C('emojimix','TOOLS',{proxyService:'dipper'}),C('device','TOOLS',{proxyService:'dipper'}),
  C('gsmarena','SEARCH',{proxyService:'dipper'}),C('define','SEARCH',{proxyService:'dipper'}),C('imdb','SEARCH',{proxyService:'dipper'}),C('weather','SEARCH',{proxyService:'dipper'}),
  C('anime','ANIME',{proxyService:'dipper'}),C('animeinfo','ANIME',{proxyService:'dipper'}),

  C('emoji_status','PREMIUM',{premium:true,proxyService:'dipper'}),
  C('customreact','PREMIUM',{premium:true,native:true}),
  C('premiumemoji','PREMIUM',{premium:true,proxyService:'dipper'}),
  C('effect','PREMIUM',{premium:true,proxyService:'dipper'}),

  C('owner','OWNER',{ownerOnly:true,native:true}),
  C('users','OWNER',{ownerOnly:true,native:true}),
  C('botstats','OWNER',{ownerOnly:true,native:true}),
  C('activity','OWNER',{ownerOnly:true,native:true}),
  C('growth','OWNER',{ownerOnly:true,native:true}),
  C('commandstats','OWNER',{ownerOnly:true,native:true}),
  C('countries','OWNER',{ownerOnly:true,native:true}),
  C('languages','OWNER',{ownerOnly:true,native:true}),
  C('user','OWNER',{ownerOnly:true,native:true})
];

export const CATEGORY_ORDER=['GENERAL','AI','DOWNLOAD','GROUP','TOOLS','STICKERS','GAMES','WHISPER','PROTECTION','ANIME','SEARCH','PREMIUM','OWNER'];
export const CATEGORY_LABELS={GENERAL:'GENERAL',AI:'AI',DOWNLOAD:'DOWNLOAD',GROUP:'GROUP',TOOLS:'TOOLS',STICKERS:'STICKERS',GAMES:'GAMES',WHISPER:'WHISPER',PROTECTION:'PROTECTION',ANIME:'ANIME',SEARCH:'SEARCH',PREMIUM:'PREMIUM',OWNER:'OWNER'};
export const CATEGORY_ICONS={GENERAL:'general',AI:'ai',DOWNLOAD:'download',GROUP:'group',TOOLS:'tools',STICKERS:'sticker',GAMES:'games',WHISPER:'whisper',PROTECTION:'shield',ANIME:'anime',SEARCH:'search',PREMIUM:'premium',OWNER:'owner'};

function loadDipperCommands(){
  try{
    const file=path.join(HERE,'generated','dipper-commands.json');
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    const list=Array.isArray(raw?.commands)?raw.commands:[];
    return list.map(cmd=>({
      ...cmd,
      source:'dipper',
      proxyService:'dipper',
      category:String(cmd.category||'TOOLS').toUpperCase()
    }));
  }catch{
    return [];
  }
}

export function commandMap(extra=loadDipperCommands()){
  const map=new Map();
  for(const cmd of [...CORE_COMMANDS,...extra]){
    if(!cmd?.name)continue;
    const key=String(cmd.name).toLowerCase();
    if(!/^[a-z0-9_]{1,64}$/.test(key))continue;
    if(!map.has(key))map.set(key,{...cmd,name:key});
  }
  return map;
}

export function commandsByCategory(commands){
  const out={};
  for(const cmd of commands.values())(out[cmd.category]??=[]).push(cmd);
  for(const list of Object.values(out))list.sort((a,b)=>a.name.localeCompare(b.name));
  return out;
}

export function registrySummary(commands=commandMap()){
  const all=[...commands.values()];
  const visible=all.filter(c=>!c.hidden);
  const dipper=all.filter(c=>c.source==='dipper');
  const unresolved=all.filter(c=>!c.aliasFor&&!c.native&&!c.proxy&&!c.proxyService);
  return {
    total:all.length,
    visible:visible.length,
    dipper:dipper.length,
    native:all.filter(c=>c.native).length,
    proxied:all.filter(c=>c.proxy||c.proxyService).length,
    unresolved:unresolved.map(c=>c.name)
  };
}
