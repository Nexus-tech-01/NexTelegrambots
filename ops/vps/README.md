# Nexus VPS migration runbook

This directory prepares the Nexus Telegram/automation stack for migration from the current Render/Pterodactyl-era layout to a normal Linux VPS without committing runtime secrets.

## Scope

Primary repository: `Nexus-tech-01/NexTelegrambots`.

The current default branch contains the active Telegram/NexAccount/NexControl work. Facebook/NexMeta work currently lives on `feature/nexmeta-v1` and is intentionally **not** merged by this migration-prep branch. See `MIGRATION_INVENTORY.md` before promoting any source to production.

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
  runtime/        # pid/state/leases
  downloads/      # transient media output
  cache/          # rebuildable cache
  logs/           # service logs

/etc/nex/
  env/            # root-readable service environment files
  secrets/        # non-env secret material if required

/backups/nex/     # off-runtime recovery copies
```

No `.env` containing production credentials belongs in Git.

## Migration order

1. Provision an Ubuntu/Debian VPS with SSH key access.
2. Run `sudo bash ops/vps/bootstrap.sh`.
3. Copy the repository to `/opt/nex/current` or clone it there.
4. Put real secrets in `/etc/nex/env/*.env` with mode `0600`.
5. Copy `ops/vps/nexcontrol-agent.config.example.json` to `/etc/nex/nexcontrol-agent.json` and adjust only paths/agent identity if necessary.
6. Install the systemd unit from `ops/vps/systemd/nexcontrol-agent.service`.
7. Run `sudo bash ops/vps/validate-host.sh`.
8. Start **NexControl Agent first** and verify its heartbeat before any bot runtime.
9. Deploy one low-risk bot/service and verify logs, restart, persistence and outbound connectivity.
10. Move the bot fleet, then NexAccount workers, then scanners/watchers, then NexMeta/other platform bridges.
11. Move persistent sessions only after stopping the corresponding runtime on the old host. Never run one MTProto session concurrently on both hosts.
12. Enable the resource watchdog and backups before declaring the migration complete.

## Hard gates

Do not mark the VPS ready until all of these are true:

- Node.js 22+ is available.
- Python 3 and FFmpeg/FFprobe are available.
- `/opt/nex`, `/var/lib/nex`, `/etc/nex`, `/backups/nex` exist with controlled ownership.
- NexControl Agent reaches the control plane and reports a heartbeat.
- secrets are absent from Git and readable only by the runtime account/root as intended.
- MongoDB and Redis connectivity is verified without printing credentials.
- a restart does not lose Telegram sessions or runtime state.
- the disk/RAM watchdog is active and cannot delete persistent session data.
- backups are stored outside the active runtime tree.

## Deliberately deferred

This branch does not:

- merge `feature/nexmeta-v1` into `main`;
- rewrite the legacy Render source bundles yet;
- rotate production secrets automatically;
- copy live sessions from the current server;
- start production Telegram/Facebook/WhatsApp accounts.

Those actions require the real VPS and a controlled cutover window.
