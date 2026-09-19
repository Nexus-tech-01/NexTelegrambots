import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLimit } from '../src/meta-client.mjs';

test('parseLimit clamps pagination safely', () => {
  assert.equal(parseLimit(undefined), 25);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit(0), 1);
  assert.equal(parseLimit(999), 100);
  assert.equal(parseLimit('not-a-number'), 25);
});
