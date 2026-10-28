#!/usr/bin/env python3
"""Safely expose an EXISTING GitHub-OIDC-protected NexControl relay via HTTPS/443.

No credentials, logins, services, firewall or other vhosts are created/altered.
Requires the existing OIDC relay on localhost:18473 to reject unauthenticated POSTs.
"""
from __future__ import annotations
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DOMAIN = "nxc.31-56-85-53.sslip.io"
PORT = 18473
URI = "/v1/operate"
MARKER = "# managed: NexControl OIDC relay /v1/operate (no credential bypass)"
ALLOWED = (
    Path("/etc/nginx/conf.d/99-nxc-exclusive.conf"),
    Path("/etc/nginx/conf.d/99-nexcontrol-dedicated.conf"),
    Path("/etc/nginx/sites-enabled/99-nexcontrol-dedicated.conf"),
    Path("/etc/nginx/sites-enabled/nxc.31-56-85-53.sslip.io.conf"),
    Path("/etc/nginx/conf.d/nxc.31-56-85-53.sslip.io.conf"),
)
OWNERSHIP_MARKERS = ("# managed: NexControl dedicated host", "# nxc-managed-dedicated-vhost")

def insert_location(source: str) -> str:
    """Patch only a NexControl-owned HTTPS vhost, idempotently."""
    if not any(marker in source for marker in OWNERSHIP_MARKERS):
        raise ValueError("Not a NexControl-owned vhost")
    if source.count(f"server_name {DOMAIN};") != 2:
        raise ValueError("Unexpected dedicated hostname count")
    if source.count("listen 443 ssl;") != 1:
        raise ValueError("No unique HTTPS vhost")
    if MARKER in source:
        if "proxy_ssl_verify on;" not in source or f"proxy_ssl_name {DOMAIN};" not in source:
            raise ValueError("Existing route marker without strict TLS verification")
        return source
    if re.search(r"\blocation\s*=\s*/v1/operate\s*\{", source):
        raise ValueError("A /v1/operate route already exists; manual audit required")
    pos = source.index("listen 443 ssl;")
    loc = source.find("location / {", pos)
    if loc < 0:
        raise ValueError("HTTPS catchall location not found")
    before = source[:loc]
    if re.search(r"(?m)^\s*}\s*$", before[pos:]):
        raise ValueError("HTTPS catchall is outside dedicated server")
    block = f"""  {MARKER}
  location = {URI} {{
    limit_except POST {{ deny all; }}
    proxy_pass https://127.0.0.1:{PORT}{URI};
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_ssl_name {DOMAIN};
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 3;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_set_header Host {DOMAIN};
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 5s;
    proxy_read_timeout 125s;
  }}
  """
    return source[:loc] + block + source[loc:]

def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=False)

def unauthenticated_rejection(port: int) -> bool:
    check = run(
        "curl", "--silent", "--show-error", "--noproxy", "*",
        "--resolve", f"{DOMAIN}:{port}:127.0.0.1",
        "--connect-timeout", "4", "--max-time", "12", "--output", "/dev/null",
        "--write-out", "%{http_code}", "--request", "POST",
        "--header", "Content-Type: application/json", "--data", "{}",
        f"https://{DOMAIN}:{port}{URI}" if port != 443 else f"https://{DOMAIN}{URI}",
    )
    return check.returncode == 0 and check.stdout.strip() in ("401", "403")

def main() -> int:
    if os.geteuid() != 0:
        print("Root required for guarded Nginx repair", file=sys.stderr)
        return 2
    if not unauthenticated_rejection(PORT):
        print("OIDC_UPSTREAM_UNHEALTHY_OR_UNVERIFIED: no changes made", file=sys.stderr)
        return 3
    check = run("nginx", "-T")
    if check.returncode != 0:
        print("NGINX_INVALID: no changes made", file=sys.stderr)
        return 4
    eligible = []
    for file in ALLOWED:
        if file.is_file() and not file.is_symlink() and f"# configuration file {file}:" in check.stdout:
            try:
                source = file.read_text(encoding="utf-8")
                patch = insert_location(source)
                eligible.append((file, source, patch))
            except ValueError:
                continue
    if len(eligible) != 1:
        print("EXCLUSIVE_VHOST_NOT_RESOLVED: no changes made", file=sys.stderr)
        return 5
    path, original, patched = eligible[0]
    if original == patched:
        print("ROUTE_ALREADY_INSTALLED=" + str(unauthenticated_rejection(443)))
        return 0 if unauthenticated_rejection(443) else 6
    backup_dir = Path("/var/backups/nxc-vps/oidc-route")
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_dir / (stamp + ".conf")
    shutil.copy2(path, backup)
    try:
        temp = path.with_name(path.name + ".nxc-new")
        temp.write_text(patched, encoding="utf-8")
        shutil.copymode(path, temp)
        os.replace(temp, path)
        if run("nginx", "-t").returncode != 0:
            raise RuntimeError("Nginx syntax check failed")
        if run("systemctl", "reload", "nginx").returncode != 0:
            raise RuntimeError("Nginx reload failed")
        if not unauthenticated_rejection(443):
            raise RuntimeError("New HTTPS relay was not verified")
    except Exception as error:
        shutil.copy2(backup, path)
        if run("nginx", "-t").returncode == 0:
            run("systemctl", "reload", "nginx")
        print(f"ROLLED_BACK: {error}", file=sys.stderr)
        return 7
    print(f"OIDC_HTTPS_ROUTE_READY={DOMAIN}{URI}; BACKUP={backup}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
