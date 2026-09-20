import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const C=(name,category,options={})=>({name,category,...options});
const G={groupOnly:true};
const GA={groupOnly:true,adminOnly:true};
const P={privateOnly:true};

export const CORE_COMMANDS=[
  // MAIN — commands that make sense everywhere.
  C('menu','GENERAL',{description:'Menu principal NexAi · Dipper'}),
  C('help','GENERAL',{description:'Aide rapide'}),
  C('ping','GENERAL',{description:'Latence du moteur'}),
  C('alive','GENERAL',{description:'État de NexAi'}),
  C('creator','GENERAL',{description:'Créateur de NexAi'}),
  C('style','GENERAL',{description:'Afficher ou changer le style'}),
  C('support','GENERAL',{description:'Support NexAi'}),
  C('repo','GENERAL',{description:'Projet Nextech'}),

  // ACCOUNT — deliberately private, like the owner/settings section of a WhatsApp bot.
  C('account','ACCOUNT',{...P,description:'Informations du compte connecté'}),
  C('pair','ACCOUNT',{...P,description:'Connecter un compte Telegram'}),
  C('sessions','ACCOUNT',{...P,description:'Sessions connectées'}),
  C('dashboard','ACCOUNT',{...P,description:'Tableau de bord'}),
  C('settings','ACCOUNT',{...P,description:'Réglages NexAi'}),
  C('stats','ACCOUNT',{...P,description:'Statistiques du compte'}),
  C('premium','ACCOUNT',{...P,description:'Statut Premium'}),
  C('prefix','ACCOUNT',{...P,description:'Changer le préfixe'}),
  C('language','ACCOUNT',{...P,description:'Changer la langue'}),
  C('device','ACCOUNT',{...P,description:'Informations de la session'}),
  C('autoreact','ACCOUNT',{...P,description:'Activer/désactiver les réactions automatiques',handler:'reflexe_systeme'}),
  C('autoreply','ACCOUNT',{...P,description:'Configurer la réponse automatique',handler:'reponseauto'}),
  C('aimode','ACCOUNT',{...P,description:'Mode conversation IA naturel',handler:'dark'}),
  C('presence','ACCOUNT',{...P,description:'Présence du compte'}),
  C('autotyping','ACCOUNT',{...P,description:'Indicateur de saisie automatique'}),
  C('botname','ACCOUNT',{...P,description:'Nom affiché dans le menu',handler:'apparence_systeme'}),
  C('menuimage','ACCOUNT',{...P,description:'Illustration du menu',handler:'illustration_grimoire'}),

  // AI.
  C('ai','AI',{engine:'ai',description:'Assistant IA',}),
  C('code','AI',{engine:'ai',description:'Aide programmation',}),
  C('deepseek','AI',{engine:'ai',description:'Raisonnement approfondi',}),

  // DOWNLOAD — useful WhatsApp-bot style media commands.
  C('song','DOWNLOAD',{engine:'download',description:'Télécharger/rechercher une musique',}),
  C('video','DOWNLOAD',{engine:'download',description:'Télécharger une vidéo',}),
  C('tiktok','DOWNLOAD',{engine:'download',description:'Télécharger TikTok',}),
  C('instagram','DOWNLOAD',{engine:'download',description:'Télécharger Instagram',}),
  C('facebook','DOWNLOAD',{engine:'download',description:'Télécharger Facebook',}),
  C('pinterest','DOWNLOAD',{engine:'download',description:'Télécharger Pinterest',}),
  C('tomp3','DOWNLOAD',{engine:'download',description:'Convertir une vidéo en MP3',}),
  C('lyrics','DOWNLOAD',{engine:'download',description:'Paroles de chanson',}),
  C('shazam','DOWNLOAD',{engine:'download',description:'Identifier une musique',}),
  C('apk','DOWNLOAD',{engine:'download',description:'Rechercher un APK',}),
  C('downloadinfo','DOWNLOAD',{description:'Inspecter une URL de téléchargement'}),

  // GROUP — information and non-destructive group utilities.
  C('id','GROUP',{...G,engine:'group',localOnly:true,description:'ID du groupe'}),
  C('groupname','GROUP',{...G,description:'Nom du groupe'}),
  C('groupstats','GROUP',{...G,engine:'group',localOnly:true,description:'Statistiques du groupe'}),
  C('admins','GROUP',{...G,engine:'group',localOnly:true,description:'Lister les admins'}),
  C('tagadmin','GROUP',{...G,description:'Mentionner les admins'}),
  C('rules','GROUP',{...G,engine:'group',localOnly:true,description:'Afficher les règles'}),
  C('notes','GROUP',{...G,engine:'group',localOnly:true,description:'Afficher les notes'}),
  C('privacy','GROUP',{...G,engine:'group',localOnly:true,description:'Informations de confidentialité'}),

  // ADMIN — destructive/configuration commands require a group admin.
  C('promote','ADMIN',{...GA,description:'Promouvoir un membre'}),
  C('demote','ADMIN',{...GA,description:'Rétrograder un admin'}),
  C('kick','ADMIN',{...GA,description:'Retirer un membre'}),
  C('ban','ADMIN',{...GA,description:'Bannir un membre'}),
  C('unban','ADMIN',{...GA,description:'Débannir un membre'}),
  C('mute','ADMIN',{...GA,description:'Rendre un membre muet'}),
  C('unmute','ADMIN',{...GA,description:'Rendre la parole à un membre'}),
  C('warn','ADMIN',{...GA,description:'Avertir un membre'}),
  C('resetwarn','ADMIN',{...GA,description:'Réinitialiser les avertissements'}),
  C('warnings','ADMIN',{...GA,engine:'group',localOnly:true,description:'Voir les avertissements'}),
  C('clearwarns','ADMIN',{...GA,engine:'group',localOnly:true,description:'Effacer les avertissements'}),
  C('add','ADMIN',{...GA,description:'Inviter un membre'}),
  C('delete','ADMIN',{...GA,description:'Supprimer le message répondu'}),
  C('clean','ADMIN',{...GA,description:'Nettoyer des messages'}),
  C('grouplink','ADMIN',{...GA,description:'Créer le lien du groupe'}),
  C('tagall','ADMIN',{...GA,description:'Mentionner tous les membres'}),
  C('hidetag','ADMIN',{...GA,description:'Mention silencieuse des membres'}),
  C('mediatag','ADMIN',{...GA,description:'Mentionner les membres avec un média'}),
  C('welcome','ADMIN',{...GA,description:'Activer/désactiver le message de bienvenue'}),
  C('goodbye','ADMIN',{...GA,description:'Activer/désactiver le message de départ'}),
  C('setwelcome','ADMIN',{...GA,description:'Définir le message de bienvenue'}),
  C('setgoodbye','ADMIN',{...GA,description:'Définir le message de départ'}),
  C('approve','ADMIN',{...GA,description:'Approuver une demande d’adhésion'}),
  C('approveall','ADMIN',{...GA,description:'Approuver toutes les demandes'}),
  C('approvepending','ADMIN',{...GA,engine:'group',localOnly:true,description:'Approuver les demandes en attente'}),
  C('autoapprove','ADMIN',{...GA,engine:'group',localOnly:true,description:'Approbation automatique'}),
  C('slowmode','ADMIN',{...GA,engine:'group',localOnly:true,description:'Configurer le slow mode'}),
  C('mutechat','ADMIN',{...GA,description:'Fermer le groupe en écriture'}),
  C('unmutechat','ADMIN',{...GA,description:'Ouvrir le groupe en écriture'}),
  C('setrules','ADMIN',{...GA,engine:'group',localOnly:true,description:'Définir les règles'}),
  C('setcommand','ADMIN',{...GA,engine:'group',localOnly:true,description:'Créer une commande personnalisée'}),
  C('broadcast','ADMIN',{...GA,engine:'group',localOnly:true,description:'Publier une annonce dans le groupe'}),
  C('config','ADMIN',{...GA,engine:'group',localOnly:true,description:'Configuration du groupe'}),
  C('permissions','ADMIN',{...GA,engine:'group',localOnly:true,description:'Permissions du compte'}),
  C('backup','ADMIN',{...GA,engine:'group',localOnly:true,description:'Sauvegarder la configuration du groupe'}),
  C('restore','ADMIN',{...GA,engine:'group',localOnly:true,description:'Restaurer la configuration du groupe'}),
  C('copyconfig','ADMIN',{...GA,engine:'group',localOnly:true,description:'Copier une configuration de groupe'}),
  C('kickall','ADMIN',{...GA,engine:'group',localOnly:true,description:'Retirer les membres non-admins'}),

  // PROTECTION.
  C('antilink','PROTECTION',{...GA,description:'Anti-liens'}),
  C('antispam','PROTECTION',{...GA,description:'Anti-spam'}),
  C('antiraid','PROTECTION',{...GA,description:'Anti-raid'}),
  C('antitag','PROTECTION',{...GA,description:'Anti-mention'}),
  C('antigroupmention','PROTECTION',{...GA,description:'Anti-mention massive'}),
  C('antibadword','PROTECTION',{...GA,description:'Filtre de mots'}),
  C('captcha','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Captcha nouveaux membres'}),
  C('raidmode','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Mode raid'}),
  C('nightmode','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Mode nuit'}),
  C('logs','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Logs de modération'}),
  C('blacklist','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Liste noire'}),
  C('whitelist','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Liste blanche'}),
  C('risk','PROTECTION',{...GA,engine:'group',localOnly:true,description:'Indice de sécurité'}),

  // TOOLS.
  C('translate','TOOLS',{description:'Traduire un texte'}),
  C('tts','TOOLS',{description:'Texte vers audio'}),
  C('qr','TOOLS',{description:'Créer un QR code'}),
  C('tinyurl','TOOLS',{description:'Raccourcir une URL'}),
  C('texttopdf','TOOLS',{description:'Texte vers PDF'}),
  C('toimage','TOOLS',{description:'Texte vers image'}),
  C('genpass','TOOLS',{description:'Générer un mot de passe'}),
  C('fliptext','TOOLS',{description:'Inverser un texte'}),
  C('calc','TOOLS',{description:'Calculatrice'}),
  C('smallcaps','TOOLS',{description:'Texte small caps'}),
  C('browse','TOOLS',{description:'Lire les métadonnées d’une page'}),
  C('ssweb','TOOLS',{description:'Capture mobile d’un site'}),
  C('sswebpc','TOOLS',{description:'Capture desktop d’un site'}),
  C('vcf','TOOLS',{description:'Créer un fichier VCF'}),
  C('emojimix','TOOLS',{description:'Combiner deux emojis'}),
  C('getname','TOOLS',{description:'Informations d’un utilisateur'}),
  C('getabout','TOOLS',{description:'Bio d’un utilisateur'}),
  C('getpp','TOOLS',{description:'Photo de profil'}),
  C('block','TOOLS',{description:'Bloquer un utilisateur'}),
  C('unblock','TOOLS',{description:'Débloquer un utilisateur'}),

  // MEDIA.
  C('tourl','MEDIA',{description:'Média vers URL'}),
  C('crop','MEDIA',{description:'Recadrer une image'}),
  C('resize','MEDIA',{description:'Redimensionner une image'}),
  C('analyzesound','MEDIA',{description:'Analyser un audio/une vidéo'}),
  C('vv','MEDIA',{description:'Récupérer un de mes médias éphémères/vue unique Telegram'}),

  // STICKERS — kept as a compact WhatsApp-style surface.
  C('sticker','STICKERS',{engine:'sticker',description:'Créer un sticker',}),
  C('stickerinfo','STICKERS',{engine:'sticker',description:'Informations d’un sticker',}),
  C('clonepack','STICKERS',{engine:'sticker',description:'Cloner un pack',}),
  C('createpack','STICKERS',{engine:'sticker',description:'Créer un pack',}),
  C('mypacks','STICKERS',{...P,engine:'sticker',description:'Mes packs',}),
  C('exportwhatsapp','STICKERS',{engine:'sticker',description:'Exporter pour WhatsApp',}),

  // FUN/GAMES — only commands that make sense conversationally.
  C('truth','FUN',{...G,description:'Question vérité',handler:'aveu'}),
  C('dare','FUN',{...G,description:'Défi',handler:'epreuve'}),
  C('joke','FUN',{description:'Blague',handler:'bouffon'}),
  C('compliment','FUN',{description:'Compliment',handler:'charme'}),
  C('riddle','FUN',{...G,engine:'game',description:'Devinette',}),
  C('quiz','FUN',{...G,engine:'game',description:'Quiz',}),
  C('tictactoe','FUN',{...G,engine:'game',description:'Morpion',}),

  // SEARCH / ANIME.
  C('weather','SEARCH',{description:'Météo'}),
  C('define','SEARCH',{description:'Définition'}),
  C('imdb','SEARCH',{description:'Film ou série'}),
  C('gsmarena','SEARCH',{description:'Recherche téléphone'}),
  C('animeinfo','ANIME',{engine:'anime',description:'Fiche complète d’un anime'}),
  C('anisearch','ANIME',{engine:'anime',description:'Rechercher un anime'}),
  C('manga','ANIME',{engine:'anime',description:'Rechercher un manga'}),
  C('character','ANIME',{engine:'anime',description:'Rechercher un personnage'}),
  C('studio','ANIME',{engine:'anime',description:'Rechercher un studio'}),
  C('seiyuu','ANIME',{engine:'anime',description:'Rechercher un doubleur/seiyuu'}),
  C('animecalendar','ANIME',{engine:'anime',description:'Calendrier des diffusions'}),
  C('airing','ANIME',{engine:'anime',description:'Prochaine diffusion d’un anime'}),
  C('season','ANIME',{engine:'anime',description:'Anime de la saison actuelle'}),
  C('upcoming','ANIME',{engine:'anime',description:'Anime à venir'}),
  C('topanime','ANIME',{engine:'anime',description:'Top anime'}),
  C('topmanga','ANIME',{engine:'anime',description:'Top manga'}),
  C('trendinganime','ANIME',{engine:'anime',description:'Anime tendances'}),
  C('randomanime','ANIME',{engine:'anime',description:'Anime aléatoire'}),
  C('randommanga','ANIME',{engine:'anime',description:'Manga aléatoire'}),
  C('recommendanime','ANIME',{engine:'anime',description:'Recommandations similaires'}),
  C('genre','ANIME',{engine:'anime',description:'Anime par genre'}),
  C('animebyyear','ANIME',{engine:'anime',description:'Anime par année'}),
  C('animebyseason','ANIME',{engine:'anime',description:'Anime par saison et année'}),
  C('episode','ANIME',{engine:'anime',description:'Informations sur un épisode'}),
  C('episodes','ANIME',{engine:'anime',description:'Lister les épisodes'}),
  C('openingsearch','ANIME',{engine:'anime',description:'Openings d’un anime'}),
  C('endingsearch','ANIME',{engine:'anime',description:'Endings d’un anime'}),
  C('anisong','ANIME',{engine:'anime',description:'Musiques d’un anime'}),
  C('ost','ANIME',{engine:'anime',description:'Rechercher l’OST d’un anime'}),
  C('trailer','ANIME',{engine:'anime',description:'Trailer officiel'}),
  C('animequote','ANIME',{engine:'anime',description:'Citation anime'}),
  C('characterquote','ANIME',{engine:'anime',description:'Citation de personnage'}),
  C('animeimage','ANIME',{engine:'anime',description:'Image/couverture d’un anime'}),
  C('wallpaperanime','ANIME',{engine:'anime',description:'Wallpaper anime'}),
  C('avataranime','ANIME',{engine:'anime',description:'Avatar de personnage'}),
  C('banneranime','ANIME',{engine:'anime',description:'Bannière anime'}),
  C('waifu','ANIME',{engine:'anime',description:'Image waifu SFW'}),
  C('waifuhd','ANIME',{engine:'anime',premium:true,description:'Waifu HD Premium'}),
  C('husbando','ANIME',{engine:'anime',description:'Personnage masculin aléatoire'}),
  C('neko','ANIME',{engine:'anime',description:'Image neko SFW'}),
  C('cosplay','ANIME',{engine:'anime',description:'Image cosplay/anime SFW'}),
  C('cosplayvip','ANIME',{engine:'anime',premium:true,description:'Cosplay HD Premium'}),
  C('amv','ANIME',{engine:'anime',description:'AMV anime aléatoire'}),
  C('amvhd','ANIME',{engine:'anime',premium:true,description:'AMV HD Premium'}),
  C('opening','ANIME',{engine:'anime',description:'Opening anime aléatoire'}),
  C('openingvip','ANIME',{engine:'anime',premium:true,description:'Opening Premium'}),
  C('ship','ANIME',{engine:'anime',description:'Compatibilité fictive entre personnages'}),
  C('guessanime','ANIME',{engine:'anime',description:'Jeu devine l’anime'}),
  C('guesscharacter','ANIME',{engine:'anime',description:'Jeu devine le personnage'}),
  C('guessopening','ANIME',{engine:'anime',description:'Jeu devine l’opening'}),
  C('animequiz','ANIME',{engine:'anime',description:'Quiz anime'}),
  C('mangaquiz','ANIME',{engine:'anime',description:'Quiz manga'}),
  C('animeriddle','ANIME',{engine:'anime',description:'Devinette anime'}),
  C('whosaid','ANIME',{engine:'anime',description:'Deviner qui a dit la citation'}),
  C('powerbattle','ANIME',{engine:'anime',description:'Comparer deux personnages/anime sans inventer de vainqueur'}),
  C('animeprofile','ANIME',{engine:'anime',description:'Profil anime personnel'}),
  C('animelist','ANIME',{engine:'anime',description:'Liste anime personnelle'}),
  C('mangalist','ANIME',{engine:'anime',description:'Liste manga personnelle'}),
  C('watching','ANIME',{engine:'anime',description:'Anime en cours'}),
  C('completed','ANIME',{engine:'anime',description:'Anime terminés'}),
  C('planned','ANIME',{engine:'anime',description:'Anime prévus'}),
  C('dropped','ANIME',{engine:'anime',description:'Anime abandonnés'}),
  C('rateanime','ANIME',{engine:'anime',description:'Noter un anime'}),
  C('favoriteanime','ANIME',{engine:'anime',description:'Ajouter un anime aux favoris'}),
  C('favoritechar','ANIME',{engine:'anime',description:'Ajouter un personnage aux favoris'}),
  C('animehistory','ANIME',{engine:'anime',description:'Historique anime'}),
  C('mal','ANIME',{engine:'anime',description:'Fiche MyAnimeList'}),
  C('anilist','ANIME',{engine:'anime',description:'Fiche AniList'}),
  C('anidb','ANIME',{engine:'anime',description:'Lien AniDB référencé'}),
  C('webtoon','ANIME',{engine:'anime',description:'Recherche webtoon'}),
  C('manhwa','ANIME',{engine:'anime',description:'Recherche manhwa'}),
  C('manhua','ANIME',{engine:'anime',description:'Recherche manhua'}),
  C('lightnovel','ANIME',{engine:'anime',description:'Recherche light novel'}),
  C('mangaauthor','ANIME',{engine:'anime',description:'Auteur/mangaka'}),
  C('publisher','ANIME',{engine:'anime',description:'Publication/sérialisation manga'}),
  C('animecompare','ANIME',{engine:'anime',description:'Comparer deux anime'}),
  C('charcompare','ANIME',{engine:'anime',description:'Comparer deux personnages'}),
  C('animefacts','ANIME',{engine:'anime',description:'Faits vérifiables sur un anime'}),
  C('characterfacts','ANIME',{engine:'anime',description:'Faits sur un personnage'}),
  C('birthdayanime','ANIME',{engine:'anime',description:'Anniversaires de personnages du jour'}),
  C('birthdaychar','ANIME',{engine:'anime',description:'Anniversaires par date'}),
  C('animecountdown','ANIME',{engine:'anime',description:'Compte à rebours prochain épisode'}),
  C('anitts','ANIME',{engine:'anime',description:'Texte vers voix anime synthétique'}),

  // PREMIUM Telegram features.
  C('customreact','PREMIUM',{premium:true,description:'Réactions personnalisées'}),
  C('emoji_status','PREMIUM',{premium:true,description:'Statut emoji Premium'}),
  C('effect','PREMIUM',{premium:true,description:'Effet de message préféré'}),

  // Platform owner controls stay private and are never shown to normal users.
  C('owner','OWNER',{...P,ownerOnly:true}),
  C('users','OWNER',{...P,ownerOnly:true}),
  C('botstats','OWNER',{...P,ownerOnly:true}),
  C('activity','OWNER',{...P,ownerOnly:true}),
  C('growth','OWNER',{...P,ownerOnly:true}),
  C('commandstats','OWNER',{...P,ownerOnly:true}),
  C('countries','OWNER',{...P,ownerOnly:true}),
  C('languages','OWNER',{...P,ownerOnly:true}),
  C('user','OWNER',{...P,ownerOnly:true})
];

