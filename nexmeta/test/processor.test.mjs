import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkCode } from '../src/processor.mjs';

test('extracts direct NexMeta pairing code', () => {
  assert.equal(extractLinkCode('NXM-ABC123XYZ'), 'NXM-ABC123XYZ');
  assert.equal(extractLinkCode(' nxm-abc123xyz '), 'NXM-ABC123XYZ');
});

test('extracts link and lier commands', () => {
  assert.equal(extractLinkCode('link NXM-ABC123XYZ'), 'NXM-ABC123XYZ');
  assert.equal(extractLinkCode('/lier nxm-abc123xyz'), 'NXM-ABC123XYZ');
});

test('rejects malformed pairing codes', () => {
  assert.equal(extractLinkCode('NXM-short'), null);
  assert.equal(extractLinkCode('hello NXM-ABC123XYZ'), null);
});
