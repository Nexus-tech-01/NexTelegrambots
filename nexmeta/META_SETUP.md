# NexMeta production setup

This runbook connects a Facebook Page to NexMeta without committing tokens.

## 1. Meta application

Create or select the Meta application that will own NexMeta.

Record server-side only:

- App ID
- App Secret
- Graph API version selected for the application

Configure:

```env
NEXMETA_GRAPH_VERSION=<selected-version>
NEXMETA_APP_ID=<app-id>
NEXMETA_APP_SECRET=<app-secret>
```

Do not put the App Secret in browser code, NexControl HTML, Git or Telegram messages.

## 2. Public NexMeta host

Deploy the `nexmeta` directory as its own service.

Set:

```env
NEXMETA_PUBLIC_BASE_URL=https://<nexmeta-host>
NEXMETA_OAUTH_REDIRECT_URI=https://<nexmeta-host>/oauth/meta/callback
```

Public HTTP endpoints:

```
GET  /health
GET  /webhooks/meta
POST /webhooks/meta
GET  /oauth/meta/callback
```

Private endpoints:

```
GET  /internal/v1/status
POST /internal/v1/actions
```

Private endpoints must never be exposed to browser code with the NexMeta machine key.

## 3. Webhook verify token

Generate a long random value:

```env
NEXMETA_VERIFY_TOKEN=<random-value>
```

NexMeta uses it for the initial webhook challenge.

The callback URL is:

```
https://<nexmeta-host>/webhooks/meta
```

NexMeta can provision the App subscription automatically after OAuth through the `configure_webhooks` NexControl action.

Default Page webhook fields:

- `messages`
- `message_echoes`
- `message_deliveries`
- `message_reads`
- `messaging_postbacks`
- `message_reactions`
- `feed`

## 4. Token encryption key

Generate exactly 32 random bytes.

Supply them either as:

- 64 hexadecimal characters, or
- standard Base64

```env
NEXMETA_TOKEN_ENCRYPTION_KEY=<32-byte-key>
```

Page Access Tokens obtained through OAuth are encrypted with AES-256-GCM before MongoDB storage.

Rotating this key requires re-encrypting/reconnecting stored Page credentials. Do not replace it casually.

## 5. MongoDB

NexMeta uses a dedicated logical database by default:

```env
NEXUS_MONGODB_URI=<shared-nexus-mongodb-uri>
NEXMETA_DB_NAME=nexmeta
```

Collections are created/indexed automatically.

No Meta token is stored as plaintext.

## 6. NexControl machine bridge

Generate another long random secret shared only by NexControl and NexMeta:

NexMeta:

```env
NEXMETA_CONTROL_KEY=<random-machine-key>
```

NexControl:

```env
NEXMETA_URL=https://<nexmeta-host>
NEXMETA_CONTROL_KEY=<same-random-machine-key>
```

The browser never receives this value.

NexControl production protects `/meta` and `/api/admin/meta/*` by probing the existing Supabase admin session before making a server-to-server NexMeta call.

## 7. OAuth permissions

NexMeta currently requests:

- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_metadata`
- `pages_manage_posts`
- `pages_manage_engagement`
- `pages_read_user_content`
- `pages_messaging`

Use only permissions approved for the application and actual product features.

Development/test users with Page/App roles can be used before Advanced Access. Production conversations with ordinary users may require Advanced Access and applicable business verification/review.

## 8. Connect a Page from NexControl

Open:

```
https://<nexcontrol-host>/meta
```

The route uses the same NexControl admin session as existing private pages.

Choose **Connecter Facebook**.

Flow:

```
NexControl
 -> NexMeta oauth_start
 -> Facebook Login
 -> NexMeta OAuth callback
 -> long-lived user token
 -> /me/accounts
 -> encrypted Page tokens
 -> App webhook subscription
 -> Page subscribed_apps
 -> default Messenger profile
```

The callback page never prints token values.

## 9. Run Doctor

From NexControl use **Doctor global**.

For each Page it checks:

- token validity
- expiry/data-access expiry
- scopes
- Page tasks
- webhook state
- post capability
- comment read/manage capability
- Messenger capability

Fix any missing permission before treating the Page as production-ready.

## 10. Runtime safety

Two persistent switches exist:

```json
{
  "inboundEnabled": true,
  "outboundEnabled": true
}
```

Inbound OFF:

- validated webhook payloads are still persisted
- Nexus routing is stopped

Outbound OFF:

- Messenger sends are blocked
- Page post writes are blocked
- comment mutations are blocked
- conversation moderation is blocked

Configuration/diagnostic actions remain available so the integration can be repaired while outbound traffic is disabled.

## 11. Telegram/Nexus gateway

Configure after the shared Render gateway receiver is implemented:

```env
NEXUS_COMMAND_GATEWAY_URL=https://<nexus-bots-host>/internal/nexus/events
NEXUS_COMMAND_GATEWAY_KEY=<shared-random-secret>
```

NexMeta signs the exact JSON body with HMAC-SHA256.

See `NEXUS_GATEWAY_CONTRACT.md`.

## 12. Validation before production

Required checks:

1. `GET /health` is healthy.
2. NexControl `/meta` requires an authenticated admin session.
3. `secretExposure` remains `false`.
4. OAuth connects the intended Page.
5. Doctor reports a valid token and required scopes.
6. App webhook callback is configured.
7. Page is subscribed to the App.
8. Messenger Profile is visible.
9. A real Messenger message appears in webhook events.
10. Reply stays inside Meta's allowed messaging rules/window.
11. Failed webhook replay works.
12. Outbound kill switch actually blocks writes.
13. No token appears in logs, audit output or UI.
