import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyNexusBridgeSignature,
  dispatchNexusEnvelope
} from '../receiver.mjs';

function signed(body, key, timestamp) {
  const signature = crypto
    .createHmac('sha256', key)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return {
    authorization: `Bearer ${key}`,
    'x-nexus-timestamp': String(timestamp),
    'x-nexus-signature': `sha256=${signature}`
  };
}

test('verifies a valid NexMeta gateway signature', () => {
  const key = 'bridge-secret';
  const body = JSON.stringify({ hello: 'world' });
  const now = 1700000000000;
  const timestamp = Math.floor(now / 1000);

  assert.equal(
    verifyNexusBridgeSignature({
      rawBody: Buffer.from(body),
      headers: signed(body, key, timestamp),
      sharedKey: key,
      nowMs: now
    }).ok,
    true
  );
});

test('rejects replay-window violations', () => {
  const key = 'bridge-secret';
  const body = '{}';
  const now = 1700000000000;
  const timestamp = Math.floor(now / 1000) - 500;

  const result = verifyNexusBridgeSignature({
    rawBody: Buffer.from(body),
    headers: signed(body, key, timestamp),
    sharedKey: key,
    nowMs: now,
    maxSkewSeconds: 120
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'expired_request');
});

test('dispatches to preferred Nexus service', async () => {
  const envelope = {
    version: 2,
    source: {
      platform: 'facebook',
      surface: 'messenger',
      pageId: 'page-1'
    },
    user: {
      externalId: 'user-1'
    },
    routing: {
      intent: 'game',
      preferredService: 'nexgame'
    },
    event: {
      type: 'message',
      id: 'm-1',
      text: '/game'
    }
  };

  const result = await dispatchNexusEnvelope(
    envelope,
    {
      services: {
        nexgame: async input => ({
          reply: {
            text: `game:${input.event.text}`
          }
        })
      }
    }
  );

  assert.equal(result.handledBy, 'nexgame');
  assert.equal(result.reply.text, 'game:/game');
});


test('handles signed system probes without service adapters', async () => {
  const envelope = {
    version: 2,
    source: {
      platform: 'facebook',
      surface: 'system',
      pageId: null
    },
    user: {
      externalId: null,
      nexusUserId: null
    },
    routing: {
      intent: 'probe',
      preferredService: 'bridge'
    },
    event: {
      type: 'system_probe',
      id: null,
      timestamp: Date.now(),
      text: ''
    }
  };

  const result = await dispatchNexusEnvelope(envelope);

  assert.equal(result.probe, true);
  assert.equal(result.handledBy, 'nexus-bridge');
  assert.equal(result.reply, null);
});


test('system probe separates loaded from production-ready services', async () => {
  const envelope = {
    version: 2,
    source: {
      platform: 'facebook',
      surface: 'system',
      pageId: null
    },
    user: {
      externalId: null,
      nexusUserId: null
    },
    routing: {
      intent: 'probe',
      preferredService: 'bridge'
    },
    event: {
      type: 'system_probe',
      id: null,
      timestamp: Date.now(),
      text: ''
    }
  };

  const result = await dispatchNexusEnvelope(
    envelope,
    {
      services: {
        nexdownloader: async () => null,
        nexgame: async () => null
      },
      serviceStatus: [
        {
          service: 'nexdownloader',
          loaded: true,
          manifest: {
            productionReady: false
          }
        },
        {
          service: 'nexgame',
          loaded: true,
          manifest: {
            productionReady: true
          }
        }
      ]
    }
  );

  assert.deepEqual(
    result.services.available,
    ['nexdownloader', 'nexgame']
  );
  assert.deepEqual(
    result.services.ready,
    ['nexgame']
  );
});
