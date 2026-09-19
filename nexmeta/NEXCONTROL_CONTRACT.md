# NexMeta ↔ NexControl contract v0.2

NexControl is the administrative control plane for NexMeta.

## Authentication

NexControl calls NexMeta with:

```
Authorization: Bearer <NEXMETA_CONTROL_KEY>
```

The machine key is stored only by the deployment secret managers of NexControl and NexMeta.

It must never be:

- rendered in the NexControl UI
- returned from a NexMeta endpoint
- written to application logs
- committed to Git

NexMeta deliberately implements **USE_SECRET, not READ_SECRET** semantics.

## Status

`GET /internal/v1/status`

Returns:

- service/version state
- whether Meta configuration is complete
- runtime kill-switch state
- advertised capabilities
- `secretExposure: false`

## Action endpoint

`POST /internal/v1/actions`

Request format:

```json
{
  "action": "<capability>",
  "...": "action-specific payload"
}
```

## Operational capabilities

### Diagnostics

- `probe_page`
- `metrics`
- `recent_audit`
- `runtime_settings`

### Safety

- `set_runtime`

Example:

```json
{
  "action": "set_runtime",
  "inboundEnabled": true,
  "outboundEnabled": false
}
```

When outbound is disabled, Meta write operations are rejected server-side even if a client UI still tries to call them.

### Webhook recovery

- `list_webhook_events`
- `replay_webhook`

Example:

```json
{
  "action": "list_webhook_events",
  "status": "failed",
  "limit": 50
}
```

```json
{
  "action": "replay_webhook",
  "eventKey": "<sha256-event-key>"
}
```

### Identity

- `create_link_code`
- `link_identity`
- `unlink_identity`

Preferred user-facing pairing flow:

```json
{
  "action": "create_link_code",
  "nexusUserId": "nx_123",
  "ttlSeconds": 600
}
```

NexControl receives the plaintext one-time code only once. NexMeta stores its hash and expiration record.

### Messenger

- `send_text`
- `send_media`
- `send_quick_replies`
- `sender_action`
- `list_conversations`
- `list_conversation_messages`
- `get_message`

### Facebook Page

- `publish_page_post`
- `edit_page_post`
- `delete_page_post`

### Comments

- `list_comments`
- `reply_comment`
- `hide_comment`
- `unhide_comment`
- `delete_comment`

## Audit rules

Every administrative action is written to `audit_logs`.

Audit metadata may contain:

- action
- target ID
- success/failure
- Meta error code
- text/message length
- timestamps
- runtime flag changes

Audit metadata must not contain:

- Meta Page access token
- Meta app secret
- NexControl machine key
- full message text supplied to write actions
- one-time pairing code plaintext

## NexControl client

The repository contains:

```
nexcontrol/lib/nexmeta-client.mjs
```

It wraps the machine contract so NexControl UI/backend code does not need to know Graph API details.

Required NexControl server-side variables:

```env
NEXMETA_URL=https://<nexmeta-host>
NEXMETA_CONTROL_KEY=<same-machine-secret>
```

## Production integration rule

Do not expose NexMeta directly to browser JavaScript for administrative calls.

The browser talks to authenticated NexControl. NexControl calls NexMeta server-to-server using the machine key.
