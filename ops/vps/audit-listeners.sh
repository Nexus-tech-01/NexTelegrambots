#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "audit-listeners.sh must run as root so listener PIDs can be inspected" >&2
  exit 1
fi

command -v ss >/dev/null 2>&1 || { echo "ss command missing (install iproute2)" >&2; exit 1; }

declare -A allowed_ports=()
while (( $# )); do
  case "$1" in
    --allow-port)
      [[ ${2:-} =~ ^[0-9]{1,5}$ ]] || { echo "Invalid --allow-port value" >&2; exit 2; }
      allowed_ports["$2"]=1
      shift 2
      ;;
    *)
      echo "Usage: audit-listeners.sh [--allow-port PORT]..." >&2
      exit 2
      ;;
  esac
done

fail=0
checked=0

is_public_addr(){
  local addr="$1"
  case "$addr" in
    127.*|::1|\[::1\]|localhost) return 1 ;;
    *) return 0 ;;
  esac
}

while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  local_field="$(awk '{print $4}' <<<"$line")"
  proc_field="$(sed -n 's/.*users:(\(.*\))$/\1/p' <<<"$line")"
  [[ -n "$local_field" ]] || continue

  # ss formats IPv6 as [addr]:port and IPv4 as addr:port.
  port="${local_field##*:}"
  addr="${local_field%:*}"
  addr="${addr#[}"
  addr="${addr%]}"

  [[ "$port" =~ ^[0-9]+$ ]] || continue
  is_public_addr "$addr" || continue

  mapfile -t pids < <(grep -oE 'pid=[0-9]+' <<<"$proc_field" | cut -d= -f2 | sort -u)
  (( ${#pids[@]} > 0 )) || continue

  for pid in "${pids[@]}"; do
    [[ -d "/proc/$pid" ]] || continue
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    cgroup="$(cat "/proc/$pid/cgroup" 2>/dev/null || true)"
    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"

    nexus=0
    [[ "$cwd" == /opt/nex/* || "$cwd" == /var/lib/nex/* ]] && nexus=1
    grep -qE '/nex[^/]*\.service(/|$)' <<<"$cgroup" && nexus=1 || true
    (( nexus )) || continue

    checked=$((checked+1))
    if [[ -n "${allowed_ports[$port]:-}" ]]; then
      echo "[OK] explicitly allowed public Nexus listener: addr=$addr port=$port pid=$pid comm=$comm cwd=$cwd"
    else
      echo "[FAIL] unexpected public Nexus listener: addr=$addr port=$port pid=$pid comm=$comm cwd=$cwd" >&2
      fail=1
    fi
  done
done < <(ss -H -lntp)

# NexAccount worker range is an additional hard guard even if PID ownership is
# hidden for some reason.
while IFS= read -r local_field; do
  [[ -n "$local_field" ]] || continue
  port="${local_field##*:}"
  addr="${local_field%:*}"
  addr="${addr#[}"
  addr="${addr%]}"
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  if (( port >= 3491 && port <= 3747 )) && is_public_addr "$addr"; then
    echo "[FAIL] NexAccount worker port $port is publicly bound at $addr" >&2
    fail=1
  fi
done < <(ss -H -lnt | awk '{print $4}')

echo "Nexus public-listener audit checked $checked Nexus-owned public socket(s)."
if (( fail )); then
  echo "LISTENER_AUDIT=FAIL" >&2
  exit 1
fi
echo "LISTENER_AUDIT=PASS"
