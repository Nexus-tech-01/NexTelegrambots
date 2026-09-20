import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { config } from './config.mjs';

let clientPromise;
let indexesPromise;
let accountIndexesPromise;

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

async function accountCollection() {
  if (!config.mongoUri) throw new Error('NEXUS_MONGODB_URI missing');

  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);
  const accounts = db.collection('connected_meta_accounts');

  accountIndexesPromise ??= Promise.all([
    accounts.createIndex({ ownerSlot: 1 }, { unique: true }),
    accounts.createIndex({ userId: 1 }),
    accounts.createIndex({ updatedAt: -1 })
  ]);

  await accountIndexesPromise;
  return accounts;
}

function publicAccount(item) {
  if (!item) return null;

  return {
    userId: item.userId,
    name: item.name || null,
    email: item.email || null,
    pictureUrl: item.pictureUrl || null,
    permissions: Array.isArray(item.permissions) ? item.permissions : [],
    tokenExpiresAt: item.tokenExpiresAt || null,
    connectedAt: item.connectedAt || item.createdAt || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
}

export async function storeConnectedAccount({
  profile,
  permissions = [],
  accessToken,
  expiresIn
} = {}) {
  const userId = String(profile?.id || '').trim();
  const token = String(accessToken || '').trim();

  if (!userId) throw new Error('Meta user profile id missing');
  if (!token) throw new Error('Meta user access token missing');

  const accounts = await accountCollection();
  const now = new Date();
  const expiresSeconds = Number(expiresIn);
  const tokenExpiresAt =
    Number.isFinite(expiresSeconds) && expiresSeconds > 0
      ? new Date(now.getTime() + expiresSeconds * 1000)
      : null;

  const normalizedPermissions = Array.isArray(permissions)
    ? permissions
        .map(item => ({
          permission: String(item?.permission || '').trim(),
          status: String(item?.status || '').trim()
        }))
        .filter(item => item.permission)
    : [];

  await accounts.updateOne(
    { ownerSlot: 'primary' },
    {
      $set: {
        ownerSlot: 'primary',
        userId,
        name: String(profile?.name || userId),
        email: profile?.email ? String(profile.email) : null,
        pictureUrl: profile?.picture?.data?.url
          ? String(profile.picture.data.url)
          : null,
        permissions: normalizedPermissions,
        token: encryptSecret(token),
        tokenExpiresAt,
        connectedAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  return getConnectedAccount();
}

export async function getConnectedAccount() {
  const accounts = await accountCollection();
  const item = await accounts.findOne(
    { ownerSlot: 'primary' },
    { projection: { token: 0 } }
  );

  return publicAccount(item);
}

export async function getConnectedUserCredential() {
  const accounts = await accountCollection();
  const item = await accounts.findOne({ ownerSlot: 'primary' });

  if (!item?.token) {
    const error = new Error('connected_facebook_account_not_found');
    error.status = 404;
    throw error;
  }

  return {
    userId: item.userId,
    userAccessToken: decryptSecret(item.token),
    tokenExpiresAt: item.tokenExpiresAt || null,
    source: 'vault'
  };
}

export async function removeConnectedAccount() {
  const accounts = await accountCollection();
  const result = await accounts.deleteOne({ ownerSlot: 'primary' });
  return result.deletedCount > 0;
}

export async function connectedAccountState() {
  const account = await getConnectedAccount();
  const expiresAt = account?.tokenExpiresAt
    ? new Date(account.tokenExpiresAt)
    : null;

  return {
    connected: Boolean(account),
    account,
    tokenExpired: Boolean(
      expiresAt &&
      Number.isFinite(expiresAt.getTime()) &&
      expiresAt.getTime() <= Date.now()
    )
  };
}

export function hasMessagingTask(tasks = []) {
  return Array.isArray(tasks) && tasks.some(
    task => /MESSAG/i.test(String(task))
  );
}

function publicPage(item) {
  return {
    pageId: item.pageId,
    name: item.name,
    tasks: item.tasks || [],
    messagingTask: hasMessagingTask(item.tasks || []),
    active: item.active === true,
    webhookSubscribed: item.webhookSubscribed === true,
    webhookFields: item.webhookFields || [],
    webhookSubscribedAt: item.webhookSubscribedAt || null,
    webhookError: item.webhookError || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
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
      messagingTask: hasMessagingTask(item?.tasks || []),
      token: encryptSecret(token),
      updatedAt: now
    };

    await pages.updateOne(
      { pageId },
      {
        $set: page,
        $setOnInsert: {
          createdAt: now,
          active: false,
          webhookSubscribed: false,
          webhookFields: []
        }
      },
      { upsert: true }
    );

    stored.push({
      pageId,
      name: page.name,
      tasks: page.tasks,
      messagingTask: page.messagingTask
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

  return items.map(publicPage);
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

export async function getPageCredential(pageId) {
  const id = String(pageId || '').trim();
  if (!id) throw new Error('pageId is required');

  if (config.tokenEncryptionKey) {
    const pages = await collection();
    const item = await pages.findOne({ pageId: id });

    if (item?.token) {
      return {
        pageId: item.pageId,
        pageAccessToken: decryptSecret(item.token),
        source: 'vault'
      };
    }
  }

  if (config.pageId === id && config.pageAccessToken) {
    return {
      pageId: config.pageId,
      pageAccessToken: config.pageAccessToken,
      source: 'environment'
    };
  }

  const error = new Error('connected_page_not_found');
  error.status = 404;
  throw error;
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

export async function markPageWebhookState(
  pageId,
  {
    subscribed,
    fields = [],
    error = null
  }
) {
  const id = String(pageId || '').trim();
  if (!id) throw new Error('pageId is required');

  const pages = await collection();
  const now = new Date();

  await pages.updateOne(
    { pageId: id },
    {
      $set: {
        webhookSubscribed: Boolean(subscribed),
        webhookFields: Array.isArray(fields) ? fields.map(String) : [],
        webhookSubscribedAt: subscribed ? now : null,
        webhookError: error ? String(error).slice(0, 1000) : null,
        updatedAt: now
      }
    }
  );
}

export async function connectedPageState() {
  let pages = [];

  if (config.tokenEncryptionKey) {
    pages = await listConnectedPages();
  }

  return {
    connectedPages: pages.length,
    activePage: pages.find(page => page.active) || null,
    subscribedPages: pages.filter(page => page.webhookSubscribed).length,
    staticFallbackConfigured: Boolean(config.pageId && config.pageAccessToken)
  };
}

export { encryptSecret, decryptSecret };
