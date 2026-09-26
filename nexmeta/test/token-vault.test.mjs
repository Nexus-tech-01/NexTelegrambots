import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasMessagingTask
} from '../src/token-vault.mjs';

test('recognizes classic Messenger Page task', () => {
  assert.equal(
    hasMessagingTask([
      'ANALYZE',
      'MESSAGING',
      'MODERATE'
    ]),
    true
  );
});

test('recognizes profile-plus Messenger Page task', () => {
  assert.equal(
    hasMessagingTask([
      'PROFILE_PLUS_ANALYZE',
      'PROFILE_PLUS_MESSAGING'
    ]),
    true
  );
});

test('does not mark content-only Page role as Messenger capable', () => {
  assert.equal(
    hasMessagingTask([
      'ANALYZE',
      'CREATE_CONTENT'
    ]),
    false
  );
});
