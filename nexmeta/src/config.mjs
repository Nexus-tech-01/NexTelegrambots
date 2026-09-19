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
    'nexdownloader,nexgame,nexstick,nexgroup,nexcanal,nexwhisper,nexai'
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

export function tokenEncryptionKeyValid(value = config.tokenEncryptionKey) {
  const key = clean(value);

  if (/^[a-f0-9]{64}$/i.test(key)) {
    return true;
  }

  try {
    return Buffer.from(key, 'base64').length === 32;
  } catch {
    return false;
  }
}

export function publicHttpsConfigured() {
  try {
    const url = new URL(config.publicBaseUrl);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function graphVersionValid() {
  return /^v\d+\.\d+$/.test(config.graphVersion);
}

export function oauthConfigured() {
  return Boolean(
    graphVersionValid() &&
    config.appId &&
    config.appSecret &&
    config.oauthRedirectUri &&
    tokenEncryptionKeyValid()
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
  if (!config.graphVersion) {
    missing.push('NEXMETA_GRAPH_VERSION');
  } else if (!graphVersionValid()) {
    missing.push('NEXMETA_GRAPH_VERSION(valid vN.N)');
  }
  if (!config.appId) missing.push('NEXMETA_APP_ID');
  if (!config.appSecret) missing.push('NEXMETA_APP_SECRET');
  if (!config.oauthRedirectUri) {
    missing.push('NEXMETA_OAUTH_REDIRECT_URI');
  } else {
    try {
      const redirect = new URL(config.oauthRedirectUri);
      if (redirect.protocol !== 'https:') {
        missing.push('NEXMETA_OAUTH_REDIRECT_URI(https)');
      }
    } catch {
      missing.push('NEXMETA_OAUTH_REDIRECT_URI(valid URL)');
    }
  }

  if (!config.tokenEncryptionKey) {
    missing.push('NEXMETA_TOKEN_ENCRYPTION_KEY');
  } else if (!tokenEncryptionKeyValid()) {
    missing.push('NEXMETA_TOKEN_ENCRYPTION_KEY(32 bytes)');
  }

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
