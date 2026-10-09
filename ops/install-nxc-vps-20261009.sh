#!/usr/bin/env bash
# NexControl and NexAI VPS-first installer; never restarts Telegram/WhatsApp bot units.
set -Eeuo pipefail
umask 077
if [[ "$(id -u)" != 0 ]]; then echo "Run as root (sudo bash)." >&2; exit 2; fi
for bin in curl python3 systemctl openssl ss; do
  command -v "$bin" >/dev/null || { echo "Missing required command: $bin" >&2; exit 2; }
done
DOMAIN="${NXC_VPS_DOMAIN:-31-56-85-53.sslip.io}"
case "$DOMAIN" in *[!a-zA-Z0-9.-]*|"") echo "Invalid public domain" >&2; exit 2;; esac
SOURCE_REF="9f70e90999b5e5d02a08ccb940494eaf1c77b9be"
REMOTE="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/${SOURCE_REF}"
ROOT="/opt/nxc-vps"
SITE="${ROOT}/site"
CONFIG="/etc/nxc-vps/config.json"
echo "=== NexControl / NexAI local VPS migration (safe coexistence) ==="
echo "Server: $(hostname); public name: ${DOMAIN}"
install -d -m 0700 /etc/nxc-vps /var/lib/nxc-vps "${ROOT}" "${SITE}"
# Download to a temporary location, validate before replacing any installed version.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
curl -fsSL --retry 3 --connect-timeout 15 --max-time 100 \
  "${REMOTE}/ops/nxc-vps-gateway-20261009.py" -o "${TMPDIR}/gateway.py"
python3 -m py_compile "${TMPDIR}/gateway.py"
for file in index.html style.css app.js; do
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 100 "${REMOTE}/${file}" -o "${TMPDIR}/${file}"
  test -s "${TMPDIR}/${file}"
done
# Same-origin URL makes the NexAI web app independent of Edge Functions.
python3 - "${TMPDIR}/app.js" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
text=p.read_text()
before="const API='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexai-connect';"
assert text.count(before)==1, "NexAI client API signature changed; refusing blind replacement."
p.write_text(text.replace(before,"const API='/api/nexai-connect';"))
PY
if [[ -f "${ROOT}/gateway.py" ]]; then
  cp -a "${ROOT}/gateway.py" "${ROOT}/gateway.py.bak-$(date +%s)"
fi
install -m 0700 "${TMPDIR}/gateway.py" "${ROOT}/gateway.py"
for file in index.html style.css app.js; do install -m 0644 "${TMPDIR}/${file}" "${SITE}/${file}"; done

# Only create admin password on first installation; subsequent re-runs preserve identity.
NEW_PASSWORD=""
if [[ ! -f "${CONFIG}" ]]; then
  NEW_PASSWORD="$(openssl rand -hex 20)"
  NXC_BOOT_PASSWORD="${NEW_PASSWORD}" NXC_BOOT_DOMAIN="${DOMAIN}" python3 - "${CONFIG}" <<'PY'
import hashlib,json,os,secrets,sys
from pathlib import Path
path=Path(sys.argv[1]); salt=secrets.token_bytes(20)
pw=os.environ["NXC_BOOT_PASSWORD"].encode()
c={"domain":os.environ["NXC_BOOT_DOMAIN"],"salt":salt.hex(),
   "password_hash":hashlib.pbkdf2_hmac("sha256",pw,salt,260000).hex(),
   "agent_key":secrets.token_urlsafe(48)}
fd=os.open(path,os.O_CREAT|os.O_WRONLY|os.O_EXCL,0o600)
with os.fdopen(fd,"w") as f: json.dump(c,f)
PY
else
  NXC_BOOT_DOMAIN="${DOMAIN}" python3 - "${CONFIG}" <<'PY'
import json,os,sys
from pathlib import Path
c=json.loads(Path(sys.argv[1]).read_text())
if c.get("domain")!=os.environ["NXC_BOOT_DOMAIN"]:
    raise SystemExit("Existing domain differs; specify NXC_VPS_DOMAIN to preserve existing certificates.")
