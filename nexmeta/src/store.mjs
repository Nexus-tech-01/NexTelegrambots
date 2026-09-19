import { MongoClient } from 'mongodb';
import { config } from './config.mjs';

let clientPromise;
let indexesPromise;

async function database() {
  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);

  indexesPromise ??= Promise.all([
    db.collection('webhook_events').createIndex({ eventKey: 1 }, { unique: true }),
    db.collection('webhook_events').createIndex({ receivedAt: -1 }),
    db.collection('messages').createIndex(
      { platform: 1, pageId: 1, externalMessageId: 1 },
      { unique: true, sparse: true }
    ),
    db.collection('identities').createIndex(
      { platform: 1, pageId: 1, externalUserId: 1 },
      { unique: true }
    ),
    db.collection('audit_logs').createIndex({ createdAt: -1 })
  ]);
  await indexesPromise;
  return db;
}

export async function persistWebhook({ eventKey, raw, objectType }) {
  const db = await database();
  const now = new Date();
  try {
    await db.collection('webhook_events').insertOne({
      eventKey,
      objectType,
      raw,
      status: 'received',
      receivedAt: now,
      updatedAt: now
    });
    return { duplicate: false };
  } catch (error) {
    if (error?.code === 11000) return { duplicate: true };
    throw error;
  }
}

export async function markWebhookProcessed(eventKey, status = 'processed', error = null) {
  const db = await database();
  await db.collection('webhook_events').updateOne(
    { eventKey },
    { $set: {
      status,
      error: error ? String(error).slice(0, 2000) : null,
      processedAt: new Date(),
      updatedAt: new Date()
    }}
  );
}

export async function upsertIdentity({ platform, externalUserId, pageId }) {
  const db = await database();
  const now = new Date();
  await db.collection('identities').updateOne(
    { platform, pageId, externalUserId },
    {
      $set: { lastSeenAt: now, updatedAt: now },
      $setOnInsert: { createdAt: now, nexusUserId: null }
    },
    { upsert: true }
  );
}

export async function saveMessage(message) {
  if (!message.externalMessageId) return;
  const db = await database();
  await db.collection('messages').updateOne(
    {
      platform: message.platform,
      pageId: message.pageId,
      externalMessageId: message.externalMessageId
    },
    {
      $setOnInsert: { ...message, createdAt: new Date() },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
}

export async function audit(action, actor, details = {}) {
  const db = await database();
  await db.collection('audit_logs').insertOne({
    action,
    actor,
    details,
    createdAt: new Date()
  });
}

export async function healthStore() {
  const db = await database();
  await db.command({ ping: 1 });
  return true;
}
