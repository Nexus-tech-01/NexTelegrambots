import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

import { routeNexusEvent } from './router.mjs';

const DEBUG_URL = String(
  process.env.NEXMETA_PERSONAL_BROWSER_URL ||
  'http://127.0.0.1:9223'
).trim();

const STATE_FILE = String(
  process.env.NEXMETA_PERSONAL_STATE_FILE ||
  '/var/lib/nex/nexmeta/personal-worker-state.json'
).trim();

const POLL_MS = Math.max(
  4000,
  Math.min(60000, Number(process.env.NEXMETA_PERSONAL_POLL_MS || 7000))
);

const MAX_THREADS = Math.max(
  3,
  Math.min(30, Number(process.env.NEXMETA_PERSONAL_MAX_THREADS || 12))
);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function threadKey(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/messages\/t\/([^/?#]+)/);
    return match?.[1] || parsed.pathname;
  } catch {
    return String(url || '');
  }
}

async function loadState() {
  try {
    const data = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return {
      bootstrapDone: data?.bootstrapDone === true,
      previewByThread:
        data?.previewByThread && typeof data.previewByThread === 'object'
          ? data.previewByThread
          : {},
      seen: Array.isArray(data?.seen) ? data.seen.slice(-1500) : [],
      lastSentByThread:
        data?.lastSentByThread && typeof data.lastSentByThread === 'object'
          ? data.lastSentByThread
          : {},
      accessClosed: data?.accessClosed === true
    };
  } catch {
    return {
      bootstrapDone: false,
      previewByThread: {},
      seen: [],
      lastSentByThread: {},
      accessClosed: false
    };
  }
}

async function saveState(state) {
  await fs.mkdir(new URL('.', 'file://' + STATE_FILE).pathname, {
    recursive: true
  }).catch(() => {});

  const payload = {
    bootstrapDone: state.bootstrapDone === true,
    previewByThread: state.previewByThread || {},
    seen: Array.from(new Set(state.seen || [])).slice(-1500),
    lastSentByThread: state.lastSentByThread || {},
    accessClosed: state.accessClosed === true,
    updatedAt: new Date().toISOString()
  };

  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, STATE_FILE);
}

async function connectBrowser() {
  return puppeteer.connect({
    browserURL: DEBUG_URL,
    defaultViewport: null
  });
}

async function facebookPage(browser) {
  const pages = await browser.pages();
  return (
    pages.find(page => /(?:facebook|messenger)\.com/i.test(page.url())) ||
    pages[0] ||
    null
  );
}

async function loggedIn(page) {
  const cookies = await page.cookies('https://www.facebook.com/');
  return cookies.some(cookie => cookie.name === 'c_user' && cookie.value);
}

async function closeInteractiveAccess(state) {
  if (state.accessClosed) return;

  const { execFile } = await import('node:child_process');
  const stop = service =>
    new Promise(resolve => {
      execFile(
        '/bin/systemctl',
        ['stop', service],
        { timeout: 15000 },
        () => resolve()
      );
    });

  for (const service of [
    'nexmeta-interactive-tunnel.service',
    'nexmeta-interactive-proxy.service',
    'nexmeta-interactive-novnc.service',
    'nexmeta-interactive-vnc.service'
  ]) {
    await stop(service);
  }

  state.accessClosed = true;
  await saveState(state);
  console.log('[NexMeta Personal] temporary VNC access closed');
}

