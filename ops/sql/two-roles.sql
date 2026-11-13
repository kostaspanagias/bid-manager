-- Two-role setup without Docker (review M7). Run once as a PostgreSQL superuser:
--   psql -v owner_password='…' -v app_password='…' -f ops/sql/two-roles.sql
-- Then:  MIGRATION_DATABASE_URL=postgres://bidmanager_owner:…@host/bidmanager \
--        APP_DATABASE_ROLE=bidmanager_app npm run migrate:prod -w server        (repeat after every upgrade)
-- and run the application with DATABASE_URL=postgres://bidmanager_app:…@host/bidmanager.
--
-- bidmanager_owner  owns the schema and runs migrations. Never used by the running application.
-- bidmanager_app    what the application connects with: SELECT/INSERT/UPDATE/DELETE on the data tables, but on
--                   audit_log only INSERT and SELECT, and no DDL — so the append-only audit log holds even if the
--                   application itself is compromised (the trigger alone could be dropped by a table owner).
CREATE ROLE bidmanager_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE bidmanager_app   LOGIN PASSWORD :'app_password'   NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE bidmanager OWNER bidmanager_owner ENCODING 'UTF8';
REVOKE ALL ON DATABASE bidmanager FROM PUBLIC;
GRANT CONNECT ON DATABASE bidmanager TO bidmanager_app;
-- The table grants themselves are applied by the migration step (server/src/db/migrate.ts → grantAppRole):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bidmanager_app;
--   REVOKE UPDATE, DELETE ON audit_log FROM bidmanager_app;
--   REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM bidmanager_app;
