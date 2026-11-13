import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface MigrateOptions {
  dir?: string;
  log?: (message: string) => void;
}

/**
 * Applies migrations/NNN_name.sql in filename order, each inside its own transaction, and records them in
 * schema_migrations. Safe to call repeatedly and concurrently (advisory lock). Returns the names applied now.
 */
export async function migrate(connectionString: string, options: MigrateOptions = {}): Promise<string[]> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

/**
 * Two-role setup (hardening, review M7): migrations run as the OWNER of the schema, the application connects as a
 * second role that can read and write data but can neither change the schema nor rewrite history — on audit_log it
 * gets INSERT and SELECT only, so even a compromised application process cannot erase its traces (the append-only
 * trigger stays as the first line of defence). Idempotent; run after every migration (new tables need grants).
 */
export async function grantAppRole(connectionString: string, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Invalid role name "${role}"`);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rows.length === 0) throw new Error(`Role "${role}" does not exist — create it first (see ops/README.md)`);
    await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${role}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

// CLI: npm run migrate -w server
//   MIGRATION_DATABASE_URL  connection of the schema owner (default: DATABASE_URL — single-role setup)
//   APP_DATABASE_ROLE       when set, the application role that gets its (restricted) grants after migrating
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('../config.js');
  try {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL?.trim() || config.databaseUrl;
    const applied = await migrate(ownerUrl, { log: (m) => console.log(m) });
    console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Database is up to date.');
    const appRole = process.env.APP_DATABASE_ROLE?.trim();
    if (appRole) {
      await grantAppRole(ownerUrl, appRole);
      console.log(`Grants for application role "${appRole}" are in place (audit_log: INSERT + SELECT only).`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
