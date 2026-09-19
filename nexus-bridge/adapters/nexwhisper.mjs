import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  actorId,
  eventText,
  externalUserId,
  languageOf,
  stripCommand
} from './_shared.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const requireFromNexMeta = createRequire(
  path.join(root, 'nexmeta', 'package.json')
);
const { MongoClient } = requireFromNexMeta('mongodb');
const { sendText } = await import(
  pathToFileURL(
    path.join(root, 'nexmeta', 'src', 'meta-client.mjs')
  ).href
);

let clientPromise;
const cooldowns = new Map();
const COOLDOWN_MS = Math.max(
  1000,
  Math.min(30000, Number(process.env.NEXWHISPER_COOLDOWN_MS || 3000))
);

export const adapterManifest = Object.freeze({
  version: '1.0.0',
  mode: 'nexmeta-native',
  productionReady: true,
  capabilities: [
    'linked_identity_delivery',
    'page_scoped_psid_delivery',
    'anonymous_whisper',
    'delivery_audit',
    'sender_rate_limit'
  ]
});

async function database() {
  const uri = String(
    process.env.NEXUS_MONGODB_URI ||
    process.env.MONGODB_URI ||
    ''
  ).trim();

  if (!uri) {
    const error = new Error('nexwhisper_mongodb_missing');
    error.status = 503;
    error.retryable = true;
    throw error;
  }

  clientPromise ??= new MongoClient(uri).connect();
  return (await clientPromise).db(
    String(process.env.NEXMETA_DB_NAME || 'nexmeta').trim()
  );
}

function parseCommand(text) {
  const args = stripCommand(text);
  const target = String(args.shift() || '').trim();
  const message = args.join(' ').trim();
  return { target, message };
}

function enforceCooldown(envelope) {
  const key = [
    envelope?.source?.pageId || '',
    externalUserId(envelope) || actorId(envelope) || ''
  ].join(':');

  const now = Date.now();
  const previous = cooldowns.get(key) || 0;

  if (previous && now - previous < COOLDOWN_MS) {
    const error = new Error('nexwhisper_rate_limited');
    error.status = 429;
    error.retryable = true;
    throw error;
  }

  cooldowns.set(key, now);
}

async function findTargetIdentity(pageId, nexusUserId) {
  const db = await database();
  return db.collection('identities').findOne(
    {
      platform: 'facebook',
      pageId: String(pageId),
      nexusUserId: String(nexusUserId)
    },
    {
      projection: {
        _id: 0,
        platform: 1,
        pageId: 1,
        externalUserId: 1,
        nexusUserId: 1
      }
    }
  );
}

async function recordDelivery({
  pageId,
  senderNexusId,
  recipientNexusId,
  recipientPsid,
  sent,
  text
}) {
  const db = await database();
  const now = new Date();

  await Promise.allSettled([
    sent?.message_id
      ? db.collection('messages').updateOne(
          {
            platform: 'facebook',
            pageId: String(pageId),
            externalMessageId: String(sent.message_id)
          },
          {
            $setOnInsert: {
              platform: 'facebook',
              surface: 'messenger',
              pageId: String(pageId),
              externalUserId: String(recipientPsid),
              externalMessageId: String(sent.message_id),
              direction: 'outbound',
              text,
              createdAt: now
            },
            $set: { updatedAt: now }
          },
          { upsert: true }
        )
      : Promise.resolve(),
    db.collection('audit_logs').insertOne({
      action: 'nexwhisper.delivered',
      actor: String(senderNexusId),
      details: {
        pageId: String(pageId),
        recipientNexusId: String(recipientNexusId),
        recipientPsid: String(recipientPsid),
        messageId: sent?.message_id || null
      },
      createdAt: now
    })
  ]);
}

export async function handle(envelope) {
  const lang = languageOf(envelope);
  const senderNexusId = actorId(envelope);
  const pageId = String(envelope?.source?.pageId || '').trim();
  const text = eventText(envelope);
  const { target, message } = parseCommand(text);

  if (!senderNexusId) {
    const error = new Error('identity_link_required');
    error.status = 403;
    throw error;
  }

  if (!pageId) {
    const error = new Error('facebook_page_id_required');
    error.status = 400;
    throw error;
  }

  if (!target || !message) {
    return {
      text: lang === 'fr'
        ? 'Utilise /whisper <NexusUserId> <message>. Le destinataire doit avoir lié son compte Facebook à Nexus sur cette Page.'
        : 'Use /whisper <NexusUserId> <message>. The recipient must have linked their Facebook account to Nexus on this Page.'
    };
  }

  if (target === senderNexusId) {
    return {
      text: lang === 'fr'
        ? 'Tu ne peux pas t’envoyer un Whisper à toi-même.'
        : 'You cannot send a Whisper to yourself.'
    };
  }

  enforceCooldown(envelope);

  const recipient = await findTargetIdentity(pageId, target);
  if (!recipient?.externalUserId) {
    const error = new Error('nexwhisper_recipient_not_linked_on_this_page');
    error.status = 404;
    throw error;
  }

  const body = (
    lang === 'fr'
      ? `Un Whisper pour toi\n\n${message}`
      : `A whisper for you\n\n${message}`
  ).slice(0, 2000);

  const sent = await sendText(
    recipient.externalUserId,
    body,
    'RESPONSE',
    pageId
  );

  await recordDelivery({
    pageId,
    senderNexusId,
    recipientNexusId: target,
    recipientPsid: recipient.externalUserId,
    sent,
    text: body
  });

  return {
    text: lang === 'fr'
      ? 'Whisper envoyé.'
      : 'Whisper sent.'
  };
}

export default handle;
