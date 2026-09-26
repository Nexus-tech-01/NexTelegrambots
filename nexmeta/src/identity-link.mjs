import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { config } from './config.mjs';
import { linkIdentity } from './store.mjs';

let clientPromise;
let indexPromise;

async function collection() {
  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);
  const links = db.collection('identity_link_codes');

  indexPromise ??= Promise.all([
    links.createIndex({ codeHash: 1 }, { unique: true }),
    links.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    links.createIndex({ nexusUserId: 1, createdAt: -1 })
  ]);

  await indexPromise;
  return links;
}

function normalizeCode(code) {
  return String(code ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function hashCode(code) {
  return crypto
    .createHash('sha256')
    .update(normalizeCode(code))
    .digest('hex');
}

function newCode() {
  const raw = crypto
    .randomBytes(7)
    .toString('base64url')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 9)
    .padEnd(9, 'X');

  return `NXM-${raw}`;
}

export async function createIdentityLinkCode({
  nexusUserId,
  ttlSeconds = 600
}) {
  const id = String(nexusUserId ?? '').trim();
  if (!id) throw new Error('nexusUserId is required');

  const ttl = Math.max(60, Math.min(3600, Number(ttlSeconds) || 600));
  const links = await collection();

  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    try {
      await links.insertOne({
        codeHash: hashCode(code),
        nexusUserId: id,
        createdAt: now,
        expiresAt,
        usedAt: null
      });

      return {
        code,
        expiresAt,
        ttlSeconds: ttl
      };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  throw new Error('could_not_allocate_link_code');
}

export async function consumeIdentityLinkCode({
  code,
  pageId,
  externalUserId,
  platform = 'facebook'
}) {
  const normalized = normalizeCode(code);
  if (!/^NXM-[A-Z0-9]{9}$/.test(normalized)) return null;

  const page = String(pageId ?? '').trim();
  const external = String(externalUserId ?? '').trim();

  if (!page || !external) return null;

  const links = await collection();
  const now = new Date();

  const claimed = await links.findOneAndUpdate(
    {
      codeHash: hashCode(normalized),
      usedAt: null,
      expiresAt: { $gt: now }
    },
    {
      $set: {
        usedAt: now,
        usedBy: {
          platform: String(platform),
          pageId: page,
          externalUserId: external
        }
      }
    },
    {
      returnDocument: 'after'
    }
  );

  if (!claimed) return null;

  const linked = await linkIdentity({
    platform,
    pageId: page,
    externalUserId: external,
    nexusUserId: claimed.nexusUserId
  });

  return {
    nexusUserId: claimed.nexusUserId,
    linked
  };
}
