#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "test-restart-bridge.sh must run as root" >&2
  exit 1
fi

hook=/var/lib/nex/runtime/nexcontrol/control/restart.json
history=/var/lib/nex/runtime/nexcontrol/restart-history

if ! systemctl is-active --quiet nex-restart-dispatcher.path; then
  echo "nex-restart-dispatcher.path is not active" >&2
  exit 1
fi
if [[ -e "$hook" ]]; then
  echo "A real restart request is already pending; refusing self-test." >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$history"
nonce="selftest-$(date +%s)-$$"
target="migration-selftest-$$"
tmp="$hook.$nonce.tmp"

cat > "$tmp" <<EOF
{
  "target": "$target",
  "reason": "VPS restart bridge self-test; unmapped target must restart nothing",
  "requestedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nonce": "$nonce"
}
EOF
chmod 0600 "$tmp"
mv "$tmp" "$hook"

for _ in $(seq 1 30); do
  if [[ ! -e "$hook" ]] && find "$history" -maxdepth 1 -type f -name "*$nonce.json" -print -quit | grep -q .; then
    echo "Restart bridge self-test passed: request was consumed and archived without a mapped workload."
    exit 0
  fi
  sleep 0.5
done

echo "Restart bridge self-test failed; request was not consumed/archived in time." >&2
rm -f "$tmp" "$hook"
exit 1
