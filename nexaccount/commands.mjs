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
  C('ai','AI',{description:'Assistant IA',proxy:'@Stacytg_bot',proxyMode:'chat'}),
  C('code','AI',{description:'Aide programmation',proxy:'@Stacytg_bot',proxyMode:'chat'}),
  C('deepseek','AI',{description:'Raisonnement approfondi',proxy:'@Stacytg_bot',proxyMode:'chat'}),

  // DOWNLOAD — useful WhatsApp-bot style media commands.
  C('song','DOWNLOAD',{description:'Télécharger/rechercher une musique',proxy:'@TheNexDownloader_bot'}),
  C('video','DOWNLOAD',{description:'Télécharger une vidéo',proxy:'@TheNexDownloader_bot'}),
  C('tiktok','DOWNLOAD',{description:'Télécharger TikTok',proxy:'@TheNexDownloader_bot'}),
  C('instagram','DOWNLOAD',{description:'Télécharger Instagram',proxy:'@TheNexDownloader_bot'}),
  C('facebook','DOWNLOAD',{description:'Télécharger Facebook',proxy:'@TheNexDownloader_bot'}),
  C('pinterest','DOWNLOAD',{description:'Télécharger Pinterest',proxy:'@TheNexDownloader_bot'}),
  C('tomp3','DOWNLOAD',{description:'Convertir une vidéo en MP3',proxy:'@TheNexDownloader_bot'}),
  C('lyrics','DOWNLOAD',{description:'Paroles de chanson',proxy:'@TheNexDownloader_bot'}),
  C('shazam','DOWNLOAD',{description:'Identifier une musique',proxy:'@TheNexDownloader_bot'}),
  C('apk','DOWNLOAD',{description:'Rechercher un APK',proxy:'@TheNexDownloader_bot'}),
  C('downloadinfo','DOWNLOAD',{description:'Inspecter une URL de téléchargement'}),

  // GROUP — information and non-destructive group utilities.
  C('id','GROUP',{...G,sourceBot:'nexgroup',localOnly:true,description:'ID du groupe'}),
  C('groupname','GROUP',{...G,description:'Nom du groupe'}),
  C('groupstats','GROUP',{...G,sourceBot:'nexgroup',localOnly:true,description:'Statistiques du groupe'}),
  C('admins','GROUP',{...G,sourceBot:'nexgroup',localOnly:true,description:'Lister les admins'}),
  C('tagadmin','GROUP',{...G,description:'Mentionner les admins'}),
  C('rules','GROUP',{...G,sourceBot:'nexgroup',localOnly:true,description:'Afficher les règles'}),
  C('notes','GROUP',{...G,sourceBot:'nexgroup',localOnly:true,description:'Afficher les notes'}),
  C('privacy','GROUP',{...G,sourceBot:'nexgroup',localOnly:true,description:'Informations de confidentialité'}),

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
  C('warnings','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Voir les avertissements'}),
  C('clearwarns','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Effacer les avertissements'}),
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
  C('approvepending','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Approuver les demandes en attente'}),
  C('autoapprove','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Approbation automatique'}),
  C('slowmode','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Configurer le slow mode'}),
  C('mutechat','ADMIN',{...GA,description:'Fermer le groupe en écriture'}),
  C('unmutechat','ADMIN',{...GA,description:'Ouvrir le groupe en écriture'}),
  C('setrules','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Définir les règles'}),
  C('setcommand','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Créer une commande personnalisée'}),
  C('broadcast','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Publier une annonce dans le groupe'}),
  C('config','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Configuration du groupe'}),
  C('permissions','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Permissions du compte'}),
  C('backup','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Sauvegarder la configuration du groupe'}),
  C('restore','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Restaurer la configuration du groupe'}),
  C('copyconfig','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Copier une configuration de groupe'}),
  C('kickall','ADMIN',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Retirer les membres non-admins'}),

  // PROTECTION.
  C('antilink','PROTECTION',{...GA,description:'Anti-liens'}),
  C('antispam','PROTECTION',{...GA,description:'Anti-spam'}),
  C('antiraid','PROTECTION',{...GA,description:'Anti-raid'}),
  C('antitag','PROTECTION',{...GA,description:'Anti-mention'}),
  C('antigroupmention','PROTECTION',{...GA,description:'Anti-mention massive'}),
  C('antibadword','PROTECTION',{...GA,description:'Filtre de mots'}),
  C('captcha','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Captcha nouveaux membres'}),
  C('raidmode','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Mode raid'}),
  C('nightmode','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Mode nuit'}),
  C('logs','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Logs de modération'}),
  C('blacklist','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Liste noire'}),
  C('whitelist','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Liste blanche'}),
  C('risk','PROTECTION',{...GA,sourceBot:'nexgroup',localOnly:true,description:'Indice de sécurité'}),

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

  // STICKERS — kept as a compact WhatsApp-style surface.
  C('sticker','STICKERS',{description:'Créer un sticker',proxy:'@The_Nexus_techbot'}),
  C('stickerinfo','STICKERS',{description:'Informations d’un sticker',proxy:'@The_Nexus_techbot'}),
  C('clonepack','STICKERS',{description:'Cloner un pack',proxy:'@The_Nexus_techbot'}),
  C('createpack','STICKERS',{description:'Créer un pack',proxy:'@The_Nexus_techbot'}),
  C('mypacks','STICKERS',{...P,description:'Mes packs',proxy:'@The_Nexus_techbot'}),
  C('exportwhatsapp','STICKERS',{description:'Exporter pour WhatsApp',proxy:'@The_Nexus_techbot'}),

  // FUN/GAMES — only commands that make sense conversationally.
  C('truth','FUN',{...G,description:'Question vérité',handler:'aveu'}),
  C('dare','FUN',{...G,description:'Défi',handler:'epreuve'}),
  C('joke','FUN',{description:'Blague',handler:'bouffon'}),
  C('compliment','FUN',{description:'Compliment',handler:'charme'}),
  C('riddle','FUN',{...G,description:'Devinette',proxy:'@TheNexGame_bot'}),
  C('quiz','FUN',{...G,description:'Quiz',proxy:'@TheNexGame_bot'}),
  C('tictactoe','FUN',{...G,description:'Morpion',proxy:'@TheNexGame_bot'}),

  // SEARCH / ANIME.
  C('weather','SEARCH',{description:'Météo'}),
  C('define','SEARCH',{description:'Définition'}),
  C('imdb','SEARCH',{description:'Film ou série'}),
  C('gsmarena','SEARCH',{description:'Recherche téléphone'}),
  C('animeinfo','ANIME',{description:'Informations anime'}),
  C('waifu','ANIME',{description:'Image anime aléatoire'}),

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
  accueil:'welcome',inscription:'setwelcome',motsadieu:'setgoodbye',
  sentence:'warn',silence:'mutechat',parole:'unmutechat',
  purification:'clean',debannissement:'unban',bannir:'ban',
  aveu:'truth',epreuve:'dare',bouffon:'joke',charme:'compliment',
  premiumemoji:'emoji_status'
};

// Explicitly discarded legacy commands: dangerous server controls, WhatsApp-only
// leftovers, placeholders, duplicates or commands that only pretended to work.
export const REMOVED_COMMANDS=new Set([
  'execute','runeval','darkfile','save','crash','mise_a_jour','renaissance','reload',
  'tostatus','tovv','antiwalink','antistatusmention','rejet_appels','autorecording',
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

  // Add only explicitly approved aliases. Dipper's historical 686 aliases are
  // no longer imported wholesale.
  for(const [alias,target] of Object.entries(LEGACY_ALIASES)){
    const a=normalize(alias),t=normalize(target);
    if(!a||!t||REMOVED_COMMANDS.has(a)||map.has(a))continue;
    const canonical=map.get(t);
    if(!canonical)continue;
    map.set(a,{...canonical,name:a,aliasFor:t,hidden:true});
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
