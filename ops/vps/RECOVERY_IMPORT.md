# Legacy source archive verification and normalization gate

When the old host becomes accessible, first create a sanitized archive with `export-bot-source.sh`. Do **not** copy the whole live container into Git.

Then verify that exact archive before any import:

```sh
sudo bash /opt/nex/current/ops/vps/verify-recovered-archive.sh \
  /backups/nexus-source/nexus-bot-source-YYYYMMDDTHHMMSSZ.tar.gz \
  /backups/nexus-source/nexus-bot-source-YYYYMMDDTHHMMSSZ.tar.gz.sha256
```

The verifier:

- validates the exporter SHA-256 when supplied;
- rejects absolute and parent-traversal archive paths;
- rejects symlink/hardlink entries;
- extracts only into an isolated temporary directory;
- requires the expected five legacy bot source families;
- checks package manifests and common entrypoint candidates;
- checks for the shared scripts directory;
- rejects secret/runtime filenames;
- scans text source for obvious private keys, credential-bearing MongoDB URIs, Telegram bot tokens and bearer-token material;
- creates a per-file SHA-256 inspection manifest;
- **does not** import, deploy, start or stop anything.

## Why there is no automatic Git import yet

The actual live runtime structure is still unknown. The old bundle evidence already showed at least one historical directory name (`nexcanal-manager`) different from the expected canonical path.

Automatically renaming directories before seeing the recovered source could break:

- relative imports;
- orchestration path assumptions;
- package workspace references;
- persisted state paths;
- bot-specific environment lookup.

So the next stage after a PASS is:

1. preserve the recovered tree exactly;
2. inspect its manifest and entrypoints;
3. build a canonical path map;
4. normalize imports/configuration;
5. run a clean install/build/test;
6. only then commit ordinary source directories on a dedicated recovery branch.

No Base64 source rebundling is allowed in the normalized result.


## Persistent review staging

After the archive passes the isolated verifier, stage a copy for review without importing it into Git:

```sh
sudo bash /opt/nex/current/ops/vps/stage-recovered-source.sh \
  /backups/nexus-source/nexus-bot-source-YYYYMMDDTHHMMSSZ.tar.gz \
  /backups/nexus-source/nexus-bot-source-YYYYMMDDTHHMMSSZ.tar.gz.sha256
```

The script first snapshots the archive, verifies that exact snapshot, and only then extracts the same bytes under:

```text
/var/lib/nex/recovery/legacy-source-<UTC timestamp>/source
```

This avoids verifying one archive and then accidentally extracting different bytes if the original file changes between steps. The staged tree remains review-only and is owned by the `nex` runtime group; it is not wired into systemd or the active release.
