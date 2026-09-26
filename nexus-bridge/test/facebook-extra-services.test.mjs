import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterManifest as aiManifest } from '../adapters/nexai.mjs';
import {
  adapterManifest as whisperManifest,
  handle as handleWhisper
} from '../adapters/nexwhisper.mjs';

test('NexAI adapter reports provider readiness honestly', () => {
  assert.equal(aiManifest.version, '1.0.0');
  assert.equal(aiManifest.mode, 'openai-compatible');
  assert.ok(Array.isArray(aiManifest.capabilities));
  assert.equal(typeof aiManifest.productionReady, 'boolean');
});

test('NexWhisper requires a linked Nexus identity before delivery', async () => {
  assert.equal(whisperManifest.productionReady, true);

  await assert.rejects(
    () => handleWhisper({
      source: {
        platform: 'facebook',
        surface: 'messenger',
        pageId: 'page-1'
      },
      user: {
        externalId: 'psid-1',
        nexusUserId: null
      },
      event: {
        type: 'message',
        text: '/whisper 123 hello'
      }
    }),
    error => error?.message === 'identity_link_required' && error?.status === 403
  );
});
