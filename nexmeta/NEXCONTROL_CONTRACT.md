# NexMeta ↔ NexControl contract v0.1

NexControl is the administrative control plane for NexMeta.

## Authentication

NexControl calls NexMeta with a machine credential:

```
Authorization: Bearer <NEXMETA_CONTROL_KEY>
```

The key is stored by the deployment secret manager. It must never be rendered in the NexControl UI, returned by NexMeta, or written to logs.

NexMeta follows **USE_SECRET, not READ_SECRET** semantics: NexControl can trigger an operation that uses Meta credentials, but cannot request the Page access token or app secret.

## Status

`GET /internal/v1/status`

Returns service state and capabilities without secret values.

## Actions

`POST /internal/v1/actions`

### send_text

```json
{
  "action": "send_text",
  "psid": "<page-scoped-user-id>",
  "text": "Hello"
}
```

### sender_action

```json
{
  "action": "sender_action",
  "psid": "<page-scoped-user-id>",
  "senderAction": "mark_seen"
}
```

Allowed sender actions are `mark_seen`, `typing_on`, and `typing_off`.

## Planned capabilities

- Page connection and token-health state
- Page post create/edit/delete
- Conversation inspection where Meta permits it
- Comment moderation
- Cross-post rules
- Facebook ↔ Telegram identity links
- Delivery queues/retries
- Feature flags
- Metrics
- Safe deploy/restart hooks
- Credential rotation triggers without returning credential values
- Emergency kill switch
- Full audit trail

Administrative operations are written to `audit_logs`.
