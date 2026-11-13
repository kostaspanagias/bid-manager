import pg from 'pg';
import { config } from '../config.js';

// The ONLY module that creates a pg pool. Nothing outside src/db/ and src/core/authStore.ts may import it
// (enforced by src/test/poolImports.test.ts) — everything else goes through scopedDb().

// Pure dates travel as 'YYYY-MM-DD' strings, never JS Date (ARCHITECTURE.md, "Data conventions").
pg.types.setTypeParser(1082, (v: string) => v);
// numeric(14,2) amounts and bigint counts/sizes as JS numbers (well inside the safe range for this app).
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
    // An idle client erroring (e.g. server restart) must not crash the process.
    pool.on('error', () => undefined);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export type { Pool, PoolClient } from 'pg';
