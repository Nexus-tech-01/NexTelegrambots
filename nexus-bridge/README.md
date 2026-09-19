# Nexus Bridge

This directory contains the Render-side receiver for the NexMeta -> Nexus protocol.

It does not emulate Telegram updates. Facebook/Messenger events are received as Nexus envelope v2 objects and must be passed to the reusable bot core through small service adapters.

## Components

- `receiver.mjs` — HMAC/Bearer validation, anti-replay window, envelope validation, idempotent dispatch and signed system probe.
- `adapter-loader.mjs` — loads only valid `<service>.mjs` adapters.
- `gateway-wrapper.mjs` — optional front proxy for the existing Render orchestrator.
- `discover-bot-cores.mjs` — build-time scanner that maps likely reusable bot-core modules after compilation.
- `test/*` — receiver and adapter-loader tests.

## Front proxy design

The current Telegram deployment already has one public HTTP gateway.

Instead of modifying the opaque bundled orchestrator, the optional proxy can sit in front of it:

```
Render :10000
     |
     v
Nexus bridge front proxy
     |-------------------- POST /internal/nexus/events
     |                           |
     |                           v
     |                    signed receiver
     |                           |
     |                           v
     |                    real service adapter
     |
     +---- all other routes ----> existing orchestrator :10001
```

The existing gateway keeps its normal Telegram routes and `/health`.

The proxy is **disabled by default**:

```env
NEXUS_BRIDGE_PROXY_ENABLED=false
NEXUS_INNER_GATEWAY_PORT=10001
```

Do not enable it until the real bot-core adapters are present and the inner orchestrator is confirmed to honor `PORT`.

## Bridge routes

Signed events:

```
POST /internal/nexus/events
```

Authenticated operator status:

```
GET /internal/nexus/bridge-status
Authorization: Bearer <NEXUS_COMMAND_GATEWAY_KEY>
```

The status route is not public. It reports:

- whether the proxy child exited
- adapter load status
- build-time discovery report
- candidate core modules/exports

NexMeta exposes this to NexControl through the private `bridge_status` action, so the browser never receives the Render bridge key.

## Security

NexMeta sends:

```
Authorization: Bearer <shared-secret>
X-Nexus-Timestamp: <unix-seconds>
X-Nexus-Signature: sha256=<hex-hmac>
```

Signature input:

```
<timestamp>.<exact raw JSON body>
```

The receiver verifies:

- Bearer secret
- HMAC-SHA256
- exact raw body
- maximum timestamp skew
- body-size limit
- envelope version/source/surface

Use a random `NEXUS_COMMAND_GATEWAY_KEY` independent from Telegram bot tokens and `NEXMETA_CONTROL_KEY`.

## Live readiness

A bridge being reachable is not enough.

The signed `system_probe` response includes the adapters actually loaded.

NexMeta defaults to requiring:

```
nexdownloader
nexgame
nexstick
nexgroup
nexcanal
nexwhisper
nexai
```

Override only when intentionally changing the production service set:

```env
NEXMETA_REQUIRED_NEXUS_SERVICES=nexdownloader,nexgame,nexstick,nexgroup,nexcanal,nexwhisper,nexai
```

`bridgeReady=true` requires:

1. gateway URL configured
2. gateway key configured
3. signed live probe succeeds
4. every required adapter is actually loaded

This prevents a receiver-only deployment from being reported as a working Facebook <-> Telegram bridge.

## Adapter directory

Default:

```
/app/nexus-bridge/adapters
```

Optional override:

```env
NEXUS_ADAPTER_DIR=/app/nexus-bridge/adapters
```

Each file is named after the Nexus service:

```
nexdownloader.mjs
nexgame.mjs
nexstick.mjs
nexgroup.mjs
nexcanal.mjs
nexwhisper.mjs
nexai.mjs
auto.mjs
```

A module is counted as loaded only when it exports one of:

- default function
- `handle` function
- `handler` function

A file merely existing is not enough.

## Service adapter contract

A service adapter receives the Nexus envelope, not a fake Telegram Update.

Do not reinterpret:

- Facebook PSID as Telegram user ID
- Page ID as Telegram chat ID

Use `envelope.user.nexusUserId` when present as the stable cross-platform Nexus identity.

Example shape:

```js
export async function handle(envelope) {
  const result = await realBotCore.handle({
    nexusUserId: envelope.user.nexusUserId,
    text: envelope.event.text,
    attachments: envelope.event.attachments,
    source: envelope.source
  });

  return {
    reply: {
      text: result.text,
      media: result.fileUrl
        ? {
            type: result.mediaType,
            url: result.fileUrl
          }
        : null
    }
  };
}
```

The adapter can return Messenger-renderable:

- `text`
- `media`
- `quickReplies`
- `template`
- `imageUrls`

## Build-time core discovery

The source archive is extracted inside the Docker build even though it cannot currently be materialized in the connected local environment.

After `scripts/build-all.mjs`, Docker runs:

```
node /app/nexus-bridge/discover-bot-cores.mjs
```

The scanner:

- inspects the five packaged Telegram bot directories; NexWhisper and NexAI are bridge-native adapters
- reads each `package.json`
- scans compiled/source modules up to a bounded depth
- prioritizes files named like `core`, `service`, `handler`, `router`, `command`, `manager`, `engine`, `index`, etc.
- extracts visible export names
- records functional signals
- writes `/app/nexus-bridge/discovery.json`

It never reads `.env`, token values or secret-manager data.

The authenticated bridge status exposes a bounded version of this discovery report for NexControl.

## Idempotency

The wrapper currently keeps a short in-memory duplicate window for event IDs:

```env
NEXUS_BRIDGE_DEDUP_TTL_MS=600000
```

The receiver also supports pluggable `claimEvent`/`releaseEvent`, so the final production adapters can move idempotency to Redis/MongoDB for restart-safe deduplication.

## Activation sequence

1. Build the Render image.
2. Inspect bot-core discovery.
3. Implement adapters against real reusable bot cores.
4. Confirm all required adapters load.
5. Set the same `NEXUS_COMMAND_GATEWAY_KEY` on Render and NexMeta.
6. Enable:
   ```env
   NEXUS_BRIDGE_PROXY_ENABLED=true
   ```
7. Confirm existing Telegram `/health` still works through the proxy.
8. Run NexControl -> **Bridge details**.
9. Confirm `deployment_readiness.bridgeReady === true`.
10. Send real Messenger tests for each mapped Nexus service.

Until steps 3–9 are complete, the system intentionally reports the bridge as not ready.
