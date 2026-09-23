#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

runtime_root="${1:-/home/container}"
output_dir="${2:-/backups/nexus-source}"

if [[ ! -d "$runtime_root" ]]; then
  echo "Runtime root does not exist: $runtime_root" >&2
  exit 1
fi

for cmd in rsync tar sha256sum grep find; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

if [[ ! -d "$runtime_root/bots" ]]; then
  echo "No bots/ directory under $runtime_root" >&2
  exit 1
fi
if [[ ! -d "$runtime_root/scripts" ]]; then
  echo "No scripts/ directory under $runtime_root" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/source" "$output_dir"

copy_path(){
  local rel="$1"
  [[ -e "$runtime_root/$rel" ]] || return 0
  mkdir -p "$stage/source/$(dirname "$rel")"
  rsync -a     --exclude='.git/'     --exclude='.env'     --exclude='.env.*'     --exclude='node_modules/'     --exclude='.runtime/'     --exclude='.nexcontrol/'     --exclude='sessions/'     --exclude='session/'     --exclude='downloads/'     --exclude='download/'     --exclude='tmp/'     --exclude='cache/'     --exclude='*.session'     --exclude='*.session-journal'     --exclude='*.pem'     --exclude='*.key'     --exclude='*.p12'     --exclude='*.pfx'     "$runtime_root/$rel" "$stage/source/$(dirname "$rel")/"
}

copy_path bots
copy_path scripts

for rel in package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock tsconfig.json; do
  copy_path "$rel"
done

# Refuse to package obvious credential material. Only file names are printed,
# never matching secret values.
mapfile -t suspicious < <(
  grep -RIlE     --exclude-dir=node_modules     --exclude='*.map'     '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|mongodb\+srv://[^[:space:]]+:[^[:space:]@]+@|[0-9]{8,12}:[A-Za-z0-9_-]{30,})'     "$stage/source" 2>/dev/null || true
)
if (( ${#suspicious[@]} > 0 )); then
  echo "Refusing source export: possible embedded credentials found in:" >&2
  printf '  %s\n' "${suspicious[@]#"$stage/source/"}" >&2
  echo "Review/sanitize those files manually before retrying. Matching values were not printed." >&2
  exit 1
fi

(
  cd "$stage/source"
  find . -type f -print0 | sort -z | xargs -0 sha256sum > SOURCE_SHA256SUMS.txt
  {
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "source_runtime_root=$runtime_root"
    echo "bot_directories:"
    find bots -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' | sort
    echo "script_files:"
    find scripts -maxdepth 1 -type f -printf '  %f\n' | sort
  } > SOURCE_RECOVERY_MANIFEST.txt
)

archive="$output_dir/nexus-bot-source-$stamp.tar.gz"
tar -C "$stage/source" -czf "$archive" .
sha256sum "$archive" > "$archive.sha256"

echo "Sanitized source archive created:"
echo "  $archive"
echo "  $archive.sha256"
echo
echo "This archive still requires manual review and a clean build before Git import or VPS deployment."
