# NexControl Rescue — independent standby control plane

**Status: staged source only. Not deployed; the existing services are NOT yet migrated.**

This branch retains the full NexTelegrambots source tree (including existing NexControl
code, UI and APIs) and adds an **independent** Node/Mongo control plane under
`nexcontrol-rescue/`. Unlike the current Vercel proxy, this runtime does not
forward control requests into the quota-blocked Supabase Edge Functions.

## What works after provisioning

- `/`, `/bots`, `/destinations`, `/campaigns`, `/campaigns/new`, `/server` — Mongo-backed NexControl operational UI.
- `/api/admin/login`, `/api/admin/logout` — isolated admin authentication.
- `/api/admin/bots`, `/api/admin/campaigns` — bot registration and campaign creation.
- `/api/v1/heartbeat`, `/api/v1/jobs/claim`, `/api/v1/jobs/result`, `/api/v1/destinations/*` — bot protocol.
- `/api/v1/agent/heartbeat`, `/api/v1/agent/jobs/claim`, `/api/v1/agent/jobs/result` — agent protocol.
- `/api/admin/agent/jobs` — operator-enqueued jobs and results.
- `/health/live`, `/health/ready` — liveness and database readiness.

**Coverage limitation:** this is an isolated emergency version based on the
Mongo-backed NexControl UI, *not yet a pixel-identical copy* of the more recent
Supabase Edge `/infrastructure` experience. Its Mongo database starts EMPTY.
Sessions, message histories, prior agent jobs, app config, backups and the advanced
infrastructure UI MUST be migrated or re-implemented before full cutover.

## Deployment after primary/alternate host access is restored

1. Keep old services and endpoints unchanged. Take **two encrypted snapshots**
   of the primary host and the Supabase database, verify integrity.
2. Provision a separate Linux host or revive `vps-7373`. Ensure Docker Compose
   is present. Place this branch's repository on disk; copy `.env.example`
   to `.env` in this directory, populate locally without sharing secrets,
   and `chmod 600 .env`.
3. On host: `cd nexcontrol-rescue && docker compose up -d --build`.
4. Health checks: `curl -fsS http://127.0.0.1:8082/health/live` and
   `curl -fsS http://127.0.0.1:8082/health/ready`.
   **Readiness does not imply migrated functionality.**
5. Provide TLS via a reverse proxy that forwards to localhost:8082. Never
   expose port 8082 publicly or use `RESCUE_ALLOW_INSECURE_HTTP=true`
   on the Internet. Configure private authentication and rate limits.
6. Migrate configuration and history with verified transformations to Mongo.
   Server-side Telegram MTProto StringSessions must remain encrypted and
   under their existing managed paths — **never include them in Git**.
7. Verify `nexus-main` agent handshake with the actual configured
   per-agent/fleet credentials. Validate bot API and dashboard login in staging.
   Reconfigure a SINGLE canary agent to use the new HTTPS URL, then check
   heartbeat, job claim, job result, file read, logs and no duplicate actions.
8. Migrate remaining agents and bots one by one with explicit success checks.
   Preserve bot publication keys/deduplication ledger and job idempotency.
   For NexAI Telegram accounts, ensure only ONE worker owns a session at once,
   to avoid `AUTH_KEY_DUPLICATED`.
9. Re-implement or migrate advanced Infrastructure v2 and pairing gateway,
   then test secure mobile QR pairing end-to-end (never capture OTP/2FA).
10. Only once every critical system is healthy: update canonical domains and
    client configurations, cut reads/writes over, disable legacy pollers,
    retire the **old deployment** without deleting its encrypted snapshots.

## Rollback

Do not retire the old stack until a written acceptance report shows every
dependent integration migrated. Rollback requires re-pointing agents/bots to
the prior verified control URL, stopping new dispatch safely, and never
running two processors for the same Telegram session simultaneously.

## Provider issues (observed 2026-10-08)

Vercel rejected a new project under the original team with
`402 resource_creation_blocked` / `fair use limits`. Supabase Edge
also returned 402. These restrictions cannot be fixed by just renaming
NexControl or creating another Vercel project in the same team. Provider
billing/usage must be resolved, or a separately authorized host must be
provisioned and paid for as applicable. Do not treat an empty standby
dashboard as restored production.
