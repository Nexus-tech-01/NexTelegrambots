# NexMeta ↔ NexControl contract v0.4

NexControl is the owner/admin control plane for NexMeta.

## Authentication boundary

NexControl calls NexMeta server-to-server:

```
Authorization: Bearer <NEXMETA_CONTROL_KEY>
```

Browser JavaScript must never receive this key.

The NexControl Vercel bridge exposes:

```
GET  /meta
GET  /api/admin/meta/status
POST /api/admin/meta/action
```

Before serving/calling NexMeta, it validates the existing NexControl admin session against the current Supabase admin API.

## Status

`GET /internal/v1/status`

Returns non-secret state such as:

- version
- Meta configuration boolean
- runtime switches
- connected/active Page summary
- advertised capabilities
- `secretExposure: false`

## Actions

All administrative calls use:

```
POST /internal/v1/actions
```

Body:

```json
{
  "action": "<action>",
  "...": "action payload"
}
```

## Connection and Pages

- `oauth_start`
- `list_connected_pages`
- `activate_connected_page`
- `remove_connected_page`

OAuth returns an authorization URL, never token values.

Connected Page responses exclude encrypted token blobs.

## Webhooks

- `configure_webhooks`
- `inspect_app_webhooks`
- `subscribe_page_webhooks`
- `inspect_page_webhooks`
- `unsubscribe_page_webhooks`

## Messenger Profile

- `configure_default_messenger_profile`
- `configure_messenger_profile`
- `inspect_messenger_profile`
- `delete_messenger_profile_fields`

## Diagnostics

- `probe_page`
- `metrics`
- `deployment_readiness`
- `doctor_page`
- `doctor_all_pages`
- `recent_audit`
- `runtime_settings`

Doctor returns token validity/scopes/expiry and capability results, but never the token.

## Safety

- `set_runtime`

Example:

```json
{
  "action": "set_runtime",
  "inboundEnabled": true,
  "outboundEnabled": false
}
```

Outbound OFF blocks user-facing Meta writes/moderation at NexMeta, even if a UI attempts the request.

Configuration and diagnostic operations remain available for recovery.

## Webhook recovery

- `list_webhook_events`
- `replay_webhook`

Replay uses the persisted server-side payload. The normal list action does not return raw webhook bodies.

## Identity

- `create_link_code`
- `link_identity`
- `unlink_identity`

Preferred flow:

```json
{
  "action": "create_link_code",
  "nexusUserId": "nx_123",
  "ttlSeconds": 600
}
```

The plaintext pairing code is returned once. MongoDB stores only its hash/expiry/use state.

## Messenger writes/reads

- `send_text`
- `send_media`
- `send_quick_replies`
- `send_template`
- `send_button_template`
- `send_image_gallery`
- `sender_action`
- `get_messenger_user_profile`
- `moderate_conversation`
- `list_conversations`
- `list_conversation_messages`
- `get_message`

## Facebook Page

- `publish_page_post`
- `edit_page_post`
- `delete_page_post`

## Comments

- `list_comments`
- `reply_comment`
- `hide_comment`
- `unhide_comment`
- `delete_comment`

## Audit policy

Every administrative action is audited.

Allowed audit metadata includes:

- action
- target identifier
- success/failure
- Meta error code/subcode
- content length
- runtime flag changes
- Page ID
- webhook provisioning result

Forbidden audit data includes:

- Page Access Token
- App Secret
- NexControl machine key
- Nexus gateway key
- full admin message content
- pairing code plaintext
- OAuth authorization code

## NexControl server-side client

```
nexcontrol/lib/nexmeta-client.mjs
```

Required NexControl server-side variables:

```env
NEXMETA_URL=https://<nexmeta-host>
NEXMETA_CONTROL_KEY=<same-machine-key>
```

## Browser rule

The browser only talks to authenticated NexControl routes.

It must not call `/internal/v1/*` directly and must never be given machine credentials.

## Current deployment note

The production Supabase `nexcontrol` Edge Function is active but its full source cannot currently be retrieved through the connected Supabase tool.

To avoid overwriting a live control plane blindly, the Meta panel/auth bridge is implemented in the Vercel proxy layer and delegates authentication to the existing Supabase admin API.