// Small compatibility layer. Old names can still work without polluting the menu.
export const LEGACY_ALIASES={
  dipper:'menu',grimoire:'menu',allmenu:'menu',
  about:'creator',founder:'creator',ceo:'creator',
  stylelist:'style',
  reflexe_systeme:'autoreact',reponseauto:'autoreply',dark:'aimode',
  apparence_systeme:'botname',illustration_grimoire:'menuimage',
  traduction:'translate',meteo:'weather',algebre:'calc',
  cobalt:'facebook',apksearch:'apk',igs:'instagram','sᴄᴇᴀᴜ_ɪɢ_ᴄᴀʀʀᴇ':'instagram',
  'ᴄᴀɴᴛɪǫᴜᴇ':'lyrics','sᴍᴀʟʟᴄᴀᴘs':'smallcaps',
  accueil:'welcome',inscription:'setwelcome',motsadieu:'setgoodbye',
  sentence:'warn',silence:'mutechat',parole:'unmutechat',
  purification:'clean',debannissement:'unban',bannir:'ban',
  aveu:'truth',epreuve:'dare',bouffon:'joke',charme:'compliment',
  premiumemoji:'emoji_status',
  viewonce:'vv',tovv:'vv',
  animesearch:'anisearch',searchanime:'anisearch',
  mangasearch:'manga',searchmanga:'manga',mangainfo:'manga',
  scheduleanime:'animecalendar',trendanime:'trendinganime',similar:'recommendanime',
  opsearch:'openingsearch',edsearch:'endingsearch',anitrailer:'trailer',
  waifuimage:'waifu',wife:'waifu',waifupremium:'waifuhd',hdwaifu:'waifuhd',
  catgirl:'neko',nekogirl:'neko',quote:'animequote',aniquote:'animequote',animecitation:'animequote',
  char:'character',perso:'character',personnage:'character',
  animemv:'amv',musicvideo:'amv',amvpremium:'amvhd',hdamv:'amvhd',
  animeop:'opening',op:'opening',opvip:'openingvip',openingpremium:'openingvip',
  cos:'cosplay',cosplayer:'cosplay',cosplaypremium:'cosplayvip',hdcosplay:'cosplayvip',
  ln:'lightnovel',animetts:'anitts',charvoice:'anitts',voixanime:'anitts',anivoice:'anitts'
};

