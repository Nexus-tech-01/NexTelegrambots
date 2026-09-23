# VPS environment / secret matrix

The VPS should not use one giant `.env` copied from the old host. Split variables by service and keep real values under `/etc/nex/env/` with mode `0600` or `0640` and group `nex` only where required.

## Shared infrastructure

Recommended file: `/etc/nex/env/shared.env`

- `NEXUS_MONGODB_URI` — secret
- `NEXUS_MONGODB_DB_NAME` — non-secret database name where a service consumes it
- Redis URLs used by individual bots — secret
- `NEXUS_PUBLIC_BASE_URL` — public configuration, only after HTTPS routing exists

Use `ops/vps/shared.env.example` as the starting template. Do not print connection strings during health checks.

## NexControl Agent

Recommended file: `/etc/nex/env/nexcontrol-agent.env`

- `NEXCONTROL_AGENT_KEY` — secret, preferred dedicated key
- `NEXCONTROL_AGENT_SLUG=nexus-vps-primary`
- `NEXCONTROL_AGENT_NAME=Nexus VPS Primary`
- `NEXCONTROL_AGENT_CONFIG=/etc/nex/nexcontrol-agent.json`
- `NEXCONTROL_URLS=...` — public control-plane URLs

The agent key should not be committed and does not need to be shared with bot processes unless intentionally reused.

## NexAccount / NexAI

Recommended file: `/etc/nex/env/nexaccount.env`

Use `ops/vps/nexaccount.env.example` as the starting template.

Secrets:

- `NEXACCOUNT_TELEGRAM_API_ID`
- `NEXACCOUNT_TELEGRAM_API_HASH`
- `NEXAI_BOT_TOKEN`
- `NEXACCOUNT_SESSION_KEY`
- `NEXACCOUNT_CONTROL_KEY`
- whichever AI provider keys are actually enabled (`NEXAI_LLM_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.)

Non-secret/runtime configuration:

- `NEXAI_BOT_USERNAME`
- `NEXAI_DEFAULT_STYLE`
- `NEXACCOUNT_DB_NAME`
- `NEXACCOUNT_WORKER_COUNT`
- worker capacity and reconcile/lease timing
- `NEXACCOUNT_RUNTIME_DIR=/var/lib/nex/runtime/nexaccount`
- `FFMPEG_PATH=ffmpeg`

The systemd instance `nexaccount@N.service` supplies `NEXACCOUNT_WORKER_INDEX=N` and a stable host/index worker ID. Do not put one global `NEXACCOUNT_WORKER_INDEX` into the shared NexAccount environment file.

All workers share the same worker count. Each worker gets a unique worker index. Worker `0` remains the coordinator. Stop the full worker set before changing `NEXACCOUNT_WORKER_COUNT`; otherwise bucket ownership changes while old workers are still live.

## NexAnime / scanners

The current `nexaccount/anime-ingest.mjs` consumes the single-underscore family such as:

- `NEXANIME_ENABLED`
- `NEXANIME_LISTENER_USERNAMES`
- `NEXANIME_DESTINATION`
- `NEXANIME_DISCOVERY_MS`
- `NEXANIME_PUBLISH_MS`
- `NEXANIME_INTER_SERIES_MS`
- `NEXANIME_POLL_MS`
- `NEXANIME_TMP_DIR`
- `NEXANIME_MEDIA_POLICY`

The repository-level `.env.example` also documents a `NEXANIME__*` family associated with an older/parallel watcher design. Do not delete that block until every consumer is audited, but do not blindly duplicate both families into the new VPS environment.

For the VPS set file-backed paths explicitly instead of relying on provider defaults:

```env
NEXANIME_TMP_DIR=/var/lib/nex/downloads/nexanime-tmp
NEXANIME_SECONDARY_SESSION_FILE=/var/lib/nex/sessions/nexcanal-reader-session.txt
NEXCANAL__WATCHER_ID_FILE=/var/lib/nex/sessions/nexcanal-watcher-id.txt
```

The current secondary reader otherwise falls back to the old provider path `/home/container/.nexcontrol/nexcanal-reader-session.txt`. The NexAccount store also has a legacy watcher-ID fallback under `/home/container`, so the VPS must set `NEXCANAL__WATCHER_ID_FILE` explicitly until that legacy fallback is removed in a later compatibility cleanup.

## Telegram bot fleet

Recommended files can be split per service, for example:

- `/etc/nex/env/nexgame.env`
- `/etc/nex/env/nexcanal.env`
- `/etc/nex/env/nexdownloader.env`
- `/etc/nex/env/nexgroup.env`
- `/etc/nex/env/nexstick.env`
- `/etc/nex/env/nexwhisper.env`
- `/etc/nex/env/stacy.env`

Known root-level secret variables include the individual bot tokens, NexGroup Telegram API credentials, Redis URL(s), owner/admin IDs where treated as private configuration, webhook secrets and payment signing secrets.

Do not place the same bot token in unrelated service files just for convenience.

## NexMeta (stage 2)

Source currently lives on `feature/nexmeta-v1`.

Recommended file: `/etc/nex/env/nexmeta.env`

Secrets include:

- `NEXMETA_APP_SECRET`
- `NEXMETA_VERIFY_TOKEN`
- `NEXMETA_TOKEN_ENCRYPTION_KEY`
- `NEXMETA_CONNECT_KEY`
- `NEXMETA_CONTROL_KEY`
- `NEXUS_COMMAND_GATEWAY_KEY`
- optional static Page access token if that fallback is used

Public configuration includes Graph API version, App ID, public base URL, redirect URI and required bridge service list.

Official Meta OAuth should not require a Facebook account password on the server.

## Migration rule

Copy **values**, not old provider files. Recreate clean `/etc/nex/env/*.env` files on the VPS from the documented variable names, verify permissions, then test presence without logging values.
