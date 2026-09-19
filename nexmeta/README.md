# NexMeta

NexMeta is the Meta/Facebook adapter for the Nexus ecosystem.

It is not a second copy of the Telegram bots. Facebook/Messenger events are normalized into a platform-neutral Nexus envelope so the same Nexus services can progressively serve Telegram, Messenger and future adapters.

## v0.2

Implemented:

- Facebook Page webhook verification
- raw-body `X-Hub-Signature-256` validation
- Messenger event normalization
- MongoDB event persistence before acknowledgement
- duplicate webhook protection
- replayable failed/stuck webhook events
- Page-scoped Facebook identities
- inbound/outbound message persistence
- one-time Nexus ↔ Messenger pairing codes
- optional common Nexus command gateway
- Messenger text, media and quick replies
- `mark_seen`, `typing_on`, `typing_off`
- Page profile probe
- Messenger conversation/message inspection through Graph API
- Page feed post create/edit/delete operations
- comment list/reply/hide/unhide/delete operations
- NexControl machine API
- metrics and recent audit history
- inbound/outbound emergency kill switch
- Docker/Node runtime
- Vercel Functions runtime with raw webhook body
- Vercel `waitUntil()` integration for post-acknowledgement processing
- security/normalization/control tests
- no API route that reveals Meta tokens or app secrets

## HTTP routes

- `GET /health`
- `GET /webhooks/meta`
- `POST /webhooks/meta`
- `GET /internal/v1/status`
- `POST /internal/v1/actions`

The `/internal/v1/*` routes require the private NexControl machine key.

## Message flow

```
Messenger
  -> Meta webhook
  -> raw signature verification
  -> durable MongoDB write + dedup
  -> fast 200 acknowledgement
  -> webhook processor
  -> event normalizer
  -> pairing handler or Nexus router
  -> Messenger renderer
  -> Meta Send API
```

On Vercel, `waitUntil()` keeps the processing promise alive after the webhook is acknowledged. The durable event is written before acknowledgement, so NexControl can inspect or replay an event that remains `received` or becomes `failed`.

## Identity pairing

NexControl creates a short-lived one-time code for a Nexus user:

```json
{
  "action": "create_link_code",
  "nexusUserId": "nx_123",
  "ttlSeconds": 600
}
```

The returned code looks like:

```
NXM-ABC123XYZ
```

The user sends the code directly to NexMeta on Messenger, or sends:

```
link NXM-ABC123XYZ
```

NexMeta atomically consumes the code and links the Page-scoped Messenger identity to the Nexus user. The plaintext code is returned only when created; MongoDB stores a SHA-256 hash and a TTL record.

## Recovery

NexControl can inspect failed/stuck webhook events with `list_webhook_events` and retry a specific event with `replay_webhook`.

Metrics include:

- total and 24-hour webhook volume
- failed webhooks
- stuck `received` webhooks
- message volume
- inbound/outbound volume
- Facebook identities
- linked Nexus identities

## Kill switch

Runtime settings are stored in MongoDB:

```json
{
  "inboundEnabled": true,
  "outboundEnabled": true
}
```

- `inboundEnabled=false`: validated webhooks are persisted but not routed to Nexus services.
- `outboundEnabled=false`: automatic replies and all NexControl Meta mutations are blocked.

This provides an emergency stop without deleting credentials or disconnecting the Meta App.

## Local runtime

```bash
cd nexmeta
npm install
cp .env.example .env
npm test
npm start
```

Load real secrets with the deployment secret manager. Never commit them.

## Vercel runtime

The directory contains:

- `api/index.mjs` — Vercel Function entrypoint
- `vercel.json` — clean public route rewrites
- `src/handler.mjs` — shared HTTP implementation

The Vercel project root should be `nexmeta`.

The callback URL exposed to Meta is:

```
https://<nexmeta-host>/webhooks/meta
```

The Vercel function disables request body parsing so the exact raw Meta request can be verified cryptographically.

## Required Meta variables

```env
NEXMETA_GRAPH_VERSION=
NEXMETA_PAGE_ID=
NEXMETA_PAGE_ACCESS_TOKEN=
NEXMETA_VERIFY_TOKEN=
NEXMETA_APP_SECRET=
```

Use the Graph API version selected for the Meta application rather than hard-coding a version in source.

## Shared infrastructure

```env
NEXUS_MONGODB_URI=
NEXMETA_DB_NAME=nexmeta
NEXMETA_CONTROL_KEY=
NEXUS_COMMAND_GATEWAY_URL=
NEXUS_COMMAND_GATEWAY_KEY=
```

The common command gateway is optional during the initial deployment. Until it is configured, NexMeta keeps a minimal fallback router for connectivity tests.

## Security model

The owner remains the highest authority.

NexControl receives a dedicated machine credential and can trigger approved operations. Meta Page tokens and app secrets remain in the NexMeta runtime.

The design follows **USE_SECRET, not READ_SECRET**:

- operations may use the Meta credentials
- API responses never return the credential values
- audit records contain targets/lengths/status, not message secrets or access tokens

See `NEXCONTROL_CONTRACT.md`.
