# NexGuard + Automation Supervisor

This directory contains the two autonomous reliability brains for the Nexus ecosystem.

## 1. NexGuard

`nexguard.mjs` continuously validates bot/runtime capabilities and infrastructure checks.

It can:

- run allow-listed command checks;
- probe HTTP health endpoints;
- verify JSON/file heartbeats;
- verify systemd services;
- restart only explicitly configured services after repeated failures;
- verify the repair after restart;
- persist incident signatures and recurrence history;
- emit repair/improvement requests for AI workers.

NexGuard deliberately does **not** rewrite production source code by itself. A source-code repair is delegated to an external worker (ChatGPT/Claude through NexForge), where leases, resource locks, Git, tests, deployment verification and rollback can be enforced.

## 2. Automation Supervisor

`automation-supervisor.mjs` watches business automation correctness rather than only process uptime.

Current strict audits include:

- anime publication identity/order;
- exactly one general synopsis before episodes;
- no duplicate published episode identity for the same series/season/episode;
- no cross-series simultaneous publishing;
- stale anime claims and scheduler gaps;
- automatic suppression of queued episode variants that are already published;
- LiteAPK watcher heartbeat, overdue queues and duplicate queue keys;
- optional HTTP health probes for Telegram/Facebook/WhatsApp/NexNews relay services.

The supervisor only performs low-risk deterministic repairs. Destructive or ambiguous corrections become repair tasks for NexForge workers.

## AI supervision contract

Workers identify themselves as `chatgpt` or `claude`.

Before changing a shared resource, a worker must:

1. inspect NexForge tasks and locks;
2. claim/create the task;
3. acquire an exclusive resource lock;
4. diagnose from logs/state/tests;
5. patch on Git;
6. run targeted tests and regression tests;
7. deploy through NexControl/NexForge;
8. verify production health;
9. roll back if verification regresses;
10. release the lock and complete the task.

Two workers must never modify the same resource concurrently.

## Self-improvement

Self-improvement is bounded:

- runtime baselines and recurrence signatures adapt automatically;
- repeated incidents generate improvement candidates;
- deterministic repair rules may be learned from previously verified incident signatures;
- source-code changes still go through Git + tests + verification + rollback.

This avoids an uncontrolled self-modifying production bot while still allowing the system to become better at diagnosing and repairing recurring failures.


## Fleet self-test

`bot-selftest.mjs` audits the installed Nexus components. When a component exposes an
`npm run check` script it runs that suite; otherwise it performs safe JavaScript syntax
checks and Python compilation checks. An optional NexAccount live smoke test can verify
the menu and core commands through the local control API without posting test traffic to
public channels.

## Additional strict publication guards

The automation supervisor also consumes the LiteAPK publication ledger so it can tell a
valid descriptor + APK pair from two unrelated publications. It detects duplicate source
publication keys and unrelated batches that violate the configured publication gap.

The WhatsApp publisher uses deterministic source publication IDs and refuses to enqueue
the same publication/destination twice. The supervisor audits stuck relay jobs and recent
duplicate delivery history.

For anime, the supervisor calls the same `animeSupervisorAudit` used by the publishing
engine. Safe repairs include recovering stale claims, requeuing a foreign series that
attempts to publish during the active series, suppressing already-published queued
episodes, and creating a missing general synopsis before episodes are allowed to resume.

## Installation

On the primary VPS:

```bash
sudo NEX_ROOT=/opt/nex/current /opt/nex/current/infra/systemd/install-nexguard.sh
```

The installer enables NexGuard and the automation supervisor, adds them to the local
NexControl service registry without changing credentials, and enables the NexForge AI
repair bridge when `/etc/nex/nexguard-ai.env` is configured.
