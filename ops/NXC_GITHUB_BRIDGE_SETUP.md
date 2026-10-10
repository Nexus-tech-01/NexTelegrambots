# NexControl outbound GitHub bridge

## Architecture
ChatGPT (connected GitHub plugin) → private GitHub issue → VPS systemd agent → private issue comment with result.

No Vercel, Supabase, inbound VPS HTTPS, Nginx or SSH connection is needed for the transport.

**Private control repo:** Tresor562/Nexus-lab.
**Authorized requester:** GitHub Tresor562 (numeric ID 232972883).

## One-time authorization
The install script requests a GitHub fine-grained personal access token on
the VPS **without printing it**. Generate at:
https://github.com/settings/personal-access-tokens/new

Select owner Tresor562, only PRIVATE Nexus-lab repository, Issues = Read and
write, Metadata = Read. Never put token into ChatGPT, issue bodies or logs.
Saved in root-only file /etc/nxc-github-bridge/github-token (0600).
The bridge starts on boot and restarts automatically if it crashes.

## Issue protocol
Title starts with [NXC/VPS] . Body is exactly a prefix then JSON, e.g.:

    NXC-OP-V1
    {"v":1,"action":"ping","params":{}}

Or:
    NXC-OP-V1
    {"v":1,"action":"service_status","params":{"service":"nxc-vps-gateway.service"}}

Or:
    NXC-OP-V1
    {"v":1,"action":"shell","params":{"command":"nginx -T 2>&1 | tail -50","timeout":20}}

Supported actions: ping, system, service_status, service_restart, service_logs,
shell, read_file, write_file.

The VPS agent checks issue ownership, private repo, creation time and replay
state. A request executes at most once and reports a result comment.
Creating an issue does NOT prove success; read the result comment.

## Security
Full shell actions run as ROOT. A compromised trusted GitHub account or a
compromised repository-scoped PAT can have serious consequences. Enable 2FA,
use only the dedicated private repo, and revoke credentials promptly if
compromised. Don't send secrets through issues, even private issues. Always
obtain user approval before destructive operations.

Root-only files are blocked in the read_file/write_file convenience actions,
but full root shell remains powerful and can access them if explicitly asked.

## Emergency shutdown
sudo systemctl disable --now nxc-github-bridge

Revoking the fine-grained PAT also disables the transport.
The existing bots keep running if the bridge stops. This is independent of
Vercel and Supabase but DOES depend on GitHub being available and connected
to ChatGPT. Agent polls approximately every 12 seconds.
