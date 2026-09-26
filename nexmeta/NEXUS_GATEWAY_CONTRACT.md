# Nexus Command Gateway contract

NexMeta must not import or copy Telegram bot command handlers.

The shared Nexus Render service already starts the Telegram bots as isolated Node.js processes behind one HTTP gateway. The Facebook adapter therefore communicates with that gateway through one signed internal endpoint.

Recommended endpoint:

```
POST /internal/nexus/events
```

Configure NexMeta with the full endpoint URL:

```env
NEXUS_COMMAND_GATEWAY_URL=https://<nexus-bots-host>/internal/nexus/events
NEXUS_COMMAND_GATEWAY_KEY=<shared-random-secret>
```

## Authentication

When `NEXUS_COMMAND_GATEWAY_KEY` is configured, NexMeta sends:

```
Authorization: Bearer <shared-secret>
X-Nexus-Timestamp: <unix-seconds>
X-Nexus-Signature: sha256=<hex-hmac>
```

Signature input:

```
<timestamp>.<exact-raw-json-body>
```

Algorithm:

```
HMAC-SHA256(shared-secret, signature-input)
```

Gateway requirements:

1. Reject missing credentials.
2. Reject timestamps outside a short replay window, recommended ±120 seconds.
3. Compare signatures in constant time.
4. Never log the shared secret.
5. Apply idempotency to event IDs where possible.

## Nexus envelope v2

Example Messenger message:

```json
{
  "version": 2,
  "source": {
    "platform": "facebook",
    "surface": "messenger",
    "pageId": "123"
  },
  "user": {
    "externalId": "456",
    "nexusUserId": "nx_123"
  },
  "routing": {
    "intent": "download",
    "preferredService": "nexdownloader"
  },
  "event": {
    "type": "message",
    "id": "mid.x",
    "timestamp": 1790000000000,
    "text": "/download https://example.com/video",
    "attachments": [],
    "payload": null,
    "field": null,
    "action": null,
    "value": null
  }
}
```

Example Facebook Page feed change:

```json
{
  "version": 2,
  "source": {
    "platform": "facebook",
    "surface": "page",
    "pageId": "123"
  },
  "user": {
    "externalId": "facebook-user-id",
    "nexusUserId": null
  },
  "routing": {
    "intent": "page_event",
    "preferredService": "nexcanal"
  },
  "event": {
    "type": "page_change",
    "id": "comment-or-post-id",
    "timestamp": 1790000000000,
    "text": "Comment text",
    "attachments": [],
    "payload": null,
    "field": "feed",
    "action": "add",
    "value": {
      "item": "comment",
      "verb": "add"
    }
  }
}
```

## Preferred-service mapping

NexMeta only provides a routing hint. The gateway remains authoritative.

| Input intent | Preferred process |
| --- | --- |
| download / audio / video | `nexdownloader` |
| game / quiz | `nexgame` |
| sticker / emoji / pack | `nexstick` |
| group / moderation / admin | `nexgroup` |
| channel / publish / broadcast | `nexcanal` |
| ai / ask / stacy | `nexai` when available |
| general conversation | `auto` |
| Facebook feed event | `nexcanal` |

The gateway may override the hint if a different Nexus service is more appropriate.

## Identity

Facebook Messenger IDs are Page-scoped.

The gateway must not assume that `user.externalId` is a Telegram ID.

When Messenger pairing has already succeeded, `user.nexusUserId` contains the stable Nexus identity. Otherwise it is `null`. Page feed/change events do not automatically inherit a Nexus identity.

NexMeta stores platform identity links separately. A future common Nexus identity service can resolve:

```
facebook pageId + PSID
        |
        v
    nexusUserId
        |
        +--> Telegram identity
        +--> KnowMe identity
        +--> other platforms
```

## Gateway response

Minimal text response:

```json
{
  "handledBy": "nexgame",
  "reply": {
    "text": "Question..."
  }
}
```

Quick replies:

```json
{
  "handledBy": "nexgame",
  "reply": {
    "text": "Choose:",
    "quickReplies": [
      {
        "title": "Answer A",
        "payload": "GAME:A"
      },
      {
        "title": "Answer B",
        "payload": "GAME:B"
      }
    ]
  }
}
```

Media:

```json
{
  "handledBy": "nexdownloader",
  "reply": {
    "text": "Ready.",
    "media": {
      "type": "video",
      "url": "https://..."
    }
  }
}
```

Image gallery:

```json
{
  "handledBy": "nexstick",
  "reply": {
    "imageUrls": [
      "https://.../1.png",
      "https://.../2.png"
    ]
  }
}
```

Messenger template:

```json
{
  "handledBy": "nexcanal",
  "reply": {
    "template": {
      "template_type": "button",
      "text": "Choose an action",
      "buttons": [
        {
          "type": "postback",
          "title": "Publish",
          "payload": "/publish"
        }
      ]
    }
  }
}
```

The gateway must return only public/renderable media URLs. It must not pass bot tokens, database credentials or internal filesystem paths to NexMeta.

## Page events

Page webhook events such as `feed` are routed internally but do not automatically generate a Messenger reply.

Possible uses:

- NexCanal mirrors or transforms a Facebook Page publication.
- NexCanal can trigger cross-post rules toward Telegram channels/groups.
- moderation workflows can notify NexGroup/NexControl.
- analytics can record reactions/read/delivery events.
- NexAI can be invoked by an explicitly configured moderation/assistant rule.

## Error behavior

Use normal HTTP status codes.

Recommended error response:

```json
{
  "error": "service_unavailable",
  "service": "nexdownloader",
  "retryable": true
}
```

NexMeta treats non-2xx gateway responses as processing errors. The original Meta webhook remains persisted and can be inspected/replayed from NexControl.

## Control boundary

NexControl is the owner/admin control plane.

NexMeta is the Meta adapter.

The Nexus gateway is the shared execution router.

Telegram bots remain isolated workers.

This keeps Facebook support from becoming a second, divergent implementation of every Telegram command.
