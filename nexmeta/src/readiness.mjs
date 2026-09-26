import {
  config,
  metaConfigured,
  oauthConfigured,
  tokenEncryptionKeyValid,
  publicHttpsConfigured,
  graphVersionValid
} from './config.mjs';
import {
  connectedPageState,
  connectedAccountState
} from './token-vault.mjs';
import { probeNexusGateway } from './router.mjs';

function check(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail: String(detail || '')
  };
}

export async function connectionReadiness() {
  const checks = [
    check(
      'mongodb',
      Boolean(config.mongoUri),
      config.mongoUri
        ? 'MongoDB URI configured'
        : 'NEXUS_MONGODB_URI missing'
    ),
    check(
      'public_https',
      publicHttpsConfigured(),
      publicHttpsConfigured()
        ? config.publicBaseUrl
        : 'NEXUS_PUBLIC_BASE_URL must be a valid HTTPS URL'
    ),
    check(
      'graph_version',
      graphVersionValid(),
      graphVersionValid()
        ? config.graphVersion
        : 'NEXMETA_GRAPH_VERSION must look like vN.N'
    ),
    check(
      'meta_app_id',
      Boolean(config.appId),
      config.appId
        ? 'Configured'
        : 'NEXMETA_APP_ID missing'
    ),
    check(
      'meta_app_secret',
      Boolean(config.appSecret),
      config.appSecret
        ? 'Configured server-side'
        : 'NEXMETA_APP_SECRET missing'
    ),
    check(
      'verify_token',
      Boolean(config.verifyToken),
      config.verifyToken
        ? 'Configured'
        : 'NEXMETA_VERIFY_TOKEN missing'
    ),
    check(
      'token_encryption',
      tokenEncryptionKeyValid(),
      tokenEncryptionKeyValid()
        ? '32-byte encryption key valid'
        : 'NEXMETA_TOKEN_ENCRYPTION_KEY must decode to 32 bytes'
    ),
    check(
      'owner_connect_key',
      config.connectKey.length >= 24,
      config.connectKey.length >= 24
        ? 'Owner connection page enabled'
        : 'NEXMETA_CONNECT_KEY must contain at least 24 characters'
    ),
    check(
      'oauth_redirect',
      Boolean(config.oauthRedirectUri),
      config.oauthRedirectUri ||
        'OAuth redirect URI unavailable'
    )
  ];

  const ready = checks.every(item => item.ok);

  return {
    version: 1,
    ready,
    oauthConfigured: oauthConfigured(),
    urls: config.publicBaseUrl
      ? {
          connect: `${config.publicBaseUrl}/connect/meta`,
          oauthCallback: config.oauthRedirectUri,
          webhook: `${config.publicBaseUrl}/webhooks/meta`,
          health: `${config.publicBaseUrl}/health/meta`
        }
      : null,
    checks
  };
}

