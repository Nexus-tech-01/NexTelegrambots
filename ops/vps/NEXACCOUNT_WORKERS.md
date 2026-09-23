# NexAccount workers on the VPS

NexAccount is horizontally sharded by a shared worker count and a unique worker index. Worker 0 is the coordinator.

## Files

- shared secrets/infrastructure: `/etc/nex/env/shared.env`
- NexAccount configuration: `/etc/nex/env/nexaccount.env`
- optional instance overrides: `/etc/nex/env/nexaccount-N.env`
- runtime/key state: `/var/lib/nex/runtime/nexaccount`
- secondary scanner session: `/var/lib/nex/sessions/nexcanal-reader-session.txt`

The systemd instance number becomes `NEXACCOUNT_WORKER_INDEX`.


## NexControl Agent autostart boundary

On the VPS, `NEXCONTROL_AGENT_AUTOSTART_NEXACCOUNT=false` is mandatory. NexAccount is controlled by `nexaccount@.service` instances so the Agent cannot silently spawn a detached second runtime outside systemd.

The Agent keeps backward-compatible autostart support for older hosts when that variable is absent, but the VPS environment template explicitly disables it.

## One-worker first cutover

Keep:

```env
NEXACCOUNT_WORKER_COUNT=1
```

Then, only after the matching old host runtime has been stopped:

```sh
sudo systemctl start nexaccount@0
sudo journalctl -u nexaccount@0 -n 100 --no-pager
sudo -u nex node /opt/nex/current/ops/vps/check-nexaccount-workers.mjs 1
```

Do not enable the service permanently until its health, MongoDB access and session restoration are verified.

## Scaling to multiple workers

All active workers must use exactly the same `NEXACCOUNT_WORKER_COUNT`.

For four workers:

```env
NEXACCOUNT_WORKER_COUNT=4
```

Then start instances 0, 1, 2 and 3. Validate with:

```sh
sudo -u nex node /opt/nex/current/ops/vps/check-nexaccount-workers.mjs 4
```

Changing the worker count changes bucket ownership. Stop the entire NexAccount worker set before changing that count, then restart the complete set with the new value. Runtime leases are an additional safety guard, not a reason to intentionally run mismatched topologies.

## Session cutover rule

Never activate the same persistent Telegram MTProto account session on the old host and the new VPS at the same time.

The safe order for a session-bearing runtime is:

1. verify the new worker configuration without starting account sessions;
2. stop the corresponding old runtime;
3. confirm the old process/lease is gone or expired;
4. start the VPS worker;
5. verify health and restored account count;
6. watch logs for authorization/flood/session errors;
7. only then enable the VPS unit for future boots.

## Pairing key state

The pairing RSA key files can now live under `NEXACCOUNT_RUNTIME_DIR` instead of inside the Git checkout. On the VPS use:

```env
NEXACCOUNT_RUNTIME_DIR=/var/lib/nex/runtime/nexaccount
```

This keeps mutable private key material out of `/opt/nex/current`.