PY
fi

cat > /etc/systemd/system/nxc-vps-gateway.service <<'UNIT'
[Unit]
Description=NexControl/NexAI quota-independent VPS control plane
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
Group=root
UMask=0077
ExecStart=/usr/bin/python3 /opt/nxc-vps/gateway.py
WorkingDirectory=/opt/nxc-vps
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nxc-vps-gateway.service
sleep 2
if ! curl -fsS --max-time 5 http://127.0.0.1:18731/healthz >/dev/null; then
  echo "Gateway didn't start. Last 15 log lines:" >&2
  journalctl -u nxc-vps-gateway --no-pager -n 15 >&2
  exit 1
fi
echo "PASS: independent NexControl backend working on VPS localhost."
echo "PASS: local SQLite data store (/var/lib/nxc-vps)."
echo "PASS: NexAI and NexControl web files available."
if [[ -f /opt/nex/apps/public/nexai/current/cli.mjs ]]; then
  echo "PASS: NexAI pairing CLI exists at the expected VPS path."
else
  echo "WARNING: NexAI pairing CLI missing. NexAI pairing remains unavailable until its runtime is restored." >&2
fi

# Online SQLite backups while the gateway is serving traffic; keep protected
# configuration together with the database for full disaster recovery.
cat > "${ROOT}/backup.py" <<'PY'
#!/usr/bin/env python3
import datetime,os,shutil,sqlite3
from pathlib import Path
source=Path('/var/lib/nxc-vps/gateway.sqlite3')
config=Path('/etc/nxc-vps/config.json')
dest=Path('/var/backups/nxc-vps')
dest.mkdir(parents=True,exist_ok=True)
os.chmod(dest,0o700)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
tmp=dest/('gateway-'+stamp+'.db.tmp')
finished=dest/('gateway-'+stamp+'.db')
src=sqlite3.connect(str(source),timeout=20)
dst=sqlite3.connect(str(tmp))
with dst: src.backup(dst)
dst.close();src.close()
os.chmod(tmp,0o600);tmp.rename(finished)
config_backup=dest/('gateway-'+stamp+'.json')
shutil.copyfile(config,config_backup);os.chmod(config_backup,0o600)
for pattern in ('gateway-*.db','gateway-*.json'):
    old=sorted(dest.glob(pattern),reverse=True)
    for filename in old[14:]: filename.unlink()
print('NexControl VPS daily SQLite online backup completed:',stamp,flush=True)
PY
chmod 0700 "${ROOT}/backup.py"
python3 -m py_compile "${ROOT}/backup.py"
cat >/etc/systemd/system/nxc-vps-backup.service <<'UNIT'
[Unit]
Description=NexControl VPS SQLite online snapshot (no bot interruption)
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/nxc-vps/backup.py
User=root
UMask=0077
UNIT
cat >/etc/systemd/system/nxc-vps-backup.timer <<'UNIT'
[Unit]
Description=Daily NexControl VPS disaster recovery backup
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1800
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now nxc-vps-backup.timer
systemctl start nxc-vps-backup.service
echo "PASS: nightly online backups configured and initial snapshot created."

# Provision HTTPS only if it doesn't impact existing frontends on ports 80/443.
PUBLIC_READY=0
if command -v caddy >/dev/null && [[ -f /etc/caddy/Caddyfile ]]; then
  echo "Existing Caddy config detected: checking a safe, additive HTTPS site."
  if grep -Fq "reverse_proxy 127.0.0.1:18731" /etc/caddy/Caddyfile; then
    echo "NexControl reverse proxy appears present; leaving existing Caddy routes unchanged."
  elif grep -Fq "${DOMAIN} {" /etc/caddy/Caddyfile; then
    echo "Domain already configured for another Caddy route. Manual reconciliation required; preserving it."
  else
    CADDY_BACKUP="/etc/caddy/Caddyfile.nxc-backup-$(date +%s)"
    cp -a /etc/caddy/Caddyfile "${CADDY_BACKUP}"
    cat >> /etc/caddy/Caddyfile <<EOF

