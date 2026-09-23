#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "backup-runtime.sh must run as root because /etc/nex contains protected configuration" >&2
  exit 1
fi

for cmd in tar age sha256sum rsync git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

recipient_file="${NEX_BACKUP_RECIPIENT_FILE:-/etc/nex/secrets/backup-age-recipients.txt}"
target="${NEX_BACKUP_TARGET:-}"
staging="${NEX_BACKUP_STAGING_DIR:-/backups/nex/staging}"
keep="${NEX_BACKUP_LOCAL_KEEP:-7}"

if [[ ! -s "$recipient_file" ]]; then
  echo "Missing age recipient file: $recipient_file" >&2
  echo "Store one or more public age recipients there; never store the private identity in the same backup tree." >&2
  exit 1
fi

if [[ -z "$target" ]]; then
  echo "NEX_BACKUP_TARGET is empty; refusing to create a backup that is only local to the VPS." >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$staging"
meta_dir="/var/lib/nex/runtime/backup-meta"
install -d -o root -g root -m 0700 "$meta_dir"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_sha="unknown"
if [[ -d /opt/nex/current/.git ]]; then
  release_sha="$(git -C /opt/nex/current rev-parse --verify HEAD 2>/dev/null || echo unknown)"
fi

cat > "$meta_dir/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname -f 2>/dev/null || hostname)",
  "releaseSha": "$release_sha",
  "scope": [
    "/etc/nex",
    "/var/lib/nex/data",
    "/var/lib/nex/sessions",
    "/var/lib/nex/runtime/nexaccount"
  ]
}
EOF

archive="$staging/nex-vps-$timestamp.tar.gz.age"
checksum="$archive.sha256"

includes=(etc/nex var/lib/nex/data var/lib/nex/sessions var/lib/nex/runtime/backup-meta)
if [[ -d /var/lib/nex/runtime/nexaccount ]]; then
  includes+=(var/lib/nex/runtime/nexaccount)
fi

cleanup(){
  rm -rf "$meta_dir"
}
trap cleanup EXIT

# Stream directly into age so an unencrypted archive containing secrets is never
# written to disk.
tar -C /   --numeric-owner   --acls   --xattrs   --exclude='var/lib/nex/runtime/nexaccount/*.pid'   --exclude='var/lib/nex/runtime/nexaccount/*.log'   -czf - "${includes[@]}"   | age -R "$recipient_file" -o "$archive"

sha256sum "$archive" > "$checksum"

copy_one(){
  local src="$1"
  if [[ "$target" == *:* ]]; then
    rsync -a --protect-args "$src" "$target/"
  else
    install -d -m 0700 "$target"
    rsync -a "$src" "$target/"
  fi
}

copy_one "$archive"
copy_one "$checksum"

if ! [[ "$keep" =~ ^[0-9]+$ ]]; then
  echo "NEX_BACKUP_LOCAL_KEEP must be an integer" >&2
  exit 1
fi

mapfile -t old < <(find "$staging" -maxdepth 1 -type f -name 'nex-vps-*.tar.gz.age' -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
for ((i=keep;i<${#old[@]};i++)); do
  rm -f "${old[$i]}" "${old[$i]}.sha256"
done

echo "Encrypted Nexus backup copied successfully: $(basename "$archive")"
echo "Target: $target"
