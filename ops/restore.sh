#!/usr/bin/env bash
# Bid Manager — restore one backup made by ops/backup.sh into an EMPTY database and an EMPTY storage directory.
# It never drops, truncates or overwrites anything: if the targets are not empty it stops.
#
#   BACKUP_PATH              required  one backup directory, e.g. /mnt/backup/bidmanager-20270507T040000Z
#   RESTORE_DATABASE_URL     required  target database (must exist and contain no tables)
#   RESTORE_STORAGE_DIR      required  target storage directory (absolute; missing or empty)
#   BACKUP_PASSPHRASE_FILE   required  file holding the backup passphrase
set -euo pipefail
umask 077

die() { echo "restore: $*" >&2; exit 1; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore: $*"; }

: "${BACKUP_PATH:?restore: BACKUP_PATH is required}"
: "${RESTORE_DATABASE_URL:?restore: RESTORE_DATABASE_URL is required}"
: "${RESTORE_STORAGE_DIR:?restore: RESTORE_STORAGE_DIR is required}"
: "${BACKUP_PASSPHRASE_FILE:?restore: BACKUP_PASSPHRASE_FILE is required}"

for tool in pg_restore psql gpg tar sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done
[[ -d "$BACKUP_PATH" ]] || die "BACKUP_PATH is not a directory: $BACKUP_PATH"
for f in db.dump.gpg storage.tar.gpg MANIFEST SHA256SUMS; do
  [[ -f "$BACKUP_PATH/$f" ]] || die "backup is incomplete: $f is missing"
done
[[ -f "$BACKUP_PASSPHRASE_FILE" && -s "$BACKUP_PASSPHRASE_FILE" ]] || die "BACKUP_PASSPHRASE_FILE is not a readable, non-empty file"
[[ "$RESTORE_STORAGE_DIR" = /* ]] || die "RESTORE_STORAGE_DIR must be an absolute path"

log "verifying checksums"
( cd "$BACKUP_PATH" && sha256sum --check --quiet --strict SHA256SUMS ) || die "checksum mismatch — the backup is damaged"

tables="$(psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --dbname="$RESTORE_DATABASE_URL" \
  --command="SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")" \
  || die "cannot connect to the target database"
[[ "$tables" = "0" ]] || die "the target database is not empty ($tables tables) — restore only into a fresh database"

if [[ -e "$RESTORE_STORAGE_DIR" ]]; then
  [[ -d "$RESTORE_STORAGE_DIR" ]] || die "RESTORE_STORAGE_DIR exists and is not a directory"
  [[ -z "$(ls -A "$RESTORE_STORAGE_DIR")" ]] || die "RESTORE_STORAGE_DIR is not empty — restore only into an empty directory"
fi
mkdir -p "$RESTORE_STORAGE_DIR"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
decrypt() { gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt "$1"; }

log "restoring database"
decrypt "$BACKUP_PATH/db.dump.gpg" | pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname="$RESTORE_DATABASE_URL"

log "restoring storage to $RESTORE_STORAGE_DIR"
decrypt "$BACKUP_PATH/storage.tar.gpg" | tar --extract --file=- --directory="$RESTORE_STORAGE_DIR" --no-same-owner --no-overwrite-dir

expected="$(sed -n 's/^storage_files=//p' "$BACKUP_PATH/MANIFEST")"
actual="$(find "$RESTORE_STORAGE_DIR" -type f | wc -l)"
[[ "$expected" = "$actual" ]] || die "storage file count differs from the manifest (expected $expected, restored $actual)"

log "done: database restored, $actual storage files restored"
