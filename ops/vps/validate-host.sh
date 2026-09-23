#!/usr/bin/env bash
set -Eeuo pipefail

fail=0
ok(){ printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
bad(){ printf '[FAIL] %s\n' "$*" >&2; fail=1; }

need_cmd(){
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd: $(command -v "$cmd")"; else bad "missing command: $cmd"; fi
}

for cmd in node npm python3 ffmpeg ffprobe git jq rsync age systemctl; do need_cmd "$cmd"; done

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if (( major >= 22 )); then ok "Node.js $(node -v)"; else bad "Node.js 22+ required; found $(node -v 2>/dev/null || echo unknown)"; fi
fi

for dir in   /opt/nex/current   /var/lib/nex/data   /var/lib/nex/sessions   /var/lib/nex/runtime   /var/lib/nex/downloads   /var/lib/nex/logs   /var/lib/nex/runtime/nexcontrol/control   /var/lib/nex/runtime/nexcontrol/restart-history   /etc/nex/env   /etc/nex/secrets   /etc/nex/restart-targets.d   /backups/nex
do
  if [[ -d "$dir" ]]; then ok "directory exists: $dir"; else bad "missing directory: $dir"; fi
done

if id -u nex >/dev/null 2>&1; then ok "runtime user nex exists"; else bad "runtime user nex missing"; fi

if id -u nex >/dev/null 2>&1; then
  if runuser -u nex -- test -w /backups/nex/nexcontrol-agent; then
    ok "NexControl Agent rollback directory writable by nex"
  else
    bad "/backups/nex/nexcontrol-agent is not writable by nex"
  fi
  if runuser -u nex -- test ! -w /backups/nex/staging; then
    ok "encrypted backup staging is not writable by nex"
  else
    bad "/backups/nex/staging should remain root-only"
  fi
fi

if [[ -d /etc/nex/env ]]; then
  while IFS= read -r -d '' f; do
    mode="$(stat -c '%a' "$f" 2>/dev/null || echo '?')"
    case "$mode" in
      600|640) ok "secret env permissions $mode: $f" ;;
      *) warn "review permissions $mode on $f (recommended 600 or 640)" ;;
    esac
  done < <(find /etc/nex/env -maxdepth 1 -type f -print0 2>/dev/null || true)
fi

for unit in   nexcontrol-agent.service   nex-resource-watchdog.service   nex-restart-dispatcher.service   nex-restart-dispatcher.path   'nexaccount@.service'   nex-backup.service   nex-backup.timer
do
  if systemctl cat "$unit" >/dev/null 2>&1; then ok "systemd unit installed: $unit"; else bad "systemd unit missing: $unit"; fi
done

if systemctl is-enabled nex-restart-dispatcher.path >/dev/null 2>&1; then
  ok "restart dispatcher path is enabled"
else
  warn "restart dispatcher path is not enabled yet"
fi

if [[ -s /etc/nex/secrets/backup-age-recipients.txt ]]; then
  ok "backup age recipient file is configured"
else
  warn "backup age recipient file not configured yet; off-host backup cannot run"
fi

if [[ -f /etc/nex/env/backup.env ]]; then
  if grep -qE '^NEX_BACKUP_TARGET=.+$' /etc/nex/env/backup.env; then
    ok "backup target is configured"
  else
    warn "NEX_BACKUP_TARGET is still empty"
  fi
fi

# Refuse obvious production secret files inside the Git checkout.
if [[ -d /opt/nex/current/.git ]]; then
  tracked_env="$(git -C /opt/nex/current ls-files 2>/dev/null | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$' || true)"
  if [[ -n "$tracked_env" ]]; then
    bad "tracked .env-like files detected in repository:\n$tracked_env"
  else
    ok "no tracked production .env files detected"
  fi
fi

# Basic capacity snapshot without imposing one VPS size as a hard rule.
mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
mem_mb=$((mem_kb/1024))
if (( mem_mb > 0 )); then
  ok "RAM detected: ${mem_mb} MiB"
  if (( mem_mb < 3500 )); then warn "less than ~3.5 GiB RAM; use conservative worker counts"; fi
fi

disk_line="$(df -Pk /var/lib/nex 2>/dev/null | awk 'NR==2{print $2" "$4" "$5}' || true)"
if [[ -n "$disk_line" ]]; then ok "disk /var/lib/nex (1K blocks total/free/use%): $disk_line"; fi

# Provider-specific paths should not be required by the VPS baseline.
if [[ -d /opt/nex/current ]]; then
  hits="$(grep -RIl --exclude-dir=.git --exclude-dir=node_modules --exclude='*.b64' --exclude='*.gz' --exclude='*.xz' -E '/home/container|RENDER_EXTERNAL_HOSTNAME' /opt/nex/current 2>/dev/null | head -50 || true)"
  if [[ -n "$hits" ]]; then
    warn "provider-specific references still present (audit before final cutover):\n$hits"
  else
    ok "no obvious /home/container or RENDER_EXTERNAL_HOSTNAME references in text source"
  fi
fi

if (( fail )); then
  echo "VPS readiness: FAILED" >&2
  exit 1
fi

echo "VPS readiness: BASE HOST CHECKS PASSED"
