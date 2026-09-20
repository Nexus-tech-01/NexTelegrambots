const DEFAULT_SERVER =
  'https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexmeta-public';

let pollInFlight = false;

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
        'send_message'
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
    return {
      paired: true,
      server: state.server,
      device
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
