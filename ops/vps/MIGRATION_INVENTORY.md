# Migration inventory and source-of-truth map

Audit date: 2026-09-23.

This document prevents a VPS migration from accidentally deploying an obsolete, incomplete or diagnostic branch.

## Repository-level map

| Component | Current source to inspect first | Migration treatment |
| --- | --- | --- |
| NexAccount / direct NexCanal watcher / current NexControl Agent | `main` | Current directly versioned Telegram-side baseline. Validate and migrate independently. |
| Legacy five-bot fleet (NexGame/NexCanal/NexDownloader/NexGroup/NexStick) | live runtime + recovery evidence | **Not fully recoverable from the current Git bundles alone. Recover/verify source before VPS cutover.** |
| NexMeta / Facebook-Messenger bridge / Nexus bridge / Pterodactyl supervisor | `feature/nexmeta-v1` | Preserve as a separate source island. Port selectively only after reconciling with `main`. |
| NexControl feature lineage used by NexMeta | `feature/nexcontrol-v1` | Historical/feature base. Do not replace the newer `main` agent blindly. |
| Early NexAccount feature branch | `feature/nexaccount-v1` | Older divergent lineage. Do not deploy it instead of `main`. |
| NexDownloader inline investigation branch | `feature/nexdownloader-inline` | Diagnostic workflow branch only; not a production source. |
| Old Render recovery branches and diagnostic PRs | diagnostic/repair branches | Recovery evidence only. None currently establishes a complete healthy five-bot source tree. |
| NID marketplace | `Nexus-tech-01/Project-02` | Separate product. Not part of the bot VPS cutover unless explicitly scheduled. |
| Nexus Tech public site | `Nexus-tech-01/Site-officiel-` | Separate web deployment. Not part of the bot runtime cutover. |

## Important branch divergence

`main` and `feature/nexmeta-v1` have diverged substantially. The NexMeta branch contains the Facebook/Messenger runtime, companion bridge and `nexus-bridge`, while `main` contains later Telegram/NexAccount/NexControl work. Neither branch should overwrite the other wholesale.

The VPS migration therefore has separate source tracks:

1. migrate the directly versioned/validated Telegram components from `main`;
2. recover and normalize the legacy five-bot source tree;
3. port/reconcile NexMeta and the cross-platform bridge on top of the stable VPS baseline.

## Legacy five-bot bundle status — confirmed historical evidence

The current `main` branch still contains `render-src.b64.part-*` and `nexus-bots-src.tar.xz.b64.part-*`, but these must **not** be treated as a healthy source archive.

A historical GitHub Actions diagnostic run (`32676994026`, 2026-08-24) tested both reconstruction modes.

For the 9-part canonical Render bundle:

- `xz -t` failed for both decode-once and decode-each modes;
- only a partial extraction was possible;
- the partial tree contained the orchestration scripts;
- it recovered about 40 NexGame files and 25 files under an older `nexcanal-manager` path;
- NexDownloader, NexGroup, NexStick and the expected `bots/nexcanal` tree were absent from that partial extraction.

For the 12-part legacy bundle:

- `xz -t` also failed in both reconstruction modes;
- only a much smaller partial tree could be extracted.

The old workflow deliberately stayed red after packaging a partial-recovery artifact. That artifact has since expired, so it is no longer a usable source package.

The current 9 Render chunks are unchanged relative to the old validated commit lineage, so a VPS migration must not assume they became healthy later merely because the files remain in `main`.

## Recovery branches

Known recovery branches are also incomplete evidence:

- `repair/five-bots-final-v2` contains only the first segment set of a larger recovery attempt; its PR explicitly states later parts were still missing.
- `repair/healthy-five-bot-runtime` contains only a single runtime-transfer part in the branch comparison.
- `render-runtime-v2` and `render-final-v7` contain small diagnostic candidate sets, not a demonstrated complete fleet.

See `BOT_SOURCE_RECOVERY.md` before trying to deploy the old five-bot fleet.

## Main-branch directly versioned runtime findings

The following important pieces do exist directly in Git and do not depend on the broken five-bot bundle:

- `nexaccount/`;
- `nexcontrol/`;
- `nexcanal/liteapks-relay.mjs`;
- `watchers/liteapks-relay.mjs`;
- VPS migration tooling under `ops/vps/`.

The current Dockerfile is **not** the VPS source of truth because it still reconstructs the incomplete Render bundle and also references `watchers/anime-pipeline.mjs.gz.b64`, which is absent from the current checkout.

## Configuration cleanup required before final cutover

1. Consolidate duplicate NexAnime environment-variable families (`NEXANIME__*` and `NEXANIME_*`) only after every consumer is audited.
2. Override/remove provider-specific paths such as `/home/container/...` with `/var/lib/nex/...` equivalents.
3. Keep secrets outside Git; `.env.example` stays documentation-only.
4. Keep NexControl web/control plane remote initially; run only NexControl Agent on the VPS until runtime migration is stable.
5. Keep MongoDB/Redis external during the first cutover unless a separate database migration is explicitly planned.
6. Do not create production systemd units for hidden legacy bot entrypoints until their recovered source tree has been verified.

## Runtime groups for the VPS

### Control plane agent

- NexControl Agent
- resource watchdog
- deployment/restart hooks
- encrypted backup/rollback tooling

### Directly versioned account automation

- NexAccount coordinator
- NexAccount workers
- Telegram MTProto session storage
- NexAnime logic integrated into NexAccount
- direct APK/channel watchers

### Legacy Telegram core — recovery gate

- NexGame
- NexCanal full bot runtime
- NexDownloader
- NexGroup
- NexStick
- any bundled orchestration scripts/core modules not directly versioned

### Cross-platform layer — stage 2

- NexMeta
- Nexus bridge
- Facebook/Messenger integrations
- future WhatsApp/other platform adapters

## Persistent data that must survive host replacement

- encrypted Telegram MTProto sessions;
- MongoDB-backed account/settings state;
- Redis state only where operationally persistent rather than disposable cache/queue data;
- NexControl Agent identity/key configuration;
- runtime state needed for deduplication and scheduled publishing;
- scanner/session files still stored on disk at cutover;
- authenticated external-platform tokens, encrypted at rest;
- backup metadata required for rollback.

## Data that must remain disposable

- media download temp files;
- FFmpeg transcode scratch files;
- caches;
- npm cache/node_modules;
- ordinary generated logs after retention/backup policy;
- temporary update artifacts.

## Cutover invariant

A persistent Telegram user session is active on **one host only**. Before copying or activating a session on the VPS, stop the matching old runtime and confirm it no longer holds the lease/connection.
