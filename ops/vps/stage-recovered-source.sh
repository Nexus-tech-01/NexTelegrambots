#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "stage-recovered-source.sh must run as root" >&2
  exit 1
fi

archive="${1:-}"
checksum="${2:-}"
repo_root="${3:-/opt/nex/current}"
recovery_root="${4:-/var/lib/nex/recovery}"

if [[ -z "$archive" || ! -f "$archive" ]]; then
  echo "Usage: stage-recovered-source.sh /path/source.tar.gz [/path/source.tar.gz.sha256] [/opt/nex/current] [/var/lib/nex/recovery]" >&2
  exit 2
fi

for cmd in cp tar sha256sum node install mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd" >&2; exit 1; }
done

verify="$repo_root/ops/vps/verify-recovered-archive.sh"
inspector="$repo_root/ops/vps/inspect-recovered-source.mjs"
[[ -f "$verify" ]] || { echo "Verifier missing: $verify" >&2; exit 1; }
[[ -f "$inspector" ]] || { echo "Inspector missing: $inspector" >&2; exit 1; }

install -d -o root -g nex -m 0750 "$recovery_root"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
snapshot="$tmp/recovered-source.tar.gz"
cp --reflink=auto -- "$archive" "$snapshot"

snapshot_sha="$(sha256sum "$snapshot" | awk '{print $1}')"
checksum_snapshot=""
if [[ -n "$checksum" ]]; then
  [[ -f "$checksum" ]] || { echo "Checksum file missing: $checksum" >&2; exit 1; }
  checksum_snapshot="$tmp/recovered-source.tar.gz.sha256"
  printf '%s  %s\n' "$(awk 'NF{print $1;exit}' "$checksum")" "$(basename "$snapshot")" > "$checksum_snapshot"
fi

bash "$verify" "$snapshot" "$checksum_snapshot" "$repo_root"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$recovery_root/legacy-source-$stamp"
if [[ -e "$dest" ]]; then
  echo "Destination already exists: $dest" >&2
  exit 1
fi
install -d -o nex -g nex -m 0750 "$dest/source"

tar --no-same-owner --no-same-permissions -xzf "$snapshot" -C "$dest/source"
node "$inspector" "$dest/source"

cat > "$dest/STAGED_FROM.txt" <<EOF
staged_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
archive_sha256=$snapshot_sha
source_archive_name=$(basename "$archive")
verification=passed
git_import=not_performed
deployment=not_performed
EOF

chown -R nex:nex "$dest"
find "$dest" -type d -exec chmod u=rwx,g=rx,o= {} +
find "$dest" -type f -exec chmod u=rw,g=r,o= {} +
chmod 0600 "$dest/source/RECOVERY_INSPECTION.json" 2>/dev/null || true

echo
echo "Recovered source staged for review:"
echo "  $dest/source"
echo "Inspection report:"
echo "  $dest/source/RECOVERY_INSPECTION.json"
echo
echo "No Git import, service installation, session copy or deployment was performed."
