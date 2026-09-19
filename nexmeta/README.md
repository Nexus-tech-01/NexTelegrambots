# NexMeta

NexMeta is the Facebook/Messenger adapter for the Nexus ecosystem.

It does not copy Telegram bot logic. Meta events are normalized into a shared Nexus protocol and can be routed to the common bot gateway so NexDownloader, NexGame, NexStick, NexGroup, NexCanal and future Nexus services can reuse their real backend logic.

Current service version: **0.4.0**.

## Implemented

### Meta ingress

- Facebook Page webhook verification
- raw-body `X-Hub-Signature-256` validation
- durable MongoDB persistence before acknowledgement
- duplicate protection
- Vercel `waitUntil()` processing after fast acknowledgement
- replayable `received` / `failed` webhook events
- Messenger message/postback/read/delivery/reaction normalization
- Page `changes` normalization, including `feed` events

### Messenger

- text
- media
- quick replies
- templates
- button templates
- image galleries
- sender actions
- Messenger user profile lookup
- conversation/message inspection
- conversation moderation
- Get Started
- greetings
- ice breakers
- persistent Nexus service menu

### Facebook Page

- Page profile probe
- create/schedule Page posts
- edit/delete Page objects
- list/reply/hide/unhide/delete comments
- Page webhook subscription provisioning
- App webhook provisioning
- subscription inspection/removal

### OAuth and credentials

- Facebook Login start/callback
- hashed, expiring OAuth state
- short-lived -> long-lived user-token exchange
- managed Page discovery
- multi-Page support
- active Page switching
- AES-256-GCM encrypted Page Access Token vault
- optional static Page-token bootstrap fallback
- App Secret proof on server Graph requests
- no token-reading endpoint

### Nexus identity

- Page-scoped Facebook identities
- explicit `nexusUserId` links
- one-time `NXM-XXXXXXXXX` pairing codes
- pairing code stored only as SHA-256 hash
- TTL + atomic one-time consumption

### Nexus gateway

- Nexus envelope v2
- routing intent classification
- preferred-service hints
- HMAC-SHA256 signed gateway requests
- timestamped gateway requests
- structured replies:
  - text
  - media
  - quick replies
  - templates
  - image galleries
- Page feed events routed toward NexCanal
- Messenger telemetry routed without accidental user replies

The receiver contract is documented in `NEXUS_GATEWAY_CONTRACT.md`.

The existing Render bundle is compressed in this repository and is not currently available as readable source through the connected environment, so the receiver inside the live Telegram gateway has **not** been patched blindly. The NexMeta sender/protocol side is complete; the Render receiver remains a deployment task once its real source is safely accessible.

### NexControl

- private machine API
- server-side NexMeta client
- OAuth/Page helpers
- webhook provisioning helpers
- Messenger Profile helpers
- Page permission Doctor
- metrics
- audit history
- webhook replay
- identity pairing
- inbound/outbound kill switch
- secret-safe deployment readiness report
- authenticated `/meta` panel source

The NexControl Vercel proxy protects `/meta` and `/api/admin/meta/*` by probing the existing Supabase admin session first. It never exposes `NEXMETA_CONTROL_KEY` to browser JavaScript.

## HTTP routes

Public:

```
GET  /health
GET  /webhooks/meta
POST /webhooks/meta
GET  /oauth/meta/callback
```

Private machine API:

```
GET  /internal/v1/status
POST /internal/v1/actions
```

Private routes require:

```
Authorization: Bearer <NEXMETA_CONTROL_KEY>
```

## Message flow

```
Facebook / Messenger
        |
        v
raw webhook signature validation
        |
        v
durable event store + dedup
        |
        +----> fast 200 ACK
        |
        v
Meta normalizer
        |
        +----> identity pairing
        |
        +----> Page event routing
        |
        v
Nexus envelope v2
        |
        v
signed Nexus gateway
        |
        v
real Nexus service
        |
        v
structured reply
        |
        v
Messenger renderer
```

## Recovery

NexControl can:

- list recent webhook events
- filter `received`, `processed`, `failed`
- detect stuck `received` events
- replay a specific persisted payload

The raw payload is not returned by the normal event-list action.

## Kill switch

Runtime state:

```json
{
  "inboundEnabled": true,
  "outboundEnabled": true
}
```

Inbound OFF:

- valid events are still persisted
- Nexus routing stops

Outbound OFF:

- Messenger sends stop
- Page post mutations stop
- comment mutations stop
- conversation moderation stops

Diagnostics/OAuth/webhook repair operations remain available while outbound is off.

## Readiness

`deployment_readiness` reports boolean checks without returning secret values.

It distinguishes:

- `adapterReady` — NexMeta/Meta control plane is configured
- `bridgeReady` — adapter is ready **and** the Nexus command gateway URL/key are configured

This prevents a connected Facebook Page from being mistaken for a complete Telegram bridge.

## Security model

The owner remains the highest authority.

The design follows **USE_SECRET, not READ_SECRET**:

- NexControl can instruct NexMeta to use Meta credentials
- NexControl cannot retrieve Page Access Tokens/App Secret
- the browser cannot retrieve the NexControl machine key
- Page tokens are encrypted at rest
- audit logs store action metadata/lengths rather than full admin message payloads
- webhook signatures are verified before processing
- gateway requests are HMAC signed
- OAuth state is one-time and expiring
- pairing codes are one-time, hashed and expiring

## Deployment

See:

- `META_SETUP.md`
- `META_APP_REVIEW.md`
- `NEXCONTROL_CONTRACT.md`
- `NEXUS_GATEWAY_CONTRACT.md`

Local:

```bash
cd nexmeta
npm install
cp .env.example .env
npm test
npm start
```

Vercel project root:

```
nexmeta
```

Do not commit real credentials.
