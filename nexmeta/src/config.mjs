const clean = value => String(value ?? '').trim();
const csv = value => clean(value)
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean);

const publicBaseUrl = clean(
  process.env.NEXMETA_PUBLIC_BASE_URL ||
  process.env.NEXUS_PUBLIC_BASE_URL
).replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT || 8788),
  publicBaseUrl,
  mongoUri: clean(process.env.NEXUS_MONGODB_URI || process.env.MONGODB_URI),
  dbName: clean(process.env.NEXMETA_DB_NAME || 'nexmeta'),

  graphVersion: clean(process.env.NEXMETA_GRAPH_VERSION),
  appId: clean(process.env.NEXMETA_APP_ID),
  appSecret: clean(process.env.NEXMETA_APP_SECRET),
  verifyToken: clean(process.env.NEXMETA_VERIFY_TOKEN),

  // Optional static fallback for first deployment.
  pageId: clean(process.env.NEXMETA_PAGE_ID),
  pageAccessToken: clean(process.env.NEXMETA_PAGE_ACCESS_TOKEN),

  oauthRedirectUri: clean(
    process.env.NEXMETA_OAUTH_REDIRECT_URI ||
    (
      publicBaseUrl
        ? `${publicBaseUrl}/oauth/meta/callback`
        : ''
    )
  ),
  tokenEncryptionKey: clean(process.env.NEXMETA_TOKEN_ENCRYPTION_KEY),

  controlKey: clean(process.env.NEXMETA_CONTROL_KEY),
  connectKey: clean(process.env.NEXMETA_CONNECT_KEY),
  nexusGatewayUrl: clean(process.env.NEXUS_COMMAND_GATEWAY_URL),
  nexusGatewayKey: clean(process.env.NEXUS_COMMAND_GATEWAY_KEY),
  requiredNexusServices: csv(
    process.env.NEXMETA_REQUIRED_NEXUS_SERVICES ||
    'nexdownloader,nexgame,nexstick,nexgroup,nexcanal'
  )
};

export function metaConfigured() {
  return Boolean(
    config.graphVersion &&
    config.verifyToken &&
    config.appSecret &&
    (
      (config.pageId && config.pageAccessToken) ||
      (config.appId && config.oauthRedirectUri && config.tokenEncryptionKey)
    )
  );
}

export function oauthConfigured() {
  return Boolean(
    config.graphVersion &&
    config.appId &&
    config.appSecret &&
    config.oauthRedirectUri &&
    config.tokenEncryptionKey
  );
}

export function assertRuntimeConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  if (!config.mongoUri) throw new Error('NEXUS_MONGODB_URI is required');
}

export function assertGraphConfig() {
  if (!config.graphVersion) {
    throw new Error('NEXMETA_GRAPH_VERSION missing');
  }
}

export function assertOAuthConfig() {
  const missing = [];
  if (!config.graphVersion) missing.push('NEXMETA_GRAPH_VERSION');
  if (!config.appId) missing.push('NEXMETA_APP_ID');
  if (!config.appSecret) missing.push('NEXMETA_APP_SECRET');
  if (!config.oauthRedirectUri) missing.push('NEXMETA_OAUTH_REDIRECT_URI');
  if (!config.tokenEncryptionKey) missing.push('NEXMETA_TOKEN_ENCRYPTION_KEY');

  if (missing.length) {
    throw new Error(`Meta OAuth config missing: ${missing.join(', ')}`);
  }
}

export function assertStaticPageConfig() {
  const missing = [];
  if (!config.pageId) missing.push('NEXMETA_PAGE_ID');
  if (!config.pageAccessToken) missing.push('NEXMETA_PAGE_ACCESS_TOKEN');

  if (missing.length) {
    throw new Error(`Static Meta Page config missing: ${missing.join(', ')}`);
  }
}
