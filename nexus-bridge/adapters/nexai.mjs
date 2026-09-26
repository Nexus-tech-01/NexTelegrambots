import {
  eventText,
  externalUserId,
  languageOf,
  stripCommand
} from './_shared.mjs';

const clean = value => String(value ?? '').trim();

const configuredUrl = clean(
  process.env.NEXAI_API_URL ||
  process.env.STACY__OPENAI_COMPATIBLE_URL ||
  process.env.STACY_OPENAI_COMPATIBLE_URL
);

const configuredKey = clean(
  process.env.NEXAI_API_KEY ||
  process.env.STACY__OPENAI_COMPATIBLE_KEY ||
  process.env.STACY_OPENAI_COMPATIBLE_KEY ||
  process.env.STACY__GROQ_API_KEY ||
  process.env.GROQ_API_KEY
);

const configuredModel = clean(
  process.env.NEXAI_MODEL ||
  process.env.STACY__OPENAI_COMPATIBLE_MODEL ||
  process.env.STACY_OPENAI_COMPATIBLE_MODEL ||
  process.env.STACY__GROQ_MODEL
);

const apiUrl = configuredUrl || (
  configuredKey && (
    process.env.GROQ_API_KEY === configuredKey ||
    process.env.STACY__GROQ_API_KEY === configuredKey
  )
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : ''
);

const model = configuredModel;
const providerReady = Boolean(apiUrl && model);
const history = new Map();
const HISTORY_TTL_MS = 20 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 6;

export const adapterManifest = Object.freeze({
  version: '1.0.0',
  mode: 'openai-compatible',
  productionReady: providerReady,
  capabilities: [
    'facebook_conversation',
    'bounded_conversation_history',
    'provider_timeout',
    'provider_rate_limit_propagation'
  ],
  missing: [
    ...(!apiUrl ? ['NEXAI_API_URL'] : []),
    ...(!model ? ['NEXAI_MODEL'] : [])
  ]
});

function sessionKey(envelope) {
  return [
    envelope?.source?.pageId || 'no-page',
    externalUserId(envelope) || 'anonymous'
  ].join(':');
}

function sweepHistory(now = Date.now()) {
  for (const [key, row] of history) {
    if (now - row.touchedAt > HISTORY_TTL_MS) history.delete(key);
  }
}

function readHistory(envelope) {
  sweepHistory();
  return history.get(sessionKey(envelope))?.messages || [];
}

function writeHistory(envelope, messages) {
  history.set(sessionKey(envelope), {
    touchedAt: Date.now(),
    messages: messages.slice(-MAX_HISTORY_MESSAGES)
  });
}

function resetHistory(envelope) {
  history.delete(sessionKey(envelope));
}

function commandPrompt(text) {
  const value = clean(text);
  if (/^\/stacy\b/i.test(value)) {
    return stripCommand(value).join(' ').trim();
  }
  if (!/^\/?(?:ai|ask|nexai)\b/i.test(value)) return value;
  return stripCommand(value).join(' ').trim();
}

const OWNER_NAME = 'Trésor HONTONNOU';
const OWNER_ALIAS = '⏤͟͟͞͞𝄞ᬼ⃟ 𝐌ꝛ⥔𝕿𝖗𝖊𝖘𝖔𝖗✧ ⃞';

const PUBLIC_PRODUCTS = [
  {
    key: 'nexcanal',
    name: 'NexCanal Manager',
    aliases: ['nexcanal', 'nex canal', 'the_big_dipper_bot'],
    url: 'https://t.me/the_big_dipper_bot',
    fr: 'gérer des chaînes Telegram, préparer et programmer des publications, organiser un calendrier éditorial et automatiser la diffusion',
    en: 'manage Telegram channels, prepare and schedule posts, organize an editorial calendar, and automate publishing'
  },
  {
    key: 'nexgroup',
    name: 'NexGroup Manager',
    aliases: ['nexgroup', 'nex group', 'darknexus01_bot'],
    url: 'https://t.me/DarkNexus01_bot',
    fr: 'protéger et administrer des groupes Telegram avec modération, anti-spam, captcha, protections et automatisations',
    en: 'protect and administer Telegram groups with moderation, anti-spam, captcha, protections, and automation'
  },
  {
    key: 'nexdownloader',
    name: 'NexDownloader',
    aliases: ['nexdownloader', 'nex downloader', 'thenexdownloader_bot'],
    url: 'https://t.me/TheNexDownloader_bot',
    fr: 'télécharger et traiter des médias compatibles, rechercher ou reconnaître de la musique, convertir, compresser et découper des fichiers',
    en: 'download and process supported media, search or identify music, and convert, compress, or trim files'
  },
  {
    key: 'nexgame',
    name: 'NexGame',
    aliases: ['nexgame', 'nex game', 'thenexgame_bot'],
    url: 'https://t.me/TheNexGame_bot',
    fr: 'jouer à des jeux, quiz, défis, duels et expériences interactives sur Telegram',
    en: 'play games, quizzes, challenges, duels, and interactive experiences on Telegram'
  },
  {
    key: 'nexstick',
    name: 'NexStick',
    aliases: ['nexstick', 'nex stick', 'the_nexus_techbot'],
    url: 'https://t.me/The_Nexus_techbot',
    fr: 'créer et cloner des packs de stickers et les exporter, notamment vers WhatsApp',
    en: 'create and clone sticker packs and export them, including to WhatsApp'
  },
  {
    key: 'nexwhisper',
    name: 'NexWhisper',
    aliases: ['nexwhisper', 'nex whisper', 'nexwhisperbot'],
    url: 'https://t.me/NexWhisperBot',
    fr: 'envoyer des messages discrets avec options de confidentialité, anonymat, lecture unique et expiration',
    en: 'send discreet messages with privacy, anonymity, one-view, and expiration options'
  },
  {
    key: 'stacy',
    name: 'Stacy',
    aliases: ['stacy', 'stacytg_bot'],
    url: 'https://t.me/Stacytg_bot',
    fr: 'discuter avec une assistante IA sociale et conversationnelle avec mémoire privée, jeux et interactions naturelles',
    en: 'chat with a social conversational AI assistant with private memory, games, and natural interactions'
  }
];

