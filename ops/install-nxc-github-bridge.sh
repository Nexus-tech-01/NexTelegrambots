#!/usr/bin/env bash
# One-time NexControl private GitHub outbound bridge install on VPS.
# Vercel, Supabase, Nginx and Telegram/WhatsApp services remain unchanged.
set -Eeuo pipefail
umask 077

[[ $(id -u) == 0 ]] || { echo "Run as root (sudo bash)." >&2; exit 2; }
for bin in curl python3 systemctl install; do
  command -v "$bin" >/dev/null || { echo "Missing: $bin" >&2; exit 2; }
done
REPO='Tresor562/Nexus-lab'
REV='9c845e25078f3c673a6f891e56a7fe77e495cfcb'
SOURCE="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/$REV/ops/nxc-github-bridge.py"
APP='/opt/nxc-github-bridge'
ETC='/etc/nxc-github-bridge'
STATE='/var/lib/nxc-github-bridge'
TOKEN_PATH="$ETC/github-token"
CONFIG_PATH="$ETC/config.json"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; unset TOKEN NXC_BOOTSTRAP_TOKEN NXC_GITHUB_TOKEN' EXIT
echo '[NexControl] Installing outbound private-GitHub bridge (no public VPS port).'

install -d -m 0700 "$APP" "$ETC" "$STATE"
if [[ -s "$TOKEN_PATH" ]]; then
  TOKEN=$(cat "$TOKEN_PATH")
  echo '[NexControl] Reusing existing locally protected GitHub credentials.'
elif [[ -v NXC_GITHUB_TOKEN ]] && [[ -n "$NXC_GITHUB_TOKEN" ]]; then
  TOKEN="$NXC_GITHUB_TOKEN"
else
  TOKEN=''
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    TOKEN=$(gh auth token 2>/dev/null || true)
  fi
  if [[ -z "$TOKEN" ]]; then
    echo
    echo 'ONE-TIME GITHUB AUTHORISATION'
    echo '1. Open https://github.com/settings/personal-access-tokens/new'
    echo '2. Resource owner: Tresor562'
    echo '3. Select only the PRIVATE Nexus-lab repository'
    echo '4. Repository permissions: Issues=Read and write, Metadata=Read'
    echo '5. Paste your fine-grained token here, NOT in ChatGPT.'
    echo
    if [[ ! -t 0 ]]; then
      echo 'Interactive VPS terminal required for secret entry.' >&2; exit 2
    fi
    read -r -s -p 'GitHub token (input hidden): ' TOKEN
    printf '\n'
  fi
fi
[[ $(printf %s "$TOKEN" | wc -c) -ge 25 ]] || { echo 'No valid token.' >&2; exit 2; }
export NXC_BOOTSTRAP_TOKEN="$TOKEN"
python3 - <<'PY'
import json,os,urllib.request,urllib.error
token=os.environ["NXC_BOOTSTRAP_TOKEN"]
base="https://api.github.com"
headers={"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json",
"User-Agent":"NexControlPrivateInstall/1","X-GitHub-Api-Version":"2022-11-28"}
def get(path):
    with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers),timeout=20) as r:
        return json.load(r)
try:
    repo=get("/repos/Tresor562/Nexus-lab")
    user=get("/users/Tresor562")
    get("/repos/Tresor562/Nexus-lab/issues?per_page=1")
except (urllib.error.URLError,urllib.error.HTTPError):
    raise SystemExit("Could not verify GitHub private issue access. No key installed.")
if repo.get("private") is not True or repo.get("full_name")!="Tresor562/Nexus-lab":
    raise SystemExit("The control repository must be private.")
if user.get("login")!="Tresor562" or user.get("id")!=232972883:
    raise SystemExit("Pinned GitHub author identity mismatch.")
print("[NexControl] PRIVATE_REPOSITORY=VERIFIED")
PY
unset NXC_BOOTSTRAP_TOKEN
curl -fLsS --retry 3 --connect-timeout 15 --max-time 80 "$SOURCE" -o "$TMP/bridge.py"
python3 -m py_compile "$TMP/bridge.py"
if [[ -s "$APP/bridge.py" ]]; then
  cp -a "$APP/bridge.py" "$APP/bridge.py.backup-$(date -u +%Y%m%d%H%M%S)"
fi
install -m 0700 "$TMP/bridge.py" "$APP/bridge.py"
printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
chmod 0600 "$TOKEN_PATH"
unset TOKEN NXC_GITHUB_TOKEN

if [[ ! -s "$CONFIG_PATH" ]]; then
  python3 - "$CONFIG_PATH" <<'PY'
import json,os,sys,time
from pathlib import Path
p=Path(sys.argv[1])
p.write_text(json.dumps({"repo":"Tresor562/Nexus-lab","trusted_author_id":232972883,
                          "installed_at":int(time.time())},indent=2)+"\n")
os.chmod(p,0o600)
PY
fi
python3 -m json.tool "$CONFIG_PATH" >/dev/null

cat > /etc/systemd/system/nxc-github-bridge.service <<'UNIT'
[Unit]
Description=NexControl private GitHub outbound VPS bridge
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
Group=root
UMask=0077
WorkingDirectory=/opt/nxc-github-bridge
ExecStart=/usr/bin/python3 -u /opt/nxc-github-bridge/bridge.py
Restart=always
RestartSec=7
NoNewPrivileges=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nxc-github-bridge.service
systemctl restart nxc-github-bridge.service
sleep 3
if systemctl is-active --quiet nxc-github-bridge.service; then
  echo '[NexControl] BRIDGE_SERVICE=ACTIVE'
else
  echo '[NexControl] BRIDGE_SERVICE=NOT_READY'
  systemctl show nxc-github-bridge.service --no-pager -p ActiveState -p SubState -p Result -p ExecMainStatus || true
  exit 1
fi
echo '[NexControl] No inbound port, Vercel, Supabase, Nginx or bot restarts.'
echo '[NexControl] Access: ChatGPT GitHub connector -> PRIVATE Nexus-lab issue -> VPS.'
echo '[NexControl] Next step: ask ChatGPT to send a NexControl ping issue.'
echo '[NexControl] Emergency disable: systemctl disable --now nxc-github-bridge'
