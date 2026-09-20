import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { config } from './config.mjs';

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALLOWED_COMMANDS = new Set([
  'ping',
  'get_context',
  'open_url',
  'list_conversations',
  'read_conversation',
  'send_message'
]);

let clientPromise;
let indexesPromise;

function now() {
  return new Date();
}

function clean(value, max = 500) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new Error('value_too_long');
  return result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomPairCode(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  }
  return out;
}

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

async function database() {
  if (!config.mongoUri) throw new Error('NEXUS_MONGODB_URI missing');

  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);

  indexesPromise ??= Promise.all([
    db.collection('companion_pairings').createIndex(
      { codeHash: 1 },
      { unique: true }
    ),
    db.collection('companion_pairings').createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 }
    ),
    db.collection('companion_devices').createIndex(
      { deviceId: 1 },
      { unique: true }
    ),
    db.collection('companion_devices').createIndex(
      { tokenHash: 1 },
      { unique: true, sparse: true }
    ),
    db.collection('companion_devices').createIndex(
      { active: 1, lastSeenAt: -1 }
    ),
    db.collection('companion_commands').createIndex(
      { commandId: 1 },
      { unique: true }
    ),
    db.collection('companion_commands').createIndex(
      { deviceId: 1, status: 1, createdAt: 1 }
    ),
    db.collection('companion_commands').createIndex(
      { cleanupAt: 1 },
      { expireAfterSeconds: 0 }
    ),
    db.collection('companion_events').createIndex(
      { deviceId: 1, createdAt: -1 }
    ),
    db.collection('companion_events').createIndex(
      { cleanupAt: 1 },
      { expireAfterSeconds: 0 }
    )
  ]);

  await indexesPromise;
  return db;
}

function publicDevice(item) {
  if (!item) return null;
  return {
    deviceId: item.deviceId,
    name: item.name || null,
    platform: item.platform || null,
    clientVersion: item.clientVersion || null,
    active: item.active === true,
    pairedAt: item.pairedAt || null,
    lastSeenAt: item.lastSeenAt || null,
    revokedAt: item.revokedAt || null,
    context: item.context || null,
    capabilities: Array.isArray(item.capabilities)
      ? item.capabilities
      : []
  };
}

async function resolveDeviceFromAuth(authHeader) {
  const token = String(authHeader || '')
    .replace(/^Bearer\s+/i, '')
    .trim();

  if (!token || token.length < 32) {
    const error = new Error('companion_unauthorized');
    error.status = 401;
    throw error;
  }

  const db = await database();
  const device = await db.collection('companion_devices').findOne({
    tokenHash: sha256(token),
    active: true
  });

  if (!device) {
    const error = new Error('companion_unauthorized');
    error.status = 401;
    throw error;
  }

  return { db, device };
}

export async function createCompanionPairing({
  label = 'NexMeta Companion',
  ttlSeconds = 900
} = {}) {
  const db = await database();
  const ttl = Math.max(60, Math.min(3600, Number(ttlSeconds) || 900));
  const code = randomPairCode();
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + ttl * 1000);

  await db.collection('companion_pairings').insertOne({
    pairingId: crypto.randomUUID(),
    codeHash: sha256(code),
    label: clean(label, 120) || 'NexMeta Companion',
    createdAt,
    expiresAt,
    usedAt: null
  });

  return {
    pairCode: code,
    expiresAt,
    ttlSeconds: ttl
  };
}

export async function pairCompanion({
  pairCode,
  deviceName,
  platform,
  clientVersion,
  capabilities
} = {}) {
  const code = clean(pairCode, 64).toUpperCase();
  if (code.length < 8) {
    const error = new Error('invalid_pair_code');
    error.status = 400;
    throw error;
  }

  const db = await database();
  const pairing = await db.collection('companion_pairings').findOne({
    codeHash: sha256(code),
    usedAt: null,
    expiresAt: { $gt: now() }
  });

  if (!pairing) {
    const error = new Error('pair_code_invalid_or_expired');
    error.status = 403;
    throw error;
  }

  const deviceId = crypto.randomUUID();
  const deviceToken = randomToken();
  const pairedAt = now();
  const caps = Array.isArray(capabilities)
    ? capabilities
        .map(item => clean(item, 80))
        .filter(Boolean)
        .slice(0, 50)
    : [];

  await db.collection('companion_devices').insertOne({
    deviceId,
    tokenHash: sha256(deviceToken),
    name: clean(deviceName, 120) || 'Facebook browser',
    platform: clean(platform, 80) || 'browser',
    clientVersion: clean(clientVersion, 80) || 'unknown',
    capabilities: caps,
    active: true,
    pairedAt,
    lastSeenAt: pairedAt,
    revokedAt: null,
    context: null
  });

  await db.collection('companion_pairings').updateOne(
    {
      _id: pairing._id,
      usedAt: null
    },
    {
      $set: {
        usedAt: pairedAt,
        deviceId
      }
    }
  );

  return {
    deviceId,
    deviceToken,
    pairedAt,
    pollIntervalMs: 2500
  };
}

