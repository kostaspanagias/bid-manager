#!/bin/sh
# Runs once, when the postgres volume is first created (docker-entrypoint-initdb.d).
# POSTGRES_USER owns the schema and runs migrations; this creates the role the APPLICATION connects with.
# Its table grants are applied by the migration step (APP_DATABASE_ROLE) — on audit_log: INSERT and SELECT only.
set -eu
: "${APP_DB_USER:?APP_DB_USER is required}" "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SQL
