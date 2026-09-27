const clean = value => String(value ?? '').trim();

export const NEXAI_TELEGRAM_PROFILE = Object.freeze({
  name: 'NexAI',
  username: '@NexAi01_bot',
  telegramUrl: 'https://t.me/NexAi01_bot',
  connectUrl: 'https://nex-telegrambots.vercel.app/',
  owner: 'Trésor HONTONNOU',
  product: 'Nextech',
  kind: 'assistant Telegram multi-session',
  registry: 'Le runtime Telegram utilise un registre fusionné de centaines de commandes et valide au moins 500 tokens de commande uniques.',
  styles: 31
});

export const NEXAI_TELEGRAM_CATEGORIES = Object.freeze([
  {
    key: 'GENERAL',
    fr: 'général et interface',
    en: 'general and interface',
    examples: ['/Menu', '/Help', '/Ping', '/Alive', '/Creator', '/Style']
  },
  {
    key: 'ACCOUNT',
    fr: 'compte, sessions et réglages',
    en: 'account, sessions and settings',
    examples: ['/Pair', '/Sessions', '/Dashboard', '/Settings', '/Mode', '/Language', '/AutoReact', '/AutoReply', '/AiMode']
  },
  {
    key: 'AI',
    fr: 'IA et programmation',
    en: 'AI and coding',
    examples: ['/Ai', '/Code', '/Deepseek']
  },
  {
    key: 'DOWNLOAD',
    fr: 'téléchargement et médias',
    en: 'downloads and media',
    examples: ['/Song', '/Video', '/Download', '/TikTok', '/Instagram', '/Facebook', '/Shazam', '/Lyrics', '/Apk']
  },
  {
    key: 'GROUP',
    fr: 'groupes, administration et modération',
    en: 'groups, administration and moderation',
    examples: ['/Tag', '/Hidetag', '/Tagall', '/Promote', '/Demote', '/Kick', '/Ban', '/Open', '/Close']
  },
  {
    key: 'PROTECTION',
    fr: 'protection des groupes',
    en: 'group protection',
    examples: ['/Antilink', '/Antispam', '/Antiraid', '/Captcha', '/Blacklist', '/Whitelist']
  },
  {
    key: 'TOOLS',
    fr: 'outils pratiques',
    en: 'utility tools',
    examples: ['/Translate', '/Tts', '/Qr', '/Tinyurl', '/Texttopdf', '/Calc', '/Browse', '/Ssweb']
  },
  {
    key: 'MEDIA',
    fr: 'traitement de médias',
    en: 'media processing',
    examples: ['/Tourl', '/Crop', '/Resize', '/Analyzesound', '/Vv']
  },
  {
    key: 'STICKERS',
    fr: 'stickers',
    en: 'stickers',
    examples: ['/Sticker', '/Stickerinfo', '/Clonepack', '/Createpack', '/Mypacks', '/Exportwhatsapp']
  },
  {
    key: 'FUN',
    fr: 'jeux et divertissement',
    en: 'fun and games',
    examples: ['/Truth', '/Dare', '/Joke', '/Riddle', '/Quiz', '/Tictactoe']
  },
  {
    key: 'SEARCH',
    fr: 'recherche et informations',
    en: 'search and information',
    examples: ['/Weather', '/Define', '/Imdb', '/Gsmarena']
  },
  {
    key: 'ANIME',
    fr: 'anime et manga',
    en: 'anime and manga',
    examples: ['/Animeinfo', '/Anisearch', '/Manga', '/Character', '/Airing', '/Season', '/Episode', '/Recommendanime']
  },
  {
    key: 'PREMIUM',
    fr: 'fonctions Telegram Premium',
    en: 'Telegram Premium features',
    examples: ['/Customreact', '/Emoji_status', '/Effect']
  }
]);

function categoryList(language) {
  const fr = language === 'fr';
  return NEXAI_TELEGRAM_CATEGORIES
    .map(category => {
      const label = fr ? category.fr : category.en;
      return label + ' : ' + category.examples.join(', ');
    })
    .join('\n');
}

function hasTelegramSignal(text) {
  return /(?:telegram|nexai01|nex\s*ai\s*(?:sur|on)?\s*telegram|multisession|multi[- ]?session|compte\s+telegram|telegram\s+account|mini\s*app|pairing)/i.test(text);
}

function hasNexAiSignal(text) {
  return /(?:\bnex\s*ai\b|\bnexai\b|@nexai01_bot)/i.test(text);
}

export function isNexAiTelegramIntent(text) {
  const value = clean(text);
  return hasTelegramSignal(value) && (hasNexAiSignal(value) || /(?:bot|assistant|commande|command|pair|connect|session)/i.test(value));
}

function isLinkIntent(text) {
  return /(?:lien|link|url|ouvrir|open|username|utilisateur|pseudo|handle|où\s+le\s+trouver|where\s+(?:is|can))/i.test(text);
}

