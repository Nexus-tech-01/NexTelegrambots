import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPublicPath
} from './routing.mjs';

test('routes Meta connection and webhook paths to NexMeta', () => {
  for (const path of [
    '/connect/meta',
    '/oauth/meta/callback',
    '/webhooks/meta',
    '/internal/v1/status',
    '/internal/v1/actions'
  ]) {
    assert.equal(
      classifyPublicPath(path),
      'nexmeta',
      path
    );
  }
});

test('routes bridge and health paths locally', () => {
  assert.equal(
    classifyPublicPath('/internal/nexus/events'),
    'bridge-events'
  );

  assert.equal(
    classifyPublicPath('/internal/nexus/bridge-status'),
    'bridge-status'
  );

  assert.equal(
    classifyPublicPath('/nexus-media/token'),
    'media'
  );

  assert.equal(
    classifyPublicPath('/health/all'),
    'health-all'
  );

  assert.equal(
    classifyPublicPath('/health/meta'),
    'meta-health'
  );
});

test('keeps existing Telegram routes on Telegram orchestrator', () => {
  for (const path of [
    '/',
    '/health',
    '/telegram/nexgame',
    '/webhook/nexcanal',
    '/anything-else'
  ]) {
    assert.equal(
      classifyPublicPath(path),
      'telegram',
      path
    );
  }
});