export async function companionStatus() {
  const db = await database();
  const [active, devices] = await Promise.all([
    db.collection('companion_devices').countDocuments({ active: true }),
    db.collection('companion_devices')
      .find({}, { projection: { tokenHash: 0, _id: 0 } })
      .sort({ lastSeenAt: -1 })
      .limit(50)
      .toArray()
  ]);

  return {
    activeDevices: active,
    devices: devices.map(publicDevice)
  };
}

export async function listCompanionDevices() {
  return (await companionStatus()).devices;
}

export async function revokeCompanionDevice(deviceId) {
  const id = clean(deviceId, 100);
  const db = await database();
  const revokedAt = now();

  const result = await db.collection('companion_devices').updateOne(
    { deviceId: id, active: true },
    {
      $set: {
        active: false,
        revokedAt
      },
      $unset: {
        tokenHash: ''
      }
    }
  );

  await db.collection('companion_commands').updateMany(
    {
      deviceId: id,
      status: { $in: ['pending', 'delivered'] }
    },
    {
      $set: {
        status: 'expired',
        completedAt: revokedAt,
        error: 'device_revoked'
      }
    }
  );

  return {
    revoked: result.modifiedCount > 0,
    deviceId: id
  };
}

export async function enqueueCompanionCommand({
  deviceId,
  type,
  payload = {},
  ttlSeconds = 300
} = {}) {
  const commandType = clean(type, 80);
  if (!ALLOWED_COMMANDS.has(commandType)) {
    const error = new Error('unsupported_companion_command');
    error.status = 400;
    throw error;
  }

  const db = await database();
  let targetId = clean(deviceId, 100);

  if (!targetId) {
    const latest = await db.collection('companion_devices').findOne(
      { active: true },
      { sort: { lastSeenAt: -1 } }
    );
    targetId = latest?.deviceId || '';
  }

  if (!targetId) {
    const error = new Error('no_active_companion_device');
    error.status = 409;
    throw error;
  }

  const device = await db.collection('companion_devices').findOne({
    deviceId: targetId,
    active: true
  });

  if (!device) {
    const error = new Error('companion_device_not_found');
    error.status = 404;
    throw error;
  }

  const ttl = Math.max(30, Math.min(3600, Number(ttlSeconds) || 300));
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + ttl * 1000);
  const commandId = crypto.randomUUID();

  const safePayload =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};

  await db.collection('companion_commands').insertOne({
    commandId,
    deviceId: targetId,
    type: commandType,
    payload: safePayload,
    status: 'pending',
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    cleanupAt: new Date(createdAt.getTime() + 7 * 24 * 3600 * 1000),
    deliveredAt: null,
    completedAt: null,
    result: null,
    error: null
  });

  return {
    commandId,
    deviceId: targetId,
    type: commandType,
    status: 'pending',
    expiresAt
  };
}

export async function getCompanionCommand(commandId) {
  const db = await database();
  const item = await db.collection('companion_commands').findOne(
    { commandId: clean(commandId, 100) },
    { projection: { _id: 0 } }
  );

  return item || null;
}

