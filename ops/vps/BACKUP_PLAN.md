# Nexus VPS backup plan

A backup stored only on the same VPS is not a recovery copy. The prepared backup flow therefore encrypts sensitive runtime/configuration data first and then copies the encrypted artifact to a separately configured target.

## Included in the host backup

The encrypted host archive contains:

- `/etc/nex` — service environment/configuration and secret material;
- `/var/lib/nex/data` — file-backed persistent service state;
- `/var/lib/nex/sessions` — file-backed Telegram/scanner sessions;
- `/var/lib/nex/runtime/nexaccount` — pairing key/runtime state, excluding transient PID/log files;
- a small backup manifest containing timestamp, hostname and deployed Git commit.

The Git checkout itself is not the primary backup source because versioned code should be recoverable from GitHub.

Downloads, caches, transcode scratch space and ordinary logs are intentionally excluded.

## Encryption

`backup-runtime.sh` streams the tar archive directly into `age`. No unencrypted tarball containing `/etc/nex` should be written to disk.

Put public age recipients in:

```text
/etc/nex/secrets/backup-age-recipients.txt
```

Keep the matching **private age identity outside the VPS**. If the VPS is fully compromised, an attacker should not automatically obtain both the encrypted backups and the decryption key.

## Off-host target

Configure `/etc/nex/env/backup.env`.

`NEX_BACKUP_TARGET` may be:

- a separately mounted backup volume/path; or
- an rsync-over-SSH destination such as `backup-user@backup-host:/srv/nex-backups`.

The script refuses to run when the target is blank, so a local-only file cannot be mistaken for an off-host recovery backup.

## Database boundary

This host archive does **not** replace MongoDB/Redis backups.

MongoDB currently remains external during the first VPS migration. Its provider snapshot/backup policy must be verified separately. Redis should be treated according to whether a given dataset is disposable queue/cache state or persistent business state.

## Scheduling

The repository contains `nex-backup.service` and `nex-backup.timer`.

The installer copies the units but does not enable the timer automatically. Enable it only after:

1. an age recipient is configured;
2. the off-host destination is reachable;
3. one manual backup completes;
4. that backup is decrypted and inspected from a different machine/environment.

Then:

```sh
sudo systemctl start nex-backup.service
sudo journalctl -u nex-backup.service -n 100 --no-pager
sudo systemctl enable --now nex-backup.timer
```

For important configuration/deployment changes, run `nex-backup.service` explicitly after the change in addition to the daily timer.

## Restore test

A backup is not considered valid merely because upload succeeded. Periodically:

1. copy one `.tar.gz.age` file and its `.sha256` to a separate recovery environment;
2. verify the SHA-256 checksum;
3. decrypt it using the offline age private identity;
4. list/extract the archive into an empty temporary directory;
5. confirm `etc/nex`, session files and required runtime key material exist;
6. never overwrite a live VPS during a restore test.

