import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityMatrix } from '../src/meta-diagnostics.mjs';

test('permission doctor identifies missing Messenger permission', () => {
  const matrix = capabilityMatrix([
    'pages_show_list',
    'pages_manage_metadata'
  ]);

  assert.equal(matrix.messenger.usable, false);
  assert.deepEqual(matrix.messenger.missing, ['pages_messaging']);
});

test('permission doctor marks post capability usable with required scopes', () => {
  const matrix = capabilityMatrix([
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts'
  ]);

  assert.equal(matrix.page_posts.usable, true);
  assert.deepEqual(matrix.page_posts.missing, []);
});
