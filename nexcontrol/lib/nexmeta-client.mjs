const clean = value => String(value ?? '').trim();

function config() {
  const baseUrl = clean(process.env.NEXMETA_URL);
  const controlKey = clean(process.env.NEXMETA_CONTROL_KEY);

  if (!baseUrl) throw new Error('NEXMETA_URL missing');
  if (!controlKey) throw new Error('NEXMETA_CONTROL_KEY missing');

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    controlKey
  };
}

async function request(path, options = {}) {
  const { baseUrl, controlKey } = config();

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${controlKey}`,
      ...(options.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `NexMeta HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error;
    error.metaCode = data?.metaCode;
    throw error;
  }

  return data;
}

export async function nexMetaStatus() {
  return request('/internal/v1/status');
}

export async function nexMetaAction(action, payload = {}) {
  if (!action) throw new Error('action is required');

  return request('/internal/v1/actions', {
    method: 'POST',
    body: JSON.stringify({
      action,
      ...payload
    })
  });
}

export async function nexMetaMetrics() {
  return nexMetaAction('metrics');
}

export async function nexMetaRuntimeSettings() {
  return nexMetaAction('runtime_settings');
}

export async function setNexMetaRuntime(patch) {
  return nexMetaAction('set_runtime', patch);
}
