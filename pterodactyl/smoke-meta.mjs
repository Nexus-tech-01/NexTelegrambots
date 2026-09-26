const publicPort = Number(
  process.env.PORT ||
  process.env.SERVER_PORT ||
  10000
);

const verifyToken = String(
  process.env.NEXMETA_VERIFY_TOKEN || ''
).trim();

const controlKey = String(
  process.env.NEXMETA_CONTROL_KEY || ''
).trim();

const base =
  `http://127.0.0.1:${publicPort}`;

const results = [];

function add(name, ok, detail) {
  results.push({
    name,
    ok: Boolean(ok),
    detail: String(detail || '')
  });
}

async function request(
  name,
  path,
  {
    expectedStatus = 200,
    headers,
    method = 'GET',
    body,
    validate
  } = {}
) {
  try {
    const response = await fetch(
      `${base}${path}`,
      {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      }
    );

    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    const statusOk = response.status === expectedStatus;
    const customOk =
      typeof validate === 'function'
        ? validate({
            response,
            text,
            data
          })
        : true;

    add(
      name,
      statusOk && customOk,
      `HTTP ${response.status}${
        text
          ? ` · ${text.slice(0, 220).replace(/\s+/g, ' ')}`
          : ''
      }`
    );
  } catch (error) {
    add(
      name,
      false,
      String(
        error?.message || error
      ).slice(0, 220)
    );
  }
}

await request(
  'nexmeta_health',
  '/health/meta',
  {
    validate: ({ data }) =>
      data?.ok === true &&
      data?.service === 'nexmeta'
  }
);

await request(
  'owner_connect_page',
  '/connect/meta',
  {
    validate: ({ text }) =>
      text.includes('Connecter Facebook')
  }
);

if (verifyToken) {
  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': verifyToken,
    'hub.challenge': 'nexmeta-smoke-ok'
  });

  await request(
    'webhook_verification',
    `/webhooks/meta?${query}`,
    {
      validate: ({ text }) =>
        text === 'nexmeta-smoke-ok'
    }
  );
} else {
  add(
    'webhook_verification',
    false,
    'NEXMETA_VERIFY_TOKEN missing'
  );
}

await request(
  'webhook_rejects_bad_signature',
  '/webhooks/meta',
  {
    method: 'POST',
    expectedStatus: 401,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256':
        'sha256=0000000000000000000000000000000000000000000000000000000000000000'
    },
    body: JSON.stringify({
      object: 'page',
      entry: []
    }),
    validate: ({ data }) =>
      data?.error === 'invalid_signature'
  }
);

if (controlKey) {
  await request(
    'private_status',
    '/internal/v1/status',
    {
      headers: {
        authorization:
          `Bearer ${controlKey}`
      },
      validate: ({ data }) =>
        data?.ok === true &&
        data?.service === 'nexmeta' &&
        data?.secretExposure === false &&
        data?.oauthConfigured === true &&
        data?.ownerConnectConfigured === true
    }
  );

  await request(
    'connection_readiness',
    '/internal/v1/actions',
    {
      method: 'POST',
      headers: {
        authorization:
          `Bearer ${controlKey}`,
        'content-type':
          'application/json'
      },
      body: JSON.stringify({
        action:
          'connection_readiness'
      }),
      validate: ({ data }) =>
        data?.ok === true &&
        data?.result?.ready === true
    }
  );
} else {
  add(
    'private_status',
    false,
    'NEXMETA_CONTROL_KEY missing'
  );
  add(
    'connection_readiness',
    false,
    'NEXMETA_CONTROL_KEY missing'
  );
}

for (const result of results) {
  console.log(
    `${result.ok ? 'OK ' : 'ERR'} ${result.name}: ${result.detail}`
  );
}

const failures = results.filter(
  result => !result.ok
);

console.log('');

if (failures.length) {
  console.error(
    `NexMeta smoke test failed: ${failures.length} check(s).`
  );

  process.exitCode = 1;
} else {
  console.log(
    'NexMeta connection smoke test passed. Facebook OAuth can be started from /connect/meta or NexControl.'
  );
}
