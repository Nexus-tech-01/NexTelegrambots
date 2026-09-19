import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const DEFAULT_NEXUS_SERVICES = Object.freeze([
  'nexdownloader',
  'nexgame',
  'nexstick',
  'nexgroup',
  'nexcanal',
  'nexai',
  'auto'
]);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function moduleHandler(mod) {
  if (typeof mod?.default === 'function') return mod.default;
  if (typeof mod?.handle === 'function') return mod.handle;
  if (typeof mod?.handler === 'function') return mod.handler;
  return null;
}

function moduleManifest(mod, service) {
  const raw =
    mod?.adapterManifest &&
    typeof mod.adapterManifest === 'object'
      ? mod.adapterManifest
      : {};

  return {
    service,
    version: String(raw.version || '0'),
    mode: String(raw.mode || 'unspecified'),
    productionReady: raw.productionReady === true,
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.map(String)
      : [],
    missing: Array.isArray(raw.missing)
      ? raw.missing.map(String)
      : []
  };
}

export async function loadNexusAdapters({
  directory = '/app/nexus-bridge/adapters',
  services = DEFAULT_NEXUS_SERVICES
} = {}) {
  const loaded = {};
  const status = [];

  for (const service of services) {
    const name = String(service || '').trim().toLowerCase();
    if (!name) continue;

    const file = path.join(directory, `${name}.mjs`);

    if (!await exists(file)) {
      status.push({
        service: name,
        loaded: false,
        reason: 'adapter_file_missing'
      });
      continue;
    }

    try {
      const mod = await import(pathToFileURL(file).href);
      const handler = moduleHandler(mod);

      if (!handler) {
        status.push({
          service: name,
          loaded: false,
          reason: 'adapter_handler_missing'
        });
        continue;
      }

      const manifest = moduleManifest(mod, name);

      loaded[name] = handler;
      status.push({
        service: name,
        loaded: true,
        manifest
      });
    } catch (error) {
      status.push({
        service: name,
        loaded: false,
        reason: String(error?.message || error).slice(0, 300)
      });
    }
  }

  return {
    services: loaded,
    status
  };
}