function isPairIntent(text) {
  return /(?:\/?pair\b|pairing|connecter|connexion|lier\s+(?:mon|un)\s+compte|connect\s+(?:my|a)\s+(?:telegram\s+)?account|qr\b|code\s+de\s+connexion)/i.test(text);
}

function isCommandIntent(text) {
  return /(?:commandes?|commands?|menu|fonctionnalit[ée]s?|features?|que\s+peut|what\s+can|fait\s+quoi|does\s+what)/i.test(text);
}

function isSyntaxIntent(text) {
  return /(?:pr[ée]fixe|prefix|sans\s+pr[ée]fixe|no\s+prefix|slash|cliquable|clickable|comment\s+(?:utiliser|taper)|how\s+to\s+use)/i.test(text);
}

function isStyleIntent(text) {
  return /(?:style|menu|emoji|emojis|anim[ée]|animated|artwork|illustration|header)/i.test(text);
}

function isDifferenceIntent(text) {
  return /(?:facebook.*telegram|telegram.*facebook|messenger.*telegram|telegram.*messenger|m[êe]me\s+bot|same\s+bot|diff[ée]rence|difference)/i.test(text);
}

export function telegramNexAiAnswer(text, language = 'fr') {
  const value = clean(text);
  if (!isNexAiTelegramIntent(value)) return '';

  const fr = language === 'fr';

  if (isDifferenceIntent(value)) {
    return fr
      ? 'Le NexAI de Facebook et NexAI Telegram partagent la même identité Nextech et la même connaissance produit, mais ce sont deux surfaces différentes. Les fonctions propres à Telegram — connexion multi-session, commandes Telegram, emojis personnalisés, actions de groupe et Mini App /Pair — restent exécutées sur Telegram ; sur Facebook, je peux les expliquer et te diriger vers @NexAi01_bot sans prétendre les avoir exécutées ici.'
      : 'Facebook NexAI and Telegram NexAI share the same Nextech identity and product knowledge, but they are different delivery surfaces. Telegram-only capabilities — multi-session account connection, Telegram commands, custom emoji, group actions, and the /Pair Mini App — execute on Telegram; on Facebook I can explain them and point you to @NexAi01_bot without claiming they ran here.';
  }

  if (isPairIntent(value)) {
    return fr
      ? 'Pour connecter un compte à NexAI Telegram, ouvre @NexAi01_bot puis utilise /Pair. NexAI ouvre NexAI Connect dans une Mini App avec les instructions de connexion (téléphone/QR selon le parcours disponible). Le bot ne doit pas demander de coller un code Telegram sensible dans une conversation ordinaire si la Mini App est disponible.'
      : 'To connect an account to Telegram NexAI, open @NexAi01_bot and use /Pair. NexAI opens NexAI Connect as a Mini App with the connection flow (phone/QR depending on the available path). The bot should not ask users to paste a sensitive Telegram login code into a normal chat when the Mini App flow is available.';
  }

  if (isLinkIntent(value) && !isCommandIntent(value)) {
    return fr
      ? 'NexAI Telegram : @NexAi01_bot — https://t.me/NexAi01_bot. La Mini App NexAI Connect utilisée par /Pair est https://nex-telegrambots.vercel.app/.'
      : 'Telegram NexAI: @NexAi01_bot — https://t.me/NexAi01_bot. The NexAI Connect Mini App used by /Pair is https://nex-telegrambots.vercel.app/.';
  }

  if (isSyntaxIntent(value)) {
    return fr
      ? 'Dans l’interface officielle, les commandes sont affichées comme de vraies commandes Telegram cliquables avec un slash, par exemple /Ping, /Menu ou /Download. Le runtime multi-session sait aussi reconnaître les commandes connues sans préfixe quand ce mode est actif, tout en conservant le préfixe configurable du compte connecté.'
      : 'In the official UI, commands are displayed as real clickable Telegram commands with a slash, such as /Ping, /Menu, or /Download. The multi-session runtime can also recognize known commands without a prefix when that mode is active, while preserving the connected account’s configurable prefix.';
  }

  if (isStyleIntent(value) && !isCommandIntent(value)) {
    return fr
      ? 'NexAI Telegram possède 31 styles de menu. Il utilise l’illustration NexAI dans les réponses de menu et privilégie les emojis Telegram personnalisés/animés quand le compte et Telegram les permettent, avec un fallback en emoji normal pour que l’interface reste lisible.'
      : 'Telegram NexAI has 31 menu styles. It uses NexAI artwork in menu replies and prefers Telegram custom/animated emoji when the account and Telegram support them, with normal-emoji fallback so the interface remains readable.';
  }

  if (isCommandIntent(value)) {
    return (fr
      ? 'NexAI Telegram est un assistant multi-session avec un registre fusionné de centaines de commandes (le runtime valide au moins 500 tokens uniques). Les grandes catégories sont :\n'
      : 'Telegram NexAI is a multi-session assistant with a fused registry containing hundreds of commands (the runtime validates at least 500 unique command tokens). Main categories are:\n'
    ) + categoryList(language);
  }

  return fr
    ? 'NexAI Telegram est l’assistant multi-session officiel de Nextech sur @NexAi01_bot. Il peut connecter des comptes Telegram via /Pair, fournir IA et code, téléchargements, outils média, stickers, recherche, anime/manga, jeux, administration/protection de groupes et réglages automatiques du compte connecté. Les fonctions Telegram restent exécutées sur Telegram ; le bot Facebook les connaît et peut les expliquer sans prétendre les exécuter sur Messenger.'
    : 'Telegram NexAI is Nextech’s official multi-session assistant at @NexAi01_bot. It can connect Telegram accounts through /Pair, provide AI and coding, downloads, media tools, stickers, search, anime/manga, games, group administration/protection, and connected-account automation settings. Telegram-specific functions execute on Telegram; Facebook NexAI knows and can explain them without pretending they ran on Messenger.';
}

