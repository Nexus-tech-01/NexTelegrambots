const clean = value => String(value ?? '').trim();

export const config = {
  port: Number(process.env.PORT || 8788),
  publicBaseUrl: clean(process.env.NEXMETA_PUBLIC_BASE_URL),
  mongoUri: clean(process.env.NEXUS_MONGODB_URI || process.env.MONGODB_URI),
  dbName: clean(process.env.NEXMETA_DB_NAME || 'nexmeta'),
  graphVersion: clean(process.env.NEXMETA_GRAPH_VERSION),
  pageId: clean(process.env.NEXMETA_PAGE_ID),
  pageAccessToken: clean(process.env.NEXMETA_PAGE_ACCESS_TOKEN),
  verifyToken: clean(process.env.NEXMETA_VERIFY_TOKEN),
  appSecret: clean(process.env.NEXMETA_APP_SECRET),
  controlKey: clean(process.env.NEXMETA_CONTROL_KEY),
  nexusGatewayUrl: clean(process.env.NEXUS_COMMAND_GATEWAY_URL),
  nexusGatewayKey: clean(process.env.NEXUS_COMMAND_GATEWAY_KEY)
};

export function metaConfigured() {
  return Boolean(
    config.graphVersion &&
    config.pageId &&
    config.pageAccessToken &&
    config.verifyToken &&
    config.appSecret
  );
}

export function assertRuntimeConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  if (!config.mongoUri) throw new Error('NEXUS_MONGODB_URI is required');
}

export function assertMetaSendConfig() {
  const missing = [];
  if (!config.graphVersion) missing.push('NEXMETA_GRAPH_VERSION');
  if (!config.pageId) missing.push('NEXMETA_PAGE_ID');
  if (!config.pageAccessToken) missing.push('NEXMETA_PAGE_ACCESS_TOKEN');
  if (missing.length) throw new Error(`Meta send config missing: ${missing.join(', ')}`);
}
