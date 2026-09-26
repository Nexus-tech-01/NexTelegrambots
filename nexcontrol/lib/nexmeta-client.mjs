const clean = value => String(value ?? '').trim();

function config() {
  const baseUrl = clean(process.env.NEXMETA_URL);
  const controlKey = clean(process.env.NEXMETA_CONTROL_KEY);

  if (!baseUrl) throw new Error('NEXMETA_URL missing');
  if (!controlKey) throw new Error('NEXMETA_CONTROL_KEY missing');

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    controlKey
  };
}

async function request(path, options = {}) {
  const { baseUrl, controlKey } = config();

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${controlKey}`,
      ...(options.body
        ? { 'content-type': 'application/json; charset=utf-8' }
        : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || `NexMeta HTTP ${response.status}`
    );
    error.status = response.status;
    error.code = data?.error;
    error.metaCode = data?.metaCode;
    error.metaSubcode = data?.metaSubcode;
    throw error;
  }

  return data;
}

export async function nexMetaStatus() {
  return request('/internal/v1/status');
}

export async function nexMetaAction(action, payload = {}) {
  if (!action) throw new Error('action is required');

  return request('/internal/v1/actions', {
    method: 'POST',
    body: JSON.stringify({
      action,
      ...payload
    })
  });
}

export async function startNexMetaOAuth(ttlSeconds = 600) {
  return nexMetaAction('oauth_start', {
    ttlSeconds
  });
}

export async function listNexMetaPages() {
  return nexMetaAction('list_connected_pages');
}

export async function activateNexMetaPage(pageId) {
  return nexMetaAction('activate_connected_page', {
    pageId
  });
}

export async function removeNexMetaPage(pageId) {
  return nexMetaAction('remove_connected_page', {
    pageId
  });
}

export async function nexMetaMetrics() {
  return nexMetaAction('metrics');
}

export async function nexMetaRuntimeSettings() {
  return nexMetaAction('runtime_settings');
}

export async function setNexMetaRuntime(patch) {
  return nexMetaAction('set_runtime', patch);
}

export async function nexMetaPage(pageId) {
  return nexMetaAction('probe_page', {
    ...(pageId ? { pageId } : {})
  });
}

export async function nexMetaConversations(payload = {}) {
  return nexMetaAction('list_conversations', payload);
}

export async function nexMetaConversationMessages(conversationId, payload = {}) {
  return nexMetaAction('list_conversation_messages', {
    conversationId,
    ...payload
  });
}

export async function createNexMetaLinkCode(nexusUserId, ttlSeconds = 600) {
  return nexMetaAction('create_link_code', {
    nexusUserId,
    ttlSeconds
  });
}

export async function nexMetaWebhookEvents(payload = {}) {
  return nexMetaAction('list_webhook_events', payload);
}

export async function replayNexMetaWebhook(eventKey) {
  return nexMetaAction('replay_webhook', {
    eventKey
  });
}

export async function publishNexMetaPost(payload) {
  return nexMetaAction('publish_page_post', payload);
}

export async function sendNexMetaMessage(
  psid,
  text,
  pageId
) {
  return nexMetaAction('send_text', {
    psid,
    text,
    ...(pageId ? { pageId } : {})
  });
}

export async function sendNexMetaMedia(
  psid,
  mediaType,
  url,
  pageId
) {
  return nexMetaAction('send_media', {
    psid,
    mediaType,
    url,
    ...(pageId ? { pageId } : {})
  });
}

export async function sendNexMetaQuickReplies(
  psid,
  text,
  quickReplies,
  pageId
) {
  return nexMetaAction('send_quick_replies', {
    psid,
    text,
    quickReplies,
    ...(pageId ? { pageId } : {})
  });
}


export async function configureNexMetaWebhooks(fields) {
  return nexMetaAction('configure_webhooks', {
    ...(Array.isArray(fields) ? { fields } : {})
  });
}

export async function inspectNexMetaAppWebhooks() {
  return nexMetaAction('inspect_app_webhooks');
}

export async function subscribeNexMetaPageWebhooks(pageId, fields) {
  return nexMetaAction('subscribe_page_webhooks', {
    pageId,
    ...(Array.isArray(fields) ? { fields } : {})
  });
}

export async function inspectNexMetaPageWebhooks(pageId) {
  return nexMetaAction('inspect_page_webhooks', {
    pageId
  });
}

export async function unsubscribeNexMetaPageWebhooks(pageId) {
  return nexMetaAction('unsubscribe_page_webhooks', {
    pageId
  });
}


export async function doctorNexMetaPage(pageId) {
  return nexMetaAction('doctor_page', {
    pageId
  });
}

export async function doctorAllNexMetaPages() {
  return nexMetaAction('doctor_all_pages');
}


export async function configureDefaultNexMetaMessengerProfile(pageId) {
  return nexMetaAction('configure_default_messenger_profile', {
    ...(pageId ? { pageId } : {})
  });
}

export async function configureNexMetaMessengerProfile(
  profile,
  pageId
) {
  return nexMetaAction('configure_messenger_profile', {
    profile,
    ...(pageId ? { pageId } : {})
  });
}

export async function inspectNexMetaMessengerProfile(
  fields,
  pageId
) {
  return nexMetaAction('inspect_messenger_profile', {
    ...(Array.isArray(fields) ? { fields } : {}),
    ...(pageId ? { pageId } : {})
  });
}

export async function deleteNexMetaMessengerProfileFields(
  fields,
  pageId
) {
  return nexMetaAction('delete_messenger_profile_fields', {
    fields,
    ...(pageId ? { pageId } : {})
  });
}


export async function getNexMetaMessengerUserProfile(
  psid,
  pageId
) {
  return nexMetaAction('get_messenger_user_profile', {
    psid,
    ...(pageId ? { pageId } : {})
  });
}

export async function moderateNexMetaConversation(
  psid,
  moderationAction,
  pageId
) {
  return nexMetaAction('moderate_conversation', {
    psid,
    moderationAction,
    ...(pageId ? { pageId } : {})
  });
}

export async function sendNexMetaTemplate(
  psid,
  template,
  pageId
) {
  return nexMetaAction('send_template', {
    psid,
    template,
    ...(pageId ? { pageId } : {})
  });
}

export async function sendNexMetaButtonTemplate(
  psid,
  text,
  buttons,
  pageId
) {
  return nexMetaAction('send_button_template', {
    psid,
    text,
    buttons,
    ...(pageId ? { pageId } : {})
  });
}

export async function sendNexMetaImageGallery(
  psid,
  imageUrls,
  pageId
) {
  return nexMetaAction('send_image_gallery', {
    psid,
    imageUrls,
    ...(pageId ? { pageId } : {})
  });
}


export async function nexMetaDeploymentReadiness() {
  return nexMetaAction('deployment_readiness');
}


export async function configureAllDefaultNexMetaMessengerProfiles() {
  return nexMetaAction('configure_all_default_messenger_profiles');
}


export async function nexMetaBridgeStatus() {
  return nexMetaAction('bridge_status');
}


export async function nexMetaConnectionReadiness() {
  return nexMetaAction('connection_readiness');
}
