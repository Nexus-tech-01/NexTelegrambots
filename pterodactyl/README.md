# Nexus + NexMeta on Pterodactyl

NexMeta is intended to run on the **same Pterodactyl server/container as the Nexus Telegram bots**.

Vercel is not the bot runtime. NexControl may remain a separate web control panel, but Facebook webhooks, OAuth callbacks, workers and bot adapters run on Pterodactyl.

## Runtime layout

One Pterodactyl public allocation is enough:

```
Internet / HTTPS reverse proxy
            |
            v
        PORT 10000
            |
            v
pterodactyl/start.mjs
   |                  |
   |                  +--> NexMeta :10002
   |
   +--> Telegram gateway :10001
   |
   +--> /internal/nexus/events
   |
   +--> /nexus-media/*
```

Public paths routed to NexMeta:

```
GET/POST /connect/meta
GET      /oauth/meta/callback
GET/POST /webhooks/meta
GET/POST /internal/v1/*
GET      /health/meta
```

Telegram routes continue through the existing orchestrator.

Combined health:

```
GET /health/all
```

## Pterodactyl startup command

Recommended startup command:

```sh
sh pterodactyl/start.sh
```

The startup script:

1. runs the existing Nexus preflight when available
2. installs NexMeta production dependencies if they are missing
3. syntax-checks the Pterodactyl/NexMeta/bridge entrypoints
4. starts the unified supervisor

## Environment

Use `pterodactyl/.env.example` as the variable checklist.

Generate the non-Meta secrets once from the server console:

```sh
node pterodactyl/generate-secrets.mjs
```

Store the output only in Pterodactyl/NexControl secret variables. Do not commit those generated values.

Then run:

```sh
node pterodactyl/check.mjs
```

The checker prints the three public URLs that matter:

```
OAuth callback: https://<host>/oauth/meta/callback
Meta webhook:   https://<host>/webhooks/meta
Owner connect:  https://<host>/connect/meta
```

## Meta App values

The following values must come from the Meta App you control:

```
NEXMETA_GRAPH_VERSION
NEXMETA_APP_ID
NEXMETA_APP_SECRET
```

The app must have the Facebook Page/Messenger products and the permissions required for the features being used.

NexMeta never needs or stores your Facebook password.

## Connect Facebook without NexControl

After the runtime is online, open:

```
https://<host>/connect/meta
```

Enter the value stored in:

```
NEXMETA_CONNECT_KEY
```

NexMeta then redirects to the official Facebook OAuth page.

After authorization it:

1. exchanges the authorization code server-side
2. obtains the managed Pages from `/me/accounts`
3. encrypts Page Access Tokens using AES-256-GCM
4. stores connected Pages in MongoDB
5. configures the Meta App webhook callback
6. subscribes each connected Page to the App
7. configures the Messenger Profile for each Page
8. activates the first Page when no active Page exists

The browser never receives the Page Access Tokens or App Secret.

## Connect through NexControl

NexControl can alternatively call:

```
oauth_start
```

through the private NexMeta machine API.

Its **Connecter Facebook** button opens the same official OAuth flow.

## Facebook account vs Page

The owner signs in with a Facebook account to authorize the app.

The Messenger bot itself operates on **Facebook Pages managed by that account**, using Page Access Tokens. It does not automate a personal Facebook profile or require the personal Facebook password.

## Public URL requirement

Meta must be able to reach the callback/webhook over public HTTPS.

Set:

```
NEXUS_PUBLIC_BASE_URL=https://<your-public-host>
```

NexMeta automatically derives:

```
NEXMETA_PUBLIC_BASE_URL=https://<your-public-host>
NEXMETA_OAUTH_REDIRECT_URI=https://<your-public-host>/oauth/meta/callback
```

unless explicit NexMeta values are supplied.

## Internal bridge

Because NexMeta and the Telegram bots share one Pterodactyl runtime, the supervisor automatically points NexMeta to:

```
http://127.0.0.1:<public-port>/internal/nexus/events
```

No second public service is required.

If `NEXUS_COMMAND_GATEWAY_KEY` is omitted, the supervisor generates an ephemeral key for that boot and passes it to NexMeta. A persistent key is recommended because temporary media-relay URLs remain valid across restarts only when the key stays the same.

## Current bot-core bridge status

NexDownloader has a real adapter wired to the existing NexDownloader direct-provider modules:

- TikWM direct video/images
- generic page direct-media metadata
- optional Cobalt direct media
- secure temporary public media relay for Messenger

It is intentionally marked partial until local `yt-dlp` / `gallery-dl` file output and conversion paths are bridged.

The readiness report therefore distinguishes:

- adapter loaded
- adapter production-ready

and does not falsely mark the complete Nexus bridge ready while required adapters/features remain incomplete.


## Live smoke test

After `sh pterodactyl/start.sh` is running, execute:

```sh
node pterodactyl/smoke-meta.mjs
```

The smoke test verifies:

1. `/health/meta` is NexMeta and healthy
2. `/connect/meta` is reachable
3. Meta webhook verification returns the expected challenge
4. a webhook with a fake signature is rejected with HTTP 401
5. the private status endpoint authenticates correctly
6. `connection_readiness` reports ready

Do not start the Facebook OAuth flow until this test passes.

## Safe migration behavior

Missing NexMeta configuration or a failed NexMeta dependency installation does **not** intentionally take the Telegram bots offline.

The public supervisor reserves the public port first, then starts Telegram and NexMeta on separate internal ports.

If NexMeta cannot be started for the current boot:

- Telegram continues through the existing orchestrator
- Meta routes return HTTP 503 with `nexmeta_unavailable`
- `/health/all` reports the problem
- fix the environment/dependencies and restart the Pterodactyl server

This avoids turning a Meta rollout problem into a regression for the existing Telegram bots.
