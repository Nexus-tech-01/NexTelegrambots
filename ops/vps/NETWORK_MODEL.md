# Nexus VPS network exposure model

The first migration stage does not need to expose every runtime to the Internet.

## Stage 1 — Telegram/control migration

Expected exposure:

- SSH: provider/admin policy only;
- NexControl Agent: **outbound HTTPS only**;
- NexAccount worker control ports: loopback only;
- MongoDB/Redis: outbound client connections to their existing providers;
- no public NexMeta webhook/OAuth endpoint yet.

NexAccount defaults to `127.0.0.1` and worker ports `3491 + workerIndex`. Do not bind those ports to `0.0.0.0`.

NexControl Agent is intentionally outbound-polling and should not require a public listening port.

## Stage 2 — public cross-platform gateway

When NexMeta is reconciled, add one HTTPS reverse proxy such as Caddy or Nginx.

Recommended principle:

```text
Internet
   |
   v
TCP 443 reverse proxy
   |
   +--> local Telegram/public gateway as required
   +--> local NexMeta HTTP service
   +--> public OAuth/webhook routes only
```

Internal service ports remain on loopback.

Do not expose the Nexus signed command receiver or NexMeta privileged machine API as an unauthenticated public service.

## Firewall policy

Before stage 2, a conservative firewall only needs the administration path required by the provider plus outbound traffic.

When HTTPS is added, open 80 only if required for certificate/bootstrap redirects and 443 for the public endpoint.

Avoid opening internal application ports merely because they appear in a development/Pterodactyl configuration.

## Verification before go-live

Inspect listeners with:

```sh
ss -lntp
```

Confirm:

- NexAccount workers listen on `127.0.0.1`;
- database services are not accidentally bound publicly if later self-hosted;
- only the intended reverse proxy owns public 80/443;
- NexMeta/internal bridge ports are loopback/private;
- no old Pterodactyl allocation or temporary tunnel remains the production path.

