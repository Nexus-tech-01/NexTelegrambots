# NexAccount first cutover and rollback

The first production NexAccount move is deliberately a **one-worker cutover**.

## Before cutover

Complete all of the following:

1. `prepare-runtime.sh` passes.
2. systemd units are installed.
3. NexControl Agent + restart dispatcher are active.
4. the new Agent heartbeat is visible/verified.
5. `pre-cutover.sh` has no hard failures.
6. `NEXACCOUNT_WORKER_COUNT=1`.
7. the matching old-host NexAccount / MTProto session-bearing runtime is stopped.

The last condition cannot be proven by the new VPS. It is an operator responsibility.

## Start

After confirming the old runtime is stopped:

```sh
sudo bash /opt/nex/current/ops/vps/start-nexaccount-cutover.sh --old-host-stopped
```

The script:

- refuses any worker count other than 1;
- refuses to start if another NexAccount instance is already active;
- requires the control plane/restart dispatcher to be active;
- starts worker 0 **without enabling it first**;
- waits for the local worker-health verifier;
- stops the worker automatically if health never becomes valid;
- enables `nexaccount@0.service` only after health passes.

## Observe

After the first successful start:

```sh
sudo journalctl -u nexaccount@0.service -f
```

Check account restoration, authorization, flood/session errors, commands, media, NexAnime/scanner behavior and NexControl visibility before scaling.

## Roll back the new VPS

If the VPS NexAccount runtime must be abandoned:

```sh
sudo bash /opt/nex/current/ops/vps/rollback-nexaccount-cutover.sh
```

This stops/disables VPS NexAccount instances only. It intentionally does not touch the old host.

Before restarting the old host, confirm the VPS workers are stopped and allow the runtime lease/disconnection state to clear.

## Scaling later

Only after worker 0 is stable should `NEXACCOUNT_WORKER_COUNT` be increased. Stop the complete worker set before changing the count because bucket ownership changes with the topology.

See `NEXACCOUNT_WORKERS.md`.
