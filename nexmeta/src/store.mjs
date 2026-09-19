import { MongoClient } from 'mongodb';
import { config } from './config.mjs';

let clientPromise;
let indexesPromise;
let runtimeCache = { value: null, expiresAt: 0 };

async function database() {
  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);

  indexesPromise ??= Promise.all([
    db.collection('webhook_events').createIndex({ eventKey: 1 }, { unique: true }),
    db.collection('webhook_events').createIndex({ status: 1, receivedAt: -1 }),
    db.collection('messages').createIndex(
      { platform: 1, pageId: 1, externalMessageId: 1 },
      { unique: true, sparse: true }
    ),
    db.collection('messages').createIndex({ createdAt: -1 }),
    db.collection('identities').createIndex(
      { platform: 1, pageId: 1, externalUserId: 1 },
      { unique: true }
    ),
    db.collection('identities').createIndex(
      { nexusUserId: 1 },
      { sparse: true }
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
      updatedAt: now,
      replayCount: 0
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
    {
      $set: {
        status,
        error: error ? String(error).slice(0, 2000) : null,
        processedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );
}

export async function getWebhookEvent(eventKey) {
  const db = await database();
  const item = await db.collection('webhook_events').findOne({
    eventKey: String(eventKey)
  });

  if (!item) return null;

  return {
    eventKey: item.eventKey,
    objectType: item.objectType,
    raw: item.raw,
    status: item.status,
    error: item.error || null,
    receivedAt: item.receivedAt,
    processedAt: item.processedAt || null,
    replayCount: Number(item.replayCount || 0),
    lastReplayAt: item.lastReplayAt || null
  };
}

export async function listWebhookEvents({
  status,
  limit = 50
} = {}) {
  const db = await database();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const filter = {};

  if (status) {
    const allowed = new Set(['received', 'processed', 'failed']);
    if (!allowed.has(String(status))) throw new Error('invalid webhook status');
    filter.status = String(status);
  }

  const items = await db.collection('webhook_events')
    .find(filter, {
      projection: {
        raw: 0
      }
    })
    .sort({ receivedAt: -1 })
    .limit(safeLimit)
    .toArray();

  return items.map(item => ({
    eventKey: item.eventKey,
    objectType: item.objectType,
    status: item.status,
    error: item.error || null,
    receivedAt: item.receivedAt,
    processedAt: item.processedAt || null,
    replayCount: Number(item.replayCount || 0),
    lastReplayAt: item.lastReplayAt || null
  }));
}

export async function markWebhookReplay(eventKey) {
  const db = await database();
  const now = new Date();

  const result = await db.collection('webhook_events').findOneAndUpdate(
    { eventKey: String(eventKey) },
    {
      $set: {
        status: 'received',
        error: null,
        lastReplayAt: now,
        updatedAt: now
      },
      $inc: {
        replayCount: 1
      }
    },
    {
      returnDocument: 'after'
    }
  );

  return result
    ? {
        eventKey: result.eventKey,
        raw: result.raw,
        replayCount: Number(result.replayCount || 0)
      }
    : null;
}

export async function upsertIdentity({ platform, externalUserId, pageId }) {
  const db = await database();
  const now = new Date();

  await db.collection('identities').updateOne(
    { platform, pageId, externalUserId },
    {
      $set: {
        lastSeenAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now,
        nexusUserId: null
      }
    },
    { upsert: true }
  );
}

export async function linkIdentity({
  platform = 'facebook',
  pageId,
  externalUserId,
  nexusUserId
}) {
  const db = await database();
  const now = new Date();

  const result = await db.collection('identities').findOneAndUpdate(
    {
      platform: String(platform),
      pageId: String(pageId),
      externalUserId: String(externalUserId)
    },
    {
      $set: {
        nexusUserId: String(nexusUserId),
        linkedAt: now,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now,
        lastSeenAt: null
      }
    },
    {
      upsert: true,
      returnDocument: 'after'
    }
  );

  return {
    platform: result.platform,
    pageId: result.pageId,
    externalUserId: result.externalUserId,
    nexusUserId: result.nexusUserId,
    linkedAt: result.linkedAt
  };
}

export async function unlinkIdentity({
  platform = 'facebook',
  pageId,
  externalUserId
}) {
  const db = await database();
  const now = new Date();

  const result = await db.collection('identities').findOneAndUpdate(
    {
      platform: String(platform),
      pageId: String(pageId),
      externalUserId: String(externalUserId)
    },
    {
      $set: {
        nexusUserId: null,
        unlinkedAt: now,
        updatedAt: now
      },
      $unset: {
        linkedAt: ''
      }
    },
    { returnDocument: 'after' }
  );

  return result
    ? {
        platform: result.platform,
        pageId: result.pageId,
        externalUserId: result.externalUserId,
        nexusUserId: result.nexusUserId
      }
    : null;
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
      $setOnInsert: {
        ...message,
        createdAt: new Date()
      },
      $set: {
        updatedAt: new Date()
      }
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

export async function recentAudit(limit = 50) {
  const db = await database();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));

  const items = await db.collection('audit_logs')
    .find({}, {
      projection: {
        action: 1,
        actor: 1,
        details: 1,
        createdAt: 1
      }
    })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();

  return items.map(item => ({
    id: String(item._id),
    action: item.action,
    actor: item.actor,
    details: item.details,
    createdAt: item.createdAt
  }));
}

export async function getMetrics() {
  const db = await database();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stuckBefore = new Date(Date.now() - 2 * 60 * 1000);

  const [
    webhookTotal,
    webhook24h,
    webhookFailed,
    webhookStuck,
    messagesTotal,
    messages24h,
    inbound24h,
    outbound24h,
    identities,
    linkedIdentities
  ] = await Promise.all([
    db.collection('webhook_events').countDocuments(),
    db.collection('webhook_events').countDocuments({
      receivedAt: { $gte: since }
    }),
    db.collection('webhook_events').countDocuments({
      status: 'failed'
    }),
    db.collection('webhook_events').countDocuments({
      status: 'received',
      receivedAt: { $lte: stuckBefore }
    }),
    db.collection('messages').countDocuments(),
    db.collection('messages').countDocuments({
      createdAt: { $gte: since }
    }),
    db.collection('messages').countDocuments({
      createdAt: { $gte: since },
      direction: 'inbound'
    }),
    db.collection('messages').countDocuments({
      createdAt: { $gte: since },
      direction: 'outbound'
    }),
    db.collection('identities').countDocuments(),
    db.collection('identities').countDocuments({
      nexusUserId: { $nin: [null, ''] }
    })
  ]);

  return {
    webhookTotal,
    webhook24h,
    webhookFailed,
    webhookStuck,
    messagesTotal,
    messages24h,
    inbound24h,
    outbound24h,
    identities,
    linkedIdentities
  };
}

export async function getRuntimeSettings({ force = false } = {}) {
  const now = Date.now();

  if (!force && runtimeCache.value && runtimeCache.expiresAt > now) {
    return runtimeCache.value;
  }

  const db = await database();
  const doc = await db.collection('settings').findOne({
    _id: 'runtime'
  });

  const value = {
    inboundEnabled: doc?.inboundEnabled !== false,
    outboundEnabled: doc?.outboundEnabled !== false,
    updatedAt: doc?.updatedAt || null
  };

  runtimeCache = {
    value,
    expiresAt: now + 5000
  };

  return value;
}

export async function setRuntimeSettings(patch = {}) {
  const db = await database();
  const update = {};
  const now = new Date();

  if (typeof patch.inboundEnabled === 'boolean') {
    update.inboundEnabled = patch.inboundEnabled;
  }

  if (typeof patch.outboundEnabled === 'boolean') {
    update.outboundEnabled = patch.outboundEnabled;
  }

  if (!Object.keys(update).length) {
    throw new Error('no runtime setting supplied');
  }

  update.updatedAt = now;

  await db.collection('settings').updateOne(
    { _id: 'runtime' },
    {
      $set: update,
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );

  runtimeCache = {
    value: null,
    expiresAt: 0
  };

  return getRuntimeSettings({ force: true });
}

export async function healthStore() {
  const db = await database();
  await db.command({ ping: 1 });
  return true;
}