${DOMAIN} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:18731
}
EOF
    if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy; then
      echo "Added independent NexControl HTTPS route without replacing any existing site."
    else
      echo "Could not safely activate Caddy route: restoring original configuration." >&2
      cp -a "${CADDY_BACKUP}" /etc/caddy/Caddyfile
      systemctl reload caddy || true
    fi
  fi
elif [[ -n "$(ss -H -ltn '( sport = :80 or sport = :443 )')" ]]; then
  echo "Ports 80/443 are in use. Existing web servers preserved; automatic proxy setup skipped."
else
  echo "Installing isolated HTTPS reverse proxy (Caddy)."
  if ! command -v caddy >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    echo "Installing Caddy with bounded APT timeouts (will not hang indefinitely)."
    if command -v timeout >/dev/null; then
      if ! (timeout 150 apt-get update -qq && timeout 150 apt-get install -y -qq caddy); then
        echo "WARNING: timed-out or failed Caddy installation; gateway remains available locally." >&2
      fi
    elif ! (apt-get update -qq && apt-get install -y -qq caddy); then
      echo "WARNING: Caddy unavailable; gateway remains available locally." >&2
    fi
  fi
  if command -v caddy >/dev/null; then
    install -d -m 0755 /etc/caddy
    if [[ -f /etc/caddy/Caddyfile ]]; then
      echo "Caddy configuration installed by package; preserving backup."
      cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.nxc-backup-$(date +%s)"
    fi
    cat >/etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:18731
}
EOF
    if caddy validate --config /etc/caddy/Caddyfile >/dev/null; then
      systemctl enable --now caddy
      systemctl reload caddy || systemctl restart caddy
    else
      echo "Caddy configuration failed validation; no agent changes."
    fi
  fi
fi

if curl --connect-timeout 5 --max-time 20 --retry 2 --retry-delay 3 \
  -fsS "https://${DOMAIN}/healthz" >"${TMPDIR}/public_health.json"; then
  if python3 - "${TMPDIR}/public_health.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('ok') is True and d.get('service')=='nexcontrol-vps'
PY
  then
    PUBLIC_READY=1
    echo "PASS: public HTTPS is live at https://${DOMAIN}/"
  fi
fi

if [[ "${PUBLIC_READY}" == 1 ]]; then
  # Preserve original NexControl authentication; do NOT regenerate keys or copy them to git.
  MAIN_PID="$(systemctl show -p MainPID --value nexcontrol-agent.service 2>/dev/null || true)"
  if [[ "${MAIN_PID}" =~ ^[0-9]+$ && "${MAIN_PID}" -gt 1 ]]; then
    if python3 - "${MAIN_PID}" "${CONFIG}" <<'PY'
import json,os,sys
from pathlib import Path
pid,config=sys.argv[1:]
env=Path('/proc/'+pid+'/environ').read_bytes().split(b'\0')
vars={}
for item in env:
    if b'=' not in item: continue
    k,v=item.split(b'=',1)
    if k in (b'NEXCONTROL_AGENT_KEY',b'NEXCONTROL_FLEET_KEY'):
        vars[k.decode()]=v.decode('utf-8','replace')
key=vars.get('NEXCONTROL_AGENT_KEY') or vars.get('NEXCONTROL_FLEET_KEY') or ''
if len(key)<16: raise SystemExit(4)
path=Path(config); c=json.loads(path.read_text());c['agent_key']=key
temp=path.with_suffix('.tmp');temp.write_text(json.dumps(c));os.chmod(temp,0o600);os.replace(temp,path)
PY
    then
      # Existing EnvironmentFile entries override [Service] Environment=.
      # Patch only URL keys; leave all other credentials untouched.
      python3 - "${DOMAIN}" <<'PY'
