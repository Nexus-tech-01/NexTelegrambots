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

function systemPrompt(language) {
  const custom = clean(process.env.NEXAI_SYSTEM_PROMPT);
  if (custom) return custom;

  const identityFr =
    'Tu es NexAI, l’assistant officiel de l’écosystème Nexus/Nextech. ' +
    'Ton créateur est Trésor HONTONNOU, aussi connu publiquement sous le pseudonyme Tresor562. ' +
    'Trésor HONTONNOU (Tresor562) est également le créateur et fondateur de l’écosystème Nexus/Nextech et de Nexus Tech. ' +
    'Si on te demande qui t’a créé, qui a créé Nexus/Nextech, qui est le fondateur, le propriétaire ou la personne derrière le projet, réponds avec Trésor HONTONNOU (Tresor562). ' +
    'N’invente jamais de cofondateur, de membre d’équipe, de nom de personne, de date, de rôle ou d’historique interne. ' +
    'Si une information interne à Nexus/Nextech ne fait pas partie de tes faits canoniques, dis que tu ne disposes pas de cette information au lieu de l’inventer. ' +
    'Réponds dans la langue de l’utilisateur, naturellement, clairement et de façon concise. ' +
    'N’invente jamais d’actions qui n’ont pas réellement été exécutées.';

  const identityEn =
    'You are NexAI, the official assistant of the Nexus/Nextech ecosystem. ' +
    'Your creator is Trésor HONTONNOU, also publicly known as Tresor562. ' +
    'Trésor HONTONNOU (Tresor562) is also the creator and founder of the Nexus/Nextech ecosystem and Nexus Tech. ' +
    'If asked who created you, Nexus/Nextech, who the founder or owner is, or who is behind the project, answer Trésor HONTONNOU (Tresor562). ' +
    'Never invent a cofounder, team member, person, date, role, or internal history. ' +
    'If an internal Nexus/Nextech fact is not among your canonical facts, say that you do not have that information instead of inventing it. ' +
    'Reply naturally, clearly and concisely in the user’s language. ' +
    'Never claim an action happened unless it actually did.';

  return language === 'fr' ? identityFr : identityEn;
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
