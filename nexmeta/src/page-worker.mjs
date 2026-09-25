import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const DEBUG_URL = String(
  process.env.NEXMETA_BROWSER_DEBUG_URL ||
  'http://127.0.0.1:9223'
).trim();

const GATEWAY_URL = String(
  process.env.NEXUS_COMMAND_GATEWAY_URL ||
  'http://127.0.0.1:18880/internal/nexus/events'
).trim();

const GATEWAY_KEY = String(
  process.env.NEXUS_COMMAND_GATEWAY_KEY ||
  ''
).trim();

const runtimeRoot = path.resolve(
  process.env.NEXUS_ROOT ||
  process.cwd()
);

const STATE_FILE = path.resolve(
  process.env.NEXMETA_PAGE_STATE_FILE ||
  path.join(runtimeRoot, '.nexmeta-state', 'page-worker-state.json')
);

const HEALTH_FILE = path.resolve(
  process.env.NEXMETA_PAGE_HEALTH_FILE ||
  path.join(runtimeRoot, '.nexmeta-state', 'page-worker-health.json')
);

const POLL_MS = Math.max(
  3000,
  Math.min(30000, Number(process.env.NEXMETA_PAGE_POLL_MS || 6000))
);

const MAX_ROWS = Math.max(
  5,
  Math.min(40, Number(process.env.NEXMETA_PAGE_MAX_ROWS || 20))
);

const MAX_CHANGED = Math.max(
  1,
  Math.min(5, Number(process.env.NEXMETA_PAGE_MAX_CHANGED || 3))
);

const DEFAULT_PAGES = [
  {
    name: 'Nexus Tech',
    assetId: '106458282029367'
  },
  {
    name: 'Otaku Nexus',
    assetId: '1140026045863021'
  }
];

function loadPagesConfig() {
  const raw = String(process.env.NEXMETA_PAGES_JSON || '').trim();
  if (!raw) return DEFAULT_PAGES;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PAGES;

    const pages = parsed
      .map(item => ({
        name: String(item?.name || '').trim(),
        assetId: String(item?.assetId || '').trim()
      }))
      .filter(item => item.name && /^\d+$/.test(item.assetId));

    return pages.length ? pages : DEFAULT_PAGES;
  } catch {
    return DEFAULT_PAGES;
  }
}

const MANAGED_PAGES = loadPagesConfig();

let browser = null;
const tabs = new Map();
let running = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex');
}

function clean(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyState() {
  return {
    version: 1,
    pages: {},
    processed: {}
  };
}

async function loadState() {
  try {
    const data = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return {
      ...emptyState(),
      ...(data && typeof data === 'object' ? data : {}),
      pages:
        data?.pages && typeof data.pages === 'object'
          ? data.pages
          : {},
      processed:
        data?.processed && typeof data.processed === 'object'
          ? data.processed
          : {}
    };
  } catch {
    return emptyState();
  }
}

let state = await loadState();

async function saveState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });

  const processed = Object.fromEntries(
    Object.entries(state.processed || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, 2500)
  );

  const payload = {
    version: 1,
    pages: state.pages || {},
    processed,
    updatedAt: new Date().toISOString()
  };

  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), {
    mode: 0o600
  });
  await fs.rename(tmp, STATE_FILE);
  await fs.chmod(STATE_FILE, 0o600).catch(() => {});
}

async function writeHealth(extra = {}) {
  await fs.mkdir(path.dirname(HEALTH_FILE), { recursive: true });

  const payload = {
    ok: true,
    service: 'nexmeta-page-worker',
    browserConnected: Boolean(browser?.connected),
    pages: MANAGED_PAGES.map(page => ({
      name: page.name,
      assetId: page.assetId,
      baselineDone:
        state.pages?.[page.assetId]?.baselineDone === true,
      observedRows:
        Object.keys(state.pages?.[page.assetId]?.rows || {}).length
    })),
    processedEvents: Object.keys(state.processed || {}).length,
    observedAt: new Date().toISOString(),
    ...extra
  };

  const tmp = HEALTH_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), {
    mode: 0o600
  });
  await fs.rename(tmp, HEALTH_FILE);
}

function safeLog(event, details = {}) {
  console.log('[NexMeta Pages]', event, details);
}

