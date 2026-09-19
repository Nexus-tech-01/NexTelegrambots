export const META_PUBLIC_PATHS = Object.freeze([
  '/webhooks/meta',
  '/oauth/meta/callback',
  '/connect/meta'
]);

export function classifyPublicPath(pathname) {
  const path = String(pathname || '/');

  if (path.startsWith('/nexus-media/')) {
    return 'media';
  }

  if (path === '/internal/nexus/events') {
    return 'bridge-events';
  }

  if (path === '/internal/nexus/bridge-status') {
    return 'bridge-status';
  }

  if (path === '/health/all') {
    return 'health-all';
  }

  if (path === '/health/meta') {
    return 'meta-health';
  }

  if (path.startsWith('/internal/v1/')) {
    return 'nexmeta';
  }

  if (
    META_PUBLIC_PATHS.some(
      prefix =>
        path === prefix ||
        path.startsWith(`${prefix}/`)
    )
  ) {
    return 'nexmeta';
  }

  return 'telegram';
}
