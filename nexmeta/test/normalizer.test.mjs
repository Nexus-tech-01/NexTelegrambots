import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMetaWebhook,
  normalizeMessengerWebhook,
  toNexusEnvelope
} from '../src/normalizer.mjs';

test('normalizes a Messenger text message into Nexus envelope v2', () => {
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

  assert.deepEqual(
    toNexusEnvelope(event, {
      intent: 'conversation',
      preferredService: 'auto'
    }),
    {
      version: 2,
      source: {
        platform: 'facebook',
        surface: 'messenger',
        pageId: 'page-1'
      },
      user: {
        externalId: 'user-1',
        nexusUserId: null
      },
      routing: {
        intent: 'conversation',
        preferredService: 'auto'
      },
      event: {
        type: 'message',
        id: 'm-1',
        timestamp: 123,
        text: 'hello',
        attachments: [],
        payload: null,
        field: null,
        action: null,
        value: null
      }
    }
  );
});

test('normalizes Page feed changes', () => {
  const events = normalizeMetaWebhook({
    object: 'page',
    entry: [{
      id: 'page-1',
      time: 1700000000,
      changes: [{
        field: 'feed',
        value: {
          item: 'comment',
          verb: 'add',
          comment_id: 'comment-1',
          post_id: 'post-1',
          sender_id: 'facebook-user-1',
          message: 'nice'
        }
      }]
    }]
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].surface, 'page');
  assert.equal(events[0].type, 'page_change');
  assert.equal(events[0].field, 'feed');
  assert.equal(events[0].action, 'add');
  assert.equal(events[0].externalMessageId, 'comment-1');
  assert.equal(events[0].text, 'nice');
  assert.equal(events[0].timestamp, 1700000000000);
});

test('ignores non-page webhook payloads', () => {
  assert.deepEqual(
    normalizeMetaWebhook({ object: 'user', entry: [] }),
    []
  );
});