import subprocess,re,sys,shlex,time
from pathlib import Path
domain=sys.argv[1]
p=subprocess.run(['systemctl','show','--value','-p','EnvironmentFiles','nexcontrol-agent.service'],capture_output=True,text=True)
for filename in re.findall(r'(/etc/[A-Za-z0-9_.\-/]+)',p.stdout):
    path=Path(filename)
    if not path.is_file(): continue
    s=path.read_text()
    keep=[line for line in s.splitlines() if not re.match(r'^(NEXCONTROL_URLS|NEXCONTROL_URL|NEXCONTROL_BASE_URL)=',line)]
    keep.append('NEXCONTROL_URLS='+shlex.quote('https://'+domain))
    backup=path.with_name(path.name+'.nxc-backup-'+str(int(time.time())))
    backup.write_bytes(path.read_bytes())
    path.write_text('\n'.join(keep)+'\n')
    path.chmod(0o600)
PY
      mkdir -p /etc/systemd/system/nexcontrol-agent.service.d
      cat > /etc/systemd/system/nexcontrol-agent.service.d/90-nxc-vps-local.conf <<EOF
[Service]
Environment="NEXCONTROL_URLS=https://${DOMAIN}"
EOF
      systemctl daemon-reload
      # Gateway loaded the initial generated key at startup. Reload the validated
      # existing key from config BEFORE restarting the agent that uses it.
      systemctl restart nxc-vps-gateway.service
      if ! curl -fsS --max-time 5 http://127.0.0.1:18731/healthz >/dev/null; then
        echo "Gateway key reload failed; NexControl agent was NOT restarted." >&2
        exit 1
      fi
      systemctl restart nexcontrol-agent.service
      echo "NexControl agent redirected to its own VPS backend; Telegram bots untouched."
    else
      echo "Could not read active NexControl agent key; preserving existing configuration."
    fi
  else
    echo "NexControl agent not running; existing agent service untouched."
  fi

  HOST_ENV=/etc/nexforge-host-agent.env
  if [[ -f "${HOST_ENV}" ]] && grep -q '^AGENT_ID=' "${HOST_ENV}" && grep -q '^AGENT_KEY=' "${HOST_ENV}"; then
    cp -a "${HOST_ENV}" "${HOST_ENV}.nxc-backup-$(date +%s)"
    python3 - "${HOST_ENV}" "${DOMAIN}" <<'PY'
from pathlib import Path
import sys,shlex
path=Path(sys.argv[1]);domain=sys.argv[2]
rows=[x for x in path.read_text().splitlines() if not x.startswith('SUPABASE_URL=')]
rows.append('SUPABASE_URL='+shlex.quote('https://'+domain))
path.write_text('\n'.join(rows)+'\n')
path.chmod(0o600)
PY
    systemctl restart nexforge-host-agent.service
    echo "Host agent redirected to local VPS RPC (no Supabase Edge)."
  else
    echo "Host agent not registered; existing configuration preserved."
  fi
else
  echo "HTTPS not verified. No existing agent redirected; bots and current services remain untouched."
  echo "Check DNS, port 80/443 firewall, or the existing Nginx/Caddy reverse proxy."
fi

echo
echo "=== Results ==="
echo "Private health: http://127.0.0.1:18731/healthz"
echo "Public NexControl: https://${DOMAIN}/nexcontrol/"
echo "Public NexAI Connect: https://${DOMAIN}/nexai/"
if [[ "${PUBLIC_READY}" == 1 ]]; then echo "PUBLIC_TLS=READY"; else echo "PUBLIC_TLS=NOT_READY"; fi
if [[ -n "${NEW_PASSWORD}" ]]; then
  echo "NEXCONTROL_ADMIN_PASSWORD=${NEW_PASSWORD}"
  echo "Save it privately; it will not be displayed again on future runs."
fi
echo "DONE. Only NexControl supervisory services may have been restarted."
