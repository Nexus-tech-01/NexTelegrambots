#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "restart-dispatcher.sh must run as root" >&2
  exit 1
fi

hook="${NEX_RESTART_HOOK:-/var/lib/nex/runtime/nexcontrol/control/restart.json}"
map_dir="${NEX_RESTART_MAP_DIR:-/etc/nex/restart-targets.d}"
history_dir="${NEX_RESTART_HISTORY_DIR:-/var/lib/nex/runtime/nexcontrol/restart-history}"

[[ -f "$hook" ]] || exit 0
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required" >&2; exit 1; }

target="$(jq -r '.target // "all"' "$hook" 2>/dev/null || true)"
reason="$(jq -r '.reason // "NexControl"' "$hook" 2>/dev/null || true)"
nonce="$(jq -r '.nonce // ""' "$hook" 2>/dev/null || true)"

if [[ ! "$target" =~ ^[A-Za-z0-9._@-]{1,80}$ ]]; then
  echo "Invalid restart target" >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$history_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
safe_nonce="$(printf '%s' "$nonce" | tr -cd 'A-Za-z0-9._-' | cut -c1-48)"
processed="$history_dir/$stamp-${safe_nonce:-request}.json"

# Move the hook before touching services so the .path unit cannot replay the same
# request if one restart operation takes a while.
mv "$hook" "$processed"
chmod 0600 "$processed"

declare -a units=()

add_unit(){
  local unit="$1"
  [[ -n "$unit" ]] || return 0
  if [[ ! "$unit" =~ ^nex[A-Za-z0-9@_.-]*\.service$ ]]; then
    echo "Ignoring invalid mapped systemd unit: $unit" >&2
    return 0
  fi
  units+=("$unit")
}

add_active_nexaccount(){
  while IFS= read -r unit; do
    [[ -n "$unit" ]] && add_unit "$unit"
  done < <(
    systemctl list-units --type=service --state=active --no-legend 'nexaccount@*.service' 2>/dev/null       | awk '{print $1}'
  )
}

add_map_file(){
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    local line
    line="$(printf '%s' "$raw" | sed 's/[[:space:]]*#.*$//' | xargs)"
    [[ -n "$line" ]] || continue
    add_unit "$line"
  done < "$file"
}

case "$target" in
  all)
    add_active_nexaccount
    add_map_file "$map_dir/all.list"
    ;;
  nexaccount|nexaccount-workers)
    add_active_nexaccount
    ;;
  nexcontrol-agent)
    add_unit "nexcontrol-agent.service"
    ;;
  resource-watchdog|nex-resource-watchdog)
    add_unit "nex-resource-watchdog.service"
    ;;
  *)
    add_map_file "$map_dir/$target.list"
    ;;
esac

if (( ${#units[@]} == 0 )); then
  echo "No active/mapped units for NexControl restart target '$target'; request archived at $processed"
  exit 0
fi

# Remove duplicates without changing the first-seen order.
declare -A seen=()
declare -a unique=()
for unit in "${units[@]}"; do
  [[ -n "${seen[$unit]:-}" ]] && continue
  seen[$unit]=1
  unique+=("$unit")
done

echo "NexControl restart target='$target' units='${unique[*]}' reason='$(printf '%s' "$reason" | tr '\n\r' '  ' | cut -c1-240)'"

failed=0
for unit in "${unique[@]}"; do
  if ! systemctl try-restart "$unit"; then
    echo "Failed to restart $unit" >&2
    failed=1
  fi
done

# Bound local request history.
find "$history_dir" -maxdepth 1 -type f -name '*.json' -mtime +14 -delete 2>/dev/null || true

exit "$failed"
