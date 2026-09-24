# NexControl Agent

Outbound-only file/runtime agent for NexControl. It opens no listening port. The agent polls NexControl for signed jobs and executes only whitelisted operations inside configured roots.

## Environment

- `NEXCONTROL_AGENT_KEY` (required, shown once when an agent is created in NexControl)
- `NEXCONTROL_AGENT_CONFIG` (optional, defaults to `./agent.config.json`)

## Supported jobs

- `fs.list`
- `fs.read`
- `fs.search`
- `fs.write` (atomic + backup + optional expected SHA)
- `fs.mkdir`
- `fs.move`
- `fs.delete` (backup first)
- `fs.rollback`
- `check.run` (only configured safe checks)
- `logs.tail` (only configured log files)
- `runtime.restart` (writes the configured restart hook file)

Backups are stored under `.nexcontrol/backups/` in the agent working directory.


## Control-plane failover

The agent now accepts multiple control-plane URLs and automatically fails over when the primary endpoint is unavailable or rejects the request.

Priority order:

1. `NEXCONTROL_URLS` (comma/space/semicolon separated)
2. `NEXCONTROL_URL`
3. `NEXCONTROL_BASE_URL`
4. `controlUrls` from the agent config
5. legacy `controlUrl`
6. built-in Supabase NexControl fallback

Every agent request also sends `x-nexcontrol-path`, so the same runtime works both behind the Vercel proxy and directly against the Supabase Edge Function. After failover, the agent periodically retries the primary endpoint (default: 5 minutes; override with `NEXCONTROL_PRIMARY_REPROBE_MS`).

## Service registry (P1)

Critical systemd services are explicitly allowlisted in `agent.config.json` under `services`. NexControl never accepts an arbitrary unit name from a job payload.

Example:

```json
{
  "services": {
    "nexcontrol-agent": {
      "unit": "nexcontrol-agent.service",
      "description": "NexControl Agent",
      "actions": ["start", "stop", "restart"],
      "healthUrl": "http://127.0.0.1:8787/health"
    }
  }
}
```

Supported service jobs:

- `service.list` — status/resource snapshot for every configured service
- `service.status` — one configured service
- `service.health` — compact systemd + HTTP health result
- `service.action` — `start`, `stop`, or `restart`, constrained by the registry
- `service.logs` — bounded `journalctl` output for the configured unit

The Server page displays the most recent successful `service.list` snapshot. Run `npm run check` in `nexcontrol/agent` before deployment.
