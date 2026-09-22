# Migration inventory and source-of-truth map

Audit date: 2026-09-22.

This document prevents a VPS migration from accidentally deploying an obsolete or diagnostic branch.

## Repository-level map

| Component | Current source to inspect first | Migration treatment |
| --- | --- | --- |
| Telegram bot fleet / NexAccount / NexCanal / current NexControl Agent | `main` | Treat as the current Telegram baseline. Validate before deployment. |
| NexMeta / Facebook-Messenger bridge / Nexus bridge / Pterodactyl supervisor | `feature/nexmeta-v1` | Preserve as a separate source island for now. Port the runtime to the VPS only after reconciling with `main`. |
| NexControl feature lineage used by NexMeta | `feature/nexcontrol-v1` | Historical/feature base. Do not replace the newer `main` agent blindly. |
| Early NexAccount feature branch | `feature/nexaccount-v1` | Older divergent lineage: 31 commits ahead of its old merge base but 260 commits behind current `main`. Do not deploy it instead of `main`. |
| NexDownloader inline investigation branch | `feature/nexdownloader-inline` | Diagnostic workflow branch only; currently far behind `main` and not a production source. |
| Old Render recovery branches and diagnostic PRs | diagnostic/repair branches | Recovery evidence only. Do not use as production source without explicit verification. |
| NID marketplace | `Nexus-tech-01/Project-02` | Separate product. Not part of the bot VPS cutover unless explicitly scheduled. |
| Nexus Tech public site | `Nexus-tech-01/Site-officiel-` | Separate web deployment. Not part of the bot runtime cutover. |

## Important divergence

`main` and `feature/nexmeta-v1` have diverged substantially. At this audit point the branches have a common historical base but hundreds of commits on each side. The NexMeta branch contains the Facebook/Messenger runtime, companion bridge and `nexus-bridge`, while `main` contains later Telegram/NexAccount/NexControl work. Neither branch should overwrite the other wholesale.

The VPS migration must therefore happen in two stages:

1. move the validated Telegram baseline from `main`;
2. port/reconcile NexMeta and the cross-platform bridge on top of that baseline.

## Main-branch runtime findings

The current repository still contains legacy packaging assumptions from Render:

- `render-src.b64.part-*` source chunks;
- `nexus-bots-src.tar.xz.b64.part-*` source chunks;
- a Dockerfile that reconstructs the Render-era runtime bundle;
- a Render blueprint;
- watcher/runtime paths that still include provider-specific assumptions.

These are not deleted during the first migration-prep pass because they remain recovery material. The VPS should not depend on them long-term.

## Configuration cleanup required before final cutover

1. Consolidate duplicate NexAnime environment-variable families (`NEXANIME__*` and `NEXANIME_*`) into one canonical schema after verifying which runtime consumes each name.
2. Replace provider-specific persistent paths such as `/home/container/...` with `/var/lib/nex/...` equivalents.
3. Keep secrets outside Git; `.env.example` stays documentation-only.
4. Keep NexControl web/control plane remote initially; run only NexControl Agent on the VPS until the bot fleet is stable.
5. Keep MongoDB/Redis external during the first cutover unless a separate database migration is explicitly planned.

## Runtime groups for the VPS

### Control plane agent

- NexControl Agent
- resource watchdog
- deployment/restart hooks
- backup/rollback directory

### Telegram core

- NexGame
- NexCanal
- NexDownloader
- NexGroup
- NexStick
- NexWhisper
- Stacy / NexAI bot-side services

### Account automation

- NexAccount coordinator
- NexAccount workers
- Telegram MTProto session storage
- scanners/watchers
- anime/APK ingestion workers

### Cross-platform layer (stage 2)

- NexMeta
- Nexus bridge
- Facebook/Messenger integrations
- future WhatsApp/other platform adapters

## Persistent data that must survive host replacement

- encrypted Telegram MTProto sessions;
- MongoDB-backed account/settings state;
- Redis-backed transient queues only when persistence is operationally required;
- NexControl Agent identity/key configuration;
- runtime state needed for deduplication and scheduled publishing;
- NexAnime state files if still file-backed at cutover time;
- any authenticated external-platform tokens, encrypted at rest;
- backup metadata required for rollback.

## Data that must remain disposable

- media download temp files;
- FFmpeg transcode scratch files;
- caches;
- npm cache/node_modules;
- generated logs after retention/backup policy;
- temporary update artifacts.

## Cutover invariant

A persistent Telegram user session is active on **one host only**. Before copying or activating a session on the VPS, stop the matching old runtime and confirm it no longer holds the lease/connection.