const INTERNAL_OR_UNFINISHED = [
  'nexcontrol',
  'nex control',
  'knowme',
  'know me',
  'nexplayer',
  'nex player'
];

const PUBLIC_PLANS = {
  nexcanal: {
    fr: [
      'Free — 1 canal.',
      'Premium — 750 Telegram Stars / 30 jours : jusqu’à 10 canaux, file éditoriale, campagnes, séries et statistiques.',
      'Business — 1 500 Telegram Stars / 30 jours : jusqu’à 50 canaux, avec notamment collaborateurs, validations et inbox.',
      'Agency — 3 500 Telegram Stars / 30 jours : jusqu’à 200 canaux.'
    ],
    en: [
      'Free — 1 channel.',
      'Premium — 750 Telegram Stars / 30 days: up to 10 channels, editorial queue, campaigns, series, and statistics.',
      'Business — 1,500 Telegram Stars / 30 days: up to 50 channels, including collaborators, approvals, and inbox.',
      'Agency — 3,500 Telegram Stars / 30 days: up to 200 channels.'
    ]
  },
  nexgroup: {
    fr: [
      'Free — 2 groupes, modération essentielle, anti-spam/liens de base et captcha simple.',
      'Premium — 299 Telegram Stars / 30 jours : jusqu’à 10 groupes, protections anti-spam/liens/captcha avancées, anti-raid, topics, automatisations, XP/réputation, statistiques avancées et sauvegardes.',
      'Pro — 799 Telegram Stars / 30 jours : tout Premium, sans limite de groupes imposée par le produit, plus dashboard réseau/sécurité/analytics et limites opérationnelles supérieures.'
    ],
    en: [
      'Free — 2 groups, essential moderation, basic anti-spam/link protection, and simple captcha.',
      'Premium — 299 Telegram Stars / 30 days: up to 10 groups, advanced anti-spam/link/captcha, anti-raid, topics, automation, XP/reputation, advanced statistics, and backups.',
      'Pro — 799 Telegram Stars / 30 days: everything in Premium, no product group limit, plus network/security/analytics dashboard and higher operational limits.'
    ]
  },
  nexdownloader: {
    fr: [
      'Free — accès de base avec quotas et limites.',
      'Plus — 200 Telegram Stars / 30 jours.',
      'Pro — 450 Telegram Stars / 30 jours.',
      'Les plans payants augmentent les quotas et limites ; le téléchargement multi-liens/batch nécessite Plus ou Pro. Les plafonds exacts dépendent de la fonction demandée.'
    ],
    en: [
      'Free — basic access with quotas and limits.',
      'Plus — 200 Telegram Stars / 30 days.',
      'Pro — 450 Telegram Stars / 30 days.',
      'Paid plans raise quotas and limits; multi-link/batch downloads require Plus or Pro. Exact limits depend on the requested feature.'
    ]
  },
  nexgame: {
    fr: [
      'Premium 1 mois — 99 Telegram Stars / 30 jours.',
      'Premium 3 mois — 249 Telegram Stars / 90 jours.',
      'Premium 12 mois — 799 Telegram Stars / 365 jours.'
    ],
    en: [
      'Premium 1 month — 99 Telegram Stars / 30 days.',
      'Premium 3 months — 249 Telegram Stars / 90 days.',
      'Premium 12 months — 799 Telegram Stars / 365 days.'
    ]
  },
  nexstick: {
    fr: [
      'Free — 2 clonages par semaine et jusqu’à 14 exports WhatsApp par semaine.',
      'Premium — 100 Telegram Stars / 30 jours : clonage de packs illimité et exports WhatsApp illimités.'
    ],
    en: [
      'Free — 2 clones per week and up to 14 WhatsApp exports per week.',
      'Premium — 100 Telegram Stars / 30 days: unlimited pack cloning and unlimited WhatsApp exports.'
    ]
  },
  nexwhisper: {
    fr: [
      'Pro — 25 Telegram Stars / 30 jours : quotas plus élevés, jusqu’à 25 destinataires, expiration jusqu’à 30 jours, davantage d’options anonymes et one-view, ainsi que des options avancées dont la programmation.'
    ],
    en: [
      'Pro — 25 Telegram Stars / 30 days: higher quotas, up to 25 recipients, expiration up to 30 days, more anonymous and one-view options, plus advanced options including scheduling.'
    ]
  },
  stacy: {
    fr: [
      'Stacy n’a pas de plan Premium public.',
      'Elle accepte uniquement des cadeaux Telegram Stars facultatifs : 5, 10, 25, 50 ou 100 Stars. Ces cadeaux n’accordent aucun avantage caché et ne doivent jamais être présentés comme nécessaires.'
    ],
    en: [
      'Stacy has no public Premium plan.',
      'She only accepts optional Telegram Stars gifts: 5, 10, 25, 50, or 100 Stars. Gifts provide no hidden benefit and must never be presented as required.'
    ]
  }
};

