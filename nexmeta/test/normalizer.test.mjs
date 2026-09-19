import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessengerWebhook,
  toNexusEnvelope
} from '../src/normalizer.mjs';

test('normalizes a Messenger text message', () => {
  const [event] = normalizeMessengerWebhook({
    object: 'page',
    entry: [{
      id: 'page-1',
      messaging: [{
        sender: { id: 'user-1' },
        recipient: { id: 'page-1' },
        timestamp: 123,
        message: {
          mid: 'm-1',
          text: 'hello'
        }
      }]
    }]
  });

  assert.equal(event.type, 'message');
  assert.equal(event.pageId, 'page-1');
  assert.equal(event.senderId, 'user-1');
  assert.equal(event.externalMessageId, 'm-1');
  assert.equal(event.text, 'hello');

  assert.deepEqual(toNexusEnvelope(event), {
    version: 1,
    source: {
      platform: 'facebook',
      surface: 'messenger',
      pageId: 'page-1'
    },
    user: {
      externalId: 'user-1'
    },
    event: {
      type: 'message',
      id: 'm-1',
      timestamp: 123,
      text: 'hello',
      attachments: [],
      payload: null
    }
  });
});

test('ignores non-page webhook payloads', () => {
  assert.deepEqual(normalizeMessengerWebhook({ object: 'user', entry: [] }), []);
});
