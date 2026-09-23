#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "pre-cutover.sh must run as root" >&2
  exit 1
fi

repo_root="${1:-/opt/nex/current}"
fail=0
warn=0

ok(){ printf '[OK] %s\n' "$*"; }
bad(){ printf '[FAIL] %s\n' "$*" >&2; fail=1; }
note(){ printf '[WARN] %s\n' "$*" >&2; warn=$((warn+1)); }

env_has_value(){
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '
    $1==k {
      v=substr($0,index($0,"=")+1)
      gsub(/^[[:space:]]+|[[:space:]]+$/,"",v)
      if(v!="") found=1
    }
    END { exit found?0:1 }
  ' "$file"
}

echo "== Nexus VPS pre-cutover gate =="
echo "Repository: $repo_root"

if [[ ! -d "$repo_root/.git" ]]; then
  bad "Git checkout missing at $repo_root"
else
  sha="$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || true)"
  branch_name="$(git -C "$repo_root" branch --show-current 2>/dev/null || true)"
  ok "Git checkout present: ${branch_name:-detached}@${sha:0:12}"
  if [[ -n "$(git -C "$repo_root" status --porcelain 2>/dev/null || true)" ]]; then
    note "repository has local changes; do not perform a release cutover until reviewed"
  else
    ok "repository working tree is clean"
  fi
fi

if [[ -f "$repo_root/ops/vps/validate-host.sh" ]]; then
  if bash "$repo_root/ops/vps/validate-host.sh"; then
    ok "host validator passed"
  else
    bad "host validator failed"
  fi
else
  bad "validate-host.sh missing"
fi

if [[ -f "$repo_root/ops/vps/audit-repository.mjs" ]]; then
  if node "$repo_root/ops/vps/audit-repository.mjs" "$repo_root"; then
    ok "repository migration audit has no hard failures"
  else
    bad "repository migration audit has hard failures"
  fi
else
  bad "repository migration auditor missing"
fi

if [[ -d "$repo_root/nexaccount/node_modules" ]]; then
  if (cd "$repo_root/nexaccount" && npm ls --omit=dev --depth=0 >/dev/null 2>&1); then
    ok "NexAccount production dependencies are installed from a coherent tree"
  else
    bad "NexAccount dependency tree is incomplete/inconsistent; rerun prepare-runtime.sh"
  fi
else
  bad "NexAccount node_modules missing; run prepare-runtime.sh before cutover"
fi

agent_env=/etc/nex/env/nexcontrol-agent.env
nex_env=/etc/nex/env/nexaccount.env
shared_env=/etc/nex/env/shared.env

if env_has_value "$agent_env" NEXCONTROL_AGENT_KEY || env_has_value "$agent_env" NEXCONTROL_FLEET_KEY; then
  ok "NexControl Agent authentication key configured"
else
  bad "NexControl Agent key is empty"
fi

agent_autostart="$(awk -F= '$1=="NEXCONTROL_AGENT_AUTOSTART_NEXACCOUNT"{gsub(/[[:space:]]/,"",$2);print tolower($2)}' "$agent_env" 2>/dev/null | tail -1)"
case "$agent_autostart" in
  0|false|no|off) ok "Agent NexAccount autostart is disabled; systemd owns worker lifecycle" ;;
  *) bad "NEXCONTROL_AGENT_AUTOSTART_NEXACCOUNT must be false on the VPS" ;;
esac

for key in NEXACCOUNT_TELEGRAM_API_ID NEXACCOUNT_TELEGRAM_API_HASH NEXACCOUNT_SESSION_KEY; do
  if env_has_value "$nex_env" "$key"; then ok "$key configured"; else bad "$key is empty"; fi
done

if env_has_value "$shared_env" NEXUS_MONGODB_URI || env_has_value "$nex_env" NEXUS_MONGODB_URI; then
  ok "NexAccount MongoDB URI configured"
else
  bad "NEXUS_MONGODB_URI is empty in shared/NexAccount environment"
fi

worker_count="$(awk -F= '$1=="NEXACCOUNT_WORKER_COUNT"{gsub(/[[:space:]]/,"",$2);print $2}' "$nex_env" 2>/dev/null | tail -1)"
worker_count="${worker_count:-1}"
if [[ "$worker_count" =~ ^[0-9]+$ ]] && (( worker_count >= 1 && worker_count <= 256 )); then
  ok "planned NexAccount worker count: $worker_count"
else
  bad "invalid NEXACCOUNT_WORKER_COUNT: $worker_count"
fi

if systemctl is-active --quiet nex-restart-dispatcher.path; then
  ok "restart dispatcher path is active"
else
  bad "restart dispatcher path is not active"
fi

if systemctl is-active --quiet nexcontrol-agent.service; then
  ok "NexControl Agent service is active"
else
  note "NexControl Agent is not active yet"
fi

active_workers="$(systemctl list-units --type=service --state=active --no-legend 'nexaccount@*.service' 2>/dev/null | awk '{print $1}' | paste -sd, -)"
if [[ -n "$active_workers" ]]; then
  note "NexAccount workers are already active on this host: $active_workers"
else
  ok "no NexAccount worker has been started yet"
fi

control_url=""
if [[ -f /etc/nex/nexcontrol-agent.json ]]; then
  if jq empty /etc/nex/nexcontrol-agent.json >/dev/null 2>&1; then
    ok "NexControl Agent JSON config is valid"
    control_url="$(jq -r '.controlUrls[0] // .controlUrl // empty' /etc/nex/nexcontrol-agent.json)"
    if [[ -n "$control_url" ]]; then
      ok "NexControl control-plane URL configured"
    else
      bad "NexControl control-plane URL missing from Agent config"
    fi
  else
    bad "NexControl Agent JSON config is invalid"
  fi
else
  bad "/etc/nex/nexcontrol-agent.json missing"
fi

# Connectivity probes intentionally do not use or print credentials.
probe_urls=(https://api.telegram.org)
[[ -n "$control_url" ]] && probe_urls+=("$control_url")
for url in "${probe_urls[@]}"; do
  if curl -sS --connect-timeout 5 --max-time 10 -o /dev/null "$url"; then
    ok "outbound HTTPS reachable: $url"
  else
    bad "outbound HTTPS failed: $url"
  fi
done

echo
echo "Pre-cutover summary: hard_failures=$fail warnings=$warn"
if (( fail )); then
  echo "PRE-CUTOVER: NOT READY" >&2
  exit 1
fi

echo "PRE-CUTOVER: BASELINE READY"
echo "This script does not authorize starting session-bearing workloads while the same sessions are active on the old host."
