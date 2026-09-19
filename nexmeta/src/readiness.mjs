import {
  config,
  metaConfigured,
  oauthConfigured
} from './config.mjs';
import { connectedPageState } from './token-vault.mjs';
import { probeNexusGateway } from './router.mjs';

function check(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail: String(detail || '')
  };
}

export async function deploymentReadiness() {
  const pages = await connectedPageState();

  const gatewayProbe =
    config.nexusGatewayUrl && config.nexusGatewayKey
      ? await probeNexusGateway()
      : {
          ok: false,
          error: 'gateway_not_configured'
        };

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
      'active_page',
      Boolean(pages.activePage || pages.staticFallbackConfigured),
      pages.activePage
        ? `Active Page: ${pages.activePage.name || pages.activePage.pageId}`
        : pages.staticFallbackConfigured
          ? 'Static bootstrap Page configured'
          : 'No active Facebook Page'
    ),
    check(
      'page_webhook_subscription',
      pages.subscribedPages > 0 || pages.staticFallbackConfigured,
      pages.subscribedPages > 0
        ? `${pages.subscribedPages} Page(s) subscribed`
        : pages.staticFallbackConfigured
          ? 'Static Page: subscription state not stored in vault'
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
    'active_page'
  ]);

  const bridgeCheckNames = new Set([
    ...adapterCheckNames,
    'nexus_gateway_url',
    'nexus_gateway_auth',
    'nexus_gateway_live'
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
    gatewayProbe: {
      ok: gatewayProbe.ok === true,
      latencyMs: gatewayProbe.latencyMs ?? null,
      status: gatewayProbe.status ?? null,
      handledBy: gatewayProbe.handledBy ?? null
    },
    checks
  };
}
