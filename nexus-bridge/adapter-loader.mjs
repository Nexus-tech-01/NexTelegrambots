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

      loaded[name] = handler;
      status.push({
        service: name,
        loaded: true
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
