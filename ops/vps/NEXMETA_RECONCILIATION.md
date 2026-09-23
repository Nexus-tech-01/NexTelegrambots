# NexMeta reconciliation map

This document records the current branch-level facts before any Facebook/Meta code is ported onto the VPS migration branch.

## Source islands

Current Telegram/NexAccount baseline:

```text
main
```

Current NexMeta/Facebook work:

```text
feature/nexmeta-v1
```

These branches have diverged heavily. The Meta branch must not replace `main` wholesale.

## What is actually on the Meta branch

`feature/nexmeta-v1` contains three distinct runtime layers that should be reviewed separately:

1. `nexmeta/`
   - Meta OAuth/webhooks/Messenger/Page runtime;
   - MongoDB-backed state;
   - encrypted Page-token vault;
   - browser companion/session components;
   - tests.

2. `nexus-bridge/`
   - signed internal Nexus event receiver;
   - service adapter loader;
   - media relay/registry;
   - adapters for NexDownloader, NexGame, NexStick, NexGroup, NexCanal, NexWhisper and NexAI;
   - bot-core discovery tooling.

3. `pterodactyl/`
   - process supervisor/public fan-out;
   - Pterodactyl-specific paths and startup scripts;
   - combined health/public route handling.

The first two layers contain reusable application logic. The third layer is primarily a hosting/process-management implementation and should not become the permanent VPS supervisor.

## Confirmed compatibility issues

### Branch divergence

The Meta branch and `main` both contain NexControl/agent-related files from different points in history. Do not overwrite the current `main` NexControl Agent with the older Meta-branch copy.

Port Meta-facing NexControl changes selectively after comparing each affected file.

### Pterodactyl paths

The Meta environment template currently uses values such as:

```text
NEXUS_ROOT=/home/container
NEXUS_ADAPTER_DIR=/home/container/nexus-bridge/adapters
NEXMETA_SESSION_PROFILE_DIR=/home/container/.nexmeta-browser-profile
```

VPS equivalents should be based on:

```text
/opt/nex/current
/var/lib/nex/...
/etc/nex/...
```

### Telegram orchestrator dependency

The current Pterodactyl supervisor requires:

```text
scripts/orchestrator.mjs
```

The default branch still hides much of the old Telegram fleet inside legacy source bundles. NexMeta stage 2 therefore cannot be declared VPS-ready until the Telegram bot source/entrypoint problem is resolved.

### Version metadata inconsistency

The Meta branch `nexmeta/package.json` currently reports version `0.8.0`, while the checked README text still says current service version `0.4.0`.

Do not use README version text as a deployment identity until that mismatch is reconciled.

### Runtime dependencies

The current NexMeta package requires Node >=20 and includes MongoDB, `puppeteer-core` and `@sparticuz/chromium`.

The VPS baseline targets Node 22, so Node itself is compatible, but Chromium/browser-session disk and memory requirements must be measured before enabling the companion/session-agent path on a small VPS.

## Selective port order

1. Keep current `main` NexControl Agent and Telegram/NexAccount code.
2. Import `nexmeta/` as an isolated application tree.
3. Import `nexus-bridge/` without the Pterodactyl supervisor.
4. Run NexMeta/bridge unit tests against Node 22.
5. Resolve all path assumptions under `/home/container`.
6. Replace Pterodactyl process supervision with systemd services.
7. Put public HTTPS routing in Caddy/Nginx only after local health checks pass.
8. Port only the NexControl Meta API/UI changes that are still required, comparing them against the current main implementation.
9. Verify the signed bridge against real reusable bot cores.
10. Enable Meta traffic only when Telegram remains independently healthy.

## Acceptance boundary

NexMeta is not considered reconciled merely because `/health/meta` returns 200.

Stage 2 requires:

- Meta webhook signature validation;
- OAuth callback over public HTTPS;
- encrypted token persistence;
- working signed Nexus bridge;
- all intentionally required adapters loaded;
- Telegram unaffected by NexMeta stop/restart;
- private bridge/control routes not exposed as unauthenticated public endpoints;
- no Pterodactyl-only filesystem dependency;
- browser-session profile, if enabled, stored under persistent VPS state rather than the code checkout.

