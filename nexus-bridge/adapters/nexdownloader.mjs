import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  registerRemoteMedia
} from '../media-registry.mjs';

const nexusRoot = path.resolve(
  process.env.NEXUS_ROOT ||
  process.cwd()
);

const providersModule = await import(
  pathToFileURL(
    path.join(
      nexusRoot,
      'bots/nexdownloader/src/download/builtin-api-providers.js'
    )
  ).href
);

const platformsModule = await import(
  pathToFileURL(
    path.join(
      nexusRoot,
      'bots/nexdownloader/src/download/platforms.js'
    )
  ).href
);

const {
  createBuiltInApiProviders
} = providersModule;

const {
  inspectUrl
} = platformsModule;
import {
  createDirectNexDownloaderHandler
} from '../nexdownloader-direct-core.mjs';

export const adapterManifest = Object.freeze({
  version: '0.2.0',
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

function envBoolean(name, fallback = false) {
  const value = String(
    process.env[name] ?? ''
  ).trim().toLowerCase();

  if (!value) return fallback;

  return ['1', 'true', 'yes', 'on'].includes(value);
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

export const handle = createDirectNexDownloaderHandler({
  createProviders: createBuiltInApiProviders,
  inspectUrl,
  registerRemoteMedia,
  providerConfig: configFromEnvironment()
});

export default handle;
