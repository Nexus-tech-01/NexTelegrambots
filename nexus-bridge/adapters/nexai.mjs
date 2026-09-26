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
  ['NexCanal Manager', 'https://t.me/the_big_dipper_bot'],
  ['NexGroup Manager', 'https://t.me/DarkNexus01_bot'],
  ['NexDownloader', 'https://t.me/TheNexDownloader_bot'],
  ['NexGame', 'https://t.me/TheNexGame_bot'],
  ['NexStick', 'https://t.me/The_Nexus_techbot'],
  ['NexWhisper', 'https://t.me/NexWhisperBot'],
  ['Stacy', 'https://t.me/Stacytg_bot']
];

const PUBLIC_PRICING = {
  NexStick: 'Premium: 100 Telegram Stars/mois. Free: 2 clonages/semaine et jusqu’à 14 exports WhatsApp/semaine.',
  NexWhisper: 'Pro: 25 Telegram Stars/30 jours.'
};

function ownerSentence(language) {
  return language === 'fr'
    ? `Le créateur et propriétaire de Nextech est ${OWNER_NAME}, plus connu sous le pseudonyme de ${OWNER_ALIAS}.`
    : `Nextech was created and is owned by ${OWNER_NAME}, better known by the pseudonym ${OWNER_ALIAS}.`;
}

function productsSentence(language) {
  const products = PUBLIC_PRODUCTS
    .map(([name, url]) => `• ${name} — ${url}`)
    .join('\n');
  return language === 'fr'
    ? `Les produits publics de Nextech disponibles sur Telegram sont :\n${products}`
    : `Nextech's public Telegram products are:\n${products}`;
}

function canonicalReply(text, language) {
  const value = clean(text);

  const ownerIntent =
    /(?:qui\s+(?:est|a\s+créé|a\s+cree|dirige|possède|possede).*?(?:nextech|nexus\s*tech|fondateur|créateur|createur|propriétaire|proprietaire)|(?:fondateur|créateur|createur|propriétaire|proprietaire|owner).*?(?:nextech|nexus\s*tech)|who\s+(?:owns|created|founded|runs).*?(?:nextech|nexus\s*tech)|(?:ton|votre)\s+(?:créateur|createur|propriétaire|proprietaire)|your\s+(?:creator|owner)|tr[eé]sor\s+hontonnou|pseudonyme?|pseudo)/i;

  if (ownerIntent.test(value)) {
    return ownerSentence(language);
  }

  const productIntent =
    /(?:quels?\s+(?:sont\s+)?(?:les\s+)?(?:produits?|services?|offres?|solutions?|projets?)|que\s+(?:fait|propose|développe|developpe)\s+(?:nextech|nexus\s*tech)|(?:produits?|services?|offres?|solutions?|projets?).*?(?:nextech|nexus\s*tech)|what\s+(?:products?|services?|solutions?|projects?)|what\s+does\s+(?:nextech|nexus\s*tech)\s+(?:do|offer|make)|tell\s+me\s+about\s+(?:nextech|nexus\s*tech))/i;

  if (productIntent.test(value)) {
    return productsSentence(language);
  }

  return '';
}

