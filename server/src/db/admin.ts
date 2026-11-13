// Organization-level (cross-tenant) operations. They live in src/db/ because they are, by nature, not scoped to
// one org: bootstrap (seed, tests), the job runner iterating over organizations, and the health check.
// Request handlers must never use these — they get a ScopedDb from req.ctx.
import { closePool, getPool } from './pool.js';

export interface Organization {
  id: string;
  name: string;
  timezone: string;
  settings: Record<string, unknown>;
  retention_days: number | null;
  created_at: Date;
  updated_at: Date;
}

export async function createOrganization(data: { name: string; timezone?: string; settings?: Record<string, unknown>; retention_days?: number | null }): Promise<Organization> {
  const { rows } = await getPool().query(
    'INSERT INTO organization (name, timezone, settings, retention_days) VALUES ($1, $2, $3, $4) RETURNING *',
    [data.name, data.timezone ?? 'Europe/Athens', JSON.stringify(data.settings ?? {}), data.retention_days ?? null],
  );
  return rows[0] as Organization;
}

export async function listOrganizations(): Promise<Organization[]> {
  return (await getPool().query('SELECT * FROM organization ORDER BY created_at, id')).rows as Organization[];
}

/** Health check: true when the database answers. */
export async function pingDatabase(timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getPool().query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Housekeeping: drop expired sessions of every org. Returns how many were removed. */
export async function purgeExpiredSessions(): Promise<number> {
  // login throttles that have neither an active lock nor recent failures go with them (nightly housekeeping)
  await getPool().query("DELETE FROM login_throttle WHERE COALESCE(locked_until, updated_at) < now() - interval '1 day'");
  return (await getPool().query('DELETE FROM session WHERE expires_at < now()')).rowCount ?? 0;
}

/** Process shutdown / end of a test file: close the connection pool. */
export async function closeDatabase(): Promise<void> {
  await closePool();
}
