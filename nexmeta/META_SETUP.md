# NexMeta production setup — Pterodactyl

This runbook connects Facebook/Messenger to NexMeta running on the **same Pterodactyl runtime as the Nexus Telegram bots**.

## 1. Runtime

Use one public HTTPS host mapped to the Pterodactyl public allocation.

Startup command:

```sh
sh pterodactyl/start.sh
```

The Pterodactyl supervisor runs:

- the existing Telegram orchestrator on an internal port
- NexMeta on another internal port
- the Nexus bridge/media relay on the public gateway

No NexMeta Vercel deployment is used.

## 2. Public URL

Set:

```env
NEXUS_PUBLIC_BASE_URL=https://<public-host>
```

The supervisor/NexMeta derive:

```
OAuth callback: https://<public-host>/oauth/meta/callback
Meta webhook:   https://<public-host>/webhooks/meta
Owner connect:  https://<public-host>/connect/meta
```

The public host must be reachable by Meta over HTTPS.

## 3. Meta application

Create or select the Meta App that will own the integration.

Store server-side only:

```env
NEXMETA_GRAPH_VERSION=<version configured for the app>
NEXMETA_APP_ID=<app-id>
NEXMETA_APP_SECRET=<app-secret>
```

Do not store the Facebook password. NexMeta uses Facebook OAuth and Page Access Tokens.

## 4. Generate NexMeta secrets

Run once on the server:

```sh
node pterodactyl/generate-secrets.mjs
```

Store the generated values as Pterodactyl environment variables:

```env
NEXMETA_VERIFY_TOKEN=
NEXMETA_TOKEN_ENCRYPTION_KEY=
NEXMETA_CONNECT_KEY=
NEXMETA_CONTROL_KEY=
NEXUS_COMMAND_GATEWAY_KEY=
```

Do not commit their real values.

## 5. MongoDB

Configure the shared Nexus MongoDB URI:

```env
NEXUS_MONGODB_URI=<shared-nexus-mongodb-uri>
NEXMETA_DB_NAME=nexmeta
```

NexMeta stores Page Access Tokens encrypted with AES-256-GCM.

## 6. Preflight

Run:

```sh
node pterodactyl/check.mjs
```

Do not proceed until the connection prerequisites are reported ready.

## 7. Meta OAuth permissions

NexMeta currently requests:

- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_metadata`
- `pages_manage_posts`
- `pages_manage_engagement`
- `pages_read_user_content`
- `pages_messaging`

Only request/use permissions that match the production features enabled in the Meta App.

Development users with the required App/Page role can be used while the app is in development mode. Broader production use may require Meta App Review/Advanced Access for applicable permissions.

## 8. Connect Facebook directly from Pterodactyl

After the server is online, open:

```
https://<public-host>/connect/meta
```

Enter the server-side value of:

```
NEXMETA_CONNECT_KEY
```

The key is submitted as a POST body; it is not placed in the URL.

NexMeta redirects to Facebook Login.

The owner signs in with the Facebook account that manages the intended Page(s). NexMeta then:

1. verifies the one-time OAuth state
2. exchanges the authorization code server-side
3. exchanges for a long-lived user token
4. calls `/me/accounts`
5. obtains Page Access Tokens for managed Pages
6. encrypts those Page tokens before MongoDB storage
7. configures the App webhook callback
8. subscribes each connected Page to the App
9. configures the Messenger Profile
10. activates the first Page when no Page is active

A Facebook personal password is never received or stored by NexMeta.

## 9. Connect through NexControl

NexControl may instead call the private action:

```
oauth_start
```

using:

```
Authorization: Bearer <NEXMETA_CONTROL_KEY>
```

The browser itself never receives `NEXMETA_CONTROL_KEY`.

## 10. Meta webhook

The callback is:

```
https://<public-host>/webhooks/meta
```

Default Page webhook fields:

- `messages`
- `message_echoes`
- `message_deliveries`
- `message_reads`
- `messaging_postbacks`
- `message_reactions`
- `feed`

Webhook POST bodies are verified using `X-Hub-Signature-256` before processing.

## 11. Messenger/Page checks

After OAuth, run the Page Doctor from NexControl or the internal API.

It verifies, without exposing the token:

- token validity
- expiry/data-access expiry
- granted scopes
- Page tasks
- webhook state
- Page-post capability
- comment capability
- Messenger capability

## 12. Internal Nexus bridge

The Pterodactyl supervisor automatically configures NexMeta to send Nexus envelopes to:

```
http://127.0.0.1:<public-port>/internal/nexus/events
```

Requests are HMAC-SHA256 signed.

No external Render/Vercel bridge is required.

The bridge readiness check requires a live signed probe and production-ready adapters for every service listed in:

```env
NEXMETA_REQUIRED_NEXUS_SERVICES=nexdownloader,nexgame,nexstick,nexgroup,nexcanal
```

## 13. Health endpoints

Telegram's existing health remains available through its current route.

NexMeta health:

```
GET /health/meta
```

Combined runtime health:

```
GET /health/all
```

## 14. Runtime kill switches

Persistent state:

```json
{
  "inboundEnabled": true,
  "outboundEnabled": true
}
```

Inbound OFF keeps valid webhook events persisted but stops Nexus routing.

Outbound OFF blocks Messenger sends, Page post/comment mutations and conversation moderation while leaving diagnostics/repair actions available.

## 15. Production validation

Before calling the connection production-ready:

1. `node pterodactyl/check.mjs` passes.
2. `GET /health/meta` returns healthy.
3. `GET /health/all` shows Telegram and NexMeta healthy.
4. `/connect/meta` accepts the owner connection key and opens Facebook Login.
5. OAuth returns to `/oauth/meta/callback`.
6. At least one intended Page is stored and active.
7. Doctor reports a valid token and expected permissions.
8. App webhook subscription exists.
9. Page is subscribed to the App.
10. Messenger Profile is configured.
11. A real Messenger message appears in persisted webhook events.
12. A reply uses the same Page that received the message.
13. Outbound kill switch blocks writes.
14. No Page token, App Secret or machine key appears in UI/log/audit output.

See also:

- `../pterodactyl/README.md`
- `META_APP_REVIEW.md`
- `NEXCONTROL_CONTRACT.md`
- `NEXUS_GATEWAY_CONTRACT.md`
