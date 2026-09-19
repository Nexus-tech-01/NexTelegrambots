import {
  getPageProfile,
  sendText,
  sendMedia,
  sendQuickReplies,
  senderAction,
  listConversations,
  listConversationMessages,
  getMessage,
  publishPagePost,
  editObjectMessage,
  deleteObject,
  listComments,
  replyToComment,
  setCommentHidden,
  getMessengerUserProfile,
  moderateConversation,
  sendTemplate,
  sendButtonTemplate,
  sendImageGallery
} from './meta-client.mjs';
import {
  getMetrics,
  recentAudit,
  linkIdentity,
  unlinkIdentity,
  getRuntimeSettings,
  setRuntimeSettings,
  listWebhookEvents,
  markWebhookReplay
} from './store.mjs';
import { processWebhookPayload } from './processor.mjs';
import { deploymentReadiness } from './readiness.mjs';
import { createIdentityLinkCode } from './identity-link.mjs';
import { createMetaOAuthStart } from './meta-oauth.mjs';
import {
  diagnoseMetaPage,
  diagnoseAllMetaPages
} from './meta-diagnostics.mjs';
import {
  configureMessengerProfile,
  configureDefaultNexusMessengerProfile,
  configureAllDefaultNexusMessengerProfiles,
  inspectMessengerProfile,
  deleteMessengerProfileFields
} from './messenger-profile.mjs';
import {
  configureCompleteWebhookStack,
  inspectAppWebhooks,
  subscribePageToApp,
  inspectPageSubscriptions,
  unsubscribePageFromApp
} from './meta-webhooks.mjs';
import {
  listConnectedPages,
  activateConnectedPage,
  removeConnectedPage,
  getActivePageCredential
} from './token-vault.mjs';

export const CONTROL_CAPABILITIES = Object.freeze([
  'status',
  'oauth_start',
  'list_connected_pages',
  'activate_connected_page',
  'remove_connected_page',
  'configure_webhooks',
  'inspect_app_webhooks',
  'subscribe_page_webhooks',
  'inspect_page_webhooks',
  'unsubscribe_page_webhooks',
  'doctor_page',
  'doctor_all_pages',
  'configure_default_messenger_profile',
  'configure_all_default_messenger_profiles',
  'configure_messenger_profile',
  'inspect_messenger_profile',
  'delete_messenger_profile_fields',
  'probe_page',
  'metrics',
  'deployment_readiness',
  'recent_audit',
  'runtime_settings',
  'set_runtime',
  'list_webhook_events',
  'replay_webhook',
  'create_link_code',
  'link_identity',
  'unlink_identity',
  'send_text',
  'send_media',
  'send_quick_replies',
  'send_template',
  'send_button_template',
  'send_image_gallery',
  'get_messenger_user_profile',
  'moderate_conversation',
  'sender_action',
  'list_conversations',
  'list_conversation_messages',
  'get_message',
  'publish_page_post',
  'edit_page_post',
  'delete_page_post',
  'list_comments',
  'reply_comment',
  'hide_comment',
  'unhide_comment',
  'delete_comment'
]);

const META_WRITE_ACTIONS = new Set([
  'send_text',
  'send_media',
  'send_quick_replies',
  'send_template',
  'send_button_template',
  'send_image_gallery',
  'moderate_conversation',
  'sender_action',
  'publish_page_post',
  'edit_page_post',
  'delete_page_post',
  'reply_comment',
  'hide_comment',
  'unhide_comment',
  'delete_comment'
]);