const PUBLIC_GUIDES = {
  nexcanal: {
    fr: {
      what: 'gestion et automatisation de canaux Telegram',
      how: 'Tu ouvres NexCanal, relies ou choisis un canal que tu administres, prépares le contenu puis tu peux le publier immédiatement ou le programmer. Le bot centralise ensuite les publications, brouillons, files éditoriales, campagnes, séries et statistiques selon le plan.',
      features: 'composition et prévisualisation de publications, brouillons, programmation, calendrier/file éditoriale, multi-canal, campagnes, séries, statistiques, automatisation de diffusion et gestion de publications enrichies'
    },
    en: {
      what: 'Telegram channel management and publishing automation',
      how: 'Open NexCanal, connect or choose a channel you administer, prepare the content, then publish immediately or schedule it. The bot centralizes posts, drafts, editorial queues, campaigns, series, and statistics depending on the plan.',
      features: 'post composition and preview, drafts, scheduling, editorial queue, multi-channel management, campaigns, series, statistics, publishing automation, and rich posts'
    }
  },
  nexgroup: {
    fr: {
      what: 'administration, modération et protection de groupes Telegram',
      how: 'Tu ajoutes NexGroup au groupe, lui donnes les droits nécessaires, puis tu règles les protections et outils depuis le bot. Il applique ensuite les règles dans le groupe et fournit les commandes de modération et d’administration aux personnes autorisées.',
      features: 'modération, anti-spam, anti-liens, captcha, anti-raid, approbation, commandes admin, gestion de membres, topics, automatisations, XP/réputation, statistiques et sauvegardes selon le plan'
    },
    en: {
      what: 'Telegram group administration, moderation, and protection',
      how: 'Add NexGroup to the group, grant the required permissions, then configure protections and tools from the bot. It enforces the rules in the group and exposes moderation and administration commands to authorized users.',
      features: 'moderation, anti-spam, anti-link, captcha, anti-raid, approvals, admin commands, member management, topics, automation, XP/reputation, statistics, and backups depending on the plan'
    }
  },
  nexdownloader: {
    fr: {
      what: 'téléchargement et traitement de médias',
      how: 'Tu lui envoies un lien compatible ou une recherche musicale. NexDownloader récupère le média, te propose ou applique le traitement demandé puis renvoie le fichier ou le résultat dans Telegram.',
      features: 'téléchargement de médias compatibles, recherche de musique, reconnaissance musicale, extraction audio, conversion, compression, découpage et téléchargement multi-liens selon le plan'
    },
    en: {
      what: 'media downloading and processing',
      how: 'Send a supported link or a music search. NexDownloader retrieves the media, applies or offers the requested processing, then returns the file or result in Telegram.',
      features: 'supported media downloads, music search, music recognition, audio extraction, conversion, compression, trimming, and multi-link downloads depending on the plan'
    }
  },
  nexgame: {
    fr: {
      what: 'jeux et défis interactifs dans Telegram',
      how: 'Tu démarres NexGame, choisis un jeu ou un mode, puis tu joues directement avec les boutons et messages du bot. Selon le jeu, tu peux jouer seul, en duel ou avec plusieurs personnes et suivre ta progression.',
      features: 'quiz, devinettes, défis, jeux rapides, modes solo, 1v1 et multijoueur, compétitions, progression, profil et statistiques de jeu'
    },
    en: {
      what: 'interactive games and challenges inside Telegram',
      how: 'Start NexGame, choose a game or mode, then play directly through the bot buttons and messages. Depending on the game, you can play solo, in a duel, or with multiple people and track your progress.',
      features: 'quizzes, riddles, challenges, quick games, solo, 1v1 and multiplayer modes, competitions, progression, profile, and game statistics'
    }
  },
  nexstick: {
    fr: {
      what: 'création, clonage et export de stickers',
      how: 'Tu envoies un sticker, un pack ou le contenu que tu veux transformer, puis NexStick crée ou clone le pack et permet de l’exporter dans les formats pris en charge, notamment vers WhatsApp.',
      features: 'création de packs, clonage de packs, récupération et organisation de stickers, export WhatsApp et gestion de quotas Free/Premium'
    },
    en: {
      what: 'sticker creation, cloning, and export',
      how: 'Send a sticker, a pack, or content you want to transform. NexStick creates or clones the pack and lets you export it to supported formats, including WhatsApp.',
      features: 'pack creation, pack cloning, sticker retrieval and organization, WhatsApp export, and Free/Premium quota management'
    }
  },
  nexwhisper: {
    fr: {
      what: 'messages privés et discrets avec contrôle de confidentialité',
      how: 'Tu choisis le destinataire et écris ton Whisper, puis tu règles les options disponibles avant l’envoi. Le destinataire ouvre le message via NexWhisper avec les règles choisies.',
      features: 'messages anonymes ou identifiés selon le mode, lecture unique, expiration, confidentialité, plusieurs destinataires et programmation selon le plan'
    },
    en: {
      what: 'private and discreet messages with privacy controls',
      how: 'Choose the recipient and write your Whisper, then set the available options before sending. The recipient opens the message through NexWhisper under the selected rules.',
      features: 'anonymous or identified messages depending on mode, one-view, expiration, privacy controls, multiple recipients, and scheduling depending on the plan'
    }
  },
  stacy: {
    fr: {
      what: 'assistante IA sociale et conversationnelle',
      how: 'Tu lui écris simplement comme à une personne. Stacy répond de façon conversationnelle, garde le contexte et peut utiliser ses fonctions sociales, de mémoire et de jeu selon la conversation.',
      features: 'conversation naturelle, mémoire privée, interactions sociales, jeux et réponses contextuelles. Stacy n’a pas de plan Premium public'
    },
    en: {
      what: 'social and conversational AI assistant',
      how: 'Simply message her as you would a person. Stacy replies conversationally, keeps context, and can use her social, memory, and game features as the conversation requires.',
      features: 'natural conversation, private memory, social interactions, games, and contextual replies. Stacy has no public Premium plan'
    }
  }
};

