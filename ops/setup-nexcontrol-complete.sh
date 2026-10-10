#!/usr/bin/env bash
# VPS-first NexControl recovery + scoped access. Run ONCE as root on the VPS.
# Does not install ChatGPT tools, create ChatGPT sessions, or restart Telegram bots.
set -Eeuo pipefail
umask 077

[[ ${EUID} -eq 0 ]] || { echo "Run as root: sudo bash setup-nexcontrol-complete.sh" >&2; exit 2; }
for b in bash curl python3 systemctl nginx openssl; do
  # Nginx is optional. Check other commands below.
  if [[ "${b}" != "nginx" ]] && ! command -v "${b}" >/dev/null; then
    echo "Missing prerequisite: ${b}" >&2; exit 2
  fi
done

DOMAIN="${NXC_VPS_DOMAIN:-31-56-85-53.sslip.io}"
[[ "${DOMAIN}" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo "Invalid domain" >&2; exit 2; }
# Immutable source revisions: no unreviewed main-branch execution.
INSTALL_SHA="3a5af61ef9ead57578df4c777970b16d6deb76da"
GATEWAY_SHA="3d35b8196d5e9157c05e242b5ca626ec89c6b0c1"
BASE="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots"
TMP="$(mktemp -d)"
LOG_DIR="/var/log/nxc-vps"
install -d -m 0700 "${LOG_DIR}" /root/.config/nexcontrol
trap 'rm -rf "${TMP}"' EXIT
LOG="${LOG_DIR}/one-shot-$(date -u +%Y%m%d-%H%M%S).log"
touch "${LOG}"; chmod 0600 "${LOG}"

say(){ printf '%s\n' "[NexControl] $*"; }
check_https(){
  local response
  response="$(curl --silent --show-error --fail --connect-timeout 4 --max-time 10 "https://${DOMAIN}/healthz" 2>/dev/null || true)"
  [[ "${response}" == *'"service":"nexcontrol-vps"'* && "${response}" == *'"ok":true'* ]]
}
check_local(){
  curl --silent --show-error --fail --connect-timeout 3 --max-time 5 \
    'http://127.0.0.1:18731/healthz' | python3 -c 'import sys,json;x=json.load(sys.stdin);assert x.get("ok") and x.get("service")=="nexcontrol-vps"'
}

say "Recovering NexControl without touching Telegram/WhatsApp units."
# A prior successful installer already created the config/site. Re-running that
# installer during an outage can introduce unrelated failure modes, so skip it.
if [[ -s /etc/nxc-vps/config.json && -f /etc/systemd/system/nxc-vps-gateway.service && -s /opt/nxc-vps/site/app.js ]]; then
  say "Existing installation detected; updating supervisor in place."
else
  say "Base installation incomplete; attempting verified bootstrap."
  curl -fsSL --retry 3 --connect-timeout 12 --max-time 60 \
    "${BASE}/${INSTALL_SHA}/ops/install-nxc-vps-20261009.sh" -o "${TMP}/installer.sh"
  bash -n "${TMP}/installer.sh"
  # A failed base install must not prevent the independent supervisor recovery.
  # Its full output may include a generated admin password, so store privately.
  if ! NXC_VPS_DOMAIN="${DOMAIN}" bash "${TMP}/installer.sh" >"${LOG}" 2>&1; then
    say "Bootstrap was incomplete; continuing with isolated gateway recovery."
    say "Private bootstrap log: ${LOG}"
  fi
fi

# Use the verified gateway release even if the old installer exited early.
curl -fsSL --retry 3 --connect-timeout 12 --max-time 60 \
  "${BASE}/${GATEWAY_SHA}/ops/nxc-vps-gateway-20261009.py" -o "${TMP}/gateway.py"
python3 -m py_compile "${TMP}/gateway.py"
valid_config(){
  python3 - "${1}" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
c=json.loads(p.read_text())
assert all(c.get(k) for k in ("domain","salt","password_hash","agent_key"))
assert isinstance(c["agent_key"],str) and len(c["agent_key"])>=16
PY
}
CONFIG="/etc/nxc-vps/config.json"
if ! valid_config "${CONFIG}" 2>/dev/null; then
  say "Local NexControl config missing or invalid: checking protected recovery snapshots."
  RESTORED=0
  shopt -s nullglob
  snapshots=(/var/backups/nxc-vps/gateway-*.json)
  shopt -u nullglob
  for ((i=${#snapshots[@]}-1; i>=0; i--)); do
    candidate="${snapshots[$i]}"
    if valid_config "${candidate}" 2>/dev/null; then
      if [[ -e "${CONFIG}" ]]; then
        cp -a "${CONFIG}" "${TMP}/corrupt-config.json"
      fi
      install -d -m 0700 /etc/nxc-vps
      install -m 0600 "${candidate}" "${CONFIG}"
      say "Protected configuration restored from a prior local backup."
      RESTORED=1
      break
    fi
  done
  if [[ "${RESTORED}" != 1 ]]; then
    say "ERROR: No valid preserved NexControl credentials found."
    say "Refusing to reset authentication or generate new admin secrets silently."
    say "Existing bots untouched. Root-only log: ${LOG}"
    exit 1
  fi
fi
install -d -m 0700 /opt/nxc-vps /var/lib/nxc-vps
if [[ -f /opt/nxc-vps/gateway.py ]]; then
  cp -a /opt/nxc-vps/gateway.py "${TMP}/gateway-previous.py"
fi
install -m 0700 "${TMP}/gateway.py" /opt/nxc-vps/gateway.py

# Missing or failed service units are repaired without touching other units.
if ! systemctl cat nxc-vps-gateway.service >/dev/null 2>&1; then
  say "Installing missing dedicated NexControl systemd unit."
  cat >/etc/systemd/system/nxc-vps-gateway.service <<'UNIT'
[Unit]
Description=NexControl autonomous VPS control plane
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
Group=root
UMask=0077
WorkingDirectory=/opt/nxc-vps
ExecStart=/usr/bin/python3 /opt/nxc-vps/gateway.py
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
systemctl reset-failed nxc-vps-gateway.service 2>/dev/null || true
if ! systemctl restart nxc-vps-gateway.service; then
  say "Systemd refused to restart the gateway; checking health before rollback."
fi
HEALTHY=0
for attempt in 1 2 3 4 5 6; do
  if check_local > /dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
if [[ "${HEALTHY}" != 1 ]]; then
  say "ERROR: gateway did not become healthy after recovery."
  say "Supervisor state:"
  systemctl show nxc-vps-gateway.service --no-pager -p LoadState -p ActiveState -p SubState -p Result -p ExecMainStatus 2>/dev/null || true
  say "Port 18731 ownership:"
  if command -v ss >/dev/null; then ss -ltnp '( sport = :18731 )' || true; fi
  say "Existing bots unchanged; full service log remains local to the VPS."
  if [[ -f "${TMP}/gateway-previous.py" ]]; then
    cp -a "${TMP}/gateway-previous.py" /opt/nxc-vps/gateway.py
    systemctl restart nxc-vps-gateway.service 2>/dev/null || true
    say "Previous supervisor file restored."
  fi
  exit 1
fi
say "LOCAL_GATEWAY=READY at 127.0.0.1:18731."

# Reattach existing authenticated agents over loopback, but only when existing
# identity keys are available. Never issue new fleet credentials or restart bots.
if systemctl is-active --quiet nexcontrol-agent.service; then
  if python3 - <<'PY'
import json,os,subprocess,sys
from pathlib import Path
p=subprocess.run(["systemctl","show","-p","MainPID","--value","nexcontrol-agent.service"],
                 capture_output=True,text=True)
pid=p.stdout.strip()
assert pid.isdecimal() and int(pid)>1
raw=Path("/proc/"+pid+"/environ").read_bytes().split(b"\0")
vars={}
for item in raw:
    if b"=" in item:
        key,value=item.split(b"=",1)
        if key in (b"NEXCONTROL_AGENT_KEY",b"NEXCONTROL_FLEET_KEY"):
            vars[key.decode()]=value.decode()
secret=vars.get("NEXCONTROL_AGENT_KEY") or vars.get("NEXCONTROL_FLEET_KEY") or ""
assert len(secret)>=16
path=Path("/etc/nxc-vps/config.json")
cfg=json.loads(path.read_text())
if cfg.get("agent_key")!=secret:
    backup=path.with_name(path.name+".before-agent-"+str(os.getpid()))
    backup.write_bytes(path.read_bytes())
    os.chmod(backup,0o600)
    cfg["agent_key"]=secret
    tmp=path.with_suffix(".new")
    tmp.write_text(json.dumps(cfg))
    os.chmod(tmp,0o600)
    os.replace(tmp,path)
PY
  then
    install -d -m 0755 /etc/systemd/system/nexcontrol-agent.service.d
    cat > /etc/systemd/system/nexcontrol-agent.service.d/95-nxc-loopback.conf <<'UNIT'
[Service]
Environment="NEXCONTROL_URLS=http://127.0.0.1:18731"
UNIT
    systemctl daemon-reload
    systemctl restart nxc-vps-gateway.service
    if check_local >/dev/null 2>&1; then
      systemctl restart nexcontrol-agent.service || true
      say "Main NexControl agent redirected through VPS loopback."
    fi
  else
    say "Original NexControl agent identity unavailable; existing agent left unchanged."
  fi
fi
HOST_ENV="/etc/nexforge-host-agent.env"
if [[ -f "${HOST_ENV}" ]] && grep -q '^AGENT_ID=' "${HOST_ENV}" && grep -q '^AGENT_KEY=' "${HOST_ENV}"; then
  if systemctl is-active --quiet nexforge-host-agent.service; then
    cp -a "${HOST_ENV}" "${HOST_ENV}.nxc-previous-$(date +%s)"
    python3 - "${HOST_ENV}" <<'PY'
from pathlib import Path
import sys,shlex
path=Path(sys.argv[1])
lines=[line for line in path.read_text().splitlines() if not line.startswith("SUPABASE_URL=")]
lines.append("SUPABASE_URL="+shlex.quote("http://127.0.0.1:18731"))
path.write_text("\n".join(lines)+"\n")
path.chmod(0o600)
PY
    systemctl restart nexforge-host-agent.service || true
    say "NexForge host agent redirected to local VPS API."
  fi
fi

# Do not touch an HTTPS server that already serves our gateway correctly.
# Caddy routing is supported by the pinned base installer. This stage handles
# the commonly missing Nginx case in a dedicated virtual host with rollback.
if check_https; then
  say "PUBLIC_TLS=READY (already configured)"
elif command -v nginx >/dev/null && systemctl is-active --quiet nginx; then
  say "Detected Nginx. Attempting isolated HTTPS virtual host for ${DOMAIN}."
  NXC_CONF="/etc/nginx/conf.d/nxc-vps-${DOMAIN}.conf"
  ACME_ROOT="/var/www/nxc-vps-acme"
  CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  install -d -m 0755 "${ACME_ROOT}/.well-known/acme-challenge"
  if [[ -e "${NXC_CONF}" ]]; then
    cp -a "${NXC_CONF}" "${TMP}/nginx-previous.conf"
  fi
  # Do not shadow another application's pre-existing virtual host.
  # Avoid SIGPIPE in 'nginx -T | grep -q' under pipefail.
  nginx -T >"${TMP}/nginx-full.conf" 2>/dev/null || true
  if [[ ! -e "${NXC_CONF}" ]] && grep -Fq "server_name ${DOMAIN}" "${TMP}/nginx-full.conf"; then
    say "Existing Nginx virtual host owns this domain; preserving it."
  else
    nginx_http(){
      cat >"${NXC_CONF}" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};
  location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
  location / { return 404; }
}
EOF
    }
    restore_nginx(){
      if [[ -f "${TMP}/nginx-previous.conf" ]]; then
        cp -a "${TMP}/nginx-previous.conf" "${NXC_CONF}"
      else
        rm -f "${NXC_CONF}"
      fi
      nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    }
    # ACME HTTP-01 requires external port 80 and valid DNS. Never disrupt
    # existing Nginx config if a syntax check or reload fails.
    if [[ ! -s "${CERT}" || ! -s "${KEY}" ]]; then
      nginx_http
      if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then
        restore_nginx
        say "Nginx validation failed, existing sites restored."
      else
        if ! command -v certbot >/dev/null; then
          say "Installing certbot with a bounded timeout."
          export DEBIAN_FRONTEND=noninteractive
          if command -v timeout >/dev/null; then
            (timeout 150 apt-get update -qq && timeout 150 apt-get install -y -qq certbot) >>"${LOG}" 2>&1 || true
          else
            (apt-get update -qq && apt-get install -y -qq certbot) >>"${LOG}" 2>&1 || true
          fi
        fi
        if command -v certbot >/dev/null; then
          ACME_OPTIONS=(--non-interactive --agree-tos --keep-until-expiring)
          if [[ -n "${NXC_LE_EMAIL:-}" ]]; then
            ACME_OPTIONS+=(--email "${NXC_LE_EMAIL}")
          else
            ACME_OPTIONS+=(--register-unsafely-without-email)
          fi
          timeout 150 certbot certonly --webroot -w "${ACME_ROOT}" -d "${DOMAIN}" "${ACME_OPTIONS[@]}" >>"${LOG}" 2>&1 || true
        fi
      fi
    fi
    if [[ -s "${CERT}" && -s "${KEY}" ]]; then
      cat >"${NXC_CONF}" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};
  location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen 443 ssl;
  server_name ${DOMAIN};
  ssl_certificate ${CERT};
  ssl_certificate_key ${KEY};
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_tickets off;
  client_max_body_size 3m;
  location / {
    proxy_pass http://127.0.0.1:18731;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 65s;
  }
}
EOF
      if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
        say "Nginx HTTPS route applied without changing existing bot units."
      else
        restore_nginx
        say "HTTPS configuration rejected; previous Nginx sites restored."
      fi
    else
      restore_nginx
      say "TLS certificate unavailable. Nginx restored; DNS/port 80 may need attention."
    fi
  fi
