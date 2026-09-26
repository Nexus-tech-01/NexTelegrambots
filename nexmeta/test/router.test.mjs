import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNexusRoute } from '../src/router.mjs';

test('routes downloader commands to NexDownloader', () => {
  assert.deepEqual(
    classifyNexusRoute({
      type: 'message',
      text: '/download https://example.com/video'
    }),
    {
      intent: 'download',
      preferredService: 'nexdownloader'
    }
  );
});

test('routes main Nexus service commands', () => {
  assert.equal(
    classifyNexusRoute({ type: 'message', text: '/game quiz' }).preferredService,
    'nexgame'
  );
  assert.equal(
    classifyNexusRoute({ type: 'message', text: '/sticker make' }).preferredService,
    'nexstick'
  );
  assert.equal(
    classifyNexusRoute({ type: 'message', text: '/whisper 123 hello' }).preferredService,
    'nexwhisper'
  );
  assert.equal(
    classifyNexusRoute({ type: 'message', text: '/group settings' }).preferredService,
    'nexgroup'
  );
  assert.equal(
    classifyNexusRoute({ type: 'message', text: '/publish update' }).preferredService,
    'nexcanal'
  );
  assert.equal(
    classifyNexusRoute({ type: 'message', text: '/ai hello' }).preferredService,
    'nexai'
  );
});

test('routes Page feed events to NexCanal', () => {
  assert.deepEqual(
    classifyNexusRoute({
      type: 'page_change',
      field: 'feed'
    }),
    {
      intent: 'page_event',
      preferredService: 'nexcanal'
    }
  );
});
