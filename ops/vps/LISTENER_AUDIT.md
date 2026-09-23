# Listener and firewall exposure checks

Stage 1 does not require any Nexus runtime to listen publicly.

Run:

```sh
sudo bash /opt/nex/current/ops/vps/audit-listeners.sh
```

The audit inspects TCP listeners and process ownership. It fails when a Nexus process under `/opt/nex` / `/var/lib/nex` or a `nex*.service` systemd unit is publicly bound without an explicit allowance.

It also has a hard check that NexAccount worker ports `3491-3747` are never bound publicly.

For a later stage-2 reverse proxy, explicitly allow only the intended public port while auditing:

```sh
sudo bash /opt/nex/current/ops/vps/audit-listeners.sh --allow-port 443
```

This is an **audit**, not a firewall manager. It deliberately does not change SSH/firewall rules because doing that without knowing the provider's real administration port could lock the server out.

Use the provider firewall or a reviewed UFW/nftables policy separately. The desired stage-1 policy remains: administration path only for inbound traffic, normal outbound HTTPS/database traffic, no public NexAccount/NexControl Agent application port.
