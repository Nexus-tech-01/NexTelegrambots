# Nexus Bridge receiver

This directory contains the receiver side of the NexMeta -> Nexus gateway protocol.

It is intentionally independent of Telegram libraries.

## Route

Mount the handler at:

```
POST /internal/nexus/events
```

Example:

```js
import { createNexusBridgeHandler } from './nexus-bridge/receiver.mjs';

const bridge = createNexusBridgeHandler({
  sharedKey: process.env.NEXUS_COMMAND_GATEWAY_KEY,

  services: {
    nexdownloader: envelope => downloaderAdapter(envelope),
    nexgame: envelope => gameAdapter(envelope),
    nexstick: envelope => stickAdapter(envelope),
    nexgroup: envelope => groupAdapter(envelope),
    nexcanal: envelope => canalAdapter(envelope),
    nexai: envelope => aiAdapter(envelope),
    auto: envelope => autoRouter(envelope)
  },

  claimEvent: event => idempotency.claim(event),
  releaseEvent: claim => idempotency.release(claim)
});
```

The existing public gateway should call `bridge(req,res)` when the path is `/internal/nexus/events`, before normal Telegram webhook routing.

## Security

The receiver verifies:

- Bearer shared key
- `X-Nexus-Timestamp`
- maximum timestamp skew
- `X-Nexus-Signature`
- HMAC-SHA256 over `timestamp + "." + exact raw body`
- envelope version/source/surface
- request body size

Use a random gateway key independent from Telegram bot tokens and independent from `NEXMETA_CONTROL_KEY`.

## Idempotency

Provide `claimEvent` backed by Redis or MongoDB in production.

Recommended key:

```
facebook:<pageId>:<eventId>
```

Return `false` from `claimEvent` when an event has already been processed.

The receiver then returns:

```json
{
  "ok": true,
  "handledBy": null,
  "duplicate": true,
  "reply": null
}
```

## Service adapters

A service adapter receives the Nexus envelope, not a fake Telegram Update.

Do not emulate Telegram user/chat IDs.

Use `envelope.user.nexusUserId` when present as the stable cross-platform Nexus identity. If it is `null`, the service must treat the caller as an unpaired Facebook identity rather than guessing a Telegram account.

Each bot should expose its reusable domain operation through an adapter layer.

Example:

```js
async function downloaderAdapter(envelope) {
  const result = await nexDownloaderCore.handle({
    user: await identity.resolve(envelope),
    text: envelope.event.text,
    attachments: envelope.event.attachments,
    source: envelope.source
  });

  return {
    reply: {
      text: result.caption,
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

This is the key architectural rule: **share bot core logic, not Telegram transport objects**.

## Current repository status

The live Render source is stored as compressed/base64 bundle parts. The connected environment can read the text parts through GitHub but cannot materialize/decompress the private bundle locally because its container has no network path to GitHub.

Therefore this receiver is production-ready reference code, but it is not claimed to be mounted in the live Render gateway yet.
