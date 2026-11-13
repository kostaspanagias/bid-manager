#!/bin/sh
# Writes .env for a LOCAL trial with docker-compose.local.yml (random secrets, Mailpit as SMTP). macOS / Linux.
# Run from the repository root:  sh ops/local/setup.sh
set -eu
if [ -e .env ]; then
  echo ".env already exists - not overwritten. Delete it first to start over." >&2
  exit 1
fi
hex() { openssl rand -hex "$1"; }
ADMIN_PASSWORD=$(hex 10)
umask 077
cat > .env <<ENV
APP_DOMAIN=localhost
APP_URL=https://localhost:8443
DB_OWNER_USER=bidmanager_owner
DB_OWNER_PASSWORD=$(hex 24)
DB_APP_USER=bidmanager_app
DB_APP_PASSWORD=$(hex 24)
FILE_ENCRYPTION_KEY=$(hex 32)
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Bid Manager <no-reply@localhost>
SESSION_IDLE_MINUTES=30
LOG_LEVEL=info
RUN_MIGRATIONS=1
SEED_ORG_NAME=Active Computer Systems
SEED_ADMIN_EMAIL=admin@example.gr
SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD
ENV
echo "Wrote $(pwd)/.env"
echo "Admin login:  admin@example.gr  /  $ADMIN_PASSWORD"