else
  say "Existing reverse proxy is not Nginx or public TLS needs external configuration."
  say "No web server was replaced or stopped."
fi

# Provision separate observer and short-lived operator tokens. Both are generated
# locally, stored ROOT-ONLY, and NEVER printed or sent to GitHub/ChatGPT.
python3 - <<'PY'
import hashlib,os,secrets,sqlite3,time,uuid
from pathlib import Path
db=Path("/var/lib/nxc-vps/gateway.sqlite3")
assert db.is_file(),"No running NexControl SQLite store"
destination=Path("/root/.config/nexcontrol")
destination.mkdir(parents=True,exist_ok=True)
os.chmod(destination,0o700)
now=int(time.time())
c=sqlite3.connect(str(db),timeout=10)
with c:
    columns={row[1] for row in c.execute("PRAGMA table_info(assistant_keys)")}
    assert "role" in columns, "Gateway version does not support scoped tokens"
    for role,minutes in (("observer",360),("operator",30)):
        label="NXC-Bootstrap-"+role
        c.execute("UPDATE assistant_keys SET revoked=1 WHERE label=? AND revoked=0",(label,))
        key=secrets.token_urlsafe(48)
        c.execute("INSERT INTO assistant_keys(id,digest,label,role,created,expires) VALUES(?,?,?,?,?,?)",
            (str(uuid.uuid4()),hashlib.sha256(key.encode()).hexdigest(),label,role,now,now+minutes*60))
        p=destination/(role+".token")
        fd=os.open(str(p),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,"w") as f: f.write(key+"\n")
    c.execute("INSERT INTO audit(created,action,detail) VALUES(?,?,?)",
              (now,"bootstrap.access","observer 6h; operator 30m, two supervised units only"))
