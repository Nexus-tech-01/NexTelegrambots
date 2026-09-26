import crypto from 'node:crypto';
import { config } from './config.mjs';
import {
  getActivePageCredential,
  getPageCredential,
  listConnectedPages
} from './token-vault.mjs';

function graphUrl(path) {
  if (!config.graphVersion) throw new Error('NEXMETA_GRAPH_VERSION missing');
  return `https://graph.facebook.com/${config.graphVersion}/${String(path).replace(/^\/+/, '')}`;
}

function appSecretProof(accessToken) {
  if (!config.appSecret) return null;

  return crypto
    .createHmac('sha256', config.appSecret)
    .update(accessToken)
    .digest('hex');
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
      `${label} HTTP ${response.status}`
    );
    error.status = response.status >= 400 ? response.status : 502;
    error.metaCode = data?.error?.code;
    error.metaSubcode = data?.error?.error_subcode;
    throw error;
  }

  return data;
}

export function defaultNexusMessengerProfile() {
  return {
    get_started: {
      payload: 'NEXMETA_START'
    },
    greeting: [
      {
        locale: 'default',
        text: 'Welcome to NexMeta. Access Nexus tools, games, downloads and assistance directly from Messenger.'
      },
      {
        locale: 'fr_FR',
        text: 'Bienvenue sur NexMeta. Accède aux outils Nexus, jeux, téléchargements et à l’assistance directement depuis Messenger.'
      }
    ],
    ice_breakers: [
      {
        question: 'Download a video or audio',
        payload: '/download'
      },
      {
        question: 'Play a Nexus game',
        payload: '/game'
      },
      {
        question: 'Create or manage stickers',
        payload: '/sticker'
      },
      {
        question: 'Ask Nexus AI',
        payload: '/ai'
      }
    ],
    persistent_menu: [
      {
        locale: 'default',
        composer_input_disabled: false,
        call_to_actions: [
          {
            type: 'nested',
            title: 'Nexus tools',
            call_to_actions: [
              {
                type: 'postback',
                title: 'Downloader',
                payload: '/download'
              },
              {
                type: 'postback',
                title: 'Stickers',
                payload: '/sticker'
              },
              {
                type: 'postback',
                title: 'Games',
                payload: '/game'
              }
            ]
          },
          {
            type: 'nested',
            title: 'Community',
            call_to_actions: [
              {
                type: 'postback',
                title: 'Group tools',
                payload: '/group'
              },
              {
                type: 'postback',
                title: 'Channel tools',
                payload: '/channel'
              }
            ]
          },
          {
            type: 'postback',
            title: 'Nexus AI',
            payload: '/ai'
          }
        ]
      }
    ]
  };
}

async function resolveCredential(pageId) {
  const id = String(pageId || '').trim();

  return id
    ? getPageCredential(id)
    : getActivePageCredential();
}

async function profileRequest({
  method = 'GET',
  fields,
  body,
  pageId
} = {}) {
  const credential = await resolveCredential(pageId);
  const url = new URL(
    graphUrl(`${credential.pageId}/messenger_profile`)
  );

  if (fields?.length) {
    url.searchParams.set('fields', fields.join(','));
  }

  const proof = appSecretProof(credential.pageAccessToken);
  if (proof) url.searchParams.set('appsecret_proof', proof);

  const result = await readJson(
    await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${credential.pageAccessToken}`,
        ...(body
          ? { 'content-type': 'application/json; charset=utf-8' }
          : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    }),
    'Messenger Profile API'
  );

  return {
    pageId: credential.pageId,
    result
  };
}

export async function configureMessengerProfile(
  profile,
  { pageId } = {}
) {
  const payload = profile && typeof profile === 'object'
    ? profile
    : defaultNexusMessengerProfile();

  const response = await profileRequest({
    method: 'POST',
    body: payload,
    pageId
  });

  return {
    pageId: response.pageId,
    success:
      response.result?.result === 'success' ||
      response.result?.success !== false,
    result: response.result
  };
}

export async function configureDefaultNexusMessengerProfile(
  { pageId } = {}
) {
  const profile = defaultNexusMessengerProfile();
  const result = await configureMessengerProfile(
    profile,
    { pageId }
  );

  return {
    ...result,
    profile
  };
}

export async function configureAllDefaultNexusMessengerProfiles() {
  const pages = await listConnectedPages();
  const results = [];

  if (!pages.length) {
    const single = await configureDefaultNexusMessengerProfile();
    return [single];
  }

  for (const page of pages) {
    try {
      results.push(
        await configureDefaultNexusMessengerProfile({
          pageId: page.pageId
        })
      );
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

export async function inspectMessengerProfile(
  fields = [
    'get_started',
    'greeting',
    'ice_breakers',
    'persistent_menu'
  ],
  { pageId } = {}
) {
  const normalized = [...new Set(
    fields.map(value => String(value || '').trim()).filter(Boolean)
  )];

  return profileRequest({
    fields: normalized,
    pageId
  });
}

export async function deleteMessengerProfileFields(
  fields,
  { pageId } = {}
) {
  if (!Array.isArray(fields) || !fields.length) {
    throw new Error('fields are required');
  }

  return profileRequest({
    method: 'DELETE',
    body: {
      fields: [...new Set(fields.map(String))]
    },
    pageId
  });
}