async function connectBrowser() {
  if (browser?.connected) return;

  browser = await puppeteer.connect({
    browserURL: DEBUG_URL,
    defaultViewport: null
  });

  browser.on('disconnected', () => {
    browser = null;
    tabs.clear();
    safeLog('browser_disconnected');
  });

  safeLog('browser_connected');
}

async function loggedIn() {
  await connectBrowser();

  const pages = await browser.pages();
  const fbPage =
    pages.find(page =>
      /facebook\.com|business\.facebook\.com/i.test(page.url())
    ) ||
    pages[0];

  if (!fbPage) return false;

  const cookies = await fbPage.cookies('https://www.facebook.com/');
  return cookies.some(
    cookie =>
      cookie.name === 'c_user' &&
      String(cookie.value || '').trim()
  );
}

function inboxUrl(assetId) {
  return (
    'https://business.facebook.com/latest/inbox/messenger' +
    '?asset_id=' +
    encodeURIComponent(assetId)
  );
}

async function pageTab(config) {
  await connectBrowser();

  let tab = tabs.get(config.assetId);

  if (!tab || tab.isClosed()) {
    tab = await browser.newPage();
    tabs.set(config.assetId, tab);
  }

  return tab;
}

async function dismissOverlays(tab) {
  for (let round = 0; round < 10; round += 1) {
    const clicked = await tab
      .evaluate(() => {
        const cleanText = value =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim();

        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        };

        const labels =
          /^(Terminé|Fermer|OK|Done|Close|Compris|Got it)$/i;

        const candidate = [
          ...document.querySelectorAll(
            'button,[role="button"]'
          )
        ]
          .filter(visible)
          .find(element =>
            labels.test(
              cleanText(
                element.innerText ||
                element.getAttribute('aria-label') ||
                ''
              )
            )
          );

        if (!candidate) return false;

        candidate.click();
        return true;
      })
      .catch(() => false);

    if (!clicked && round > 2) break;
    await sleep(clicked ? 450 : 150);
  }
}

async function ensureInbox(config) {
  const tab = await pageTab(config);

  const current = String(tab.url() || '');
  const rightAsset =
    current.includes('business.facebook.com/latest/inbox') &&
    current.includes('asset_id=' + config.assetId);

  if (!rightAsset) {
    await tab
      .goto(inboxUrl(config.assetId), {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })
      .catch(() => {});

    await sleep(1800);
  }

  await dismissOverlays(tab);
  return tab;
}

function parseRowText(rawText) {
  const lines = String(rawText || '')
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);

  const name = lines[0] || '';

  const dateLike =
    /^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}\s+\S+\s+\d{4}|aujourd|hier|today|yesterday)/i;

  const metaLike =
    /^(?:Priorité|Priority|Suivi|Follow up|Non lu|Unread)$/i;

  const candidates = lines
    .slice(1)
    .filter(line => !dateLike.test(line))
    .filter(line => !metaLike.test(line));

  const preview = candidates[0] || '';
  const outbound =
    /^(?:Vous\s*:|You\s*:|Vous avez envoyé|You sent)/i.test(
      preview
    );

  return {
    name,
    preview,
    outbound,
    lines
  };
}

async function listRows(tab) {
  const rows = await tab.evaluate(maxRows => {
    const cleanText = value =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim();

    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };

    return [
      ...document.querySelectorAll('[role="presentation"]')
    ]
      .filter(visible)
      .map(element => {
        const rect = element.getBoundingClientRect();

        return {
          rawText: String(element.innerText || ''),
          text: cleanText(element.innerText || ''),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      })
      .filter(row =>
        row.x >= 70 &&
        row.x < 550 &&
        row.width > 250 &&
        row.height > 45 &&
        row.text
      )
      .slice(0, maxRows);
  }, MAX_ROWS);

  return rows.map(row => {
    const parsed = parseRowText(row.rawText);

    return {
      ...row,
      ...parsed,
      rowKey: hash(parsed.name || row.text).slice(0, 24),
      fingerprint: hash(row.text)
    };
  });
}

