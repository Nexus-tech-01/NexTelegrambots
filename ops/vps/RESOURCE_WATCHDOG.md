# VPS RAM/disk watchdog behavior

The existing NexControl resource watchdog was originally designed around an orchestrator/fleet-launcher parent process. On a normal systemd VPS, NexAccount and later bot services are direct systemd children, so the old `requireSupervisedParent=true` rule would reject those processes as restart candidates.

The VPS template therefore uses:

```json
"requireSupervisedParent": false
```

while keeping a strict command-line allowlist and explicit exclusions.

## Memory policy

Default thresholds:

- warning: 75%
- relief: 85%
- critical: 92%
- emergency: 96%

At relief/critical pressure the watchdog searches only processes whose command lines match the configured Nexus runtime roots. It excludes NexControl Agent, the watchdog itself and fleet-launcher processes.

If a qualifying process exceeds the minimum RSS threshold, the watchdog sends `SIGTERM`. For systemd-managed services this lets systemd perform the restart rather than spawning a second unmanaged copy.

At emergency pressure, if no safe individual candidate can be selected, the watchdog writes the NexControl restart hook. The root-owned restart dispatcher then restarts only approved/mapped workload services.

## Disk policy

Default thresholds:

- warning: 75%
- cleanup: 80%
- critical: 90%
- emergency: 95%

Cleanup is limited to explicitly disposable paths under `/var/lib/nex`, currently including NexControl temporary/old backup material, downloads and cache.

Persistent session/data/secrets paths are not cleanup targets.

## Important safety boundary

Disabling parent matching does **not** mean the watchdog may kill arbitrary system processes.

Candidate selection still requires a command-line match such as:

```text
/opt/nex/current/bots/
/opt/nex/current/nexaccount/
```

and respects the exclusion list.

When new bot services are normalized from the legacy bundle, their runtime path must stay under the configured Nexus roots or be added deliberately after review.

## VPS acceptance test

Before production load:

1. verify the watchdog state file updates;
2. verify it reports host/cgroup RAM and disk percentages correctly;
3. launch a controlled disposable Nexus test process under the allowed runtime tree;
4. confirm a test SIGTERM is restarted by systemd as expected;
5. confirm NexControl Agent and the watchdog are never selected as candidates;
6. confirm disk cleanup cannot traverse outside `/var/lib/nex`.

Do not intentionally drive the production VPS to 96% RAM just to test emergency behavior.
