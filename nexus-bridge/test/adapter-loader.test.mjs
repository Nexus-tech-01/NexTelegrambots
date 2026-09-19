import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadNexusAdapters } from '../adapter-loader.mjs';

test('loads an adapter that exports a handler', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'nexus-adapters-')
  );

  await writeFile(
    path.join(directory, 'nexgame.mjs'),
    `export async function handle(envelope) {
      return { reply: { text: 'ok:' + envelope.event.text } };
    }`
  );

  const result = await loadNexusAdapters({
    directory,
    services: ['nexgame']
  });

  assert.equal(typeof result.services.nexgame, 'function');
  assert.deepEqual(result.status, [
    {
      service: 'nexgame',
      loaded: true
    }
  ]);
});

test('does not mark missing or invalid adapter modules as loaded', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'nexus-adapters-')
  );

  await writeFile(
    path.join(directory, 'nexstick.mjs'),
    'export const version = 1;'
  );

  const result = await loadNexusAdapters({
    directory,
    services: ['nexstick', 'nexgroup']
  });

  assert.equal(result.services.nexstick, undefined);
  assert.equal(result.services.nexgroup, undefined);
  assert.deepEqual(result.status, [
    {
      service: 'nexstick',
      loaded: false,
      reason: 'adapter_handler_missing'
    },
    {
      service: 'nexgroup',
      loaded: false,
      reason: 'adapter_file_missing'
    }
  ]);
});
