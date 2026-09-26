import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sealMediaItem,
  openMediaToken,
  assertPublicHttpUrl
} from '../media-registry.mjs';

test('media token encrypts and authenticates relay metadata', () => {
  const previous = process.env.NEXUS_COMMAND_GATEWAY_KEY;
  process.env.NEXUS_COMMAND_GATEWAY_KEY = 'test-bridge-secret';

  try {
    const item = {
      url: 'https://cdn.example.com/media.mp4',
      headers: {
        'user-agent': 'Nexus'
      },
      mediaType: 'video',
      filename: null,
      maxBytes: 1000000,
      expiresAt: Date.now() + 60000
    };

    const token = sealMediaItem(item);

    assert.ok(token.startsWith('v1.'));
    assert.equal(token.includes('cdn.example.com'), false);
    assert.deepEqual(openMediaToken(token), item);

    const parts = token.split('.');
    const tampered = [
      parts[0],
      parts[1],
      parts[2].slice(0, -1) +
        (parts[2].endsWith('A') ? 'B' : 'A'),
      parts[3]
    ].join('.');

    assert.equal(openMediaToken(tampered), null);
  } finally {
    if (previous === undefined) {
      delete process.env.NEXUS_COMMAND_GATEWAY_KEY;
    } else {
      process.env.NEXUS_COMMAND_GATEWAY_KEY = previous;
    }
  }
});

test('expired media tokens are rejected', () => {
  const previous = process.env.NEXUS_COMMAND_GATEWAY_KEY;
  process.env.NEXUS_COMMAND_GATEWAY_KEY = 'test-bridge-secret';

  try {
    const token = sealMediaItem({
      url: 'https://cdn.example.com/media.mp4',
      headers: {},
      mediaType: 'video',
      filename: null,
      maxBytes: 1000000,
      expiresAt: Date.now() - 1
    });

    assert.equal(openMediaToken(token), null);
  } finally {
    if (previous === undefined) {
      delete process.env.NEXUS_COMMAND_GATEWAY_KEY;
    } else {
      process.env.NEXUS_COMMAND_GATEWAY_KEY = previous;
    }
  }
});

test('private literal media hosts are rejected', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('http://127.0.0.1/file.mp4'),
    /private_media_address/
  );

  await assert.rejects(
    () => assertPublicHttpUrl('http://[::1]/file.mp4'),
    /private_media_address/
  );
});
