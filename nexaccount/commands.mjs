import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const C=(name,category,options={})=>({name,category,...options});

export const CORE_COMMANDS=[
  C('menu','GENERAL',{description:'Menu NexAI'}),
  C('creator','GENERAL',{description:'Origine et créateur de NexAI'}),
  C('about','GENERAL',{aliasFor:'creator',hidden:true}),
  C('founder','GENERAL',{aliasFor:'creator',hidden:true}),
  C('ceo','GENERAL',{aliasFor:'creator',hidden:true}),
  C('style','GENERAL',{description:'Afficher/changer le style'}),
  C('ping','GENERAL',{description:'Latence du moteur'}),
  C('alive','GENERAL',{description:'État de NexAccount'}),
  C('account','GENERAL',{description:'Informations du compte connecté'}),
  C('help','GENERAL',{description:'Aide rapide'}),
  C('pair','GENERAL',{description:'Connecter un compte Telegram via MTProto'}),
  C('sessions','GENERAL',{description:'Sessions NexAccount connectées'}),
  C('dashboard','GENERAL',{description:'Tableau de bord unifié NexAI'}),
  C('settings','GENERAL',{description:'Réglages unifiés NexAI'}),
  C('stats','GENERAL',{description:'Statistiques unifiées NexAI'}),
  C('premium','PREMIUM',{description:'Premium NexAI unifié'}),

  C('join','GROUP',{description:'Rejoindre un groupe ou canal par lien/username'}),
  C('leave','GROUP',{description:'Quitter le chat courant'}),
  C('promote','GROUP'),C('demote','GROUP'),C('kick','GROUP'),C('ban','GROUP'),C('unban','GROUP'),
  C('mute','GROUP'),C('unmute','GROUP'),C('warn','GROUP'),C('tagall','GROUP'),C('hidetag','GROUP'),
  C('welcome','GROUP'),C('goodbye','GROUP'),C('delete','GROUP'),C('grouplink','GROUP'),C('groupname','GROUP'),
  C('approve','GROUP'),C('approveall','GROUP'),C('add','GROUP'),

  C('antilink','PROTECTION'),C('antispam','PROTECTION'),C('antiraid','PROTECTION'),C('clean','PROTECTION'),

  C('song','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('video','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('tiktok','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('instagram','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('facebook','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('pinterest','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('tomp3','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('lyrics','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('shazam','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),
  C('apk','DOWNLOAD',{proxy:'@TheNexDownloader_bot'}),

  C('sticker','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('stickerinfo','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('clonepack','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('newsticker','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('newanimatedsticker','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('createpack','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('mypacks','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('renamepack','STICKERS',{proxy:'@The_Nexus_techbot'}),
  C('exportwhatsapp','STICKERS',{proxy:'@The_Nexus_techbot'}),

  C('game','GAMES',{proxy:'@TheNexGame_bot'}),
  C('riddle','GAMES',{proxy:'@TheNexGame_bot'}),
  C('tictactoe','GAMES',{proxy:'@TheNexGame_bot'}),
  C('quiz','GAMES',{proxy:'@TheNexGame_bot'}),

  C('whisper','TOOLS',{proxy:'@Nexwhisper_bot'}),
  C('oneview','TOOLS',{proxy:'@Nexwhisper_bot'}),
  C('anon','TOOLS',{proxy:'@Nexwhisper_bot'}),
  C('whisperadmin','TOOLS',{proxy:'@Nexwhisper_bot'}),

  C('ai','AI',{proxy:'@Stacytg_bot',proxyMode:'chat'}),
  C('code','AI',{proxy:'@Stacytg_bot',proxyMode:'chat'}),
  C('deepseek','AI',{proxy:'@Stacytg_bot',proxyMode:'chat'}),
  C('image','AI',{proxy:'@Stacytg_bot',proxyMode:'chat'}),
  C('translate','TOOLS'),C('tts','TOOLS'),C('qr','TOOLS'),C('tinyurl','TOOLS'),
  C('texttopdf','TOOLS'),C('toimage','TOOLS'),C('genpass','TOOLS'),C('fliptext','TOOLS'),
  C('emojimix','TOOLS'),C('device','TOOLS'),C('calc','TOOLS'),C('smallcaps','TOOLS'),
  C('gsmarena','SEARCH'),C('define','SEARCH'),C('imdb','SEARCH'),C('weather','SEARCH'),
  C('anime','ANIME'),C('animeinfo','ANIME'),C('waifu','ANIME'),

  C('emoji_status','PREMIUM',{premium:true}),C('customreact','PREMIUM',{premium:true}),
  C('premiumemoji','PREMIUM',{premium:true}),C('effect','PREMIUM',{premium:true}),

  C('owner','OWNER',{ownerOnly:true}),
  C('users','OWNER',{ownerOnly:true}),
  C('botstats','OWNER',{ownerOnly:true}),
  C('activity','OWNER',{ownerOnly:true}),
  C('growth','OWNER',{ownerOnly:true}),
  C('commandstats','OWNER',{ownerOnly:true}),
  C('countries','OWNER',{ownerOnly:true}),
  C('languages','OWNER',{ownerOnly:true}),
  C('user','OWNER',{ownerOnly:true})
];

const SOURCE_CATEGORY_TO_CATEGORY={
  ai_images:'AI',
  anime:'ANIME',
  audio_lab:'TOOLS',
  bot_sovereignty:'OWNER',
  download_tools:'DOWNLOAD',
  file_lab:'TOOLS',
  games_entertainment:'GAMES',
  general_tools:'TOOLS',
  group_guardians:'PROTECTION',
  group_management:'GROUP',
  owner_control:'OWNER',
  search_tools:'SEARCH',
  social_media_download:'DOWNLOAD'
};

function loadDipperManifest(){
  try{
    const raw=JSON.parse(fs.readFileSync(path.join(HERE,'generated','dipper-commands.json'),'utf8'));
    return Array.isArray(raw.commands)?raw.commands:[];
  }catch{return []}
}

export const DIPPER_COMMANDS=loadDipperManifest();

function loadSourceManifest(){
  try{
    const raw=JSON.parse(fs.readFileSync(path.join(HERE,'generated','source-commands.json'),'utf8'));
    return raw?.sources&&typeof raw.sources==='object'?raw.sources:{};
  }catch{return {}}
}
export const SOURCE_COMMANDS=loadSourceManifest();
const SOURCE_META={
  nexgroup:{category:'GROUP',sourceBot:'nexgroup'},
  nexgame:{category:'GAMES',proxy:'@TheNexGame_bot',sourceBot:'nexgame'},
  nexstick:{category:'STICKERS',proxy:'@The_Nexus_techbot',sourceBot:'nexstick'},
  nexwhisper:{category:'TOOLS',proxy:'@Nexwhisper_bot',sourceBot:'nexwhisper'},
  nexdownloader:{category:'DOWNLOAD',proxy:'@TheNexDownloader_bot',sourceBot:'nexdownloader'}
};

export const CATEGORY_ORDER=['GENERAL','AI','DOWNLOAD','GROUP','TOOLS','STICKERS','GAMES','PROTECTION','ANIME','SEARCH','PREMIUM','OWNER','ALIASES'];
export const CATEGORY_LABELS={GENERAL:'GENERAL',AI:'AI',DOWNLOAD:'DOWNLOAD',GROUP:'GROUP',TOOLS:'TOOLS',STICKERS:'STICKERS',GAMES:'GAMES',PROTECTION:'PROTECTION',ANIME:'ANIME',SEARCH:'SEARCH',PREMIUM:'PREMIUM',OWNER:'OWNER',ALIASES:'ALIASES'};
export const CATEGORY_ICONS={GENERAL:'general',AI:'ai',DOWNLOAD:'download',GROUP:'group',TOOLS:'tools',STICKERS:'sticker',GAMES:'games',PROTECTION:'shield',ANIME:'anime',SEARCH:'search',PREMIUM:'premium',OWNER:'owner',ALIASES:'tools'};

const normalize=value=>String(value||'').trim().toLowerCase();

function dipperEntry(spec){
  const name=normalize(spec.name);
  const category=SOURCE_CATEGORY_TO_CATEGORY[spec.sourceCategory]||'TOOLS';
  return C(name,category,{
    description:spec.description||('THE BIG DIPPER · '+name),
    dipper:true,
    dipperCanonical:name,
    sourceCategory:spec.sourceCategory,
    sourceFile:spec.file,
    groupOnly:spec.groupOnly===true,
    adminOnly:spec.adminOnly===true,
    ownerOnly:spec.ownerOnly===true||spec.sourceCategory==='owner_control'||spec.sourceCategory==='bot_sovereignty'
  });
}

export function commandMap(extra=[]){
  const map=new Map();
  const put=cmd=>{
    if(!cmd?.name)return;
    const key=normalize(cmd.name);
    if(!key||map.has(key))return;
    map.set(key,{...cmd,name:key});
  };

  // 1) NexAI core always wins.
  for(const cmd of CORE_COMMANDS)put(cmd);

  // 2) Keep every source-bot command addressable with an explicit namespace.
  //    This guarantees that no collision can make a source command disappear.
  for(const [source,names] of Object.entries(SOURCE_COMMANDS)){
    const meta=SOURCE_META[source]||{category:'TOOLS',sourceBot:source};
    for(const raw of names||[]){
      const name=normalize(raw);if(!name)continue;
      const specific=source.replace(/^nex/,'')+'_'+name;
      put(C(specific,meta.category,{
        ...meta,
        sourceCommand:name,
        description:'NexAI · '+source+' · '+name,
        hidden:false
      }));
    }
  }

  // 3) For the short/bare name, prefer the service that actually owns the
  //    Telegram implementation. Dipper is an extension layer, not a mask.
  const sourcePriority=['nexdownloader','nexgroup','nexstick','nexgame','nexwhisper'];
  for(const source of sourcePriority){
    const names=SOURCE_COMMANDS[source]||[];
    const meta=SOURCE_META[source]||{category:'TOOLS',sourceBot:source};
    for(const raw of names){
      const name=normalize(raw);if(!name||map.has(name))continue;
      put(C(name,meta.category,{
        ...meta,
        sourceCommand:name,
        description:'NexAI · '+source+' · '+name
      }));
    }
  }

  // 4) Add THE BIG DIPPER commands. If a canonical command already has a
  //    native Nexus owner, all Dipper aliases inherit that real implementation.
  for(const spec of DIPPER_COMMANDS){
    const canonical=normalize(spec.name);
    if(!canonical)continue;
    if(!map.has(canonical))put(dipperEntry(spec));
    const target=map.get(canonical)||dipperEntry(spec);
    for(const aliasRaw of spec.aliases||[]){
      const alias=normalize(aliasRaw);
      if(!alias||map.has(alias))continue;
      map.set(alias,{
        ...target,
        name:alias,
        aliasFor:canonical,
        hidden:true,
        description:'Alias de '+canonical
      });
    }
  }

  for(const cmd of extra)put(cmd);
  return map;
}
export function commandsByCategory(commands){
  const out={};
  const seen=new Set();
  for(const cmd of commands.values()){
    if(cmd.hidden&&cmd.aliasFor){
      (out.ALIASES??=[]).push({...cmd,category:'ALIASES',name:cmd.name});
      continue;
    }
    if(cmd.hidden)continue;
    const canonical=cmd.aliasFor||cmd.name;
    if(seen.has(canonical))continue;
    seen.add(canonical);
    (out[cmd.category]??=[]).push({...cmd,name:canonical});
  }
  for(const list of Object.values(out))list.sort((a,b)=>a.name.localeCompare(b.name));
  return out;
}

export function commandStats(commands){
  const values=[...commands.values()];
  return {
    tokens:commands.size,
    visible:values.filter(c=>!c.hidden).length,
    aliases:values.filter(c=>c.hidden&&c.aliasFor).length,
    dipperCanonical:DIPPER_COMMANDS.length,
    sourceTokens:Object.values(SOURCE_COMMANDS).reduce((n,v)=>n+(Array.isArray(v)?v.length:0),0)
  };
}
