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

  return language === 'fr'
    ? 'Tu es NexAI, l’assistant de l’écosystème Nexus. Réponds clairement, utilement et de façon concise. N’invente pas d’actions qui n’ont pas réellement été exécutées.'
    : 'You are NexAI, the Nexus ecosystem assistant. Be clear, useful and concise. Never claim an action happened unless it actually did.';
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