function ownerSentence(language) {
  return language === 'fr'
    ? 'Le créateur et propriétaire de Nextech est ' + OWNER_NAME + ', plus connu sous le pseudonyme de ' + OWNER_ALIAS + '.'
    : 'Nextech was created and is owned by ' + OWNER_NAME + ', better known by the pseudonym ' + OWNER_ALIAS + '.';
}

function productFromText(text) {
  const value = clean(text).toLowerCase();
  return PUBLIC_PRODUCTS.find(product =>
    product.aliases.some(alias => value.includes(alias))
  ) || null;
}

function plainMessengerAnswer(value) {
  return String(value || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function socialReply(text, language) {
  const raw = clean(text)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!raw) return '';

  if (language === 'fr') {
    const howAreYou =
      /^(?:(?:ok|d'accord|daccord|dac)\s+)?(?:(?:sinon|non genre)\s+)?(?:(?:est ce que|es ce que)\s+)?(?:cv|ca va|ça va|sa va|tu vas bien|vous allez bien|comment tu vas|comment allez vous)$/i;
    if (howAreYou.test(raw)) {
      return /vous|allez vous/.test(raw)
        ? 'Oui, ça va bien 😄 Et vous ?'
        : 'Oui, ça va bien 😄 Et toi ?';
    }

    if (/^(?:oui\s+)?(?:ca va|ça va|sa va|cv|je vais bien|tranquille|ça roule|ca roule)(?:\s+(?:bien|merci))?$/i.test(raw)) {
      return 'Nickel 😄';
    }

    if (/^(?:salut|slt|coucou|cc|hey|hello|yo|wesh|wsh|bonjour|bonsoir)$/i.test(raw)) {
      return /bonjour|bonsoir/.test(raw)
        ? 'Salut 😄 Ça va ?'
        : 'Hey 😄 Ça va ?';
    }

    if (/^(?:merci|mercii+|merci beaucoup|thx|thanks)$/i.test(raw)) {
      return 'Avec plaisir 😄';
    }

    if (/^(?:ok|okay|d'accord|daccord|dac|ça marche|ca marche)$/i.test(raw)) {
      return 'Ça marche 👌';
    }

    if (/^(?:mdr+|lol+|ptdr+)$/i.test(raw)) {
      return '😂';
    }
  } else {
    if (/^(?:(?:ok|okay)\s+)?(?:(?:so|anyway)\s+)?(?:how are you|you good|u good|wyd how are you)$/i.test(raw)) {
      return "I'm good 😄 How about you?";
    }

    if (/^(?:hi|hey|hello|yo|sup)$/i.test(raw)) {
      return 'Hey 😄 How are you?';
    }

    if (/^(?:thanks|thank you|thx)$/i.test(raw)) {
      return 'Anytime 😄';
    }

    if (/^(?:ok|okay|got it|cool)$/i.test(raw)) {
      return 'Got it 👌';
    }

    if (/^(?:lol+|lmao+)$/i.test(raw)) {
      return '😂';
    }
  }

  return '';
}

const PLAN_INTENT_RE =
  /(?:premium|pro\b|plus\b|business|agency|payant|payante|prix|tarif|co[uû]t|combien|stars?|abonnement|subscription|pricing|price|paid|cost|plans?)/i;

const PLAN_DETAIL_RE =
  /(?:d[ée]tail|avantages?|fonctions?|fonctionnalit[ée]s?|features?|inclut|compris|obtiens?|compare|comparaison|diff[ée]rence|limites?|quotas?)/i;

function isPlanIntent(text) {
  return PLAN_INTENT_RE.test(clean(text));
}

function isPlanDetailIntent(text) {
  return PLAN_DETAIL_RE.test(clean(text));
}

function recentPlanContext(messages = []) {
  return messages
    .slice(-4)
    .some(message => isPlanIntent(message?.content || ''));
}

function asksAboutNonPublic(text) {
  const value = clean(text).toLowerCase();
  return INTERNAL_OR_UNFINISHED.some(name => value.includes(name));
}

function nonPublicReply(language) {
  return language === 'fr'
    ? 'Ce projet ne fait pas partie du catalogue public actuellement disponible. Si tu me dis ce que tu cherches à faire, je peux te proposer un produit Nextech public adapté.'
    : 'That project is not part of the currently available public catalog. Tell me what you want to do and I can suggest a suitable public Nextech product.';
}

function productsSentence(language) {
  const fr = language === 'fr';
  const intro = fr
    ? 'Nextech propose 7 bots publics :'
    : 'Nextech has 7 public bots:';

  const rows = PUBLIC_PRODUCTS.map((product, index) => {
    const guide = PUBLIC_GUIDES[product.key]?.[fr ? 'fr' : 'en'];
    const role = guide?.what || product[fr ? 'fr' : 'en'];
    const linkLabel = fr ? 'Lien' : 'Link';

    return [
      String(index + 1) + '. ' + product.name + ' — ' + role + '.',
      linkLabel + ' : ' + product.url
    ].join('\n');
  });

  return [intro, ...rows].join('\n\n');
}

function productGuideSentence(product, language) {
  if (!product) return '';

  const fr = language === 'fr';
  const guide = PUBLIC_GUIDES[product.key]?.[fr ? 'fr' : 'en'];
  if (!guide) return '';

  return [
    product.name,
    (fr ? 'Rôle : ' : 'Role: ') + guide.what + '.',
    (fr ? 'Fonctionnement : ' : 'How it works: ') + guide.how,
    (fr ? 'Fonctions principales : ' : 'Main features: ') + guide.features + '.',
    (fr ? 'Lien : ' : 'Link: ') + product.url
  ].join('\n');
}

const PRODUCT_GUIDE_INTENT_RE =
  /(?:comment\s+(?:ça|ca|il|elle|le\s+bot)?\s*(?:marche|fonctionne)|fonctionnement|fonctionnalit[ée]s?|fonctions?|que\s+(?:fait|permet)|sert\s+[àa]\s+quoi|utiliser|usage|comment\s+l['’]utiliser|how\s+(?:does|to\s+use)|what\s+(?:does|can)|features?)/i;

function isProductGuideIntent(text) {
  return PRODUCT_GUIDE_INTENT_RE.test(clean(text));
}

function planSentence(product, language, { detailed = false } = {}) {
  if (!product) {
    return language === 'fr'
      ? 'Quel bot ? NexCanal, NexGroup, NexDownloader, NexGame, NexStick, NexWhisper ou Stacy.'
      : 'Which bot? NexCanal, NexGroup, NexDownloader, NexGame, NexStick, NexWhisper, or Stacy.';
  }

  if (!detailed) {
    const compact = {
      nexcanal: {
        fr: 'NexCanal Manager : Premium 750 Stars/30 jours, Business 1 500, Agency 3 500. Free : 1 canal.',
        en: 'NexCanal Manager: Premium 750 Stars/30 days, Business 1,500, Agency 3,500. Free: 1 channel.'
      },
      nexgroup: {
        fr: 'NexGroup Manager : Premium 299 Stars/30 jours, Pro 799. Free : jusqu’à 2 groupes.',
        en: 'NexGroup Manager: Premium 299 Stars/30 days, Pro 799. Free: up to 2 groups.'
      },
      nexdownloader: {
        fr: 'NexDownloader : Plus 200 Stars/30 jours, Pro 450. Une version Free est disponible.',
        en: 'NexDownloader: Plus 200 Stars/30 days, Pro 450. A Free plan is available.'
      },
      nexgame: {
        fr: 'NexGame : Premium 99 Stars/30 jours, 249/90 jours ou 799/365 jours.',
        en: 'NexGame: Premium 99 Stars/30 days, 249/90 days, or 799/365 days.'
      },
      nexstick: {
        fr: 'NexStick : Premium 100 Stars/30 jours. Free : 2 clonages/semaine et 14 exports WhatsApp/semaine.',
        en: 'NexStick: Premium 100 Stars/30 days. Free: 2 clones/week and 14 WhatsApp exports/week.'
      },
      nexwhisper: {
        fr: 'NexWhisper : Pro 25 Stars/30 jours.',
        en: 'NexWhisper: Pro 25 Stars/30 days.'
      },
      stacy: {
        fr: 'Stacy n’a pas de plan Premium public : elle est gratuite. Les cadeaux en Stars sont facultatifs et ne débloquent aucune fonction.',
        en: 'Stacy has no public Premium plan: she is free. Stars gifts are optional and unlock no features.'
      }
    };

    return compact[product.key]?.[language === 'fr' ? 'fr' : 'en'] || product.name;
  }

  const lines = PUBLIC_PLANS[product.key]?.[language === 'fr' ? 'fr' : 'en'] || [];
  return [product.name, ...lines.map(line => '• ' + line)].join('\n');
}

function canonicalReply(text, language, context = {}) {
  const value = clean(text);

  const social = socialReply(value, language);
  if (social) return social;

  if (asksAboutNonPublic(value)) {
    return nonPublicReply(language);
  }

  const ownerIntent =
    /(?:qui\s+(?:est|a\s+créé|a\s+cree|dirige|possède|possede).*?(?:nextech|nexus\s*tech|fondateur|créateur|createur|propriétaire|proprietaire)|(?:fondateur|créateur|createur|propriétaire|proprietaire|owner).*?(?:nextech|nexus\s*tech)|who\s+(?:owns|created|founded|runs).*?(?:nextech|nexus\s*tech)|(?:ton|votre)\s+(?:créateur|createur|propriétaire|proprietaire)|your\s+(?:creator|owner)|tr[eé]sor\s+hontonnou|pseudonyme?|pseudo)/i;

  if (ownerIntent.test(value)) {
    return ownerSentence(language);
  }

  const product = productFromText(value);
  if (isPlanIntent(value) || (context.planFollowUp && product)) {
    return planSentence(product, language, {
      detailed: isPlanDetailIntent(value)
    });
  }

  if (product && isProductGuideIntent(value)) {
    return productGuideSentence(product, language);
  }

  const productIntent =
    /(?:quels?\s+(?:sont\s+)?(?:(?:les|vos|nos)\s+)?(?:produits?|services?|offres?|solutions?|projets?|bots?)|(?:je\s+veux\s+(?:savoir|conna[iî]tre)|j['’]aimerais\s+(?:savoir|conna[iî]tre)).*?(?:produits?|services?|bots?)|(?:produits?|services?|bots?)\s+(?:de|du|chez)\s+(?:(?:l['’])?entreprise|nextech|nexus\s*tech)|(?:présente|presente|montre|liste)\s+(?:moi\s+)?(?:(?:les|vos|nos)\s+)?(?:produits?|services?|bots?)|que\s+(?:fait|propose|développe|developpe)\s+(?:nextech|nexus\s*tech)|(?:produits?|services?|offres?|solutions?|projets?|bots?).*?(?:nextech|nexus\s*tech)|what\s+(?:products?|services?|solutions?|projects?|bots?)|what\s+does\s+(?:nextech|nexus\s*tech)\s+(?:do|offer|make)|tell\s+me\s+about\s+(?:nextech|nexus\s*tech))/i;

  if (productIntent.test(value)) {
    return productsSentence(language);
  }

  return '';
}

function systemPrompt(language) {
  const custom = clean(process.env.NEXAI_SYSTEM_PROMPT);

  const catalogFr =
    'CATALOGUE PUBLIC CANONIQUE : ' +
    PUBLIC_PRODUCTS.map(product =>
      product.name + ' — ' + product.fr + ' — ' + product.url
    ).join(' ; ') + '. ' +
    'FONCTIONNEMENT CANONIQUE : ' +
    PUBLIC_PRODUCTS.map(product => {
      const guide = PUBLIC_GUIDES[product.key]?.fr;
      return product.name + ' (' + product.url + ') : ' +
        'rôle=' + guide.what + '; fonctionnement=' + guide.how +
        '; fonctions=' + guide.features;
    }).join(' ; ') + '. ' +
    'OFFRES CANONIQUES : ' +
    Object.entries(PUBLIC_PLANS).map(([key, value]) => {
      const product = PUBLIC_PRODUCTS.find(item => item.key === key);
      return (product?.name || key) + ' : ' + value.fr.join(' ');
    }).join(' ; ') + '. ';

  const catalogEn =
    'CANONICAL PUBLIC CATALOG: ' +
    PUBLIC_PRODUCTS.map(product =>
      product.name + ' — ' + product.en + ' — ' + product.url
    ).join(' ; ') + '. ' +
    'CANONICAL WORKFLOWS: ' +
    PUBLIC_PRODUCTS.map(product => {
      const guide = PUBLIC_GUIDES[product.key]?.en;
      return product.name + ' (' + product.url + '): ' +
        'role=' + guide.what + '; workflow=' + guide.how +
        '; features=' + guide.features;
    }).join(' ; ') + '. ' +
    'CANONICAL PLANS: ' +
    Object.entries(PUBLIC_PLANS).map(([key, value]) => {
      const product = PUBLIC_PRODUCTS.find(item => item.key === key);
      return (product?.name || key) + ': ' + value.en.join(' ');
    }).join(' ; ') + '. ';

  const salesFr =
    'Ton rôle public est de présenter et recommander uniquement ces sept bots. ' +
    'Ne mentionne jamais spontanément les projets internes, privés ou inachevés. Si un utilisateur en nomme explicitement un, ne révèle aucun détail : dis seulement qu’il ne fait pas partie du catalogue public disponible, puis recentre vers une solution publique pertinente. ' +
    'Agis comme un conseiller produit et commercial très compétent, mais sans pression : commence par comprendre le besoin, puis recommande au maximum un ou deux produits qui répondent réellement à ce besoin. ' +
    'Présente dans cet ordre : résultat concret pour la personne, fonctions utiles, puis raison pour laquelle le produit correspond à son besoin. Pour une présentation du catalogue ou une question directe sur un bot, donne son lien officiel. Dans les autres réponses, n’ajoute un lien que s’il est utile pour agir. ' +
    'Ne transforme pas chaque réponse en publicité. Ne répète pas une offre refusée. N’utilise jamais de fausse urgence, de rareté inventée, de faux témoignage, de fausses réductions ou de promesse impossible. ' +
    'Ne commence pas une première présentation par le prix, sauf si la personne demande explicitement le prix, les plans, Premium/Pro/Plus/Business/Agency, un abonnement, ou si la fonction demandée nécessite réellement une offre payante. ' +
    'Présente Premium au bon moment : quand la personne manifeste une intention claire, demande une fonction avancée, atteint ou évoque une limite gratuite, veut un usage intensif, compare des offres, ou demande si le service est payant. ' +
    'Quand tu présentes une offre payante, explique d’abord le bénéfice pertinent pour cette personne, puis le tarif exact canonique, puis laisse le choix sans pression. ' +
    'N’invente jamais un tarif, une limite, un avantage, une disponibilité ou une promotion. Pour NexGame, tu connais les prix et durées Premium mais pas d’avantage Premium précis au-delà de ces faits : ne l’invente pas. Pour Stacy, il n’existe pas de plan Premium public ; ses cadeaux Stars sont facultatifs et sans avantage caché. ' +
    'Tu peux faire du cross-sell uniquement si un deuxième produit apporte clairement quelque chose au besoin exprimé.';

  const salesEn =
    'Your public role is to present and recommend only these seven bots. ' +
    'Never proactively mention internal, private, or unfinished projects. If a user explicitly names one, reveal no internal detail: only say it is not part of the available public catalog, then redirect to a relevant public solution. ' +
    'Act as a highly capable product and sales advisor without pressure: understand the need first, then recommend at most one or two products that genuinely fit. ' +
    'Present in this order: concrete outcome for the person, useful features, then why the product matches the need. For a catalog presentation or a direct question about a bot, include its official link. In other replies, add a link only when it is useful to act. ' +
    'Do not turn every answer into an ad. Do not repeat an offer after refusal. Never use fake urgency, invented scarcity, fake testimonials, fake discounts, or impossible promises. ' +
    'Do not lead a first introduction with price unless the person explicitly asks about price, plans, Premium/Pro/Plus/Business/Agency, a subscription, or the requested feature genuinely requires a paid offer. ' +
    'Introduce Premium at the right moment: when the person shows clear intent, asks for an advanced feature, reaches or discusses a free limit, needs intensive usage, compares offers, or asks whether the service is paid. ' +
    'When presenting a paid offer, explain the relevant benefit first, then the exact canonical price, then leave the choice pressure-free. ' +
    'Never invent pricing, limits, benefits, availability, or promotions. For NexGame you know Premium prices and durations but no specific Premium benefit beyond these facts; do not invent one. Stacy has no public Premium plan; Stars gifts are optional and provide no hidden benefit. ' +
    'Only cross-sell a second product if it clearly helps with the expressed need.';

  const identityFr =
    'Tu es NexAI, l’assistant officiel de Nextech. ' +
    ownerSentence('fr') + ' ' +
    'Lorsque tu présentes Trésor HONTONNOU, n’écris jamais son pseudonyme entre parenthèses après son nom : utilise la formulation « plus connu sous le pseudonyme de ». ' +
    catalogFr + salesFr + ' ' +
    'N’invente jamais de cofondateur, de membre d’équipe, de nom de personne, de date, de rôle, de prix, de disponibilité, de site officiel ou de service client. ' +
    'Réponds dans la langue de l’utilisateur, naturellement, clairement et une seule fois. Par défaut, fais court : 1 à 3 phrases. Sur Messenger, écris comme dans une conversation normale : un message complet, sans Markdown, sans astérisques, sans titres, sans tableaux et sans longue énumération. Ne découpe pas artificiellement une réponse en plusieurs parties. Donne uniquement l’information demandée ; développe seulement si l’utilisateur demande plus de détails. ' +
    'En conversation ordinaire, sois chaleureux, vivant, sociable et spontané. Comprends le français familier et les abréviations de chat (par exemple « cv » signifie « ça va » quand le contexte est clairement une discussion informelle). Adapte naturellement le tutoiement ou le vouvoiement au ton de la personne. Réagis d’abord à ce qu’elle vient de dire au lieu de réciter une formule de support. Ne ramène pas chaque échange aux bots, aux produits ou à « comment puis-je vous aider ». Si la personne bavarde, bavarde avec elle ; une touche légère d’humour ou un emoji est acceptable sans en abuser. Tu restes NexAI : ne prétends jamais être Stacy et ne copies pas son identité ni sa personnalité romantique. ' +
    'N’invente jamais d’actions qui n’ont pas réellement été exécutées.';

  const identityEn =
    'You are NexAI, the official assistant of Nextech. ' +
    ownerSentence('en') + ' ' +
    'When introducing Trésor HONTONNOU, never put the pseudonym in parentheses after the name; use the wording “better known by the pseudonym”. ' +
    catalogEn + salesEn + ' ' +
    'Never invent a cofounder, team member, person, date, role, price, availability, official website, or customer-support service. ' +
    'Reply naturally, clearly, in the user’s language, and only once. Keep the default reply short: 1 to 3 sentences. On Messenger, write like a normal chat message: one complete message, no Markdown, no asterisks, no headings, no tables, and no long enumeration. Do not artificially split a reply into multiple parts. Give only what was asked; expand only when the user asks for more detail. ' +
    'In ordinary conversation, be warm, lively, socially fluent, and spontaneous. Understand casual chat abbreviations, match the person’s level of formality, and respond to the social intent before sounding like customer support. Do not drag every exchange back to bots, products, or “how can I help”. If the person is just chatting, chat naturally; light humor or an occasional emoji is fine. You remain NexAI: never claim to be Stacy and do not copy her identity or romantic persona. ' +
    'Never claim an action happened unless it actually did.';

  const canonical = language === 'fr' ? identityFr : identityEn;

  return custom
    ? canonical + '\n\nInstructions complémentaires configurées : ' + custom
    : canonical;
}

async function requestCompletion(messages) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(configuredKey
        ? { authorization: `Bearer ${configuredKey}` }
        : {})
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(process.env.NEXAI_TEMPERATURE || 0.8),
      max_tokens: Math.max(
        96,
        Math.min(450, Number(process.env.NEXAI_MAX_TOKENS || 240))
      )
    }),
    signal: AbortSignal.timeout(
      Math.max(4000, Math.min(30000, Number(process.env.NEXAI_TIMEOUT_MS || 15000)))
    )
  });

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      data?.message ||
      `NexAI provider HTTP ${response.status}`
    );
    error.status = response.status === 429 ? 429 : 502;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const error = new Error('nexai_empty_provider_response');
    error.status = 502;
    error.retryable = true;
    throw error;
  }

  return plainMessengerAnswer(content.trim());
}