function classify(text) {
  const value = String(text || '').trim();

  const rules = [
    [/^\/?(?:download|dl|video|audio|music|musique)\b/i, 'download', 'nexdownloader'],
    [/^\/?(?:game|play|quiz|jeu|jouer)\b/i, 'game', 'nexgame'],
    [/^\/?(?:sticker|stick|emoji|pack)\b/i, 'sticker', 'nexstick'],
    [/^\/?(?:whisper|chuchoter|secret)\b/i, 'whisper', 'nexwhisper'],
    [/^\/?(?:group|groupe|moderation|admin)\b/i, 'group', 'nexgroup'],
    [/^\/?(?:channel|canal|publish|post|broadcast)\b/i, 'channel', 'nexcanal'],
    [/^\/?(?:ai|ask|nexai|stacy)\b/i, 'assistant', 'nexai']
  ];

  for (const [pattern, intent, preferredService] of rules) {
    if (pattern.test(value)) {
      return {
        intent,
        preferredService
      };
    }
  }

  return {
    intent: 'conversation',
    preferredService: 'auto'
  };
}

function signedHeaders(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));

  const signature = crypto
    .createHmac('sha256', GATEWAY_KEY)
    .update(timestamp + '.' + body)
    .digest('hex');

  return {
    'content-type': 'application/json',
    authorization: 'Bearer ' + GATEWAY_KEY,
    'x-nexus-timestamp': timestamp,
    'x-nexus-signature': 'sha256=' + signature
  };
}

async function bridgeRequest({
  config,
  externalUserId,
  text,
  eventId
}) {
  const envelope = {
    version: 2,
    source: {
      platform: 'facebook',
      surface: 'messenger',
      pageId: config.assetId
    },
    user: {
      externalId: externalUserId,
      nexusUserId: null
    },
    routing: classify(text),
    event: {
      type: 'message',
      id: eventId,
      timestamp: Date.now(),
      text,
      attachments: [],
      payload: null,
      field: null,
      action: null,
      value: null
    }
  };

  const body = JSON.stringify(envelope);

  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
    signal: AbortSignal.timeout(30000)
  });

  const raw = await response.text();
  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {
      error: 'invalid_gateway_json'
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
      data?.message ||
      'gateway_http_' + response.status
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

function replyText(data) {
  if (!data || data.duplicate === true) return '';

  const reply =
    data.reply && typeof data.reply === 'object'
      ? data.reply
      : data;

  if (!reply || reply.silent === true) return '';

  const parts = [];

  if (typeof reply.text === 'string' && reply.text.trim()) {
    parts.push(reply.text.trim());
  }

  if (reply.media?.url) {
    parts.push(String(reply.media.url));
  }

  if (Array.isArray(reply.imageUrls)) {
    for (const url of reply.imageUrls.slice(0, 8)) {
      if (url) parts.push(String(url));
    }
  }

  if (Array.isArray(reply.quickReplies) && reply.quickReplies.length) {
    const titles = reply.quickReplies
      .map(item => clean(item?.title || ''))
      .filter(Boolean)
      .slice(0, 10);

    if (titles.length) {
      parts.push(titles.map(title => '• ' + title).join('\n'));
    }
  }

  return parts.join('\n\n').trim().slice(0, 7000);
}

function splitMessage(text, max = 1800) {
  const value = String(text || '').trim();

  if (!value) return [];
  if (value.length <= max) return [value];

  const chunks = [];
  let rest = value;

  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);

    if (cut < max * 0.5) {
      cut = rest.lastIndexOf(' ', max);
    }

    if (cut < max * 0.5) {
      cut = max;
    }

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);

  return chunks.filter(Boolean);
}

async function selectedConversationId(tab) {
  try {
    const url = new URL(tab.url());
    return (
      url.searchParams.get('selected_item_id') ||
      url.searchParams.get('thread_id') ||
      ''
    );
  } catch {
    return '';
  }
}

async function openRow(tab, row) {
  await tab.mouse.click(
    row.x + row.width / 2,
    row.y + row.height / 2
  );

  await sleep(1200);

  return selectedConversationId(tab);
}

async function findComposer(tab) {
  const handles = await tab.$$(
    '[contenteditable="true"][role="textbox"],textarea'
  );

  let best = null;

  for (const handle of handles) {
    const box = await handle.boundingBox().catch(() => null);

    if (!box || box.width < 100 || box.height < 10) continue;

    if (box.x > 500) {
      best = {
        handle,
        box
      };
      break;
    }
  }

  return best;
}

