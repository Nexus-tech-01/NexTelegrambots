const URL_PATTERN = /https?:\/\/[^\s<>"'\])}]+/i;

export function extractDownloadUrl(envelope) {
  const text = String(envelope?.event?.text || '');
  return text.match(URL_PATTERN)?.[0] || null;
}

export function requestedMediaKind(envelope) {
  const text = String(
    envelope?.event?.text || ''
  ).toLowerCase();

  if (/\b(audio|music|musique|mp3|song|son)\b/.test(text)) {
    return 'audio';
  }

  if (/\b(video|vidéo|mp4)\b/.test(text)) {
    return 'video';
  }

  return 'auto';
}

export function normalizeMediaKind(value) {
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

export function createDirectNexDownloaderHandler({
  createProviders,
  inspectUrl,
  registerRemoteMedia,
  providerConfig = {},
  maxImages = 30
}) {
  if (typeof createProviders !== 'function') {
    throw new Error('createProviders is required');
  }

  if (typeof inspectUrl !== 'function') {
    throw new Error('inspectUrl is required');
  }

  if (typeof registerRemoteMedia !== 'function') {
    throw new Error('registerRemoteMedia is required');
  }

  const imageLimit = Math.max(
    1,
    Math.min(30, Number(maxImages) || 30)
  );

  async function inspectDirect(url, envelope) {
    const platform = inspectUrl(url) || {};
    const requestedKind = requestedMediaKind(envelope);

    const providers = createProviders(providerConfig)
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
          normalizeMediaKind(result.directMedia.kind) !== 'audio'
        ) {
          errors.push({
            provider: provider.name,
            error: 'provider_returned_non_audio_media'
          });
          continue;
        }

        if (
          result?.directMedia?.url ||
          (
            Array.isArray(result?.directImages) &&
            result.directImages.length
          )
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

    return {
      provider: null,
      result: null,
      errors
    };
  }

  async function relaySingle(meta, provider) {
    const direct = meta.directMedia;
    const kind = normalizeMediaKind(direct.kind);

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
      ? meta.directImages.slice(0, imageLimit)
      : [];

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

  return async function handle(envelope) {
    const url = extractDownloadUrl(envelope);

    if (!url) {
      return {
        reply: {
          text: 'Envoie une URL http(s) après /download.'
        }
      };
    }

    const {
      provider,
      result,
      errors = []
    } = await inspectDirect(url, envelope);

    if (result?.directMedia?.url) {
      return relaySingle(result, provider);
    }

    if (
      Array.isArray(result?.directImages) &&
      result.directImages.length
    ) {
      return relayImages(result, provider);
    }

    return {
      handledBy: 'nexdownloader',
      reply: {
        text:
          'Ce lien nécessite le moteur de téléchargement complet NexDownloader. ' +
          'Le bridge direct n’a trouvé aucun média HTTP directement relayable.'
      },
      diagnostic: {
        directProviderErrors: errors.slice(0, 8)
      }
    };
  };
}
