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

  C('join','GROUP',{description:'Rejoindre un groupe ou canal par lien/username'}),
  C('leave','GROUP',{description:'Quitter le chat courant'}),
  C('promote','GROUP'),C('demote','GROUP'),C('kick','GROUP'),C('ban','GROUP'),C('unban','GROUP'),
  C('mute','GROUP'),C('unmute','GROUP'),C('warn','GROUP'),C('tagall','GROUP'),C('hidetag','GROUP'),
  C('welcome','GROUP'),C('goodbye','GROUP'),

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

  C('game','GAMES',{proxy:'@TheNexGame_bot'}),
  C('riddle','GAMES',{proxy:'@TheNexGame_bot'}),
  C('tictactoe','GAMES',{proxy:'@TheNexGame_bot'}),
  C('quiz','GAMES',{proxy:'@TheNexGame_bot'}),

  C('ai','AI'),C('code','AI'),C('deepseek','AI'),C('image','AI'),
  C('translate','TOOLS'),C('tts','TOOLS'),C('qr','TOOLS'),C('tinyurl','TOOLS'),
  C('texttopdf','TOOLS'),C('toimage','TOOLS'),C('genpass','TOOLS'),C('fliptext','TOOLS'),
  C('emojimix','TOOLS'),C('device','TOOLS'),
  C('gsmarena','SEARCH'),C('define','SEARCH'),C('imdb','SEARCH'),C('weather','SEARCH'),
  C('anime','ANIME'),C('animeinfo','ANIME'),

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

export const CATEGORY_ORDER=['GENERAL','AI','DOWNLOAD','GROUP','TOOLS','STICKERS','GAMES','PROTECTION','ANIME','SEARCH','PREMIUM','OWNER'];
export const CATEGORY_LABELS={GENERAL:'GENERAL',AI:'AI',DOWNLOAD:'DOWNLOAD',GROUP:'GROUP',TOOLS:'TOOLS',STICKERS:'STICKERS',GAMES:'GAMES',PROTECTION:'PROTECTION',ANIME:'ANIME',SEARCH:'SEARCH',PREMIUM:'PREMIUM',OWNER:'OWNER'};
export const CATEGORY_ICONS={GENERAL:'general',AI:'ai',DOWNLOAD:'download',GROUP:'group',TOOLS:'tools',STICKERS:'sticker',GAMES:'games',PROTECTION:'shield',ANIME:'anime',SEARCH:'search',PREMIUM:'premium',OWNER:'owner'};

export function commandMap(extra=[]){
  const map=new Map();
  for(const cmd of [...CORE_COMMANDS,...extra]){
    if(!cmd?.name)continue;
    const key=String(cmd.name).toLowerCase();
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
