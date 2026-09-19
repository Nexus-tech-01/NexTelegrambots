import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { config, assertOAuthConfig } from './config.mjs';
import { storeConnectedPages } from './token-vault.mjs';
import {
  configureAppWebhook,
  subscribePageToApp
} from './meta-webhooks.mjs';
import {
  configureAllDefaultNexusMessengerProfiles
} from './messenger-profile.mjs';

let clientPromise;
let indexesPromise;

export const META_OAUTH_SCOPES = Object.freeze([
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_messaging'
]);

async function statesCollection() {
  if (!config.mongoUri) throw new Error('NEXUS_MONGODB_URI missing');

  clientPromise ??= new MongoClient(config.mongoUri).connect();
  const db = (await clientPromise).db(config.dbName);
  const states = db.collection('oauth_states');

  indexesPromise ??= Promise.all([
    states.createIndex({ stateHash: 1 }, { unique: true }),
    states.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);

  await indexesPromise;
  return states;
}

function hashState(state) {
  return crypto.createHash('sha256').update(String(state)).digest('hex');
}

function graphUrl(path) {
  return `https://graph.facebook.com/${config.graphVersion}/${path.replace(/^\/+/, '')}`;
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

function appSecretProof(accessToken) {
  return crypto
    .createHmac('sha256', config.appSecret)
    .update(accessToken)
    .digest('hex');
}

export async function createMetaOAuthStart({
  actor = 'nexcontrol',
  ttlSeconds = 600
} = {}) {
  assertOAuthConfig();

  const states = await statesCollection();
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const ttl = Math.max(120, Math.min(1800, Number(ttlSeconds) || 600));
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  await states.insertOne({
    stateHash: hashState(state),
    actor: String(actor),
    createdAt: now,
    expiresAt,
    usedAt: null
  });

  const url = new URL(
    `https://www.facebook.com/${config.graphVersion}/dialog/oauth`
  );

  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.oauthRedirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', META_OAUTH_SCOPES.join(','));

  return {
    authorizationUrl: url.toString(),
    expiresAt,
    scopes: META_OAUTH_SCOPES
  };
}

async function consumeState(state) {
  const value = String(state || '').trim();
  if (!value) return null;

  const states = await statesCollection();
  const now = new Date();

  return states.findOneAndUpdate(
    {
      stateHash: hashState(value),
      usedAt: null,
      expiresAt: { $gt: now }
    },
    {
      $set: {
        usedAt: now
      }
    },
    {
      returnDocument: 'after'
    }
  );
}

async function exchangeAuthorizationCode(code) {
  const url = new URL(graphUrl('oauth/access_token'));
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('redirect_uri', config.oauthRedirectUri);
  url.searchParams.set('code', String(code));

  return readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta authorization-code exchange'
  );
}

async function exchangeLongLivedUserToken(shortLivedToken) {
  const url = new URL(graphUrl('oauth/access_token'));
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('fb_exchange_token', shortLivedToken);

  return readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta long-lived-token exchange'
  );
}

async function getManagedPages(userAccessToken) {
  const url = new URL(graphUrl('me/accounts'));
  url.searchParams.set('fields', 'id,name,access_token,tasks');
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', userAccessToken);
  url.searchParams.set('appsecret_proof', appSecretProof(userAccessToken));

  const data = await readJson(
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000)
    }),
    'Meta managed Pages request'
  );

  return Array.isArray(data?.data) ? data.data : [];
}

async function provisionWebhooks(storedPages) {
  let app = null;

  try {
    app = await configureAppWebhook();
  } catch (error) {
    app = {
      success: false,
      error: String(error?.message || error).slice(0, 500),
      metaCode: error?.metaCode ?? null
    };
  }

  const pages = [];

  for (const page of storedPages) {
    try {
      pages.push(await subscribePageToApp(page.pageId));
    } catch (error) {
      pages.push({
        pageId: page.pageId,
        success: false,
        error: String(error?.message || error).slice(0, 500),
        metaCode: error?.metaCode ?? null
      });
    }
  }

  return {
    app,
    pages,
    success:
      app?.success === true &&
      pages.length > 0 &&
      pages.every(item => item.success)
  };
}

export async function completeMetaOAuth({
  code,
  state
}) {
  assertOAuthConfig();

  const claimedState = await consumeState(state);
  if (!claimedState) {
    const error = new Error('invalid_or_expired_oauth_state');
    error.status = 400;
    throw error;
  }

  const authorization = await exchangeAuthorizationCode(
    String(code || '').trim()
  );

  if (!authorization?.access_token) {
    throw new Error('Meta did not return a user access token');
  }

  const longLived = await exchangeLongLivedUserToken(
    authorization.access_token
  );

  if (!longLived?.access_token) {
    throw new Error('Meta did not return a long-lived user token');
  }

  const pages = await getManagedPages(longLived.access_token);
  const stored = await storeConnectedPages(pages);
  const webhooks = stored.length
    ? await provisionWebhooks(stored)
    : {
        app: null,
        pages: [],
        success: false
      };

  let messengerProfile = null;

  if (stored.length) {
    try {
      messengerProfile = await configureAllDefaultNexusMessengerProfiles();
    } catch (error) {
      messengerProfile = {
        success: false,
        error: String(error?.message || error).slice(0, 500),
        metaCode: error?.metaCode ?? null
      };
    }
  }

  return {
    actor: claimedState.actor,
    pagesDiscovered: pages.length,
    pagesStored: stored.length,
    pages: stored,
    webhooks,
    messengerProfile
  };
}