export async function deploymentReadiness() {
  let pages = {
    connectedPages: 0,
    activePage: null,
    subscribedPages: 0,
    staticFallbackConfigured: Boolean(
      config.pageId && config.pageAccessToken
    )
  };
  let pageStateError = null;
  let account = {
    connected: false,
    account: null,
    tokenExpired: false
  };
  let accountStateError = null;

  try {
    pages = await connectedPageState();
  } catch (error) {
    pageStateError = String(
      error?.message || error
    ).slice(0, 300);
  }

  try {
    account = await connectedAccountState();
  } catch (error) {
    accountStateError = String(
      error?.message || error
    ).slice(0, 300);
  }

  const gatewayProbe =
    config.nexusGatewayUrl && config.nexusGatewayKey
      ? await probeNexusGateway()
      : {
          ok: false,
          error: 'gateway_not_configured'
        };

  const requiredServices = Array.isArray(config.requiredNexusServices)
    ? config.requiredNexusServices
    : [];

  const availableServices = Array.isArray(gatewayProbe.availableServices)
    ? gatewayProbe.availableServices
    : [];

  const readyServices = Array.isArray(gatewayProbe.readyServices)
    ? gatewayProbe.readyServices
    : [];

  const missingServices = requiredServices.filter(
    service => !readyServices.includes(service)
  );

  const checks = [
    check(
      'mongodb',
      Boolean(config.mongoUri),
      config.mongoUri ? 'Configured' : 'NEXUS_MONGODB_URI missing'
    ),
    check(
      'graph_version',
      Boolean(config.graphVersion),
      config.graphVersion ? 'Configured' : 'NEXMETA_GRAPH_VERSION missing'
    ),
    check(
      'meta_app',
      Boolean(config.appId && config.appSecret),
      config.appId && config.appSecret
        ? 'App ID/Secret configured server-side'
        : 'Meta App ID/Secret incomplete'
    ),
    check(
      'public_base_url',
      Boolean(config.publicBaseUrl),
      config.publicBaseUrl
        ? 'Public base URL configured'
        : 'NEXMETA_PUBLIC_BASE_URL missing'
    ),
    check(
      'verify_token',
      Boolean(config.verifyToken),
      config.verifyToken
        ? 'Webhook verify token configured'
        : 'NEXMETA_VERIFY_TOKEN missing'
    ),
    check(
      'oauth_redirect',
      Boolean(config.oauthRedirectUri),
      config.oauthRedirectUri
        ? 'OAuth redirect configured'
        : 'NEXMETA_OAUTH_REDIRECT_URI missing'
    ),
    check(
      'token_encryption',
      Boolean(config.tokenEncryptionKey),
      config.tokenEncryptionKey
        ? 'Encrypted Page-token vault enabled'
        : 'NEXMETA_TOKEN_ENCRYPTION_KEY missing'
    ),
    check(
      'nexcontrol_machine_key',
      Boolean(config.controlKey),
      config.controlKey
        ? 'Machine control configured'
        : 'NEXMETA_CONTROL_KEY missing'
    ),
    check(
      'account_connected',
      account.connected === true && account.tokenExpired !== true,
      account.connected
        ? account.tokenExpired
          ? 'Facebook owner account token is expired'
          : `Connected account: ${account.account?.name || account.account?.userId || 'Facebook user'}`
        : accountStateError
          ? `Account state unavailable: ${accountStateError}`
          : 'No Facebook owner account connected'
    ),
    check(
      'active_page',
      Boolean(pages.activePage || pages.staticFallbackConfigured),
      pages.activePage
        ? `Active Page: ${pages.activePage.name || pages.activePage.pageId}`
        : pages.staticFallbackConfigured
          ? 'Static bootstrap Page configured'
          : pageStateError
            ? `Page state unavailable: ${pageStateError}`
            : 'No active Facebook Page'
    ),
    check(
      'page_webhook_subscription',
      pages.subscribedPages > 0,
      pages.subscribedPages > 0
        ? `${pages.subscribedPages} Page(s) subscribed`
        : pages.staticFallbackConfigured
          ? 'Static Page configured, but webhook subscription is not confirmed'
          : pageStateError
            ? `Webhook state unavailable: ${pageStateError}`
            : 'No Page webhook subscription confirmed'
    ),
    check(
      'nexus_gateway_url',
      Boolean(config.nexusGatewayUrl),
      config.nexusGatewayUrl
        ? 'Nexus command gateway URL configured'
        : 'NEXUS_COMMAND_GATEWAY_URL missing'
    ),
    check(
      'nexus_gateway_auth',
      Boolean(config.nexusGatewayKey),
      config.nexusGatewayKey
        ? 'Signed Nexus gateway authentication configured'
        : 'NEXUS_COMMAND_GATEWAY_KEY missing'
    ),
    check(
      'nexus_gateway_live',
      gatewayProbe.ok === true,
      gatewayProbe.ok
        ? `Authenticated bridge probe succeeded in ${gatewayProbe.latencyMs}ms`
        : gatewayProbe.status
          ? `Bridge probe failed with HTTP ${gatewayProbe.status}`
          : gatewayProbe.error === 'gateway_not_configured'
            ? 'Gateway URL/key not configured'
            : 'Authenticated bridge probe failed'
    ),
    check(
      'nexus_gateway_services',
      gatewayProbe.ok === true && missingServices.length === 0,
      gatewayProbe.ok !== true
        ? 'Bridge receiver is not live'
        : missingServices.length
          ? `Missing adapters: ${missingServices.join(', ')}`
          : `All required adapters production-ready: ${requiredServices.join(', ')}`
    )
  ];

  const adapterCheckNames = new Set([
    'mongodb',
    'graph_version',
    'meta_app',
    'public_base_url',
    'verify_token',
    'oauth_redirect',
    'token_encryption',
    'nexcontrol_machine_key',
    'account_connected',
    'active_page',
    'page_webhook_subscription'
  ]);

  const bridgeCheckNames = new Set([
    ...adapterCheckNames,
    'nexus_gateway_url',
    'nexus_gateway_auth',
    'nexus_gateway_live',
    'nexus_gateway_services'
  ]);

  const adapterReady = checks
    .filter(item => adapterCheckNames.has(item.name))
    .every(item => item.ok);

  const bridgeReady = checks
    .filter(item => bridgeCheckNames.has(item.name))
    .every(item => item.ok);

  return {
    version: 1,
    metaConfigured: metaConfigured(),
    oauthConfigured: oauthConfigured(),
    adapterReady,
    bridgeReady,
    pages,
    account,
    pageStateError,
    accountStateError,
    gatewayProbe: {
      ok: gatewayProbe.ok === true,
      latencyMs: gatewayProbe.latencyMs ?? null,
      status: gatewayProbe.status ?? null,
      handledBy: gatewayProbe.handledBy ?? null,
      availableServices,
      readyServices,
      requiredServices,
      missingServices,
      serviceStatus: Array.isArray(gatewayProbe.serviceStatus)
        ? gatewayProbe.serviceStatus
        : []
    },
    checks
  };
}
