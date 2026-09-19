import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_CAPABILITIES,
  controlAuditMetadata
} from '../src/control-actions.mjs';

test('control plane never exposes a read-secret capability', () => {
  assert.equal(CONTROL_CAPABILITIES.includes('read_secret'), false);
  assert.equal(CONTROL_CAPABILITIES.includes('get_page_access_token'), false);
  assert.equal(CONTROL_CAPABILITIES.includes('get_app_secret'), false);
});

test('audit metadata stores lengths instead of message contents', () => {
  const meta = controlAuditMetadata({
    action: 'send_text',
    psid: 'user-1',
    text: 'super secret message'
  });

  assert.equal(meta.action, 'send_text');
  assert.equal(meta.target, 'user-1');
  assert.equal(meta.textLength, 20);
  assert.equal(Object.values(meta).includes('super secret message'), false);
});
