import crypto from 'node:crypto';
import { config } from './config.mjs';
import {
  getPageCredential,
  listConnectedPages,
  markPageWebhookState
} from './token-vault.mjs';

export const DEFAULT_PAGE_WEBHOOK_FIELDS = Object.freeze([
  'messages',
  'message_echoes',
  'message_deliveries',
  'message_reads',
  'messaging_postbacks',
  'message_reactions',
  'feed'
]);

function graphUrl(path) {
  if (!config.graphVersion) throw new Error('NEXMETA_GRAPH_VERSION missing');
  return `https://graph.facebook.com/${config.graphVersion}/${String(path).replace(/^\/+/, '')}`;
}

async function readJson(response, label) {
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }

  if (!response.ok || data?.error) {
    const error = new Error(
      data?.error?.message ||
      data?.error_description ||
      `${label} HTTP ${response.status}`
    );
    error.status = response.status >= 400 ? response.status : 502;
    error.metaCode = data?.error?.code;
    error.metaSubcode = data?.error?.error_subcode;
    throw error;
  }

  return data;
}

function normalizeFields(fields) {
  const source = Array.isArray(fields) && fields.length
    ? fields
    : DEFAULT_PAGE_WEBHOOK_FIELDS;

  return [...new Set(
    source
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )];
}

function appSecretProof(accessToken) {
  if (!config.appSecret) return null;
  return crypto
    .createHmac('sha256', config.appSecret)
    .update(accessToken)
    .digest('hex');
}

async function getAppAccessToken() {
  if (!config.appId || !config.appSecret) {
    throw new Error('NEXMETA_APP_ID and NEXMETA_APP_SECRET are required');
  }

  const url = new URL(graphUrl('oauth/access_token'));
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('grant_type', 'client_credentials');

  const data = await readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta app access-token request'
  );

  if (!data?.access_token) {
    throw new Error('Meta did not return an app access token');
  }

  return data.access_token;
}

export async function configureAppWebhook({ fields } = {}) {
  if (!config.appId) throw new Error('NEXMETA_APP_ID missing');
  if (!config.verifyToken) throw new Error('NEXMETA_VERIFY_TOKEN missing');
  if (!config.publicBaseUrl) throw new Error('NEXMETA_PUBLIC_BASE_URL missing');

  const subscribedFields = normalizeFields(fields);
  const appAccessToken = await getAppAccessToken();
  const callbackUrl = `${config.publicBaseUrl.replace(/\/+$/, '')}/webhooks/meta`;

  const body = new URLSearchParams({
    object: 'page',
    callback_url: callbackUrl,
    verify_token: config.verifyToken,
    fields: subscribedFields.join(','),
    access_token: appAccessToken
  });

  const data = await readJson(
    await fetch(graphUrl(`${config.appId}/subscriptions`), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
      },
      body,
      signal: AbortSignal.timeout(15000)
    }),
    'Meta App webhook subscription'
  );

  return {
    success: data?.success !== false,
    callbackUrl,
    fields: subscribedFields
  };
}

export async function inspectAppWebhooks() {
  if (!config.appId) throw new Error('NEXMETA_APP_ID missing');

  const appAccessToken = await getAppAccessToken();
  const url = new URL(graphUrl(`${config.appId}/subscriptions`));
  url.searchParams.set('access_token', appAccessToken);

  const data = await readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta App webhook inspection'
  );

  return Array.isArray(data?.data) ? data.data : [];
}

export async function subscribePageToApp(pageId, { fields } = {}) {
  const credential = await getPageCredential(pageId);
  const subscribedFields = normalizeFields(fields);

  const proof = appSecretProof(credential.pageAccessToken);
  const body = new URLSearchParams({
    subscribed_fields: subscribedFields.join(',')
  });

  if (proof) body.set('appsecret_proof', proof);

  try {
    const data = await readJson(
      await fetch(graphUrl(`${credential.pageId}/subscribed_apps`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.pageAccessToken}`,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
        },
        body,
        signal: AbortSignal.timeout(15000)
      }),
      'Meta Page subscribed_apps request'
    );

    await markPageWebhookState(credential.pageId, {
      subscribed: data?.success !== false,
      fields: subscribedFields
    });

    return {
      pageId: credential.pageId,
      success: data?.success !== false,
      fields: subscribedFields
    };
  } catch (error) {
    await markPageWebhookState(credential.pageId, {
      subscribed: false,
      fields: subscribedFields,
      error: error?.message || error
    }).catch(() => {});

    throw error;
  }
}

export async function inspectPageSubscriptions(pageId) {
  const credential = await getPageCredential(pageId);
  const url = new URL(graphUrl(`${credential.pageId}/subscribed_apps`));
  url.searchParams.set('access_token', credential.pageAccessToken);

  const proof = appSecretProof(credential.pageAccessToken);
  if (proof) url.searchParams.set('appsecret_proof', proof);

  const data = await readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta Page subscription inspection'
  );

  return Array.isArray(data?.data) ? data.data : [];
}

export async function unsubscribePageFromApp(pageId) {
  const credential = await getPageCredential(pageId);
  const url = new URL(graphUrl(`${credential.pageId}/subscribed_apps`));
  url.searchParams.set('access_token', credential.pageAccessToken);

  const proof = appSecretProof(credential.pageAccessToken);
  if (proof) url.searchParams.set('appsecret_proof', proof);

  const data = await readJson(
    await fetch(url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta Page subscribed_apps removal'
  );

  await markPageWebhookState(credential.pageId, {
    subscribed: false,
    fields: []
  });

  return {
    pageId: credential.pageId,
    success: data?.success !== false
  };
}

export async function subscribeAllConnectedPages({ fields } = {}) {
  const pages = await listConnectedPages();
  const results = [];

  for (const page of pages) {
    try {
      results.push(await subscribePageToApp(page.pageId, { fields }));
    } catch (error) {
      results.push({
        pageId: page.pageId,
        success: false,
        error: String(error?.message || error).slice(0, 500),
        metaCode: error?.metaCode ?? null
      });
    }
  }

  return results;
}

export async function configureCompleteWebhookStack({ fields } = {}) {
  const app = await configureAppWebhook({ fields });
  const pages = await subscribeAllConnectedPages({ fields });

  return {
    app,
    pages,
    success: app.success && pages.every(item => item.success)
  };
}
