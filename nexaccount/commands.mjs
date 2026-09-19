const C=(name,category,options={})=>({name,category,...options});

export const CORE_COMMANDS=[
  C('menu','GENERAL',{description:'Afficher le menu NexAI'}),
  C('style','GENERAL',{description:'Afficher/changer le style'}),
  C('ping','GENERAL',{description:'Latence du moteur'}),
  C('alive','GENERAL',{description:'État de NexAccount'}),
  C('account','GENERAL',{description:'Informations du compte connecté'}),
  C('help','GENERAL',{description:'Aide rapide'}),

  C('join','GROUP',{description:'Rejoindre un groupe ou canal par lien/username'}),
  C('leave','GROUP',{description:'Quitter le chat courant'}),
  C('promote','GROUP',{description:'Promouvoir un membre'}),
  C('demote','GROUP',{description:'Rétrograder un administrateur'}),
  C('kick','GROUP',{description:'Retirer un membre'}),
  C('ban','GROUP',{description:'Bannir un membre'}),
  C('unban','GROUP',{description:'Débannir un membre'}),
  C('mute','GROUP',{description:'Restreindre un membre'}),
  C('unmute','GROUP',{description:'Lever une restriction'}),
  C('warn','GROUP',{description:'Avertir un membre'}),
  C('tagall','GROUP',{description:'Mentionner les membres'}),
  C('hidetag','GROUP',{description:'Mention silencieuse'}),
  C('welcome','GROUP',{description:'Réglage welcome'}),
  C('goodbye','GROUP',{description:'Réglage goodbye'}),
  C('channels','CHANNEL',{description:'Lister les chaînes du compte'}),
  C('post','CHANNEL',{description:'Publier dans une chaîne'}),
  C('forward','CHANNEL',{description:'Transférer une publication'}),
  C('schedule','CHANNEL',{description:'Programmer une publication'}),
  C('drafts','CHANNEL',{description:'Brouillons de publication'}),
  C('story','CHANNEL',{description:'Publier une Story',premium:true}),

  C('antilink','PROTECTION',{description:'Protection anti-liens'}),
  C('antispam','PROTECTION',{description:'Protection anti-spam'}),
  C('antiraid','PROTECTION',{description:'Protection anti-raid'}),
  C('clean','PROTECTION',{description:'Nettoyage de messages'}),

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

  C('ai','AI'),
  C('code','AI'),
  C('deepseek','AI'),
  C('image','AI'),
  C('translate','TOOLS'),
  C('tts','TOOLS'),
  C('qr','TOOLS'),
  C('tinyurl','TOOLS'),
  C('texttopdf','TOOLS'),
  C('toimage','TOOLS'),
  C('genpass','TOOLS'),
  C('fliptext','TOOLS'),
  C('emojimix','TOOLS'),
  C('device','TOOLS'),
  C('gsmarena','SEARCH'),
  C('define','SEARCH'),
  C('imdb','SEARCH'),
  C('weather','SEARCH'),
  C('anime','ANIME'),
  C('animeinfo','ANIME'),

  C('emoji_status','PREMIUM',{premium:true,description:'Définir un emoji status Telegram'}),
  C('customreact','PREMIUM',{premium:true,description:'Réaction custom emoji'}),
  C('premiumemoji','PREMIUM',{premium:true,description:'Utiliser les custom emojis Premium'}),
  C('effect','PREMIUM',{premium:true,description:'Envoyer avec un effet Telegram'}),

  C('sessions','OWNER',{ownerOnly:true}),
  C('setpp','OWNER',{ownerOnly:true}),
  C('setname','OWNER',{ownerOnly:true}),
  C('block','OWNER',{ownerOnly:true}),
  C('unblock','OWNER',{ownerOnly:true})
];

export const CATEGORY_ORDER=['GENERAL','AI','DOWNLOAD','GROUP','CHANNEL','TOOLS','STICKERS','GAMES','PROTECTION','ANIME','SEARCH','PREMIUM','OWNER'];

export const CATEGORY_LABELS={
  GENERAL:'GENERAL',AI:'AI',DOWNLOAD:'DOWNLOAD',GROUP:'GROUP',CHANNEL:'CHANNEL',
  TOOLS:'TOOLS',STICKERS:'STICKERS',GAMES:'GAMES',PROTECTION:'PROTECTION',
  ANIME:'ANIME',SEARCH:'SEARCH',PREMIUM:'PREMIUM',OWNER:'OWNER'
};

export const CATEGORY_ICONS={
  GENERAL:'general',AI:'ai',DOWNLOAD:'download',GROUP:'group',CHANNEL:'channel',
  TOOLS:'tools',STICKERS:'sticker',GAMES:'games',PROTECTION:'shield',
  ANIME:'anime',SEARCH:'search',PREMIUM:'premium',OWNER:'owner'
};

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
