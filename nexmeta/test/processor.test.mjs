import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLinkCode,
  splitMessengerText
} from '../src/processor.mjs';

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


test('splits long Messenger text without losing content', () => {
  const source = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(1500);
  const chunks = splitMessengerText(source);

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => chunk.length <= 2000));
  assert.equal(
    chunks.join('').replace(/\s+/g, ''),
    source.replace(/\s+/g, '')
  );
});

test('does not split a surrogate pair at the message boundary', () => {
  const source = 'A'.repeat(1999) + '😀' + 'B';
  const chunks = splitMessengerText(source);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].endsWith('\ud83d'), false);
  assert.equal(chunks[1].startsWith('\ude00'), false);
  assert.equal(chunks.join(''), source);
});
