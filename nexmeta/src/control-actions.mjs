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
  setCommentHidden
} from './meta-client.mjs';
import {
  getMetrics,
  recentAudit,
  linkIdentity,
  unlinkIdentity,
  getRuntimeSettings,
  setRuntimeSettings
} from './store.mjs';
import { config } from './config.mjs';

export const CONTROL_CAPABILITIES = Object.freeze([
  'status',
  'probe_page',
  'metrics',
  'recent_audit',
  'runtime_settings',
  'set_runtime',
  'link_identity',
  'unlink_identity',
  'send_text',
  'send_media',
  'send_quick_replies',
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
      safeAuditTarget(body?.objectId) ||
      safeAuditTarget(body?.commentId) ||
      safeAuditTarget(body?.conversationId) ||
      safeAuditTarget(body?.messageId) ||
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

export async function executeControlAction(body) {
  const action = requireString(body?.action, 'action', 80);

  switch (action) {
    case 'probe_page':
      return getPageProfile();

    case 'metrics':
      return getMetrics();

    case 'recent_audit':
      return recentAudit(body.limit);

    case 'runtime_settings':
      return getRuntimeSettings({ force: true });

    case 'set_runtime':
      return setRuntimeSettings({
        inboundEnabled: body.inboundEnabled,
        outboundEnabled: body.outboundEnabled
      });

    case 'link_identity':
      return linkIdentity({
        platform: optionalString(body.platform, 40) || 'facebook',
        pageId: optionalString(body.pageId, 300) || config.pageId,
        externalUserId: requireString(body.externalUserId, 'externalUserId', 500),
        nexusUserId: requireString(body.nexusUserId, 'nexusUserId', 500)
      });

    case 'unlink_identity':
      return unlinkIdentity({
        platform: optionalString(body.platform, 40) || 'facebook',
        pageId: optionalString(body.pageId, 300) || config.pageId,
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
