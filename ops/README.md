# Bid Manager — operations: backups, database roles, maintenance

Covers the spec's non-functional row **Backups**: a daily dump of the database and of the file storage, encrypted,
kept in a second location for 30 days, with a restore test every quarter.

| Script | What it does |
| --- | --- |
| `backup.sh` | `pg_dump` (custom format) + `tar` of the storage directory, each piped straight into `gpg` (AES-256, symmetric); writes `bidmanager-<UTC timestamp>/` with `SHA256SUMS` and a `MANIFEST`; then deletes backups older than the retention period |
| `restore.sh` | Verifies the checksums and restores one backup into an **empty** database and an **empty** directory. Never drops or overwrites anything |
| `restore-test.sh` | Restores the newest backup into a scratch database + temp directory, checks that every file row has its blob with the right size, prints a report, cleans up |

Requirements on the machine that runs them: `bash`, PostgreSQL client tools of the server's major version
(`pg_dump`, `pg_restore`, `psql`), `gpg` (2.1+), `tar`, `sha256sum`, `flock`.

## What is in a backup — and what is not

- `db.dump.gpg` — the whole database, including the append-only `audit_log`.
- `storage.tar.gpg` — the storage directory as it is on disk: `{org_id}/{tender_id|org}/{file_id}` blobs. They are
  already AES-256-GCM ciphertext (the application encrypts at rest); the backup adds its own layer on top.
- **Not included: `FILE_ENCRYPTION_KEY`.** Without it the restored files cannot be decrypted and every user has to
  re-enrol 2FA. Keep it in the company password manager / secrets vault, separately from the backups, and check
  during every restore test that the stored copy is the current one.
- **Not included: the backup passphrase.** Same place, separate entry.

Because of GDPR erasure and the retention job, a backup can contain personal data that was erased from the live
system afterwards. That is why backups are kept **30 days and not longer**: after 30 days an erasure is complete
everywhere. If a backup older than an erasure is ever restored for real, repeat the erasures recorded in the audit
log since then (`entity = 'gdpr'`, `action = 'erase_person'`).

## Configuration (environment only — nothing secret is in the repository)

| Variable | Used by | |
| --- | --- | --- |
| `DATABASE_URL` | backup | Database to dump. Leave the password out of the URL and use `~/.pgpass` (mode 600), so it never shows up in the process list |
| `FILE_STORAGE_DIR` | backup | The server's storage directory, absolute path |
| `BACKUP_DIR` | backup, restore-test | Destination. **Must be a second location**: another host or volume mounted here (NFS/SSHFS, a mounted S3-compatible bucket, an attached backup disk) — not the application's own disk |
| `BACKUP_PASSPHRASE_FILE` | all | File containing the passphrase; must be mode 600 or 400. Create once: `openssl rand -base64 48 > /etc/bidmanager/backup.pass && chmod 600 /etc/bidmanager/backup.pass` |
| `BACKUP_RETENTION_DAYS` | backup | Default `30` |
| `BACKUP_PATH` | restore, restore-test | One backup directory (`…/bidmanager-20270507T010000Z`) |
| `RESTORE_DATABASE_URL` | restore | Target database: must exist and be empty |
| `RESTORE_STORAGE_DIR` | restore | Target directory: must be missing or empty |
| `RESTORE_TEST_ADMIN_URL` | restore-test | Any database on a server where the role may `CREATE DATABASE` (preferably **not** the production server) |

Put them in a root-only file, e.g. `/etc/bidmanager/backup.env` (mode 600), not in the repository.

## Daily schedule

Cron of the application user (times are server time; 01:30 keeps it clear of the 07:00 jobs):

```cron
30 1 * * *  set -a; . /etc/bidmanager/backup.env; set +a; /opt/bidmanager/ops/backup.sh >> /var/log/bidmanager/backup.log 2>&1
```

- The script exits non-zero on any failure (`set -euo pipefail`); alert on a non-zero exit or on a missing
  `backup: done` line for the day. A failed run leaves no half-written `bidmanager-*` directory (it writes to
  `.incoming-*` and renames at the end) and never prunes old backups.
- Only one run at a time (`flock`).
- Consistency: the database dump is a single consistent snapshot; the storage archive is taken right after it.
  A file uploaded in between appears as a blob without a row (harmless); a file deleted in between appears as a row
  without a blob — `restore-test.sh` reports it. Running at night makes both unlikely.

## Restore (disaster recovery)

1. Install the application and PostgreSQL on the new machine; create an empty database.
2. Put `FILE_ENCRYPTION_KEY` (from the vault) into the server's `.env` — the same key as before.
3. Restore:

   ```bash
   export BACKUP_PATH=/mnt/backup/bidmanager-20270507T010000Z
   export RESTORE_DATABASE_URL=postgres://bidmanager@127.0.0.1:5432/bidmanager
   export RESTORE_STORAGE_DIR=/var/lib/bidmanager/storage
   export BACKUP_PASSPHRASE_FILE=/etc/bidmanager/backup.pass
   ops/restore.sh
   ```

