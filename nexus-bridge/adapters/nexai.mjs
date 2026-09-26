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
const MAX_HISTORY_MESSAGES = 12;

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
  if (!/^\/?(?:ai|ask|nexai|stacy)\b/i.test(text)) return text;
  return stripCommand(text).join(' ').trim();
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
      'Premium 12 mois — 799 Telegram Stars / 365 jours.',
      'Ne promets pas un avantage Premium précis qui n’est pas présent dans ces faits canoniques.'
    ],
    en: [
      'Premium 1 month — 99 Telegram Stars / 30 days.',
      'Premium 3 months — 249 Telegram Stars / 90 days.',
      'Premium 12 months — 799 Telegram Stars / 365 days.',
      'Do not promise a specific Premium benefit that is not present in these canonical facts.'
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

function ownerSentence(language) {
  return language === 'fr'
    ? `Le créateur et propriétaire de Nextech est ${OWNER_NAME}, plus connu sous le pseudonyme de ${OWNER_ALIAS}.`
    : `Nextech was created and is owned by ${OWNER_NAME}, better known by the pseudonym ${OWNER_ALIAS}.`;
}

function productFromText(text) {
  const value = clean(text).toLowerCase();
  return PUBLIC_PRODUCTS.find(product =>
    product.aliases.some(alias => value.includes(alias))
  ) || null;
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
  const products = PUBLIC_PRODUCTS
    .map(product => {
      const description = language === 'fr' ? product.fr : product.en;
      return `• ${product.name} — ${description}\\n${product.url}`;
    })
    .join('\\n\\n');

  return language === 'fr'
    ? `Les produits publics de Nextech disponibles sur Telegram sont :\\n\\n${products}`
    : `Nextech's public Telegram products are:\\n\\n${products}`;
}

function planSentence(product, language) {
  if (!product) {
    return language === 'fr'
      ? 'Je peux te donner les offres d’un bot précis. Dis-moi lequel : NexCanal Manager, NexGroup Manager, NexDownloader, NexGame, NexStick, NexWhisper ou Stacy.'
      : 'I can give you the plans for a specific bot. Tell me which one: NexCanal Manager, NexGroup Manager, NexDownloader, NexGame, NexStick, NexWhisper, or Stacy.';
  }

  const lines = PUBLIC_PLANS[product.key]?.[language === 'fr' ? 'fr' : 'en'] || [];

  return [
    product.name,
    ...lines.map(line => '• ' + line),
    '',
    product.url
  ].join('\\n');
}

function canonicalReply(text, language) {
  const value = clean(text);

  if (asksAboutNonPublic(value)) {
    return nonPublicReply(language);
  }

  const ownerIntent =
    /(?:qui\\s+(?:est|a\\s+créé|a\\s+cree|dirige|possède|possede).*?(?:nextech|nexus\\s*tech|fondateur|créateur|createur|propriétaire|proprietaire)|(?:fondateur|créateur|createur|propriétaire|proprietaire|owner).*?(?:nextech|nexus\\s*tech)|who\\s+(?:owns|created|founded|runs).*?(?:nextech|nexus\\s*tech)|(?:ton|votre)\\s+(?:créateur|createur|propriétaire|proprietaire)|your\\s+(?:creator|owner)|tr[eé]sor\\s+hontonnou|pseudonyme?|pseudo)/i;

  if (ownerIntent.test(value)) {
    return ownerSentence(language);
  }

  const planIntent =
    /(?:premium|pro\\b|plus\\b|business|agency|payant|payante|prix|tarif|co[uû]t|combien|stars?|abonnement|subscription|pricing|price|paid|cost|plan)/i;

  if (planIntent.test(value)) {
    return planSentence(productFromText(value), language);
  }

  const productIntent =
    /(?:quels?\\s+(?:sont\\s+)?(?:les\\s+)?(?:produits?|services?|offres?|solutions?|projets?|bots?)|que\\s+(?:fait|propose|développe|developpe)\\s+(?:nextech|nexus\\s*tech)|(?:produits?|services?|offres?|solutions?|projets?|bots?).*?(?:nextech|nexus\\s*tech)|what\\s+(?:products?|services?|solutions?|projects?|bots?)|what\\s+does\\s+(?:nextech|nexus\\s*tech)\\s+(?:do|offer|make)|tell\\s+me\\s+about\\s+(?:nextech|nexus\\s*tech))/i;

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
    'CANONICAL PLANS: ' +
    Object.entries(PUBLIC_PLANS).map(([key, value]) => {
      const product = PUBLIC_PRODUCTS.find(item => item.key === key);
      return (product?.name || key) + ': ' + value.en.join(' ');
    }).join(' ; ') + '. ';

  const salesFr =
    'Ton rôle public est de présenter et recommander uniquement ces sept bots. ' +
    'Ne mentionne jamais spontanément les projets internes, privés ou inachevés. Si un utilisateur en nomme explicitement un, ne révèle aucun détail : dis seulement qu’il ne fait pas partie du catalogue public disponible, puis recentre vers une solution publique pertinente. ' +
    'Agis comme un conseiller produit et commercial très compétent, mais sans pression : commence par comprendre le besoin, puis recommande au maximum un ou deux produits qui répondent réellement à ce besoin. ' +
    'Présente dans cet ordre : résultat concret pour la personne, fonctions utiles, raison pour laquelle le produit correspond à son besoin, puis lien officiel. ' +
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
    'Present in this order: concrete outcome for the person, useful features, why the product matches the need, then the official link. ' +
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
    'Réponds dans la langue de l’utilisateur, naturellement, clairement et une seule fois. ' +
    'N’invente jamais d’actions qui n’ont pas réellement été exécutées.';

  const identityEn =
    'You are NexAI, the official assistant of Nextech. ' +
    ownerSentence('en') + ' ' +
    'When introducing Trésor HONTONNOU, never put the pseudonym in parentheses after the name; use the wording “better known by the pseudonym”. ' +
    catalogEn + salesEn + ' ' +
    'Never invent a cofounder, team member, person, date, role, price, availability, official website, or customer-support service. ' +
    'Reply naturally, clearly, in the user’s language, and only once. ' +
    'Never claim an action happened unless it actually did.';

  const canonical = language === 'fr' ? identityFr : identityEn;

  return custom
    ? canonical + '\\n\\nInstructions complémentaires configurées : ' + custom
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
      temperature: Number(process.env.NEXAI_TEMPERATURE || 0.7),
      max_tokens: Math.max(
        128,
        Math.min(4096, Number(process.env.NEXAI_MAX_TOKENS || 1200))
      )
    }),
    signal: AbortSignal.timeout(
      Math.max(5000, Math.min(60000, Number(process.env.NEXAI_TIMEOUT_MS || 25000)))
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

  return content.trim();
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

  const canonical = canonicalReply(prompt, lang);
  if (canonical) {
    const previous = readHistory(envelope);
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

  const previous = readHistory(envelope);
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