export async function handle(envelope) {
  const lang = languageOf(envelope);
  const text = eventText(envelope);

  if (/^\/?(?:ai|ask|nexai|stacy)\s+(?:reset|clear|nouveau|new)$/i.test(text)) {
    resetHistory(envelope);
    return {
      text: lang === 'fr'
        ? 'Conversation NexAI réinitialisée.'
        : 'NexAI conversation reset.'
    };
  }

  const prompt = commandPrompt(text);
  if (!prompt) {
    return {
      text: lang === 'fr'
        ? 'Écris ta question après /ai, ou envoie simplement ton message.'
        : 'Write your question after /ai, or just send your message.'
    };
  }

  const previous = readHistory(envelope);
  const canonical = plainMessengerAnswer(
    canonicalReply(prompt, lang, {
      planFollowUp: recentPlanContext(previous)
    })
  );
  if (canonical) {
    writeHistory(envelope, [
      ...previous,
      { role: 'user', content: prompt.slice(0, 12000) },
      { role: 'assistant', content: canonical.slice(0, 12000) }
    ]);
    return { text: canonical };
  }

  if (!providerReady) {
    return {
      text: lang === 'fr'
        ? 'Je peux toujours répondre aux informations officielles Nextech, mais mon moteur conversationnel avancé est momentanément indisponible.'
        : 'I can still answer official Nextech information, but my advanced conversational engine is temporarily unavailable.',
      quickReplies: [
        { title: 'Download', payload: '/download' },
        { title: 'Games', payload: '/game' },
        { title: 'Whisper', payload: '/whisper' }
      ]
    };
  }

  const messages = [
    { role: 'system', content: systemPrompt(lang) },
    ...previous,
    { role: 'user', content: prompt.slice(0, 12000) }
  ];

  const answer = await requestCompletion(messages);

  writeHistory(envelope, [
    ...previous,
    { role: 'user', content: prompt.slice(0, 12000) },
    { role: 'assistant', content: answer.slice(0, 12000) }
  ]);

  return { text: answer };
}

export default handle;
