import {
  createBuiltInApiProviders
} from '/app/bots/nexdownloader/src/download/builtin-api-providers.js';
import {
  inspectUrl
} from '/app/bots/nexdownloader/src/download/platforms.js';
import {
  registerRemoteMedia
} from '../media-registry.mjs';

export const adapterManifest = Object.freeze({
  version: '0.1.0',
  mode: 'direct-media',
  productionReady: false,
  capabilities: [
    'tiktok_direct_video',
    'tiktok_direct_images',
    'generic_page_direct_media',
    'optional_cobalt_direct_media',
    'temporary_public_media_relay'
  ],
  missing: [
    'yt_dlp_local_file_delivery',
    'gallery_dl_local_file_delivery',
    'full_audio_conversion',
    'full_video_conversion',
    'telegram_job_queue_parity'
  ]
});

const URL_PATTERN = /https?:\/\/[^\s<>"'\])}]+/i;

function envBoolean(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();

  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function extractUrl(envelope) {
  const text = String(envelope?.event?.text || '');
  const match = text.match(URL_PATTERN);

  if (match) return match[0];

  return null;
}

function requestedMediaKind(envelope) {
  const text = String(envelope?.event?.text || '').toLowerCase();

  if (/\b(audio|music|musique|mp3|song|son)\b/.test(text)) {
    return 'audio';
  }

  if (/\b(video|vidéo|mp4)\b/.test(text)) {
    return 'video';
  }

  return 'auto';
}

function configFromEnvironment() {
  return {
    tikwmEnabled: !envBoolean(
      'NEXUS_BRIDGE_TIKWM_DISABLED',
      false
    ),
    tikwmTaskEnabled: !envBoolean(
      'NEXUS_BRIDGE_TIKWM_TASK_DISABLED',
      false
    ),
    tikwmEndpoint:
      process.env.NEXDOWNLOADER__TIKWM_ENDPOINT ||
      process.env.TIKWM_ENDPOINT ||
      undefined,
    cobaltCommunityEnabled: envBoolean(
      'NEXUS_BRIDGE_COBALT_ENABLED',
      false
    ),
    cobaltDirectoryUrl:
      process.env.NEXDOWNLOADER__COBALT_DIRECTORY_URL ||
      undefined,
    webMetadataEnabled: !envBoolean(
      'NEXUS_BRIDGE_WEB_METADATA_DISABLED',
      false
    )
  };
}

function normalizeKind(value) {
  const kind = String(value || '').toLowerCase();

  if (kind.includes('audio')) return 'audio';
  if (kind.includes('video')) return 'video';
  if (kind.includes('image')) return 'image';

  return 'file';
}

function caption(meta, providerName) {
  const title = String(meta?.title || 'Media').trim();
  const uploader = String(meta?.uploader || '').trim();

  return [
    title,
    uploader ? `by ${uploader}` : null,
    providerName ? `via ${providerName}` : null
  ].filter(Boolean).join('\n');
}

async function inspectDirect(url, envelope) {
  const platform = inspectUrl(url);
  const requestedKind = requestedMediaKind(envelope);

  const providers = createBuiltInApiProviders(
    configFromEnvironment()
  )
    .filter(provider => {
      try {
        return provider?.available?.() !== false;
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) =>
        Number(a?.priority || 999) -
        Number(b?.priority || 999)
    );

  const errors = [];

  for (const provider of providers) {
    const context = {
      platform: platform?.platform || null,
      capabilities: platform?.capabilities || null,
      preferMediaKind:
        requestedKind === 'auto'
          ? undefined
          : requestedKind,
      audioFormat: 'mp3'
    };

    if (
      typeof provider?.supports === 'function' &&
      !provider.supports(url, context)
    ) {
      continue;
    }

    try {
      const result = await provider.inspect(
        url,
        context
      );

      if (
        requestedKind === 'audio' &&
        result?.directMedia &&
        normalizeKind(result.directMedia.kind) !== 'audio'
      ) {
        errors.push({
          provider: provider.name,
          error: 'provider_returned_non_audio_media'
        });
        continue;
      }

      if (
        result?.directMedia?.url ||
        Array.isArray(result?.directImages)
      ) {
        return {
          provider,
          result
        };
      }
    } catch (error) {
      errors.push({
        provider: provider?.name || 'unknown',
        error: String(
          error?.message || error
        ).slice(0, 220)
      });
    }
  }

  const error = new Error(
    errors.length
      ? 'no_direct_media_provider_succeeded'
      : 'no_direct_media_provider_available'
  );

  error.retryable = false;
  error.providerErrors = errors.slice(0, 8);
  throw error;
}

async function relaySingle(meta, provider) {
  const direct = meta.directMedia;
  const kind = normalizeKind(direct.kind);

  const relay = await registerRemoteMedia({
    url: direct.url,
    headers: direct.headers || {},
    mediaType: kind,
    ttlMs: 15 * 60 * 1000
  });

  return {
    handledBy: 'nexdownloader',
    reply: {
      text: caption(
        meta,
        provider?.name ||
        meta.externalProvider ||
        meta.providerKind
      ),
      media: {
        type: kind,
        url: relay.url
      }
    }
  };
}

async function relayImages(meta, provider) {
  const images = Array.isArray(meta.directImages)
    ? meta.directImages.slice(0, 30)
    : [];

  if (!images.length) {
    throw new Error('empty_direct_image_set');
  }

  const relays = [];

  for (const image of images) {
    const relay = await registerRemoteMedia({
      url: image.url,
      headers: image.headers || {},
      mediaType: 'image',
      ttlMs: 15 * 60 * 1000
    });

    relays.push(relay.url);
  }

  return {
    handledBy: 'nexdownloader',
    reply: {
      text: caption(
        meta,
        provider?.name ||
        meta.externalProvider ||
        meta.providerKind
      ),
      imageUrls: relays
    }
  };
}

export async function handle(envelope) {
  const url = extractUrl(envelope);

  if (!url) {
    return {
      reply: {
        text: 'Envoie une URL http(s) après /download.'
      }
    };
  }

  const { provider, result } = await inspectDirect(
    url,
    envelope
  );

  if (result?.directMedia?.url) {
    return relaySingle(result, provider);
  }

  if (
    Array.isArray(result?.directImages) &&
    result.directImages.length
  ) {
    return relayImages(result, provider);
  }

  throw new Error('nexdownloader_direct_media_unavailable');
}

export default handle;