export function telegramNexAiSystemContext(language = 'fr') {
  const fr = language === 'fr';
  const categories = categoryList(language);

  if (fr) {
    return [
      'CONNAISSANCE CANONIQUE DE NEXAI TELEGRAM :',
      '- NexAI Telegram est l’assistant officiel multi-session de Nextech : @NexAi01_bot (https://t.me/NexAi01_bot).',
      '- /Pair ouvre le parcours NexAI Connect dans la Mini App https://nex-telegrambots.vercel.app/ ; privilégier ce parcours pour la connexion du compte.',
      '- Le runtime Telegram fusionne des centaines de commandes et sa validation impose au moins 500 tokens de commande uniques.',
      '- Le menu officiel affiche les commandes avec un slash cliquable, par exemple /Ping. Le runtime connecté peut aussi reconnaître les commandes connues sans préfixe quand le mode correspondant est actif ; le préfixe reste configurable.',
      '- Le menu possède 31 styles. Les emojis Telegram personnalisés/animés sont utilisés quand disponibles, avec fallback en emojis normaux. L’illustration NexAI accompagne les réponses de menu.',
      '- /Hidetag est une utilité de groupe et ne doit pas être présentée comme exigeant que l’utilisateur soit administrateur. Les actions réellement administratives comme /Promote, /Demote, /Kick ou les réglages de protection peuvent exiger les droits nécessaires.',
      '- /Code doit être interprété comme une demande de générer/écrire le code demandé, pas comme une calculatrice ni comme une question sur la valeur à calculer.',
      '- Le bot est multi-session : les réglages et capacités peuvent s’appliquer au compte Telegram connecté (mode, langue, préfixe, réactions auto, réponse auto, mode IA, présence, saisie, style/menu).',
      '- N’affirme jamais qu’une action Telegram a été exécutée depuis Facebook si aucun adaptateur Telegram n’a confirmé l’action. Explique la fonction, donne la commande et le lien Telegram si nécessaire.',
      '- Ne révèle jamais de session StringSession, token BotFather, code de connexion, mot de passe 2FA, clé API, secret OAuth ou autre secret.',
      'CATÉGORIES TELEGRAM :',
      categories
    ].join('\n');
  }

  return [
    'CANONICAL TELEGRAM NEXAI KNOWLEDGE:',
    '- Telegram NexAI is Nextech’s official multi-session assistant: @NexAi01_bot (https://t.me/NexAi01_bot).',
    '- /Pair opens NexAI Connect in the Mini App at https://nex-telegrambots.vercel.app/; prefer that account-connection flow.',
    '- The Telegram runtime fuses hundreds of commands and validation requires at least 500 unique command tokens.',
    '- The official menu displays clickable slash commands such as /Ping. Connected runtimes may also recognize known commands without a prefix when that mode is active; the prefix remains configurable.',
    '- The menu has 31 styles. Telegram custom/animated emoji are used when available with normal-emoji fallback, and NexAI artwork accompanies menu replies.',
    '- /Hidetag is a group utility and should not be described as requiring the user to be an admin. Truly administrative actions such as /Promote, /Demote, /Kick, or protection configuration may require appropriate rights.',
    '- /Code means generate/write the requested implementation; do not reinterpret it as a calculator prompt.',
    '- NexAI is multi-session: settings and automation can apply to the connected Telegram account (mode, language, prefix, auto reactions, auto reply, AI mode, presence, typing, style/menu).',
    '- Never claim a Telegram action ran from Facebook unless a Telegram adapter returned a confirmed success receipt. Explain the function, command, and Telegram link instead.',
    '- Never expose StringSession values, BotFather tokens, login codes, 2FA passwords, API keys, OAuth secrets, or other secrets.',
    'TELEGRAM CATEGORIES:',
    categories
  ].join('\n');
}