export async function pollCompanionCommands(authHeader, {
  limit = 10,
  context
} = {}) {
  const { db, device } = await resolveDeviceFromAuth(authHeader);
  const timestamp = now();
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 10));

  await db.collection('companion_devices').updateOne(
    { deviceId: device.deviceId, active: true },
    {
      $set: {
        lastSeenAt: timestamp,
        ...(context && typeof context === 'object'
          ? { context }
          : {})
      }
    }
  );

  await db.collection('companion_commands').updateMany(
    {
      deviceId: device.deviceId,
      status: { $in: ['pending', 'delivered'] },
      expiresAt: { $lte: timestamp }
    },
    {
      $set: {
        status: 'expired',
        completedAt: timestamp,
        updatedAt: timestamp,
        error: 'command_expired'
      }
    }
  );

  const retryBefore = new Date(timestamp.getTime() - 45_000);
  const items = await db.collection('companion_commands')
    .find({
      deviceId: device.deviceId,
      expiresAt: { $gt: timestamp },
      attempts: { $lt: 5 },
      $or: [
        { status: 'pending' },
        {
          status: 'delivered',
          deliveredAt: { $lte: retryBefore }
        }
      ]
    })
    .sort({ createdAt: 1 })
    .limit(safeLimit)
    .toArray();

  if (items.length) {
    const ids = items.map(item => item.commandId);
    await db.collection('companion_commands').updateMany(
      {
        commandId: { $in: ids },
        deviceId: device.deviceId
      },
      {
        $set: {
          status: 'delivered',
          deliveredAt: timestamp,
          updatedAt: timestamp
        },
        $inc: {
          attempts: 1
        }
      }
    );
  }

  return {
    device: publicDevice({
      ...device,
      lastSeenAt: timestamp,
      context: context || device.context || null
    }),
    commands: items.map(item => ({
      commandId: item.commandId,
      type: item.type,
      payload: item.payload || {},
      attempts: Number(item.attempts || 0) + 1,
      expiresAt: item.expiresAt
    }))
  };
}

export async function acknowledgeCompanionCommand(
  authHeader,
  {
    commandId,
    ok,
    result,
    error
  } = {}
) {
  const { db, device } = await resolveDeviceFromAuth(authHeader);
  const id = clean(commandId, 100);
  const timestamp = now();

  const command = await db.collection('companion_commands').findOne({
    commandId: id,
    deviceId: device.deviceId
  });

  if (!command) {
    const failure = new Error('companion_command_not_found');
    failure.status = 404;
    throw failure;
  }

  const success = ok === true;
  await db.collection('companion_commands').updateOne(
    {
      commandId: id,
      deviceId: device.deviceId
    },
    {
      $set: {
        status: success ? 'done' : 'failed',
        completedAt: timestamp,
        updatedAt: timestamp,
        result: success && result !== undefined ? result : null,
        error: success
          ? null
          : clean(error || 'companion_command_failed', 2000)
      }
    }
  );

  await db.collection('companion_devices').updateOne(
    { deviceId: device.deviceId },
    { $set: { lastSeenAt: timestamp } }
  );

  return {
    commandId: id,
    status: success ? 'done' : 'failed'
  };
}

export async function ingestCompanionEvents(
  authHeader,
  {
    context,
    events = []
  } = {}
) {
  const { db, device } = await resolveDeviceFromAuth(authHeader);
  const timestamp = now();
  const safeEvents = Array.isArray(events)
    ? events.slice(0, 50)
    : [];

  await db.collection('companion_devices').updateOne(
    { deviceId: device.deviceId, active: true },
    {
      $set: {
        lastSeenAt: timestamp,
        ...(context && typeof context === 'object'
          ? { context }
          : {})
      }
    }
  );

  if (safeEvents.length) {
    const cleanupAt = new Date(
      timestamp.getTime() + 7 * 24 * 3600 * 1000
    );

    await db.collection('companion_events').insertMany(
      safeEvents.map(item => ({
        eventId: crypto.randomUUID(),
        deviceId: device.deviceId,
        type: clean(item?.type || 'event', 80),
        payload:
          item?.payload &&
          typeof item.payload === 'object' &&
          !Array.isArray(item.payload)
            ? item.payload
            : {},
        createdAt: timestamp,
        cleanupAt
      })),
      { ordered: false }
    ).catch(error => {
      if (error?.code !== 11000) throw error;
    });
  }

  return {
    accepted: safeEvents.length,
    device: publicDevice({
      ...device,
      lastSeenAt: timestamp,
      context: context || device.context || null
    })
  };
}

export async function companionDeviceStatus(authHeader) {
  const { device } = await resolveDeviceFromAuth(authHeader);
  return publicDevice(device);
}
