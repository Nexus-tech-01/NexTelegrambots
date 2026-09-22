# NexMeta / cross-platform porting to the VPS

NexMeta currently lives on `feature/nexmeta-v1` and was designed around a Pterodactyl supervisor. Do not copy the branch wholesale over `main`: the branches have diverged substantially.

## Existing runtime model to preserve

The current NexMeta design expects one public HTTPS entry point that fans out internally to:

- the Telegram gateway/orchestrator;
- NexMeta OAuth/webhook routes;
- the Nexus internal command bridge;
- temporary media relay routes;
- combined health reporting.

The Pterodactyl design uses separate internal ports for Telegram and NexMeta and keeps Telegram alive if NexMeta fails. That failure isolation should be preserved on the VPS.

## VPS mapping

Recommended stage-2 layout:

```text
Internet
  |
  v
HTTPS reverse proxy (Caddy/Nginx, installed only when public routing is ready)
  |
  +--> Telegram/public gateway service
  +--> NexMeta service
  +--> /internal/... restricted to loopback/private routing

systemd
  +--> nexus-telegram.service
  +--> nexmeta.service
  +--> nexus-bridge.service (if separated)
  +--> nexcontrol-agent.service
  +--> nex-resource-watchdog.service
```

The public reverse proxy should be the only process binding 80/443. Internal services should bind loopback unless they must be directly reachable.

## Porting rules

1. Keep NexControl web on Vercel during the first VPS cutover.
2. Preserve the NexMeta behavior where Telegram continues if NexMeta cannot start.
3. Preserve HTTPS-only OAuth/webhook public URLs.
4. Preserve encrypted-at-rest external-platform tokens.
5. Keep `NEXUS_COMMAND_GATEWAY_KEY` persistent across restarts once media relay or signed bridge traffic is enabled.
6. Do not expose private `/internal/*` routes publicly without authentication and routing restrictions.
7. Do not use a Facebook password as server configuration; official Meta OAuth/Page tokens and the existing Companion model remain separate connection paths.
8. Run the existing NexMeta smoke tests after the code is reconciled into a VPS-ready branch.

## Reconciliation work before deployment

The following files/features from `feature/nexmeta-v1` need to be ported selectively onto the current Telegram baseline:

- `nexmeta/` runtime and tests;
- `nexus-bridge/` adapters/gateway/media registry;
- the relevant NexControl Meta client/UI additions;
- public routing/health logic currently embedded in `pterodactyl/start.mjs`;
- environment documentation and smoke tests.

The Pterodactyl-specific supervisor should then be replaced by systemd/reverse-proxy units rather than retained as the permanent process manager.

## Stage-2 acceptance gates

- Telegram remains healthy when NexMeta is intentionally stopped.
- NexMeta `/health/meta` succeeds independently.
- combined health accurately reports degraded services.
- OAuth callback and webhook routes are reachable through HTTPS.
- fake/invalid webhook signatures are rejected.
- private bridge calls require their key/signature.
- no personal Facebook password or session cookie is stored server-side by the official Meta path.
- reboot restores the services without losing encrypted tokens or runtime state.
