const DEFAULT_SERVER =
  'https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexmeta-public';

let pollInFlight = false;
let wakeInFlight = false;
let backgroundDispatchInFlight = false;

const HEARTBEAT_ALARM = 'nexmeta-heartbeat';
const BACKGROUND_POLL_ALARM = 'nexmeta-background-poll';
const BACKGROUND_POLL_PERIOD_MINUTES = 0.5;

const FACEBOOK_PATTERNS = [
  'https://facebook.com/*',
  'https://www.facebook.com/*',
  'https://web.facebook.com/*',
  'https://m.facebook.com/*',
  'https://*.facebook.com/*',
  'https://messenger.com/*',
  'https://www.messenger.com/*',
  'https://*.messenger.com/*'
];

async function loadState() {
  const data = await chrome.storage.local.get([
    'nexmetaServer',
    'nexmetaDeviceId',
    'nexmetaDeviceToken',
    'nexmetaDeviceName',
    'nexmetaPairedAt'
  ]);

  return {
    server: String(data.nexmetaServer || DEFAULT_SERVER).replace(/\/+$/, ''),
    deviceId: data.nexmetaDeviceId || null,
    token: data.nexmetaDeviceToken || null,
    deviceName: data.nexmetaDeviceName || null,
    pairedAt: data.nexmetaPairedAt || null
  };
}

async function savePairing({
  server,
  deviceId,
  deviceToken,
  deviceName,
  pairedAt
}) {
  await chrome.storage.local.set({
    nexmetaServer: server,
    nexmetaDeviceId: deviceId,
    nexmetaDeviceToken: deviceToken,
    nexmetaDeviceName: deviceName,
    nexmetaPairedAt: pairedAt
  });
}

async function clearPairing() {
  await chrome.storage.local.remove([
    'nexmetaDeviceId',
    'nexmetaDeviceToken',
    'nexmetaDeviceName',
    'nexmetaPairedAt',
    'nexmetaPendingCommand'
  ]);
}

async function api(path, {
  method = 'GET',
  body,
  auth = true,
  server
} = {}) {
  const state = await loadState();
  const base = String(server || state.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const headers = {
    accept: 'application/json'
  };

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (auth) {
    if (!state.token) throw new Error('not_paired');
    headers.authorization = 'Bearer ' + state.token;
  }

  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store'
  });

  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = {
      ok: false,
      error: 'invalid_server_response',
      preview: text.slice(0, 200)
    };
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(
      payload?.error ||
      payload?.message ||
      'http_' + response.status
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload?.result ?? payload;
}

async function facebookTabs() {
  try {
    return await chrome.tabs.query({ url: FACEBOOK_PATTERNS });
  } catch {
    return [];
  }
}

function tabRank(tab) {
  let score = 0;
  if (tab?.active) score += 100;
  if (!tab?.discarded) score += 50;
  const url = String(tab?.url || '').toLowerCase();
  if (url.includes('/messages/')) score += 30;
  if (url.includes('web.facebook.com')) score += 20;
  if (url.includes('www.facebook.com')) score += 15;
  if (url.includes('messenger.com')) score += 15;
  return score;
}

function sortedFacebookTabs(tabs) {
  return [...tabs].sort((a, b) => tabRank(b) - tabRank(a));
}

async function injectCompanion(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function sendToTab(tabId, message, { injectOnFailure = true } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    if (!injectOnFailure) throw firstError;
    await injectCompanion(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function wakeFacebookTabs() {
  if (wakeInFlight) return { tabs: 0, awakened: 0, injected: 0 };
  wakeInFlight = true;

  try {
    const tabs = sortedFacebookTabs(await facebookTabs());
    let awakened = 0;
    let injected = 0;

    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || tab?.discarded) continue;

      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'NEXMETA_WAKE',
          source: 'background'
        });
        if (response?.ok !== false) awakened += 1;
        continue;
      } catch {}

      try {
        await injectCompanion(tab.id);
        injected += 1;

        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'NEXMETA_WAKE',
          source: 'background'
        });
        if (response?.ok !== false) awakened += 1;
      } catch {}
    }

    return {
      tabs: tabs.length,
      awakened,
      injected
    };
  } finally {
    wakeInFlight = false;
  }
}

