# NexControl restart hook on the VPS

NexControl Agent does not run as root. Its `runtime.restart` capability writes a JSON request file instead of calling `systemctl` directly.

On the VPS the request path is:

```text
/var/lib/nex/runtime/nexcontrol/control/restart.json
```

A root-owned systemd path unit watches that file and runs `restart-dispatcher.sh`.

## Why this exists

Giving the `nex` service account unrestricted sudo/systemctl access would turn a bot/control-plane compromise into unrestricted root process control.

The dispatcher keeps the privilege boundary narrow:

- NexControl can write a restart **request**;
- root systemd decides how that target maps to units;
- arbitrary command strings are never executed as root;
- only unit names beginning with `nex...` and ending in `.service` are accepted;
- requests are archived before restart execution to avoid replay loops.

## Built-in targets

- `nexaccount` or `nexaccount-workers` — restart currently active `nexaccount@*.service` instances;
- `nexcontrol-agent` — restart `nexcontrol-agent.service`;
- `resource-watchdog` — restart `nex-resource-watchdog.service`;
- `all` — restart active NexAccount workers plus units listed in `/etc/nex/restart-targets.d/all.list`.

The `all` target intentionally does **not** restart the agent or watchdog automatically. It is meant for workload runtimes, not the control/recovery plane.

## Future bot mappings

When the recovered bot fleet has real systemd unit names, add mappings without granting arbitrary root execution.

Example:

```text
/etc/nex/restart-targets.d/nexcanal.list
```

containing:

```text
nexcanal.service
```

and optionally add that unit to:

```text
/etc/nex/restart-targets.d/all.list
```

The dispatcher uses `systemctl try-restart`, so a mapped but stopped service is not unexpectedly started.

## Request history

Processed JSON requests are moved to:

```text
/var/lib/nex/runtime/nexcontrol/restart-history/
```

and are automatically pruned after 14 days.

Do not place secrets in the `reason` field; it is written to the system journal.
