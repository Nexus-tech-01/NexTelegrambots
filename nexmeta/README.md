# NexMeta

NexMeta is the Facebook/Messenger adapter for the Nexus ecosystem.

It is not a second copy of the Telegram bots. Messenger events are converted into a platform-neutral Nexus envelope so the same future Nexus services can serve Telegram, Facebook and other adapters.

## v0.1 foundation

Implemented:

- Facebook Page webhook verification
- `X-Hub-Signature-256` validation for webhook POSTs
- Messenger event normalization
- MongoDB event persistence and duplicate protection
- Facebook identity/message persistence
- Messenger `mark_seen`, `typing_on`, `typing_off`
- text responses through Meta Send API
- optional bridge to a common Nexus command gateway
- private NexControl machine API
- audit log for control actions
- health endpoint
- security unit tests
- no API route that reveals Meta secrets

## Routes

- `GET /health`
- `GET /webhooks/meta`
- `POST /webhooks/meta`
- `GET /internal/v1/status`
- `POST /internal/v1/actions`

## Local start

```bash
cd nexmeta
npm install
cp .env.example .env
npm test
npm start
```

Load real secrets with the deployment secret manager. Do not commit them.

## Meta callback

```
https://<nexmeta-host>/webhooks/meta
```

Use `NEXMETA_VERIFY_TOKEN` as the verify token during webhook setup.

Set `NEXMETA_GRAPH_VERSION` to the Graph API version selected for the Meta app instead of relying on a hard-coded version.

## Flow

```
Messenger
  -> Meta webhook
  -> signature validation
  -> durable store + dedup
  -> event normalizer
  -> Nexus router/common gateway
  -> Messenger renderer
  -> Meta Send API
```

## Control/security model

The owner remains the highest authority. NexControl gets operational capability through a dedicated machine credential. The Page token and app secret remain inside the NexMeta runtime and are never returned through the control API.

See `NEXCONTROL_CONTRACT.md`.