async function heartbeatAndWake() {
  const state = await loadState();
  if (!state.token) return { paired: false, tabs: 0 };

  try {
    const device = await api('/companion/v1/status');
    const wake = await wakeFacebookTabs();

    return {
      paired: true,
      device,
      ...wake
    };
  } catch (error) {
    if (error?.status === 401) {
      await clearPairing();
      return {
        paired: false,
        revoked: true,
        tabs: 0
      };
    }

    return {
      paired: true,
      offline: true,
      error: String(error?.message || error),
      tabs: 0
    };
  }
}

function scheduleAlarms() {
  try {
    chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 0.1,
      periodInMinutes: 1
    });
  } catch {}

  try {
    chrome.alarms.create(BACKGROUND_POLL_ALARM, {
      delayInMinutes: 0.05,
      periodInMinutes: BACKGROUND_POLL_PERIOD_MINUTES
    });
  } catch {
    try {
      chrome.alarms.create(BACKGROUND_POLL_ALARM, {
        delayInMinutes: 0.1,
        periodInMinutes: 1
      });
    } catch {}
  }
}

async function pairDevice(message) {
  const server = String(message.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const deviceName = String(message.deviceName || 'Facebook browser').slice(0, 120);
  const result = await api('/companion/v1/pair', {
    method: 'POST',
    auth: false,
    server,
    body: {
      pairCode: String(message.pairCode || '').trim(),
      deviceName,
      platform: navigator.userAgentData?.platform || navigator.platform || 'browser',
      clientVersion: chrome.runtime.getManifest().version,
      capabilities: [
        'ping',
        'get_context',
        'open_url',
        'list_conversations',
        'read_conversation',
        'send_message',
        'background_dispatch'
      ]
    }
  });

  await savePairing({
    server,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
    deviceName,
    pairedAt: result.pairedAt || new Date().toISOString()
  });

  scheduleAlarms();
  await wakeFacebookTabs().catch(() => {});
  backgroundPollAndDispatch('paired').catch(() => {});

  return {
    paired: true,
    deviceId: result.deviceId,
    server
  };
}

async function poll(context) {
  if (pollInFlight) return { commands: [] };
  pollInFlight = true;

  try {
    const result = await api('/companion/v1/poll', {
      method: 'POST',
      body: {
        limit: 10,
        context: context || {}
      }
    });

    return {
      commands: Array.isArray(result?.commands) ? result.commands : [],
      device: result?.device || null
    };
  } finally {
    pollInFlight = false;
  }
}

async function ack(message) {
  return api('/companion/v1/ack', {
    method: 'POST',
    body: {
      commandId: message.commandId,
      ok: message.ok === true,
      result: message.result,
      error: message.error
    }
  });
}

async function pushEvents(message) {
  return api('/companion/v1/events', {
    method: 'POST',
    body: {
      context: message.context || {},
      events: Array.isArray(message.events) ? message.events : []
    }
  });
}

function sameConversationTarget(tabUrl, command) {
  const target = String(
    command?.payload?.threadUrl ||
    command?.payload?.url ||
    ''
  );

  if (!target) return false;

  try {
    const a = new URL(tabUrl);
    const b = new URL(target);
    return (
      a.hostname === b.hostname &&
      a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

async function dispatchCommandToBrowser(command) {
  const tabs = sortedFacebookTabs(await facebookTabs());
  if (!tabs.length) {
    return {
      delivered: false,
      reason: 'no_facebook_tab'
    };
  }

  const exact = tabs.filter(tab => sameConversationTarget(String(tab?.url || ''), command));
  const candidates = [...exact, ...tabs.filter(tab => !exact.includes(tab))];

  for (const tab of candidates) {
    if (!Number.isInteger(tab?.id) || tab?.discarded) continue;

    try {
      const response = await sendToTab(tab.id, {
        type: 'NEXMETA_EXECUTE_COMMAND',
        command,
        source: 'background_service_worker'
      });

      return {
        delivered: true,
        tabId: tab.id,
        commandOk: response?.ok !== false,
        deferred: response?.deferred === true,
        error: response?.error || null
      };
    } catch {}
  }

  return {
    delivered: false,
    reason: 'no_live_facebook_tab'
  };
}

async function backgroundPollAndDispatch(reason = 'alarm') {
  if (backgroundDispatchInFlight) {
    return { skipped: true, reason: 'dispatch_in_flight' };
  }

  backgroundDispatchInFlight = true;

  try {
    const state = await loadState();
    if (!state.token) return { paired: false };

    const tabs = await facebookTabs();
    const activeTab = sortedFacebookTabs(tabs)[0] || null;

    const result = await poll({
      source: 'extension_background',
      reason,
      observedAt: new Date().toISOString(),
      openFacebookTabs: tabs.length,
      activeFacebookUrl: String(activeTab?.url || ''),
      activeFacebookTabDiscarded: Boolean(activeTab?.discarded)
    });

    const commands = Array.isArray(result?.commands) ? result.commands : [];
    const dispatch = [];

    for (const command of commands) {
      dispatch.push({
        commandId: command?.commandId || null,
        type: command?.type || null,
        ...(await dispatchCommandToBrowser(command))
      });
    }

    return {
      paired: true,
      commands: commands.length,
      dispatch
    };
  } catch (error) {
    if (error?.status === 401) {
      await clearPairing();
      return { paired: false, revoked: true };
    }

    return {
      paired: true,
      error: String(error?.message || error)
    };
  } finally {
    backgroundDispatchInFlight = false;
  }
}

async function connectionStatus() {
  const state = await loadState();

  if (!state.token) {
    return {
      paired: false,
      server: state.server
    };
  }

  try {
    const device = await api('/companion/v1/status');
    const wake = await wakeFacebookTabs().catch(() => ({
      tabs: 0,
      awakened: 0,
      injected: 0
    }));

    backgroundPollAndDispatch('status_check').catch(() => {});

    return {
      paired: true,
      server: state.server,
      device,
      wake,
      backgroundPolling: true,
      backgroundPollMinutes: BACKGROUND_POLL_PERIOD_MINUTES
    };
  } catch (error) {
    if (error?.status === 401) {
      await clearPairing();
      return {
        paired: false,
        server: state.server,
        revoked: true
      };
    }
    return {
      paired: true,
      server: state.server,
      deviceId: state.deviceId,
      offline: true,
      error: String(error?.message || error)
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = String(message?.type || '');

  (async () => {
    if (type === 'NEXMETA_STATUS') {
      return connectionStatus();
    }

    if (type === 'NEXMETA_PAIR') {
      return pairDevice(message);
    }

    if (type === 'NEXMETA_UNPAIR') {
      await clearPairing();
      return { paired: false };
    }

    if (type === 'NEXMETA_POLL_TICK') {
      const state = await loadState();
      if (!state.token) return { commands: [] };
      return poll(message.context || {});
    }

    if (type === 'NEXMETA_BACKGROUND_POLL') {
      return backgroundPollAndDispatch('manual');
    }

    if (type === 'NEXMETA_ACK') {
      return ack(message);
    }

    if (type === 'NEXMETA_EVENTS') {
      return pushEvents(message);
    }

    throw new Error('unsupported_message');
  })()
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => {
      sendResponse({
        ok: false,
        error: String(error?.message || error),
        status: error?.status || null
      });
    });

  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port?.name !== 'nexmeta-keepalive') return;
  port.onMessage.addListener(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarms();
  heartbeatAndWake().catch(() => {});
  backgroundPollAndDispatch('installed').catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  heartbeatAndWake().catch(() => {});
  backgroundPollAndDispatch('startup').catch(() => {});
});

chrome.tabs.onActivated.addListener(() => {
  backgroundPollAndDispatch('tab_activated').catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo?.status !== 'complete') return;
  const url = String(tab?.url || '').toLowerCase();
  if (!url.includes('facebook.com') && !url.includes('messenger.com')) return;
  backgroundPollAndDispatch('facebook_tab_updated').catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === HEARTBEAT_ALARM) {
    heartbeatAndWake().catch(() => {});
    return;
  }

  if (alarm?.name === BACKGROUND_POLL_ALARM) {
    backgroundPollAndDispatch('alarm').catch(() => {});
  }
});

scheduleAlarms();
heartbeatAndWake().catch(() => {});
backgroundPollAndDispatch('service_worker_boot').catch(() => {});
