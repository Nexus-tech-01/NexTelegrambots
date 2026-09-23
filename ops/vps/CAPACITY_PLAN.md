# VPS capacity planning — measure first, then place services

Do not size the final Nexus fleet from package count alone. Telegram clients, scanners, FFmpeg/media jobs and account-session density can have very different memory/CPU behavior.

The migration branch includes a non-secret runtime profiler:

```sh
python3 /opt/nex/current/ops/vps/profile-runtime-footprint.py \
  --duration 300 \
  --interval 5 \
  --output /var/lib/nex/runtime/runtime-footprint.json
```

For the old host, the same script can be copied there and run against the live runtime. It does not print full command lines or environment values.

## What the profile records

Per detected Nexus service/runtime:

- peak RSS during the sample;
- average sampled RSS;
- maximum sampled CPU utilization;
- process IDs;
- safe identifiers such as systemd unit, working directory, executable name and script basename.

It intentionally does **not** collect:

- full command arguments;
- environment variables;
- tokens/passwords;
- MongoDB/Redis URIs;
- Telegram session values.

## Sampling windows

Use at least three profiles before final placement:

1. normal idle/low traffic — 5 minutes;
2. normal publishing/download activity — 10 to 15 minutes;
3. a controlled heavy period involving media/transcoding/scanners — 10 to 15 minutes.

A five-minute snapshot is better than guessing, but it is not enough to establish a production ceiling.

## Headroom targets

The current watchdog warns at 75% RAM and begins relief at 85%. Service placement should therefore target a materially lower steady state.

Recommended initial operating target:

- ordinary steady RAM: at or below roughly 65–70%;
- reserve at least ~20–25% RAM for bursts, kernel/filesystem cache and transcodes;
- avoid planning around swap as normal operating memory;
- average CPU should leave enough headroom for FFmpeg/download bursts;
- keep disk below the 75% warning threshold after accounting for temporary media peaks.

These are operational targets, not claims about the final VPS size. The real profile determines the worker/bot placement.

## Initial migration placement

Before the legacy five-bot source is recovered, only directly-versioned components should influence stage-1 placement:

- NexControl Agent;
- restart dispatcher;
- resource watchdog;
- one NexAccount worker;
- directly-versioned scanners/watchers that pass their own checks.

Start with `NEXACCOUNT_WORKER_COUNT=1`. Increase workers only after measuring the one-worker baseline and verifying account distribution/health.

## Legacy five-bot placement

After source recovery, profile each bot separately before grouping them on a host:

- NexCanal;
- NexDownloader;
- NexGroup;
- NexGame;
- NexStick.

NexDownloader/media/transcoding workloads should be treated as bursty even if idle RSS is low.

## Multiple VPS placement rule

If the ecosystem is split across several VPS instances, separate by failure domain rather than simply dividing process count:

- **control/account plane:** NexControl Agent + NexAccount/session-bearing services;
- **media/download plane:** NexDownloader, FFmpeg-heavy jobs, temporary media;
- **publishing/scanner plane:** NexCanal/watchers/automation;
- **cross-platform plane (stage 2):** NexMeta/Facebook/WhatsApp bridges.

This limits a media/RAM spike from disconnecting every Telegram account at once.

## Acceptance before increasing load

For every placement change:

1. record a new footprint profile;
2. confirm no duplicate Telegram MTProto session exists on another host;
3. check NexControl heartbeat and systemd service state;
4. confirm watchdog state remains normal under ordinary load;
5. confirm temporary media cleanup works;
6. keep the previous stable placement available for rollback until the new topology has survived real workload.
