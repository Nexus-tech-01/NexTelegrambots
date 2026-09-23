#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

archive="${1:-}"
expected_sha_file="${2:-}"
repo_root="${3:-/opt/nex/current}"

if [[ -z "$archive" || ! -f "$archive" ]]; then
  echo "Usage: verify-recovered-archive.sh /path/source.tar.gz [/path/source.tar.gz.sha256] [/opt/nex/current]" >&2
  exit 2
fi

for cmd in tar sha256sum node awk grep mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd" >&2; exit 1; }
done

if [[ -n "$expected_sha_file" ]]; then
  [[ -f "$expected_sha_file" ]] || { echo "Checksum file missing: $expected_sha_file" >&2; exit 1; }
  expected="$(awk 'NF{print $1;exit}' "$expected_sha_file")"
  actual="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || {
    echo "Archive SHA-256 mismatch" >&2
    echo "expected=$expected" >&2
    echo "actual=$actual" >&2
    exit 1
  }
  echo "[OK] archive SHA-256 verified"
else
  echo "[WARN] no checksum file supplied; archive integrity is not anchored to the exporter output" >&2
fi

listing="$(mktemp)"
stage="$(mktemp -d)"
trap 'rm -rf "$listing" "$stage"' EXIT

tar -tzf "$archive" > "$listing"

# Reject archive entries that could escape the extraction root.
if awk '
  /^\// { bad=1 }
  {
    n=split($0,a,"/")
    for(i=1;i<=n;i++) if(a[i]=="..") bad=1
  }
  END{exit bad?0:1}
' "$listing"; then
  echo "Unsafe absolute/parent-traversal archive entry detected" >&2
  exit 1
fi

# Symlink/hardlink archives are rejected for source recovery. Source should be
# ordinary files/directories so review/import is deterministic.
if tar -tvzf "$archive" | awk '$1 ~ /^[lh]/ {found=1} END{exit found?0:1}'; then
  echo "Archive contains symlink/hardlink entries; refusing source recovery import" >&2
  exit 1
fi

tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"

inspector="$repo_root/ops/vps/inspect-recovered-source.mjs"
[[ -f "$inspector" ]] || { echo "Inspector missing: $inspector" >&2; exit 1; }
node "$inspector" "$stage"

echo
echo "Recovered source archive passed structural/security inspection."
echo "Temporary extraction was not imported into Git or deployed."