// Explicitly discarded legacy commands: dangerous server controls, WhatsApp-only
// leftovers, placeholders, duplicates or commands that only pretended to work.
export const REMOVED_COMMANDS=new Set([
  'execute','runeval','darkfile','save','crash','mise_a_jour','renaissance','reload',
  'tostatus','antiwalink','antistatusmention','rejet_appels','autorecording',
  'annihiler','exaucee','setsudo','delsudo','setvip','delvip','transferowner',
  'filtervcf','pausequeue','adoration','arcanes','boutique','rang','sanctuaire',
  'fresque','quete_fresque','jugement_d','malediction','piege','destin','fakehack',
  'leaderboard','rep','schedule','template','topicpolicy'
]);

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

export const CATEGORY_ORDER=[
  'GENERAL','ACCOUNT','AI','DOWNLOAD','GROUP','ADMIN','PROTECTION',
  'TOOLS','MEDIA','STICKERS','FUN','SEARCH','ANIME','PREMIUM','OWNER'
];
export const CATEGORY_LABELS={
  GENERAL:'MAIN',ACCOUNT:'ACCOUNT',AI:'AI',DOWNLOAD:'DOWNLOAD',GROUP:'GROUP',
  ADMIN:'ADMIN',PROTECTION:'PROTECTION',TOOLS:'TOOLS',MEDIA:'MEDIA',
  STICKERS:'STICKERS',FUN:'FUN',SEARCH:'SEARCH',ANIME:'ANIME',
  PREMIUM:'PREMIUM',OWNER:'OWNER'
};
export const CATEGORY_ICONS={
  GENERAL:'general',ACCOUNT:'account',AI:'ai',DOWNLOAD:'download',GROUP:'group',
  ADMIN:'admin',PROTECTION:'shield',TOOLS:'tools',MEDIA:'media',
  STICKERS:'sticker',FUN:'games',SEARCH:'search',ANIME:'anime',
  PREMIUM:'premium',OWNER:'owner'
};