4. `npm run migrate -w server` (applies migrations newer than the backup, if any), start the server, log in,
   download one file.

`restore.sh` refuses to run when the database has tables or the directory has files, so it cannot destroy a
working system by mistake. To roll a live system back, restore next to it and switch over.

## Restore test — every quarter

Who: the administrator of the installation. When: first week of January, April, July, October, and after every
PostgreSQL major upgrade or change of backup location.

1. Run, on a machine that is not the production database server if possible:

   ```bash
   set -a; . /etc/bidmanager/backup.env; set +a
   export RESTORE_TEST_ADMIN_URL=postgres://bidmanager@127.0.0.1:5432/postgres
   ops/restore-test.sh
   ```

   It restores the newest backup into `bidmanager_restoretest_<timestamp>` and a temp directory, and checks:
   the checksums; that the core tables and the audit-log protection triggers exist; that **every file row has its
   blob with exactly the recorded size**; it prints row counts and the time of the newest audit entry (compare it
   with the time of the backup: it should be at most a day older).
2. The last line must be `restore-test: PASSED`. Exit code 0.
3. Once a year, or after any change of `FILE_ENCRYPTION_KEY` handling, go one step further: run with
   `RESTORE_TEST_KEEP=1`, start a server against the scratch database and directory with the key **from the
   vault**, log in and download a file — this proves that the vault copy of the key is the right one. Then drop the
   scratch database and delete the directory.
4. Record in the operations log: date, backup name, result, who ran it, how long the restore took.
5. If it fails: treat it as an incident — the backups are not usable until it passes again.

## Verified

The scripts were run end to end on 13/11/2026 against a scratch database (PostgreSQL 16.15) with 7 encrypted
files: backup → `restore-test.sh` PASSED → manual `restore.sh` into a second scratch database, after which the
application's own storage code decrypted all 7 restored blobs to the sha256 recorded in the database. Also checked:
pruning removes only `bidmanager-*` directories older than the retention period; a second restore into the same
targets is refused; a wrong passphrase and a damaged archive stop the restore with a non-zero exit and leave the
target database empty; a passphrase file with loose permissions is refused.

## Database roles (recommended hardening)

The application works with a single database role, but production should use two:

| Role | Used by | Rights |
| --- | --- | --- |
| owner (e.g. `bidmanager_owner`) | migrations only (`MIGRATION_DATABASE_URL`) | owns the schema |
| application (e.g. `bidmanager_app`) | the running server (`DATABASE_URL`) | SELECT / INSERT / UPDATE / DELETE on the data tables; on **`audit_log` only INSERT and SELECT**; no DDL |

Why: the audit log is append-only through a trigger, and a trigger can be disabled or dropped by the table's owner.
With two roles the running application is not the owner, so even a compromised server process (or a leaked
`DATABASE_URL`) cannot rewrite or delete audit history, nor change the schema.

- **docker-compose.yml already does this**: `ops/docker/initdb-roles.sh` creates the application role when the
  database volume is first created, and every container start runs the migrations as the owner and then re-applies
  the grants (`APP_DATABASE_ROLE`).
- **Without Docker**: run `ops/sql/two-roles.sql` once as a PostgreSQL superuser, then migrate with
  `MIGRATION_DATABASE_URL=<owner url> APP_DATABASE_ROLE=bidmanager_app npm run migrate:prod -w server` (repeat after
  every upgrade — new tables need their grants) and start the server with `DATABASE_URL=<application url>`.
- Backups (`backup.sh`) and the restore test connect as the owner (or a superuser): `pg_dump` needs to read everything.
- Check after setting up: as the application role, `DELETE FROM audit_log` and `ALTER TABLE audit_log DISABLE TRIGGER ALL`
  must both fail with a permission error. (Verified on 13/11/2026 against PostgreSQL 16 with the production build:
  migrate + seed + login work as the application role; both statements are refused.)

## One-off maintenance: personal data in old audit rows

Since the integration release, names and e-mail addresses of users and invited people are no longer copied into
`audit_log` (the row keeps the id and which field changed; the value reads `[redacted]`), because an append-only log
could never honour a GDPR erasure. Rows written **before** that still contain them. On an installation that was in
use before this release run `ops/sql/redact-audit-personal-data.sql` once, as the schema owner — the file's header
explains exactly what it changes. A fresh installation does not need it.

## Daily jobs

The 07:00 (Europe/Athens) jobs — digest, retention — are recorded in `job_run` (one row per organization, job and
day). If the server was down or restarting at 07:00, or a run failed (e.g. SMTP outage), it is caught up automatically:
at start-up and every hour until 12:59 the runner retries what has no successful row for the day. A run that is still
`failed` after 13:00 needs a look at the server log and `email_log`.
