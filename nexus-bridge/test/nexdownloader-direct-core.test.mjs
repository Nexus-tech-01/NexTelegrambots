import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDirectNexDownloaderHandler,
  extractDownloadUrl,
  requestedMediaKind
} from '../nexdownloader-direct-core.mjs';

test('extracts download URL and requested media kind', () => {
  const envelope = {
    event: {
      text: '/download audio https://example.com/watch?v=1'
    }
  };

  assert.equal(
    extractDownloadUrl(envelope),
    'https://example.com/watch?v=1'
  );
  assert.equal(requestedMediaKind(envelope), 'audio');
});

test('uses highest-priority compatible direct provider', async () => {
  const calls = [];

  const handle = createDirectNexDownloaderHandler({
    inspectUrl: () => ({
      platform: 'tiktok'
    }),
    createProviders: () => [
      {
        name: 'slow',
        priority: 20,
        available: () => true,
        supports: () => true,
        inspect: async () => {
          calls.push('slow');
          return {
            directMedia: {
              url: 'https://cdn.example/slow.mp4',
              kind: 'video'
            }
          };
        }
      },
      {
        name: 'fast',
        priority: 1,
        available: () => true,
        supports: () => true,
        inspect: async () => {
          calls.push('fast');
          return {
            title: 'Clip',
            directMedia: {
              url: 'https://cdn.example/fast.mp4',
              kind: 'video',
              headers: {
                Referer: 'https://example.com/'
              }
            }
          };
        }
      }
    ],
    registerRemoteMedia: async item => ({
      url: 'https://nexus.example/nexus-media/token',
      input: item
    })
  });

  const result = await handle({
    event: {
      text: '/download https://tiktok.example/video'
    }
  });

  assert.deepEqual(calls, ['fast']);
  assert.equal(result.handledBy, 'nexdownloader');
  assert.equal(result.reply.media.type, 'video');
  assert.equal(
    result.reply.media.url,
    'https://nexus.example/nexus-media/token'
  );
});

test('audio request skips a provider that only returns video', async () => {
  const calls = [];

  const handle = createDirectNexDownloaderHandler({
    inspectUrl: () => ({
      platform: 'youtube'
    }),
    createProviders: () => [
      {
        name: 'video-only',
        priority: 1,
        available: () => true,
        inspect: async () => {
          calls.push('video-only');
          return {
            directMedia: {
              url: 'https://cdn.example/video.mp4',
              kind: 'video'
            }
          };
        }
      },
      {
        name: 'audio-provider',
        priority: 2,
        available: () => true,
        inspect: async (_url, context) => {
          calls.push(
            `audio-provider:${context.preferMediaKind}`
          );

          return {
            directMedia: {
              url: 'https://cdn.example/audio.mp3',
              kind: 'audio'
            }
          };
        }
      }
    ],
    registerRemoteMedia: async () => ({
      url: 'https://nexus.example/nexus-media/audio'
    })
  });

  const result = await handle({
    event: {
      text: '/download mp3 https://example.com/song'
    }
  });

  assert.deepEqual(
    calls,
    [
      'video-only',
      'audio-provider:audio'
    ]
  );
  assert.equal(result.reply.media.type, 'audio');
});

test('relays direct image galleries', async () => {
  const relayed = [];

  const handle = createDirectNexDownloaderHandler({
    inspectUrl: () => ({
      platform: 'tiktok'
    }),
    createProviders: () => [
      {
        name: 'gallery',
        priority: 1,
        available: () => true,
        inspect: async () => ({
          title: 'Photos',
          directImages: [
            { url: 'https://cdn.example/1.jpg' },
            { url: 'https://cdn.example/2.jpg' }
          ]
        })
      }
    ],
    registerRemoteMedia: async item => {
      relayed.push(item.url);
      return {
        url: `https://nexus.example/${relayed.length}.jpg`
      };
    }
  });

  const result = await handle({
    event: {
      text: '/download https://example.com/gallery'
    }
  });

  assert.deepEqual(relayed, [
    'https://cdn.example/1.jpg',
    'https://cdn.example/2.jpg'
  ]);
  assert.deepEqual(result.reply.imageUrls, [
    'https://nexus.example/1.jpg',
    'https://nexus.example/2.jpg'
  ]);
});

test('returns explicit full-engine fallback instead of failing webhook', async () => {
  const handle = createDirectNexDownloaderHandler({
    inspectUrl: () => ({
      platform: 'youtube'
    }),
    createProviders: () => [
      {
        name: 'broken',
        priority: 1,
        available: () => true,
        inspect: async () => {
          throw new Error('provider unavailable');
        }
      }
    ],
    registerRemoteMedia: async () => {
      throw new Error('should not run');
    }
  });

  const result = await handle({
    event: {
      text: '/download https://example.com/video'
    }
  });

  assert.equal(result.handledBy, 'nexdownloader');
  assert.match(
    result.reply.text,
    /moteur de téléchargement complet NexDownloader/
  );
  assert.equal(
    result.diagnostic.directProviderErrors[0].provider,
    'broken'
  );
});