const normalize=value=>{
  const token=String(value||'').normalize('NFKC').trim().toLowerCase();
  if(!token||[...token].length>64||/[\s/@]/u.test(token))return '';
  if(!/^[\p{L}\p{N}_-]+$/u.test(token))return '';
  return token;
};

export function commandMap(extra=[]){
  const map=new Map();
  const put=cmd=>{
    if(!cmd?.name)return;
    const key=normalize(cmd.name);
    if(!key||REMOVED_COMMANDS.has(key)||map.has(key))return;
    map.set(key,{...cmd,name:key});
  };

  for(const cmd of CORE_COMMANDS)put(cmd);

  // Compatibility aliases are alternate names only: they never create another
  // visible command or another handler.
  const resolveCanonical=target=>{
    let key=normalize(target);
    const seen=new Set();
    while(key&&map.has(key)&&map.get(key)?.aliasFor&&!seen.has(key)){
      seen.add(key);
      key=normalize(map.get(key).aliasFor);
    }
    return key&&map.has(key)?key:'';
  };
  const addAlias=(alias,target)=>{
    const a=normalize(alias),t=resolveCanonical(target);
    if(!a||!t||REMOVED_COMMANDS.has(a)||map.has(a))return;
    const canonical=map.get(t);
    if(!canonical)return;
    map.set(a,{...canonical,name:a,aliasFor:t,hidden:true});
  };

  // Hand-picked renames made during the NexAi cleanup.
  for(const [alias,target] of Object.entries(LEGACY_ALIASES))addAlias(alias,target);

  // Preserve every historical Dipper alias for commands that are still kept.
  // All aliases resolve directly to the final canonical command, even if the
  // historical Dipper command itself was renamed (cobalt -> facebook, etc.).
  for(const spec of DIPPER_COMMANDS){
    const oldCanonical=normalize(spec?.name);
    if(!oldCanonical)continue;
    const target=resolveCanonical(oldCanonical)
      ||resolveCanonical(LEGACY_ALIASES[oldCanonical]||'');
    if(!target)continue;
    addAlias(oldCanonical,target);
    for(const alias of spec.aliases||[])addAlias(alias,target);
  }

  for(const cmd of extra)put(cmd);
  return map;
}

export function commandsByCategory(commands){
  const out={};
  const seen=new Set();
  for(const cmd of commands.values()){
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
    removed:REMOVED_COMMANDS.size,
    dipperSourceCanonical:DIPPER_COMMANDS.length,
    sourceTokens:Object.values(SOURCE_COMMANDS).reduce((n,v)=>n+(Array.isArray(v)?v.length:0),0)
  };
}
