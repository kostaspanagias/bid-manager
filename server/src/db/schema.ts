import type { Pool } from 'pg';

export type ColumnKind = 'uuid' | 'jsonb' | 'array' | 'other';
export type TableSchema = Map<string, ColumnKind>;
export type DbSchema = Map<string, TableSchema>;

const cache = new WeakMap<Pool, Promise<DbSchema>>();

/** Identifier allowlist: every table/column of the live schema (read once per pool). */
export function loadSchema(pool: Pool): Promise<DbSchema> {
  let promise = cache.get(pool);
  if (!promise) {
    promise = read(pool);
    cache.set(pool, promise);
    promise.catch(() => cache.delete(pool));
  }
  return promise;
}

/** Forget the cached schema (after applying a migration to a pool that is already in use). */
export function resetSchemaCache(pool: Pool): void {
  cache.delete(pool);
}

async function read(pool: Pool): Promise<DbSchema> {
  const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string; udt_name: string }>(
    `SELECT table_name, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'`,
  );
  const schema: DbSchema = new Map();
  for (const r of rows) {
    let table = schema.get(r.table_name);
    if (!table) schema.set(r.table_name, (table = new Map()));
    const kind: ColumnKind =
      r.data_type === 'ARRAY' ? 'array' : r.udt_name === 'uuid' ? 'uuid' : r.udt_name === 'jsonb' || r.udt_name === 'json' ? 'jsonb' : 'other';
    table.set(r.column_name, kind);
  }
  if (schema.size === 0) throw new Error('Database schema is empty — run migrations first (npm run migrate -w server).');
  return schema;
}
