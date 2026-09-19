import { config } from './config.mjs';
import {
  getPageCredential,
  listConnectedPages
} from './token-vault.mjs';

export const CAPABILITY_PERMISSIONS = Object.freeze({
  page_read: [
    'pages_show_list',
    'pages_read_engagement'
  ],
  page_posts: [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts'
  ],
  comments_read: [
    'pages_show_list',
    'pages_read_user_content'
  ],
  comments_manage: [
    'pages_show_list',
    'pages_read_user_content',
    'pages_manage_engagement'
  ],
  messenger: [
    'pages_show_list',
    'pages_manage_metadata',
    'pages_messaging'
  ]
});

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

async function debugAccessToken(pageAccessToken) {
  const appToken = await getAppAccessToken();
  const url = new URL(graphUrl('debug_token'));
  url.searchParams.set('input_token', pageAccessToken);
  url.searchParams.set('access_token', appToken);

  const data = await readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta token debugger'
  );

  return data?.data || {};
}

export function capabilityMatrix(scopes) {
  const granted = new Set(scopes.map(String));
  const matrix = {};

  for (const [capability, required] of Object.entries(CAPABILITY_PERMISSIONS)) {
    const missing = required.filter(permission => !granted.has(permission));

    matrix[capability] = {
      usable: missing.length === 0,
      required,
      missing
    };
  }

  return matrix;
}

export async function diagnoseMetaPage(pageId) {
  const credential = await getPageCredential(pageId);
  const pages = await listConnectedPages();
  const page = pages.find(item => item.pageId === credential.pageId) || null;
  const debug = await debugAccessToken(credential.pageAccessToken);

  const scopes = Array.isArray(debug.scopes)
    ? debug.scopes.map(String)
    : [];

  return {
    page: page
      ? {
          pageId: page.pageId,
          name: page.name,
          active: page.active,
          tasks: page.tasks,
          webhookSubscribed: page.webhookSubscribed,
          webhookFields: page.webhookFields,
          webhookError: page.webhookError
        }
      : {
          pageId: credential.pageId,
          name: credential.pageId,
          active: true,
          tasks: [],
          webhookSubscribed: null,
          webhookFields: [],
          webhookError: null
        },
    token: {
      valid: debug.is_valid === true,
      appId: debug.app_id ? String(debug.app_id) : null,
      userId: debug.user_id ? String(debug.user_id) : null,
      expiresAt: debug.expires_at
        ? new Date(Number(debug.expires_at) * 1000)
        : null,
      dataAccessExpiresAt: debug.data_access_expires_at
        ? new Date(Number(debug.data_access_expires_at) * 1000)
        : null,
      scopes
    },
    capabilities: capabilityMatrix(scopes)
  };
}

export async function diagnoseAllMetaPages() {
  const pages = await listConnectedPages();
  const results = [];

  for (const page of pages) {
    try {
      results.push({
        pageId: page.pageId,
        ok: true,
        diagnosis: await diagnoseMetaPage(page.pageId)
      });
    } catch (error) {
      results.push({
        pageId: page.pageId,
        ok: false,
        error: String(error?.message || error).slice(0, 500),
        metaCode: error?.metaCode ?? null
      });
    }
  }

  return results;
}