async function sendMessage(tab, text) {
  for (const chunk of splitMessage(text)) {
    let composer = await findComposer(tab);

    if (!composer) {
      await sleep(700);
      composer = await findComposer(tab);
    }

    if (!composer) {
      throw new Error('page_message_composer_not_found');
    }

    await composer.handle.focus();
    await tab.keyboard.insertText(chunk);
    await sleep(180);
    await tab.keyboard.press('Enter');
    await sleep(650);
  }
}

async function baselinePage(config, rows) {
  state.pages[config.assetId] = {
    baselineDone: true,
    rows: Object.fromEntries(
      rows.map(row => [
        row.rowKey,
        row.fingerprint
      ])
    ),
    updatedAt: new Date().toISOString()
  };

  await saveState();

  safeLog('baseline_ready', {
    page: config.name,
    rows: rows.length
  });
}

async function processRow(config, tab, pageState, row) {
  if (row.outbound) {
    pageState.rows[row.rowKey] = row.fingerprint;
    return;
  }

  const text = clean(row.preview);

  if (!text) {
    pageState.rows[row.rowKey] = row.fingerprint;
    return;
  }

  const conversationId =
    await openRow(tab, row) ||
    row.rowKey;

  const eventId = hash(
    config.assetId +
    '\n' +
    conversationId +
    '\n' +
    row.fingerprint +
    '\n' +
    text
  );

  if (state.processed[eventId]) {
    pageState.rows[row.rowKey] = row.fingerprint;
    return;
  }

  safeLog('inbound_detected', {
    page: config.name,
    thread: hash(conversationId).slice(0, 12),
    length: text.length
  });

  const routed = await bridgeRequest({
    config,
    externalUserId: conversationId,
    text,
    eventId
  });

  const response = replyText(routed);

  if (response) {
    await sendMessage(tab, response);
  }

  state.processed[eventId] = Date.now();
  pageState.rows[row.rowKey] = row.fingerprint;

  safeLog('reply_completed', {
    page: config.name,
    thread: hash(conversationId).slice(0, 12),
    handledBy: routed?.handledBy || null,
    replyLength: response.length
  });
}

async function scanPage(config) {
  const tab = await ensureInbox(config);
  const rows = await listRows(tab);

  const pageState =
    state.pages[config.assetId] || {
      baselineDone: false,
      rows: {},
      updatedAt: null
    };

  if (!pageState.baselineDone) {
    await baselinePage(config, rows);
    return;
  }

  const changed = rows.filter(row => {
    const previous = pageState.rows[row.rowKey];
    return !previous || previous !== row.fingerprint;
  });

  for (const row of changed.slice(0, MAX_CHANGED)) {
    try {
      await processRow(config, tab, pageState, row);
    } catch (error) {
      safeLog('thread_error', {
        page: config.name,
        thread: row.rowKey,
        error: String(error?.message || error).slice(0, 160)
      });
    }

    await ensureInbox(config);
  }

  for (const row of rows) {
    if (!pageState.rows[row.rowKey]) {
      pageState.rows[row.rowKey] = row.fingerprint;
    }
  }

  pageState.updatedAt = new Date().toISOString();
  state.pages[config.assetId] = pageState;

  await saveState();
}

async function cycle() {
  if (running) return;
  running = true;

  try {
    if (!GATEWAY_KEY) {
      throw new Error('NEXUS_COMMAND_GATEWAY_KEY missing');
    }

    if (!await loggedIn()) {
      await writeHealth({
        loggedIn: false,
        waitingForLogin: true
      });
      return;
    }

    for (const config of MANAGED_PAGES) {
      await scanPage(config);
    }

    await writeHealth({
      loggedIn: true,
      waitingForLogin: false,
      lastCycleOk: true
    });
  } catch (error) {
    safeLog('cycle_error', {
      error: String(error?.message || error).slice(0, 180)
    });

    await writeHealth({
      lastCycleOk: false,
      lastError: String(error?.message || error).slice(0, 180)
    }).catch(() => {});

    if (!browser?.connected) {
      browser = null;
      tabs.clear();
    }
  } finally {
    running = false;
  }
}

safeLog('worker_started', {
  pages: MANAGED_PAGES.map(page => page.name),
  pollMs: POLL_MS
});

await cycle();

setInterval(() => {
  cycle().catch(() => {});
}, POLL_MS);