async function gotoMessages(page) {
  if (!/facebook\.com\/messages/i.test(page.url())) {
    await page.goto('https://www.facebook.com/messages/?locale=fr_FR', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(2500);
  }
}

async function listConversations(page) {
  return page.evaluate(maxThreads => {
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

    const seen = new Set();
    const rows = [];

    for (const anchor of document.querySelectorAll('a[href*="/messages/t/"]')) {
      if (!visible(anchor)) continue;

      let href = '';
      try {
        const url = new URL(anchor.href, location.href);
        url.hash = '';
        href = url.toString();
      } catch {
        continue;
      }

      if (seen.has(href)) continue;
      seen.add(href);

      const container =
        anchor.closest('[role="row"]') ||
        anchor.parentElement ||
        anchor;

      const label = String(
        anchor.getAttribute('aria-label') ||
        container.getAttribute?.('aria-label') ||
        container.innerText ||
        anchor.innerText ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1200);

      rows.push({ url: href, label });
      if (rows.length >= maxThreads) break;
    }

    return rows;
  }, MAX_THREADS);
}

async function readLatestMessage(page) {
  return page.evaluate(() => {
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

    const main =
      document.querySelector('div[role="main"]') ||
      document.querySelector('main') ||
      document.body;

    const rows = [...main.querySelectorAll('div[role="row"]')];
    const candidates = [];

    for (const row of rows) {
      if (!visible(row)) continue;

      const textNodes = [...row.querySelectorAll('[dir="auto"]')]
        .filter(visible)
        .filter(node => !node.closest('[contenteditable="true"]'));

      let bubble = null;
      let text = '';

      for (const node of textNodes) {
        const value = String(node.innerText || node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!value || value.length > 4000) continue;
        bubble = node;
        text = value;
      }

      if (!bubble || !text) continue;

      const rect = bubble.getBoundingClientRect();
      const context = String(
        row.getAttribute('aria-label') ||
        row.innerText ||
        ''
      ).toLowerCase();

      const explicitOutbound =
        /vous avez envoyé|vous avez répondu|you sent|you replied|sent by you/.test(
          context
        );

      const rightAligned =
        rect.left + rect.width / 2 > window.innerWidth * 0.58;

      candidates.push({
        text,
        outbound: explicitOutbound || rightAligned,
        y: rect.top,
        x: rect.left
      });
    }

    candidates.sort((a, b) => a.y - b.y);
    return candidates[candidates.length - 1] || null;
  });
}

async function sendMessage(page, text) {
  const message = String(text || '').trim();
  if (!message) return false;

  return page.evaluate(async message => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

    const composers = [
      ...document.querySelectorAll(
        '[contenteditable="true"][role="textbox"],' +
        '[contenteditable="true"][data-lexical-editor="true"]'
      )
    ].filter(visible);

    const composer =
      composers.find(node => {
        const label = String(
          node.getAttribute('aria-label') ||
          node.getAttribute('data-placeholder') ||
          ''
        ).toLowerCase();

        return (
          /message|envoyer|écrire|write|type/.test(label) ||
          Boolean(node.closest('[role="main"]'))
        );
      }) ||
      composers[composers.length - 1];

    if (!composer) throw new Error('message_composer_not_found');

    composer.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, message);
    } catch {
      inserted = false;
    }

    if (!inserted || !String(composer.innerText || '').includes(message)) {
      composer.textContent = message;
      composer.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: message
        })
      );
    }

    await sleep(300);

    const sendButton = [
      ...document.querySelectorAll(
        'button[aria-label],div[role="button"][aria-label]'
      )
    ].find(node => {
      if (!visible(node)) return false;
      const label = String(node.getAttribute('aria-label') || '').toLowerCase();
      return /^(envoyer|send)$/.test(label) || label.includes('envoyer');
    });

    if (sendButton) {
      sendButton.click();
    } else {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        composer.dispatchEvent(
          new KeyboardEvent(type, {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          })
        );
      }
    }

    await sleep(800);
    return true;
  }, message);
}

function renderBrowserReply(result) {
  if (!result || result.silent) return '';

  const lines = [];

  if (typeof result.text === 'string' && result.text.trim()) {
    lines.push(result.text.trim());
  }

  if (result.media?.url) {
    lines.push(String(result.media.url));
  }

  if (Array.isArray(result.imageUrls)) {
    lines.push(
      ...result.imageUrls
        .map(String)
        .filter(Boolean)
        .slice(0, 10)
    );
  }

  if (result.template) {
    lines.push('[Contenu interactif disponible via NexMeta]');
  }

  if (Array.isArray(result.quickReplies) && result.quickReplies.length) {
    const options = result.quickReplies
      .map(item => String(item?.title || '').trim())
      .filter(Boolean)
      .slice(0, 10);

    if (options.length) {
      lines.push(options.join(' · '));
    }
  }

  return lines.join('\n\n').slice(0, 5000);
}

function friendlyError(error) {
  const code = String(error?.message || error || '');

  if (code.includes('identity_link_required')) {
    return 'Cette commande nécessite une identité Nexus liée.';
  }

  if (code.includes('permission_denied')) {
    return 'Tu n’as pas l’autorisation nécessaire pour cette commande.';
  }

  if (code.includes('rate_limited')) {
    return 'Trop de demandes rapprochées. Réessaie dans un instant.';
  }

  if (code.includes('service_unavailable')) {
    return 'Ce service Nexus est momentanément indisponible.';
  }

  return 'NexMeta a rencontré une erreur en traitant ce message. Réessaie dans un instant.';
}

