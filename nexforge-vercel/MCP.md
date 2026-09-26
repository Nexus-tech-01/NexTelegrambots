# NexForge MCP

NexForge exposes a remote MCP control plane for external AI workers such as Claude while keeping NexControl as the infrastructure execution layer.

## Architecture

- **NexForge**: shared task queue, worker presence, leases, exclusive resource locks, agent coordination.
- **NexControl**: runtime/infrastructure execution layer.
- **MCP transport**: public HTTPS endpoint handled by the existing `nxc-env-keys-probe` Supabase Edge Function.
- **Authentication**: revocable capability tokens. Only SHA-256 token hashes are stored in `public.nxf_mcp_tokens`.
- **Workers**: `chatgpt`, `claude`, and future agents.
- **Concurrency**: tasks use leases; shared files/services use exclusive resource locks.

The private connector URL is intentionally **not** committed to GitHub because it contains a capability token.

## MCP tools

- `nexforge_status`
- `list_workers`
- `list_tasks`
- `create_task`
- `claim_task`
- `heartbeat_task`
- `complete_task`
- `release_task`
- `list_locks`
- `lock_resource`
- `unlock_resource`
- `list_infrastructure_agents`
- `run_host_job`
- `host_job_status`

## Operating rule

Before changing a shared project, a worker must inspect tasks and locks, claim/create its task, lock the resources it will mutate, keep its lease alive, persist code changes to Git, deploy through NexControl/NexForge when required, verify the result, complete the task, and release locks.

## Production

The MCP handler is merged into the existing NexForge Edge Function so it does not consume an additional Supabase Edge Function slot.
Current synced Edge Function version at the time of this commit: **18**.
