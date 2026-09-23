# Nexus VPS migration runbook

This directory prepares the Nexus Telegram/automation stack for migration from the current Render/Pterodactyl-era layout to a normal Linux VPS without committing runtime secrets.

## Scope

Primary repository: `Nexus-tech-01/NexTelegrambots`.

The current default branch contains the active directly-versioned NexAccount/NexControl work. Facebook/NexMeta work currently lives on `feature/nexmeta-v1` and is intentionally **not** merged by this migration-prep branch.

The old five-bot Render fleet is a separate recovery problem: historical CI proved the checked-in bundle is incomplete/corrupt. See `MIGRATION_INVENTORY.md` and `BOT_SOURCE_RECOVERY.md`.

## Target filesystem

The VPS layout is intentionally split by responsibility:

```text
/opt/nex/
  current/        # checked-out/deployed application source
  releases/       # optional immutable release snapshots
  scripts/        # operator scripts

/var/lib/nex/
  data/           # persistent service data
  sessions/       # Telegram/account sessions
  runtime/        # pid/state/leases/private runtime keys
  downloads/      # transient media output
  cache/          # rebuildable cache
  logs/           # service logs

/etc/nex/
  env/            # root-readable service environment files
  secrets/        # non-env secret material if required

/backups/nex/     # encrypted local staging before off-host copy
```

No `.env` containing production credentials belongs in Git.

## Prepared VPS components

This migration branch now contains:

- base Debian/Ubuntu bootstrap;
- host/readiness validation;
- NexControl Agent configuration and systemd unit;
- RAM/disk resource watchdog unit;
- NexAccount worker systemd template;
- NexAccount/shared environment templates with blank secrets;
- worker health verifier;
- repository migration auditor;
- sanitized old-server bot-source exporter;
- encrypted `age` backup script plus systemd service/timer;
- NexMeta/Pterodactyl-to-VPS porting/reconciliation notes;
- current NexControl Vercel control-plane audit;
- safe NexControl restart-hook dispatcher;
- controlled historical-secret rotation plan;
- network exposure model.

NexAccount mutable pairing/runtime state can be moved out of the Git checkout through `NEXACCOUNT_RUNTIME_DIR`. Existing deployments keep their old behavior when that variable is absent.

## Migration order

1. Provision an Ubuntu/Debian VPS with SSH key access.
2. Run `sudo bash ops/vps/bootstrap.sh`.
3. Copy the repository to `/opt/nex/current` or clone it there.
4. Run `node ops/vps/audit-repository.mjs .` and review all warnings.
5. Run `runuser -u nex -- bash ops/vps/prepare-runtime.sh` to install locked NexAccount dependencies and execute the local regression suite.
6. Run `sudo bash ops/vps/install-systemd.sh`.
7. Fill real secrets in `/etc/nex/env/*.env` with mode `0600` or `0640`.
8. Review `/etc/nex/nexcontrol-agent.json`.
9. Run `sudo bash ops/vps/validate-host.sh`.
10. Enable/start `nex-restart-dispatcher.path`, then **NexControl Agent**, and verify its heartbeat before any bot runtime. The installer itself intentionally enables nothing.
11. Deploy one low-risk directly-versioned service and verify logs, restart, persistence and outbound connectivity.
12. Cut over NexAccount using `NEXACCOUNT_WORKERS.md`: stop the old session-bearing runtime first, then start worker 0 on the VPS and validate health.
13. Add further NexAccount workers only after the one-worker cutover is stable.
14. Recover the actual old five-bot source from the current runtime using `BOT_SOURCE_RECOVERY.md`; do not deploy the broken Git bundle.
15. Normalize that recovered source into ordinary Git directories and pass clean build/preflight tests.
16. Migrate the legacy bot fleet one service at a time only after step 15.
17. Move remaining scanners/watchers.
18. Reconcile and port NexMeta/other platform bridges as stage 2.
19. Rotate/revoke historically exposed production credentials according to `SECRET_ROTATION.md` without breaking the current live path.
20. Configure and restore-test the encrypted off-host backup flow described in `BACKUP_PLAN.md`.
21. Enable the resource watchdog and backup timer before declaring the migration complete.

## NexAccount first-start example

With `NEXACCOUNT_WORKER_COUNT=1`:

```sh
sudo systemctl start nexaccount@0
sudo journalctl -u nexaccount@0 -n 100 --no-pager
runuser -u nex -- node /opt/nex/current/ops/vps/check-nexaccount-workers.mjs 1
```

Do **not** run that cutover command while the same persistent MTProto sessions are still active on the old server.

## Backup first-run example

After configuring an offline age recipient and `NEX_BACKUP_TARGET`:

```sh
sudo systemctl start nex-backup.service
sudo journalctl -u nex-backup.service -n 100 --no-pager
```

Do not enable the timer until that encrypted backup has been copied elsewhere and successfully restore-tested.

## Hard gates

Do not mark the VPS ready until all of these are true:

- Node.js 22+ is available.
- Python 3 and FFmpeg/FFprobe are available.
- `age` and `rsync` are available for encrypted recovery copies.
- `/opt/nex`, `/var/lib/nex`, `/etc/nex`, `/backups/nex` exist with controlled ownership.
- NexControl Agent reaches the control plane and reports a heartbeat.
- secrets are absent from Git and readable only by the runtime account/root as intended.
- MongoDB and Redis connectivity is verified without printing credentials.
- NexAccount worker health reports the configured worker index/count consistently.
- a restart does not lose Telegram sessions or runtime state.
- pairing private-key state is outside the immutable code tree on the VPS.
- the disk/RAM watchdog is active and cannot delete persistent session data.
- at least one encrypted backup has been copied off the runtime host and restore-tested.
- the old five-bot fleet is not considered migrated until a complete normalized source tree passes a clean build.

## Deliberately deferred

This branch does not:

- merge `feature/nexmeta-v1` into `main`;
- pretend the legacy Render bundles are healthy;
- rotate production secrets automatically;
- copy live sessions from the current server;
- start production Telegram/Facebook/WhatsApp accounts;
- guess bot-fleet systemd entrypoints that are still hidden/incomplete.

Those actions require either the real VPS or a verified source extraction/cutover window.