async function processConversation(page, state, conversation) {
  const key = threadKey(conversation.url);

  await page.goto(conversation.url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await sleep(1800);

  const latest = await readLatestMessage(page);
  if (!latest?.text) return;

  const fingerprint = hash(
    [
      key,
      latest.text,
      conversation.label || '',
      latest.outbound ? 'out' : 'in'
    ].join('\n')
  );

  if (state.seen.includes(fingerprint)) return;

  state.seen.push(fingerprint);
  state.seen = state.seen.slice(-1500);

  if (latest.outbound) {
    await saveState(state);
    return;
  }

  const recentlySent = state.lastSentByThread[key];
  if (
    recentlySent &&
    hash(latest.text) === recentlySent &&
    Date.now() - Number(state.lastSentAtByThread?.[key] || 0) < 120000
  ) {
    await saveState(state);
    return;
  }

  const event = {
    platform: 'facebook',
    surface: 'messenger',
    pageId: 'personal-account',
    senderId: key,
    recipientId: 'personal-account',
    timestamp: Date.now(),
    type: 'message',
    externalMessageId: fingerprint,
    text: latest.text,
    attachments: [],
    quickReplyPayload: null,
    isEcho: false
  };

  let reply = '';

  try {
    const result = await routeNexusEvent(event, {
      identity: { nexusUserId: null }
    });

    reply = renderBrowserReply(result);
  } catch (error) {
    console.error(
      '[NexMeta Personal] route failed',
      String(error?.message || error)
    );
    reply = friendlyError(error);
  }

  if (!reply) {
    await saveState(state);
    return;
  }

  await sendMessage(page, reply);

  state.lastSentByThread[key] = hash(reply);
  state.lastSentAtByThread ||= {};
  state.lastSentAtByThread[key] = Date.now();

  await saveState(state);

  console.log('[NexMeta Personal] replied', {
    thread: key.slice(0, 80),
    inputLength: latest.text.length,
    replyLength: reply.length
  });
}

async function scan(page, state) {
  await gotoMessages(page);
  await sleep(1000);

  const conversations = await listConversations(page);

  if (!conversations.length) {
    console.log('[NexMeta Personal] no conversations visible');
    return;
  }

  if (!state.bootstrapDone) {
    for (const conversation of conversations) {
      state.previewByThread[threadKey(conversation.url)] = hash(
        conversation.label || conversation.url
      );
    }

    state.bootstrapDone = true;
    await saveState(state);

    console.log('[NexMeta Personal] baseline ready', {
      conversations: conversations.length
    });

    return;
  }

  const changed = [];

  for (const conversation of conversations) {
    const key = threadKey(conversation.url);
    const preview = hash(conversation.label || conversation.url);

    if (state.previewByThread[key] !== preview) {
      changed.push(conversation);
    }

    state.previewByThread[key] = preview;
  }

  await saveState(state);

  for (const conversation of changed.slice(0, 5)) {
    await processConversation(page, state, conversation);
  }

  await gotoMessages(page);
}

async function main() {
  const state = await loadState();

  console.log('[NexMeta Personal] worker started', {
    debugUrl: DEBUG_URL,
    pollMs: POLL_MS,
    maxThreads: MAX_THREADS
  });

  let browser = null;

  for (;;) {
    try {
      if (!browser?.connected) {
        browser = await connectBrowser();
      }

      const page = await facebookPage(browser);
      if (!page) throw new Error('facebook_page_missing');

      if (!await loggedIn(page)) {
        console.log('[NexMeta Personal] waiting for Facebook login');
        await sleep(POLL_MS);
        continue;
      }

      await closeInteractiveAccess(state);
      await scan(page, state);
    } catch (error) {
      console.error(
        '[NexMeta Personal] loop error',
        String(error?.message || error)
      );

      try {
        await browser?.disconnect();
      } catch {}

      browser = null;
    }

    await sleep(POLL_MS);
  }
}

main().catch(error => {
  console.error('[NexMeta Personal] fatal', error);
  process.exit(1);
});
