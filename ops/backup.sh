#!/usr/bin/env bash
# Bid Manager — daily encrypted backup of the database and the file storage (spec: non-functional row "Backups").
#
# Writes   $BACKUP_DIR/bidmanager-<UTC timestamp>/{db.dump.gpg, storage.tar.gpg, MANIFEST, SHA256SUMS}
# and then removes backups older than $BACKUP_RETENTION_DAYS (default 30).
#
# Configuration comes from the environment only — see ops/README.md. Nothing secret lives in the repository.
#   DATABASE_URL             required  connection string of the database to dump (prefer ~/.pgpass for the password)
#   FILE_STORAGE_DIR         required  the server's storage directory (absolute path)
#   BACKUP_DIR               required  destination — must be a SECOND location (other disk / host / mounted bucket)
#   BACKUP_PASSPHRASE_FILE   required  file holding the backup passphrase (mode 600, readable only by this user)
#   BACKUP_RETENTION_DAYS    optional  default 30
set -euo pipefail
umask 077

die() { echo "backup: $*" >&2; exit 1; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup: $*"; }

: "${DATABASE_URL:?backup: DATABASE_URL is required}"
: "${FILE_STORAGE_DIR:?backup: FILE_STORAGE_DIR is required}"
: "${BACKUP_DIR:?backup: BACKUP_DIR is required}"
: "${BACKUP_PASSPHRASE_FILE:?backup: BACKUP_PASSPHRASE_FILE is required}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

for tool in pg_dump gpg tar sha256sum flock find date; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS >= 1 )) || die "BACKUP_RETENTION_DAYS must be a positive integer"
[[ "$FILE_STORAGE_DIR" = /* ]] || die "FILE_STORAGE_DIR must be an absolute path"
[[ "$BACKUP_DIR" = /* ]] || die "BACKUP_DIR must be an absolute path"
[[ -d "$FILE_STORAGE_DIR" ]] || die "FILE_STORAGE_DIR does not exist: $FILE_STORAGE_DIR"
[[ -f "$BACKUP_PASSPHRASE_FILE" && -r "$BACKUP_PASSPHRASE_FILE" ]] || die "BACKUP_PASSPHRASE_FILE is not a readable file"
[[ -s "$BACKUP_PASSPHRASE_FILE" ]] || die "BACKUP_PASSPHRASE_FILE is empty"
perm="$(stat -c '%a' "$BACKUP_PASSPHRASE_FILE")"
[[ "$perm" = "600" || "$perm" = "400" ]] || die "BACKUP_PASSPHRASE_FILE must have mode 600 or 400 (is $perm)"

storage_real="$(realpath "$FILE_STORAGE_DIR")"
mkdir -p "$BACKUP_DIR"
backup_real="$(realpath "$BACKUP_DIR")"
case "$backup_real/" in "$storage_real"/*) die "BACKUP_DIR must not be inside FILE_STORAGE_DIR" ;; esac
case "$storage_real/" in "$backup_real"/*) die "FILE_STORAGE_DIR must not be inside BACKUP_DIR" ;; esac

# One backup at a time.
exec 9>"$backup_real/.backup.lock"
flock -n 9 || die "another backup is running"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$backup_real/bidmanager-$stamp"
work="$backup_real/.incoming-$stamp.$$"
[[ ! -e "$final" ]] || die "backup already exists: $final"

# gpg gets its own empty home so the user's keyring/agent is never involved.
GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
cleanup() { rm -rf "$GNUPGHOME" "$work"; }
trap cleanup EXIT

encrypt() { gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
                --symmetric --cipher-algo AES256 --compress-algo none --output "$1"; }

mkdir "$work"
log "dumping database"
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" | encrypt "$work/db.dump.gpg"

log "archiving storage ($storage_real)"
blob_count="$(find "$storage_real" -type f ! -name '*.part' | wc -l)"
tar --create --file=- --directory="$storage_real" --exclude='*.part' . | encrypt "$work/storage.tar.gpg"

{
  echo "created_at=$stamp"
  echo "format=1"
  echo "pg_dump=$(pg_dump --version)"
  echo "storage_files=$blob_count"
  echo "db_bytes=$(stat -c '%s' "$work/db.dump.gpg")"
  echo "storage_bytes=$(stat -c '%s' "$work/storage.tar.gpg")"
} > "$work/MANIFEST"
( cd "$work" && sha256sum db.dump.gpg storage.tar.gpg MANIFEST > SHA256SUMS )

mv "$work" "$final"
log "written $final (storage files: $blob_count)"

# Retention: only directories this script created (strict name pattern), only after a successful backup.
cutoff="$(date -u -d "$RETENTION_DAYS days ago" +%Y%m%d)"
removed=0
while IFS= read -r -d '' dir; do
  name="$(basename "$dir")"
  [[ "$name" =~ ^bidmanager-([0-9]{8})T[0-9]{6}Z$ ]] || continue
  if [[ "${BASH_REMATCH[1]}" < "$cutoff" ]]; then
    rm -rf -- "$dir"
    removed=$((removed + 1))
    log "removed expired backup $name"
  fi
done < <(find "$backup_real" -mindepth 1 -maxdepth 1 -type d -name 'bidmanager-*' -print0)
# Leftovers of crashed runs older than a day.
find "$backup_real" -mindepth 1 -maxdepth 1 -type d -name '.incoming-*' -mmin +1440 -exec rm -rf -- {} +

log "done (kept $RETENTION_DAYS days, removed $removed)"