function requireString(value, name, max = 10000) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} is too long`);
  return result;
}

function optionalString(value, max = 10000) {
  if (value === undefined || value === null || value === '') return undefined;
  const result = String(value).trim();
  if (result.length > max) throw new Error('value is too long');
  return result;
}

function safeAuditTarget(value) {
  const text = String(value ?? '');
  return text ? text.slice(0, 160) : null;
}

export function controlAuditMetadata(body) {
  const action = String(body?.action || '');
  const metadata = {
    action,
    target:
      safeAuditTarget(body?.psid) ||
      safeAuditTarget(body?.pageId) ||
      safeAuditTarget(body?.objectId) ||
      safeAuditTarget(body?.commentId) ||
      safeAuditTarget(body?.conversationId) ||
      safeAuditTarget(body?.messageId) ||
      safeAuditTarget(body?.eventKey) ||
      safeAuditTarget(body?.externalUserId) ||
      safeAuditTarget(body?.nexusUserId)
  };

  if (typeof body?.text === 'string') metadata.textLength = body.text.length;
  if (typeof body?.message === 'string') metadata.messageLength = body.message.length;
  if (typeof body?.url === 'string') metadata.hasUrl = true;
  if (Array.isArray(body?.quickReplies)) metadata.quickReplyCount = body.quickReplies.length;
  if (typeof body?.inboundEnabled === 'boolean') metadata.inboundEnabled = body.inboundEnabled;
  if (typeof body?.outboundEnabled === 'boolean') metadata.outboundEnabled = body.outboundEnabled;

  return metadata;
}

async function assertMetaWritesEnabled(action) {
  if (!META_WRITE_ACTIONS.has(action)) return;

  const settings = await getRuntimeSettings();
  if (!settings.outboundEnabled) {
    const error = new Error('outbound_disabled');
    error.status = 503;
    throw error;
  }
}

async function resolvePageId(explicitPageId) {
  const provided = optionalString(explicitPageId, 300);
  if (provided) return provided;
  return (await getActivePageCredential()).pageId;
}

export async function executeControlAction(body) {
  const action = requireString(body?.action, 'action', 80);
  await assertMetaWritesEnabled(action);

  switch (action) {
    case 'oauth_start':
      return createMetaOAuthStart({
        actor: 'nexcontrol',
        ttlSeconds: body.ttlSeconds
      });

    case 'list_connected_pages':
      return listConnectedPages();

    case 'activate_connected_page':
      return activateConnectedPage(
        requireString(body.pageId, 'pageId', 300)
      );

    case 'remove_connected_page':
      return {
        removed: await removeConnectedPage(
          requireString(body.pageId, 'pageId', 300)
        )
      };

    case 'configure_webhooks':
      return configureCompleteWebhookStack({
        fields: Array.isArray(body.fields) ? body.fields : undefined
      });

    case 'inspect_app_webhooks':
      return inspectAppWebhooks();

    case 'subscribe_page_webhooks':
      return subscribePageToApp(
        requireString(body.pageId, 'pageId', 300),
        {
          fields: Array.isArray(body.fields) ? body.fields : undefined
        }
      );

    case 'inspect_page_webhooks':
      return inspectPageSubscriptions(
        requireString(body.pageId, 'pageId', 300)
      );

    case 'unsubscribe_page_webhooks':
      return unsubscribePageFromApp(
        requireString(body.pageId, 'pageId', 300)
      );

    case 'doctor_page':
      return diagnoseMetaPage(
        requireString(body.pageId, 'pageId', 300)
      );

    case 'doctor_all_pages':
      return diagnoseAllMetaPages();

    case 'configure_default_messenger_profile':
      return configureDefaultNexusMessengerProfile({
        pageId: optionalString(body.pageId, 300)
      });

    case 'configure_all_default_messenger_profiles':
      return configureAllDefaultNexusMessengerProfiles();

    case 'configure_messenger_profile':
      return configureMessengerProfile(
        body.profile && typeof body.profile === 'object'
          ? body.profile
          : null,
        {
          pageId: optionalString(body.pageId, 300)
        }
      );

    case 'inspect_messenger_profile':
      return inspectMessengerProfile(
        Array.isArray(body.fields) ? body.fields : undefined,
        {
          pageId: optionalString(body.pageId, 300)
        }
      );

    case 'delete_messenger_profile_fields':
      return deleteMessengerProfileFields(
        body.fields,
        {
          pageId: optionalString(body.pageId, 300)
        }
      );

    case 'probe_page':
      return getPageProfile();

    case 'metrics':
      return getMetrics();

    case 'deployment_readiness':
      return deploymentReadiness();

    case 'recent_audit':
      return recentAudit(body.limit);

    case 'runtime_settings':
      return getRuntimeSettings({ force: true });

    case 'set_runtime':
      return setRuntimeSettings({
        inboundEnabled: body.inboundEnabled,
        outboundEnabled: body.outboundEnabled
      });

    case 'list_webhook_events':
      return listWebhookEvents({
        status: optionalString(body.status, 40),
        limit: body.limit
      });

    case 'replay_webhook':
      {
        const eventKey = requireString(body.eventKey, 'eventKey', 200);
        const item = await markWebhookReplay(eventKey);

        if (!item) {
          const error = new Error('webhook_not_found');
          error.status = 404;
          throw error;
        }

        const result = await processWebhookPayload(
          item.eventKey,
          item.raw,
          { throwOnFailure: true }
        );

        return {
          eventKey: item.eventKey,
          replayCount: item.replayCount,
          ...result
        };
      }

    case 'create_link_code':
      return createIdentityLinkCode({
        nexusUserId: requireString(body.nexusUserId, 'nexusUserId', 500),
        ttlSeconds: body.ttlSeconds
      });

    case 'link_identity':
      return linkIdentity({
        platform: optionalString(body.platform, 40) || 'facebook',
        pageId: await resolvePageId(body.pageId),
        externalUserId: requireString(body.externalUserId, 'externalUserId', 500),
        nexusUserId: requireString(body.nexusUserId, 'nexusUserId', 500)
      });

    case 'unlink_identity':
      return unlinkIdentity({
        platform: optionalString(body.platform, 40) || 'facebook',
        pageId: await resolvePageId(body.pageId),
        externalUserId: requireString(body.externalUserId, 'externalUserId', 500)
      });

    case 'send_text':
      return sendText(
        requireString(body.psid, 'psid', 300),
        requireString(body.text, 'text', 2000)
      );

    case 'send_media':
      return sendMedia(
        requireString(body.psid, 'psid', 300),
        requireString(body.mediaType, 'mediaType', 20),
        requireString(body.url, 'url', 5000)
      );

    case 'send_quick_replies':
      return sendQuickReplies(
        requireString(body.psid, 'psid', 300),
        requireString(body.text, 'text', 2000),
        body.quickReplies
      );

    case 'send_template':
      return sendTemplate(
        requireString(body.psid, 'psid', 300),
        body.template
      );

    case 'send_button_template':
      return sendButtonTemplate(
        requireString(body.psid, 'psid', 300),
        requireString(body.text, 'text', 640),
        body.buttons
      );

    case 'send_image_gallery':
      return sendImageGallery(
        requireString(body.psid, 'psid', 300),
        body.imageUrls
      );

    case 'get_messenger_user_profile':
      return getMessengerUserProfile(
        requireString(body.psid, 'psid', 300)
      );

    case 'moderate_conversation':
      return moderateConversation(
        requireString(body.psid, 'psid', 300),
        requireString(body.moderationAction, 'moderationAction', 40)
      );

    case 'sender_action':
      return senderAction(
        requireString(body.psid, 'psid', 300),
        requireString(body.senderAction, 'senderAction', 30)
      );

    case 'list_conversations':
      return listConversations({
        limit: body.limit,
        after: optionalString(body.after, 2000)
      });

    case 'list_conversation_messages':
      return listConversationMessages(
        requireString(body.conversationId, 'conversationId', 500),
        {
          limit: body.limit,
          after: optionalString(body.after, 2000)
        }
      );

    case 'get_message':
      return getMessage(requireString(body.messageId, 'messageId', 500));

    case 'publish_page_post':
      return publishPagePost({
        message: optionalString(body.message, 63206) || '',
        link: optionalString(body.link, 5000),
        published: body.published !== false,
        scheduledPublishTime: body.scheduledPublishTime
      });

    case 'edit_page_post':
      return editObjectMessage(
        requireString(body.objectId, 'objectId', 500),
        requireString(body.message, 'message', 63206)
      );

    case 'delete_page_post':
      return deleteObject(requireString(body.objectId, 'objectId', 500));

    case 'list_comments':
      return listComments(
        requireString(body.objectId, 'objectId', 500),
        {
          limit: body.limit,
          after: optionalString(body.after, 2000)
        }
      );

    case 'reply_comment':
      return replyToComment(
        requireString(body.commentId, 'commentId', 500),
        requireString(body.message, 'message', 8000)
      );

    case 'hide_comment':
      return setCommentHidden(
        requireString(body.commentId, 'commentId', 500),
        true
      );

    case 'unhide_comment':
      return setCommentHidden(
        requireString(body.commentId, 'commentId', 500),
        false
      );

    case 'delete_comment':
      return deleteObject(requireString(body.commentId, 'commentId', 500));

    default:
      {
        const error = new Error('unsupported_action');
        error.status = 400;
        throw error;
      }
  }
}
