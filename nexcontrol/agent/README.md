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
