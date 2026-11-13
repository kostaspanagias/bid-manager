#!/usr/bin/env bash
# Bid Manager — restore test (spec: "δοκιμή επαναφοράς ανά τρίμηνο").
# Restores the newest backup (or $BACKUP_PATH) into a scratch database and a temporary directory, checks that the
# database and the storage agree, prints a short report, then drops the scratch database and the directory.
# Exit code 0 = the backup can be restored.
#
#   BACKUP_DIR               required unless BACKUP_PATH is set
#   BACKUP_PATH              optional  a specific backup directory
#   RESTORE_TEST_ADMIN_URL   required  connection used to CREATE/DROP the scratch database (role needs CREATEDB);
#                                      the database named in it is only connected to, never changed
#   BACKUP_PASSPHRASE_FILE   required
#   RESTORE_TEST_KEEP=1      optional  keep the scratch database and directory for manual inspection
set -euo pipefail
umask 077

die() { echo "restore-test: $*" >&2; exit 1; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore-test: $*"; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${RESTORE_TEST_ADMIN_URL:?restore-test: RESTORE_TEST_ADMIN_URL is required}"
: "${BACKUP_PASSPHRASE_FILE:?restore-test: BACKUP_PASSPHRASE_FILE is required}"

if [[ -z "${BACKUP_PATH:-}" ]]; then
  : "${BACKUP_DIR:?restore-test: BACKUP_DIR or BACKUP_PATH is required}"
  BACKUP_PATH="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'bidmanager-*' | sort | tail -n 1)"
  [[ -n "$BACKUP_PATH" ]] || die "no backups found in $BACKUP_DIR"
fi
log "testing $BACKUP_PATH"

scratch_db="bidmanager_restoretest_$(date -u +%Y%m%d%H%M%S)_$$"
scratch_dir="$(mktemp -d)"
# Same server and credentials as the admin URL, scratch database name.
scratch_url="$(printf '%s' "$RESTORE_TEST_ADMIN_URL" | sed -E "s#^([a-z]+://[^/]+)/[^?]*#\1/$scratch_db#")"
[[ "$scratch_url" == *"/$scratch_db"* ]] || die "RESTORE_TEST_ADMIN_URL must look like postgres://user@host:port/dbname"

admin() { psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --dbname="$RESTORE_TEST_ADMIN_URL" --command="$1"; }
q() { psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --dbname="$scratch_url" --command="$1"; }

cleanup() {
  if [[ "${RESTORE_TEST_KEEP:-0}" = "1" ]]; then
    log "kept for inspection: database $scratch_db, directory $scratch_dir"
    return
  fi
  admin "DROP DATABASE IF EXISTS \"$scratch_db\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$scratch_dir"
}
trap cleanup EXIT

admin "CREATE DATABASE \"$scratch_db\""
BACKUP_PATH="$BACKUP_PATH" RESTORE_DATABASE_URL="$scratch_url" RESTORE_STORAGE_DIR="$scratch_dir/storage" \
  BACKUP_PASSPHRASE_FILE="$BACKUP_PASSPHRASE_FILE" "$here/restore.sh"

failures=0
check() { if [[ "$2" = "$3" ]]; then log "ok    $1 ($2)"; else log "FAIL  $1: expected $3, got $2"; failures=$((failures + 1)); fi; }

# 1. The schema is there and the audit log is still protected.
check "core tables present" "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('organization','user','tender','file','company_document','audit_log')")" "6"
check "audit_log append-only trigger" "$(q "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND tgname LIKE 'audit_log_no_%'")" "2"

# 2. Every live file row has its blob, with the right size (AES-GCM ciphertext is exactly as long as the plaintext).
live="$(q "SELECT count(*) FROM file WHERE enc IS NOT NULL")"
missing=0; wrong=0
while IFS='|' read -r key size; do
  [[ -n "$key" ]] || continue
  blob="$scratch_dir/storage/$key"
  if [[ ! -f "$blob" ]]; then missing=$((missing + 1)); log "missing blob: $key"
  elif [[ "$(stat -c '%s' "$blob")" != "$size" ]]; then wrong=$((wrong + 1)); log "wrong size: $key"; fi
done < <(q "SELECT storage_key, size FROM file WHERE enc IS NOT NULL ORDER BY storage_key")
check "file rows without a blob" "$missing" "0"
check "blobs with a wrong size" "$wrong" "0"
# 3. No blob without a row (would mean the dump and the archive are from different moments, or deletes leak).
on_disk="$(find "$scratch_dir/storage" -type f | wc -l)"
if (( on_disk > live )); then log "note  $((on_disk - live)) blob(s) have no live file row (uploads/deletes during the backup, or awaiting the retention sweep)"; fi

log "rows: organizations=$(q 'SELECT count(*) FROM organization') users=$(q 'SELECT count(*) FROM "user"') tenders=$(q 'SELECT count(*) FROM tender') files=$live audit=$(q 'SELECT count(*) FROM audit_log')"
log "newest audit entry: $(q "SELECT coalesce(max(at)::text, 'none') FROM audit_log")"

if (( failures > 0 )); then die "$failures check(s) failed — this backup is NOT restorable as is"; fi
log "PASSED — record the date, the backup name and who ran the test"
