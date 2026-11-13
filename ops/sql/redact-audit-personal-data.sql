-- One-off maintenance (review M2): audit_log rows written BEFORE the redaction was introduced still hold names and
-- e-mail addresses of users and invited people in their before/after JSON. New rows no longer do (db/scoped.ts).
--
-- The application cannot and must not do this: audit_log is append-only (trigger + missing privileges). Run it ONCE,
-- by hand, as the OWNER of the schema, in a maintenance window, and record in the operations log who ran it and when:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/sql/redact-audit-personal-data.sql
-- It changes values only inside before/after of entities `user` and `invitation`; ids, actions, actors and
-- timestamps stay as they are. Everything happens in one transaction; the trigger is back on before it commits.
BEGIN;
LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE;
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete;

CREATE FUNCTION pg_temp.redact(doc jsonb, keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN doc IS NULL OR jsonb_typeof(doc) <> 'object' THEN doc ELSE (
    SELECT COALESCE(jsonb_object_agg(k, CASE WHEN k = ANY(keys) AND v <> 'null'::jsonb THEN '"[redacted]"'::jsonb ELSE v END), '{}'::jsonb)
      FROM jsonb_each(doc) AS e(k, v)) END
$$;

UPDATE audit_log
   SET before = pg_temp.redact(before, ARRAY['name', 'email', 'ip', 'user_agent', 'to_email']),
       after  = pg_temp.redact(after,  ARRAY['name', 'email', 'ip', 'user_agent', 'to_email'])
 WHERE entity = 'user';
UPDATE audit_log
   SET before = pg_temp.redact(before, ARRAY['email', 'ip', 'user_agent', 'to_email']),
       after  = pg_temp.redact(after,  ARRAY['email', 'ip', 'user_agent', 'to_email'])
 WHERE entity = 'invitation';

ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete;
INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
SELECT id, NULL, 'audit_log', NULL, 'personal_data_redacted', jsonb_build_object('script', 'ops/sql/redact-audit-personal-data.sql')
  FROM organization;
COMMIT;