c.close()
PY

# Verify remote credentials against the LOCAL gateway without printing either.
python3 - <<'PY'
from pathlib import Path
import json,urllib.request
base="http://127.0.0.1:18731"
for role in ("observer","operator"):
    key=(Path("/root/.config/nexcontrol")/(role+".token")).read_text().strip()
    request=urllib.request.Request(base+"/api/nxc/assistant/status",headers={"Authorization":"Bearer "+key})
    with urllib.request.urlopen(request,timeout=10) as response:
        body=json.load(response)
        assert body.get("ok") and body.get("role")=="observer"
print("LOCAL_ASSISTANT_KEYS=VERIFIED")
PY

if check_https; then
  say "PUBLIC_TLS=READY"
  say "NexControl console: https://${DOMAIN}/nexcontrol/"
  say "NexAI Connect: https://${DOMAIN}/nexai/"
else
  say "PUBLIC_TLS=NOT_READY; localhost remains operational."
fi
say "Temporary keys saved ONLY on VPS: /root/.config/nexcontrol/{observer,operator}.token"
say "Read access lasts 6h; operator access lasts 30 min and can restart only two NexControl supervisors."
say "IMPORTANT: server setup does not automatically connect a ChatGPT plugin."
say "A separately authenticated ChatGPT-compatible integration must be connected in ChatGPT."
say "DONE: no Telegram, WhatsApp, or KnowMe bot services were restarted by this script."
