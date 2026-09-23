# Legacy bot source recovery gate

The old Render-era five-bot fleet cannot be promoted to the new VPS from the current Git bundles alone.

The recovery goal is **not** to copy a running container blindly. It is to obtain a clean, reviewable source tree for the bot fleet and preserve the live runtime only as recovery evidence.

## What must be recovered

From the currently working/most complete old runtime, capture the real source/configuration structure for:

- NexGame;
- NexCanal;
- NexDownloader;
- NexGroup;
- NexStick;
- shared `scripts/` orchestration/preflight/build/install files;
- root package/build metadata needed to reproduce the runtime;
- any reusable shared libraries consumed by those bots;
- watcher/source directories and root build metadata actually referenced by that runtime.

Do not assume the historical directory names in the broken bundle are the final names. Record the actual live paths first.

## What must NOT enter the source archive

The sanitized source archive must exclude:

- `.env` and `.env.*` secret files;
- Telegram session strings/session files;
- private keys/certificates;
- MongoDB/Redis credentials;
- bot tokens;
- browser profiles/cookies;
- `node_modules`;
- download/cache/temp directories;
- NexControl backup directories;
- Git credentials.

Encrypted disaster-recovery backup is a separate process; see `BACKUP_PLAN.md`.

## Prepared exporter

`export-bot-source.sh` is designed to run on the old host when console/SSH access is available.

It copies `bots/`, `scripts/` and known source-oriented shared directories such as `lib/`, `shared/`, `src/` and `watchers/` when they exist, plus root package/build metadata. It strips known secret/runtime paths, performs a basic secret-pattern scan and only then creates a tarball.

Example:

```sh
sudo bash /path/to/ops/vps/export-bot-source.sh /home/container /backups/nexus-source
```

The exporter does not stop or restart the bots.

## Recovery acceptance gates

Before the recovered source is committed or deployed:

1. every expected bot has a real source/package directory;
2. the orchestration scripts referenced by the runtime exist;
3. no real `.env`, Telegram token, private key, MongoDB credential or MTProto session is present;
4. package manifests and lockfiles are preserved when available;
5. TypeScript/Node/Python build steps succeed in a clean environment;
6. the generated runtime can start without relying on files outside its documented persistent directories;
7. each bot can be started independently enough to diagnose failures;
8. health/preflight checks identify each service separately;
9. recovered source is committed as normal files/directories, **not re-hidden in large Base64 bundle chunks**;
10. the old host remains untouched until the new source passes reproducible tests.

## Recommended Git normalization

After recovery, create a separate branch and import normal directories such as:

```text
bots/
  ...
scripts/
  ...
```

Keep the existing broken bundle files temporarily as historical recovery evidence. Remove/archive them only after the normalized tree has passed a clean build and the VPS rollout is stable.

## Why this blocks the full bot-fleet cutover

Historical CI proved the current bundle only supports partial extraction. Building production systemd units around guessed entrypoints would make the migration fragile and could silently deploy incomplete bots.

NexAccount, NexControl Agent and the directly versioned watcher code can continue to be prepared independently while this recovery gate remains open.
