(() => {
  if (window.__NEXMETA_COMPANION_CONTENT__) return;
  window.__NEXMETA_COMPANION_CONTENT__ = true;

  const POLL_MS = 2500;
  const MAX_READ_ITEMS = 120;
  let polling = false;
  let lastEventFingerprint = '';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  }

  function supportedUrl(value) {
    try {
      const url = new URL(value, location.href);
      return [
        'facebook.com',
        'www.facebook.com',
        'web.facebook.com',
        'm.facebook.com',
        'messenger.com',
        'www.messenger.com'
      ].includes(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function normalizedUrl(value) {
    try {
      const url = new URL(value, location.href);
      url.hash = '';
      return url.toString();
    } catch {
      return String(value || '');
    }
  }

  function pageContext() {
    const loginField = document.querySelector(
      'input[name="email"], input[name="pass"], form[action*="login"]'
    );

    const profileCandidate = [
      ...document.querySelectorAll(
        'a[aria-label][href*="facebook.com"], a[href*="/me/"], a[href*="/profile.php"]'
      )
    ].find(visible);

    return {
      url: location.href,
      title: document.title,
      host: location.hostname,
      loggedInLikely: !loginField,
      profileLabel:
        profileCandidate?.getAttribute('aria-label') ||
        profileCandidate?.textContent?.trim()?.slice(0, 120) ||
        null,
      visibility: document.visibilityState,
      observedAt: new Date().toISOString()
    };
  }

  function conversationLinks() {
    const seen = new Set();
    const items = [];

    for (const anchor of document.querySelectorAll('a[href*="/messages/t/"]')) {
      if (!visible(anchor)) continue;

      const href = normalizedUrl(anchor.href);
      if (!supportedUrl(href) || seen.has(href)) continue;
      seen.add(href);

      const text = String(
        anchor.getAttribute('aria-label') ||
        anchor.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

      items.push({
        url: href,
        label: text || null
      });

      if (items.length >= 80) break;
    }

    return items;
  }

  function readVisibleConversation() {
    const main =
      document.querySelector('div[role="main"]') ||
      document.querySelector('main') ||
      document.body;

    const seen = new Set();
    const messages = [];
    const candidates = main.querySelectorAll(
      '[dir="auto"], [data-ad-comet-preview="message"], div[role="row"]'
    );

    for (const node of candidates) {
      if (!visible(node)) continue;

      const text = String(node.innerText || node.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (
        text.length < 1 ||
        text.length > 2500 ||
        seen.has(text)
      ) {
        continue;
      }

      seen.add(text);
      messages.push(text);

      if (messages.length >= MAX_READ_ITEMS) break;
    }

    return {
      url: location.href,
      title: document.title,
      items: messages
    };
  }

  function composerCandidates() {
    return [
      ...document.querySelectorAll(
        '[contenteditable="true"][role="textbox"],' +
        '[contenteditable="true"][data-lexical-editor="true"]'
      )
    ].filter(visible);
  }

  function chooseComposer() {
    const candidates = composerCandidates();
    if (!candidates.length) return null;

    const preferred = candidates.find(node => {
      const label = String(
        node.getAttribute('aria-label') ||
        node.getAttribute('data-placeholder') ||
        ''
      ).toLowerCase();

      return (
        /message|envoyer|écrire|write|mensaje|nachricht|messaggio|mensagem|type/.test(label) ||
        Boolean(node.closest('[role="main"]'))
      );
    });

    return preferred || candidates[candidates.length - 1];
  }

  async function waitForComposer(timeoutMs = 15000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const composer = chooseComposer();
      if (composer) return composer;
      await sleep(300);
    }

    return null;
  }

  function replaceEditableText(element, text) {
    element.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }

    if (!inserted || !String(element.innerText || '').includes(text)) {
      element.textContent = text;

      try {
        element.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          })
        );
      } catch {}

      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        })
      );
    }
  }

  function findSendButton() {
    const patterns = [
      'send',
      'envoyer',
      'enviar',
      'senden',
      'invia',
      'enviar mensagem'
    ];

    const nodes = document.querySelectorAll(
      'button[aria-label], div[role="button"][aria-label]'
    );

    return [...nodes].find(node => {
      if (!visible(node)) return false;
      const label = String(node.getAttribute('aria-label') || '').toLowerCase();
      return patterns.some(pattern => label === pattern || label.includes(pattern));
    }) || null;
  }

  function pressEnter(element) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      element.dispatchEvent(
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

  async function sendMessage(text) {
    const message = String(text || '');
    if (!message.trim()) throw new Error('message_text_required');
    if (message.length > 5000) throw new Error('message_too_long');

    const composer = await waitForComposer();
    if (!composer) throw new Error('message_composer_not_found');

    replaceEditableText(composer, message);
    await sleep(350);

    const sendButton = findSendButton();
    if (sendButton) {
      sendButton.click();
    } else {
      pressEnter(composer);
    }

    await sleep(700);

    return {
      sent: true,
      url: location.href,
      usedButton: Boolean(sendButton),
      textLength: message.length
    };
  }

  async function deferNavigation(command, targetUrl) {
    if (!supportedUrl(targetUrl)) {
      throw new Error('target_url_not_allowed');
    }

    await chrome.storage.local.set({
      nexmetaPendingCommand: {
        command,
        targetUrl: normalizedUrl(targetUrl),
        savedAt: Date.now()
      }
    });

    location.assign(targetUrl);
    return { deferred: true };
  }

  function targetAlreadyOpen(targetUrl) {
    try {
      const target = new URL(targetUrl, location.href);
      const current = new URL(location.href);
      return (
        target.hostname === current.hostname &&
        target.pathname.replace(/\/+$/, '') ===
          current.pathname.replace(/\/+$/, '')
      );
    } catch {
      return false;
    }
  }

  async function executeCommand(command) {
    const type = String(command?.type || '');
    const payload = command?.payload && typeof command.payload === 'object'
      ? command.payload
      : {};

    if (type === 'ping') {
      return {
        pong: true,
        context: pageContext()
      };
    }

    if (type === 'get_context') {
      return pageContext();
    }

    if (type === 'open_url') {
      const targetUrl = String(payload.url || '');
      if (!supportedUrl(targetUrl)) throw new Error('target_url_not_allowed');

      if (!targetAlreadyOpen(targetUrl)) {
        return deferNavigation(command, targetUrl);
      }

      return {
        opened: true,
        url: location.href
      };
    }

    if (type === 'list_conversations') {
      return {
        url: location.href,
        conversations: conversationLinks()
      };
    }

    if (type === 'read_conversation') {
      const targetUrl = String(payload.url || payload.threadUrl || '');
      if (targetUrl && !targetAlreadyOpen(targetUrl)) {
        return deferNavigation(command, targetUrl);
      }

      return readVisibleConversation();
    }

    if (type === 'send_message') {
      const targetUrl = String(payload.url || payload.threadUrl || '');
      if (targetUrl && !targetAlreadyOpen(targetUrl)) {
        return deferNavigation(command, targetUrl);
      }

      return sendMessage(payload.text);
    }

    throw new Error('unsupported_companion_command');
  }

  async function ack(commandId, ok, result, error) {
    const response = await chrome.runtime.sendMessage({
      type: 'NEXMETA_ACK',
      commandId,
      ok,
      result,
      error
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'ack_failed');
    }
  }

  async function processCommand(command) {
    try {
      const result = await executeCommand(command);
      if (result?.deferred) return;
      await ack(command.commandId, true, result, null);
    } catch (error) {
      await ack(
        command.commandId,
        false,
        null,
        String(error?.message || error)
      ).catch(() => {});
    }
  }

  async function resumePendingCommand() {
    const data = await chrome.storage.local.get('nexmetaPendingCommand');
    const pending = data?.nexmetaPendingCommand;
    if (!pending?.command) return;

    const age = Date.now() - Number(pending.savedAt || 0);
    if (!Number.isFinite(age) || age > 10 * 60 * 1000) {
      await chrome.storage.local.remove('nexmetaPendingCommand');
      await ack(
        pending.command.commandId,
        false,
        null,
        'navigation_resume_expired'
      ).catch(() => {});
      return;
    }

    if (
      pending.targetUrl &&
      !targetAlreadyOpen(pending.targetUrl)
    ) {
      return;
    }

    await chrome.storage.local.remove('nexmetaPendingCommand');
    await sleep(1000);
    await processCommand(pending.command);
  }

  async function maybePushContext(context) {
    const fingerprint = JSON.stringify([
      context.url,
      context.title,
      context.loggedInLikely,
      context.profileLabel
    ]);

    if (fingerprint === lastEventFingerprint) return;
    lastEventFingerprint = fingerprint;

    await chrome.runtime.sendMessage({
      type: 'NEXMETA_EVENTS',
      context,
      events: [
        {
          type: 'page_context',
          payload: context
        }
      ]
    }).catch(() => {});
  }

  async function tick() {
    if (polling) return;
    polling = true;

    try {
      const context = pageContext();
      const response = await chrome.runtime.sendMessage({
        type: 'NEXMETA_POLL_TICK',
        context
      });

      if (!response?.ok) return;

      await maybePushContext(context);

      const commands = Array.isArray(response?.result?.commands)
        ? response.result.commands
        : [];

      for (const command of commands) {
        await processCommand(command);
      }
    } finally {
      polling = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (String(message?.type || '') !== 'NEXMETA_WAKE') return false;

    Promise.resolve()
      .then(() => resumePendingCommand())
      .then(() => tick())
      .then(() => sendResponse({
        ok: true,
        context: pageContext()
      }))
      .catch(error => {
        sendResponse({
          ok: false,
          error: String(error?.message || error)
        });
      });

    return true;
  });

  window.addEventListener('pageshow', () => {
    tick().catch(() => {});
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tick().catch(() => {});
    }
  });

  resumePendingCommand().catch(() => {});
  tick().catch(() => {});
  setInterval(() => {
    tick().catch(() => {});
  }, POLL_MS);
})();
