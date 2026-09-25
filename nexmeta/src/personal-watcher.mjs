import crypto from 'node:crypto';
import path from 'node:path';
import {
  mkdir,
  readFile,
  rename,
  writeFile
} from 'node:fs/promises';

import {
  executePersistentSessionCommand,
  persistentSessionStatus
} from './session-agent.mjs';
import {
  routeNexusEvent
} from './router.mjs';
import {
  audit,
  getRuntimeSettings,
  saveMessage
} from './store.mjs';

const enabled = !/^(?:0|false|no|off)$/i.test(
  String(process.env.NEXMETA_PERSONAL_WATCHER ?? '1')
);

const pollMs = Math.max(
  4000,
  Math.min(
    60_000,
    Number(process.env.NEXMETA_PERSONAL_WATCH_INTERVAL_MS || 8000)
  )
);

const maxThreads = Math.max(
  5,
  Math.min(
    40,
    Number(process.env.NEXMETA_PERSONAL_WATCH_MAX_THREADS || 20)
  )
);

const stateFile = path.resolve(
  process.env.NEXMETA_PERSONAL_WATCH_STATE_FILE ||
  '/var/lib/nex/nexmeta/personal-watcher-state.json'
);

let timer = null;
let ticking = false;
let state = null;
let lastSessionReady = false;

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function threadIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/messages\/t\/([^/]+)/i);
    return match?.[1] || hash(url.pathname).slice(0, 24);
  } catch {
    return hash(value).slice(0, 24);
  }
}

function cleanText(value, max = 5000) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function conversationListFingerprint(item) {
  return hash([
    cleanText(item?.label, 1200),
    item?.unread === true ? '1' : '0',
    item?.outboundHint === true ? '1' : '0'
  ].join('|'));
}

function newestMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages)
    ? snapshot.messages
    : [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = cleanText(messages[i]?.text);
    if (!text) continue;
    return {
      text,
      outbound: messages[i]?.outbound === true,
      accessibility: cleanText(messages[i]?.accessibility, 2000)
    };
  }

  const items = Array.isArray(snapshot?.items)
    ? snapshot.items
    : [];

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const text = cleanText(items[i]);
    if (text) {
      return {
        text,
        outbound: false,
        accessibility: ''
      };
    }
  }

  return null;
}

function messageFingerprint(threadUrl, message) {
  return hash([
    threadUrl,
    message?.text || '',
    message?.outbound === true ? '1' : '0',
    message?.accessibility || ''
  ].join('|'));
}

function buildReply(result) {
  if (!result || result.silent) return '';

  const parts = [];
  if (typeof result.text === 'string' && result.text.trim()) {
    parts.push(result.text.trim());
  }

  if (result.media?.url) {
    parts.push(String(result.media.url));
  }

  if (Array.isArray(result.imageUrls)) {
    for (const url of result.imageUrls.slice(0, 8)) {
      if (url) parts.push(String(url));
    }
  }

  if (Array.isArray(result.quickReplies) && result.quickReplies.length) {
    const actions = result.quickReplies
      .slice(0, 10)
      .map(item => {
        const title = cleanText(item?.title, 80);
        const payload = cleanText(item?.payload, 300);
        if (!title && !payload) return '';
        return payload && payload !== title
          ? `${title || payload} — ${payload}`
          : title || payload;
      })
      .filter(Boolean);

    if (actions.length) {
      parts.push(actions.join('\n'));
    }
  }

  return parts
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 5000);
}

async function loadState() {
  if (state) return state;

  try {
    const raw = JSON.parse(await readFile(stateFile, 'utf8'));
    state = {
      version: 1,
      initialized: raw?.initialized === true,
      activatedAt: raw?.activatedAt || null,
      threads:
        raw?.threads &&
        typeof raw.threads === 'object' &&
        !Array.isArray(raw.threads)
          ? raw.threads
          : {}
    };
  } catch {
    state = {
      version: 1,
      initialized: false,
      activatedAt: null,
      threads: {}
    };
  }

  return state;
}

async function persistState() {
  await mkdir(path.dirname(stateFile), { recursive: true });

  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 }
  );
  await rename(tmp, stateFile);
}

async function listConversations() {
  const result = await executePersistentSessionCommand({
    type: 'list_conversations'
  });

  return Array.isArray(result?.conversations)
    ? result.conversations.slice(0, maxThreads)
    : [];
}

async function readLatest(threadUrl) {
  const snapshot = await executePersistentSessionCommand({
    type: 'read_conversation',
    payload: {
      threadUrl
    }
  });

  return {
    snapshot,
    message: newestMessage(snapshot)
  };
}

function eventFor(threadUrl, message, fingerprint) {
  return {
    platform: 'facebook',
    surface: 'messenger',
    pageId: 'personal-account',
    type: 'message',
    senderId: threadIdFromUrl(threadUrl),
    externalMessageId: `personal-${fingerprint.slice(0, 32)}`,
    timestamp: Date.now(),
    text: message.text,
    attachments: [],
    isEcho: false,
    raw: {
      source: 'persistent-browser',
      threadUrl
    }
  };
}

async function recordInbound(event) {
  await saveMessage({
    platform: 'facebook',
    surface: 'messenger',
    pageId: event.pageId,
    externalUserId: event.senderId,
    externalMessageId: event.externalMessageId,
    direction: 'inbound',
    text: event.text,
    attachments: [],
    timestamp: new Date(event.timestamp)
  }).catch(() => {});
}

