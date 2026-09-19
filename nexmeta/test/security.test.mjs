import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyWebhookChallenge,
  verifyMetaSignature,
  authorizeControl
} from '../src/security.mjs';

test('verifies Meta webhook challenge', () => {
  const params = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'secret',
    'hub.challenge': '123456'
  });

  assert.deepEqual(
    verifyWebhookChallenge(params, 'secret'),
    { ok: true, challenge: '123456' }
  );
  assert.deepEqual(verifyWebhookChallenge(params, 'wrong'), { ok: false });
});

test('verifies X-Hub-Signature-256', () => {
  const body = Buffer.from('{"object":"page"}');
  const secret = 'app-secret';
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(
    verifyMetaSignature(body, `sha256=${digest}`, secret),
    true
  );
  assert.equal(
    verifyMetaSignature(body, 'sha256=bad', secret),
    false
  );
});

test('authorizes NexControl machine key', () => {
  assert.equal(
    authorizeControl('Bearer control-secret', 'control-secret'),
    true
  );
  assert.equal(
    authorizeControl('Bearer nope', 'control-secret'),
    false
  );
});
