import path from 'node:path';
import { access } from 'node:fs/promises';

const root = path.resolve(
  process.env.NEXUS_ROOT ||
  process.cwd()
);

const publicBase = String(
  process.env.NEXUS_PUBLIC_BASE_URL ||
  process.env.NEXMETA_PUBLIC_BASE_URL ||
  ''
).trim();

const checks = [];

function add(name, ok, detail) {
  checks.push({
    name,
    ok: Boolean(ok),
    detail
  });
}

async function fileCheck(name, relative) {
  const file = path.join(root, relative);

  try {
    await access(file);
    add(name, true, file);
  } catch {
    add(name, false, `Missing: ${file}`);
  }
}

add(
  'public_url',
  /^https:\/\/[^/\s]+(?:\/.*)?$/.test(publicBase),
  publicBase
    ? publicBase
    : 'NEXUS_PUBLIC_BASE_URL missing'
);

add(
  'mongodb',
  Boolean(
    process.env.NEXUS_MONGODB_URI ||
    process.env.MONGODB_URI
  ),
  'MongoDB URI'
);

const graphVersion = String(
  process.env.NEXMETA_GRAPH_VERSION || ''
).trim();

add(
  'nexmeta_graph_version',
  /^v\d+\.\d+$/.test(graphVersion),
  graphVersion
    ? /^v\d+\.\d+$/.test(graphVersion)
      ? graphVersion
      : 'Invalid; expected vN.N'
    : 'Missing'
);

for (const name of [
  'NEXMETA_APP_ID',
  'NEXMETA_APP_SECRET',
  'NEXMETA_VERIFY_TOKEN',
  'NEXMETA_CONTROL_KEY'
]) {
  add(
    name.toLowerCase(),
    Boolean(String(process.env[name] || '').trim()),
    String(process.env[name] || '').trim()
      ? 'Configured'
      : 'Missing'
  );
}

const encryptionKey = String(
  process.env.NEXMETA_TOKEN_ENCRYPTION_KEY || ''
).trim();

let encryptionKeyBytes = 0;

if (/^[a-f0-9]{64}$/i.test(encryptionKey)) {
  encryptionKeyBytes = 32;
} else if (encryptionKey) {
  try {
    encryptionKeyBytes = Buffer.from(
      encryptionKey,
      'base64'
    ).length;
  } catch {
    encryptionKeyBytes = 0;
  }
}

add(
  'nexmeta_token_encryption_key',
  encryptionKeyBytes === 32,
  encryptionKey
    ? encryptionKeyBytes === 32
      ? 'Configured (32 bytes)'
      : `Invalid length: ${encryptionKeyBytes} bytes`
    : 'Missing'
);

const connectKey = String(
  process.env.NEXMETA_CONNECT_KEY || ''
).trim();

add(
  'nexmeta_connect_key',
  connectKey.length >= 24,
  connectKey
    ? connectKey.length >= 24
      ? 'Configured'
      : 'Too short; use at least 24 characters'
    : 'Missing'
);

await fileCheck(
  'telegram_orchestrator',
  'scripts/orchestrator.mjs'
);

await fileCheck(
  'nexmeta_server',
  'nexmeta/src/server.mjs'
);

await fileCheck(
  'nexmeta_mongodb_dependency',
  'nexmeta/node_modules/mongodb/package.json'
);

await fileCheck(
  'bridge_receiver',
  'nexus-bridge/receiver.mjs'
);

await fileCheck(
  'nexdownloader_adapter',
  'nexus-bridge/adapters/nexdownloader.mjs'
);

const failures = checks.filter(
  item => !item.ok
);

for (const item of checks) {
  console.log(
    `${item.ok ? 'OK ' : 'ERR'} ${item.name}: ${item.detail}`
  );
}

console.log('');

if (publicBase) {
  console.log(
    `OAuth callback: ${publicBase.replace(/\/+$/, '')}/oauth/meta/callback`
  );
  console.log(
    `Meta webhook:   ${publicBase.replace(/\/+$/, '')}/webhooks/meta`
  );
  console.log(
    `Owner connect:  ${publicBase.replace(/\/+$/, '')}/connect/meta`
  );
}

if (failures.length) {
  console.error(
    `\nPterodactyl preflight failed: ${failures.length} missing requirement(s).`
  );
  process.exitCode = 1;
} else {
  console.log(
    '\nPterodactyl NexMeta connection prerequisites are ready.'
  );
}