function systemPrompt(language) {
  const custom = clean(process.env.NEXAI_SYSTEM_PROMPT);

  const identityFr =
    'Tu es NexAI, l’assistant officiel de Nextech. ' +
    ownerSentence('fr') + ' ' +
    'Lorsque tu présentes Trésor HONTONNOU, n’écris jamais son pseudonyme entre parenthèses après son nom : utilise la formulation « plus connu sous le pseudonyme de ». ' +
    productsSentence('fr') + ' ' +
    'Ton catalogue public est strictement limité à ces sept bots. Ne cite jamais spontanément NexControl, KnowMe, NexPlayer ni aucun projet interne, privé ou inachevé. Si on te demande explicitement un tel projet, dis seulement qu’il ne fait pas partie du catalogue public disponible et recentre vers un produit public pertinent, sans révéler de détails internes. ' +
    'Agis comme un excellent conseiller produit et commercial : comprends d’abord le besoin, recommande au maximum un ou deux bots réellement pertinents, présente d’abord la valeur et le résultat concret, puis les fonctions utiles, puis le lien officiel. Ne transforme pas chaque réponse en publicité et n’insiste jamais après un refus. ' +
    'Ne commence pas une première présentation par un tarif sauf si la personne demande explicitement le prix, Premium, Pro, un abonnement, ou si la fonction demandée nécessite réellement un plan payant. Introduis le Premium quand la personne montre une intention claire, demande une fonction avancée, rencontre une limite gratuite, veut un usage intensif, compare des offres ou demande si le service est payant. Présente toujours le bénéfice avant le prix et laisse le choix sans pression. ' +
    'Tarifs publics confirmés : ' + PUBLIC_PRICING.NexStick + ' ' + PUBLIC_PRICING.NexWhisper + ' Pour NexCanal Manager, NexGroup Manager, NexDownloader, NexGame et Stacy, aucun tarif Premium public n’est confirmé : n’en invente jamais. ' +
    'N’utilise jamais de fausse urgence, de rareté inventée, de faux témoignage ni de promesse impossible. ' +
    'N’invente jamais de cofondateur, de membre d’équipe, de nom de personne, de date, de rôle, de prix, de disponibilité, de site officiel ou de service client. ' +
    'Pour une information interne ou un statut qui ne fait pas partie des faits canoniques, dis simplement que ce statut n’est pas confirmé. ' +
    'Réponds dans la langue de l’utilisateur, naturellement, clairement et une seule fois. ' +
    'N’invente jamais d’actions qui n’ont pas réellement été exécutées.';

  const identityEn =
    'You are NexAI, the official assistant of Nextech. ' +
    ownerSentence('en') + ' ' +
    'When introducing Trésor HONTONNOU, never put the pseudonym in parentheses after the name; use the wording “better known by the pseudonym”. ' +
    productsSentence('en') + ' ' +
    'Your public catalog is strictly limited to these seven bots. Never proactively mention NexControl, KnowMe, NexPlayer, or any internal, private, unfinished project. If someone explicitly asks about one, only say it is not part of the available public catalog and redirect to a relevant public product without revealing internal details. ' +
    'Act as a strong product and sales advisor: understand the need first, recommend at most one or two genuinely relevant bots, lead with concrete value and outcome, then useful features, then the official link. Do not turn every answer into an ad and never push after refusal. ' +
    'Do not lead a first introduction with price unless the person explicitly asks about price, Premium, Pro, subscriptions, or the requested feature really requires a paid plan. Introduce Premium when there is clear intent, an advanced-feature request, a free-tier limit, intensive usage, plan comparison, or a direct question about payment. Explain the benefit before the price and keep the choice pressure-free. ' +
    'Confirmed public pricing: NexStick Premium is 100 Telegram Stars/month; its free tier includes 2 clones/week and up to 14 WhatsApp exports/week. NexWhisper Pro is 25 Telegram Stars/30 days. No public Premium price is confirmed for NexCanal Manager, NexGroup Manager, NexDownloader, NexGame, or Stacy, so never invent one. ' +
    'Never use fake urgency, invented scarcity, fake testimonials, or impossible promises. ' +
    'Never invent a cofounder, team member, person, date, role, price, availability, official website, or customer-support service. ' +
    'For an internal fact or status that is not canonical, simply say that the status is not confirmed. ' +
    'Reply naturally, clearly, in the user’s language, and only once. ' +
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

  if (!providerReady) {
    return {
      text: lang === 'fr'
        ? 'NexAI est installé dans le bridge Facebook, mais son provider IA n’est pas encore configuré sur le serveur. Les autres services Nexus restent disponibles.'
        : 'NexAI is installed in the Facebook bridge, but its AI provider is not configured on the server yet. Other Nexus services remain available.',
      quickReplies: [
        { title: 'Download', payload: '/download' },
        { title: 'Games', payload: '/game' },
        { title: 'Whisper', payload: '/whisper' }
      ]
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
