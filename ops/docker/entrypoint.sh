#!/bin/sh
# Container entrypoint: apply pending migrations (idempotent, advisory-locked), then start the server.
#   RUN_MIGRATIONS=0          skip (run them yourself: docker compose run --rm app node server/dist/db/migrate.js)
#   MIGRATION_DATABASE_URL    connection of the schema OWNER (two-role setup); default: DATABASE_URL
#   APP_DATABASE_ROLE         application role that receives its restricted grants after migrating
set -eu
if [ "${RUN_MIGRATIONS:-1}" != "0" ] && [ "${1:-}" = "node" ] && [ "${2:-}" = "server/dist/index.js" ]; then
  node server/dist/db/migrate.js
fi
exec "$@"