async function recordOutbound(event, text) {
  await saveMessage({
    platform: 'facebook',
    surface: 'messenger',
    pageId: event.pageId,
    externalUserId: event.senderId,
    externalMessageId: `personal-out-${hash(event.externalMessageId + '|' + text).slice(0, 32)}`,
    direction: 'outbound',
    text,
    timestamp: new Date()
  }).catch(() => {});
}

async function processChangedConversation(item, row) {
  const threadUrl = String(item.url || '');
  if (!threadUrl) return;

  const { message } = await readLatest(threadUrl);
  if (!message) return;

  const fingerprint = messageFingerprint(threadUrl, message);
  if (row.messageFingerprint === fingerprint) return;

  row.messageFingerprint = fingerprint;
  row.lastObservedAt = new Date().toISOString();
  await persistState();

  const suppressUntil = Number(row.suppressUntil || 0);
  if (Date.now() < suppressUntil) return;

  const labelOutbound = item?.outboundHint === true;
  if (message.outbound || labelOutbound) {
    row.lastDirection = 'outbound';
    await persistState();
    return;
  }

  const settings = await getRuntimeSettings();
  if (!settings.inboundEnabled) {
    await audit('nexmeta.personal.skipped', 'runtime', {
      reason: 'inbound_disabled',
      threadId: threadIdFromUrl(threadUrl)
    }).catch(() => {});
    return;
  }

  const event = eventFor(threadUrl, message, fingerprint);
  await recordInbound(event);

  const result = await routeNexusEvent(event, {
    identity: {
      nexusUserId: null
    }
  });

  await audit('nexmeta.personal.routed', 'facebook', {
    threadId: event.senderId,
    eventId: event.externalMessageId,
    handled: result?.handled === true,
    handledBy: result?.handledBy || null
  }).catch(() => {});

  if (!settings.outboundEnabled) return;

  const reply = buildReply(result);
  if (!reply) return;

  row.suppressUntil = Date.now() + 12_000;
  row.lastDirection = 'inbound';
  await persistState();

  await executePersistentSessionCommand({
    type: 'send_message',
    payload: {
      threadUrl,
      text: reply
    }
  });

  await recordOutbound(event, reply);

  await new Promise(resolve => setTimeout(resolve, 1200));

  try {
    const after = await readLatest(threadUrl);
    if (after.message) {
      row.messageFingerprint = messageFingerprint(
        threadUrl,
        after.message
      );
    }
  } catch {}

  row.lastReplyAt = new Date().toISOString();
  await persistState();
}

async function baseline(conversations) {
  const s = await loadState();

  for (const item of conversations) {
    const threadUrl = String(item?.url || '');
    if (!threadUrl) continue;

    const id = threadIdFromUrl(threadUrl);
    s.threads[id] = {
      ...(s.threads[id] || {}),
      url: threadUrl,
      listFingerprint: conversationListFingerprint(item),
      messageFingerprint: s.threads[id]?.messageFingerprint || null,
      suppressUntil: 0,
      baselinedAt: new Date().toISOString()
    };
  }

  s.initialized = true;
  s.activatedAt = new Date().toISOString();
  await persistState();

  await audit('nexmeta.personal.watcher_activated', 'runtime', {
    baselinedThreads: conversations.length
  }).catch(() => {});

  console.log('[NexMeta Personal] baseline ready', {
    conversations: conversations.length
  });
}

async function tick() {
  if (!enabled || ticking) return;
  ticking = true;

  try {
    const session = await persistentSessionStatus();

    if (!session?.loggedIn) {
      if (lastSessionReady) {
        console.warn('[NexMeta Personal] Facebook session lost');
      }
      lastSessionReady = false;
      return;
    }

    if (!lastSessionReady) {
      console.log('[NexMeta Personal] Facebook session ready');
    }
    lastSessionReady = true;

    const conversations = await listConversations();
    const s = await loadState();

    if (!s.initialized) {
      await baseline(conversations);
      return;
    }

    for (const item of conversations) {
      const threadUrl = String(item?.url || '');
      if (!threadUrl) continue;

      const id = threadIdFromUrl(threadUrl);
      const nextListFingerprint = conversationListFingerprint(item);
      const previous = s.threads[id];

      if (!previous) {
        s.threads[id] = {
          url: threadUrl,
          listFingerprint: nextListFingerprint,
          messageFingerprint: null,
          suppressUntil: 0,
          firstSeenAt: new Date().toISOString()
        };
        await persistState();

        if (item?.unread === true) {
          await processChangedConversation(item, s.threads[id]);
        }
        continue;
      }

      const changed =
        previous.listFingerprint !== nextListFingerprint ||
        item?.unread === true;

      previous.url = threadUrl;
      previous.listFingerprint = nextListFingerprint;
      previous.lastListedAt = new Date().toISOString();

      if (changed) {
        await processChangedConversation(item, previous);
      }
    }

    await persistState();
  } catch (error) {
    console.error(
      '[NexMeta Personal] watcher tick failed',
      String(error?.message || error).slice(0, 500)
    );
  } finally {
    ticking = false;
  }
}

export function startPersonalWatcher() {
  if (!enabled) {
    return {
      enabled: false,
      pollMs
    };
  }

  if (timer) {
    return {
      enabled: true,
      pollMs,
      alreadyStarted: true
    };
  }

  console.log('[NexMeta Personal] watcher enabled', {
    pollMs,
    maxThreads,
    stateFile
  });

  setTimeout(() => {
    tick().catch(() => {});
  }, 1500).unref();

  timer = setInterval(() => {
    tick().catch(() => {});
  }, pollMs);

  timer.unref();

  return {
    enabled: true,
    pollMs,
    maxThreads,
    stateFile
  };
}
