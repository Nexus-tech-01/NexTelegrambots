import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { config } from './config.mjs';

let clientPromise;
let indexesPromise;

function decodeMasterKey() {
  const value = String(config.tokenEncryptionKey || '').trim();
  if (!value) throw new Error('NEXMETA_TOKEN_ENCRYPTION_KEY missing');

  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }

  if (key.length !== 32) {
    throw new Error('NEXMETA_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  return key;
}

function encryptSecret(plaintext) {
  const key = decodeMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptSecret(record) {
  if (!record || record.version !== 1 || record.algorithm !== 'aes-256-gcm') {
    throw new Error('unsupported encrypted secret format');
  }

  const key = decodeMasterKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function collection() {
  if (!config.mongoUri) throw new Error('NEXUS_MONGODB_URI missing');

  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);
  const pages = db.collection('connected_pages');

  indexesPromise ??= Promise.all([
    pages.createIndex({ pageId: 1 }, { unique: true }),
    pages.createIndex({ active: 1, updatedAt: -1 })
  ]);

  await indexesPromise;
  return pages;
}

export async function storeConnectedPages(items = []) {
  const pages = await collection();
  const now = new Date();
  const existingActive = await pages.findOne({ active: true });
  let firstStoredId = null;
  const stored = [];

  for (const item of items) {
    const pageId = String(item?.id || '').trim();
    const token = String(item?.access_token || '').trim();

    if (!pageId || !token) continue;
    if (!firstStoredId) firstStoredId = pageId;

    const page = {
      pageId,
      name: String(item?.name || pageId),
      tasks: Array.isArray(item?.tasks) ? item.tasks.map(String) : [],
      token: encryptSecret(token),
      updatedAt: now
    };

    await pages.updateOne(
      { pageId },
      {
        $set: page,
        $setOnInsert: {
          createdAt: now,
          active: false
        }
      },
      { upsert: true }
    );

    stored.push({
      pageId,
      name: page.name,
      tasks: page.tasks
    });
  }

  if (!existingActive && firstStoredId) {
    await activateConnectedPage(firstStoredId);
  }

  return stored;
}

export async function listConnectedPages() {
  const pages = await collection();
  const items = await pages
    .find(
      {},
      {
        projection: {
          token: 0
        }
      }
    )
    .sort({ active: -1, name: 1 })
    .toArray();

  return items.map(item => ({
    pageId: item.pageId,
    name: item.name,
    tasks: item.tasks || [],
    active: item.active === true,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  }));
}

export async function activateConnectedPage(pageId) {
  const id = String(pageId || '').trim();
  if (!id) throw new Error('pageId is required');

  const pages = await collection();
  const exists = await pages.findOne({ pageId: id });

  if (!exists) {
    const error = new Error('connected_page_not_found');
    error.status = 404;
    throw error;
  }

  const now = new Date();

  await pages.updateMany(
    { active: true, pageId: { $ne: id } },
    {
      $set: {
        active: false,
        updatedAt: now
      }
    }
  );

  await pages.updateOne(
    { pageId: id },
    {
      $set: {
        active: true,
        activatedAt: now,
        updatedAt: now
      }
    }
  );

  return {
    pageId: id,
    name: exists.name,
    active: true
  };
}

export async function removeConnectedPage(pageId) {
  const id = String(pageId || '').trim();
  if (!id) throw new Error('pageId is required');

  const pages = await collection();
  const item = await pages.findOne({ pageId: id });
  if (!item) return false;

  await pages.deleteOne({ pageId: id });

  if (item.active) {
    const next = await pages.findOne({}, { sort: { updatedAt: -1 } });
    if (next) await activateConnectedPage(next.pageId);
  }

  return true;
}

export async function getActivePageCredential() {
  if (config.tokenEncryptionKey) {
    const pages = await collection();
    const active = await pages.findOne({ active: true });

    if (active?.token) {
      return {
        pageId: active.pageId,
        pageAccessToken: decryptSecret(active.token),
        source: 'vault'
      };
    }
  }

  if (config.pageId && config.pageAccessToken) {
    return {
      pageId: config.pageId,
      pageAccessToken: config.pageAccessToken,
      source: 'environment'
    };
  }

  throw new Error('No active Meta Page credential is configured');
}

export async function connectedPageState() {
  let pages = [];

  if (config.tokenEncryptionKey) {
    pages = await listConnectedPages();
  }

  return {
    connectedPages: pages.length,
    activePage: pages.find(page => page.active) || null,
    staticFallbackConfigured: Boolean(config.pageId && config.pageAccessToken)
  };
}

export { encryptSecret, decryptSecret };
