import type { Pool, PoolClient } from 'pg';
import { getPool } from './pool.js';
import { loadSchema, type ColumnKind, type DbSchema, type TableSchema } from './schema.js';

// The scoped data layer (tenant-ready rule). Every statement it builds is bound to one organization:
// rows of another org are invisible to and untouchable by every method. See ARCHITECTURE.md.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
/** column → value. `null` → IS NULL, array → `= ANY(...)`. `undefined` is rejected (it would silently drop a filter). */
export type Where = Record<string, unknown>;
export interface ListOptions {
  /** e.g. `'due_date desc nulls last, sort'` — columns are validated against the schema. */
  orderBy?: string;
  limit?: number;
  offset?: number;
}
export interface AuditData {
  before?: unknown;
  after?: unknown;
  tenderId?: string | null;
}

export interface ScopedDb {
  readonly orgId: string;
  readonly userId: string | null;
  list<T = Row>(table: string, where?: Where, opts?: ListOptions): Promise<T[]>;
  get<T = Row>(table: string, id: string): Promise<T | null>;
  findOne<T = Row>(table: string, where: Where): Promise<T | null>;
  count(table: string, where?: Where): Promise<number>;
  /** Sets org_id and created_by. Writes an audit_log row. */
  insert<T = Row>(table: string, data: Row): Promise<T>;
  insertMany<T = Row>(table: string, rows: Row[]): Promise<T[]>;
  /** Sets updated_at. Returns null when the row does not exist in this org. Writes an audit_log row. */
  update<T = Row>(table: string, id: string, patch: Row): Promise<T | null>;
  remove(table: string, id: string): Promise<boolean>;
  /**
   * Raw SQL with named params (`:name`). The text MUST reference `:org_id` (bound automatically) or this throws.
   * Arrays are passed as Postgres arrays (use `= ANY(:ids)`), plain objects as JSON. Not audited: call `audit()`
   * yourself when a raw statement changes data.
   */
  sql<T = Row>(text: string, params?: Record<string, unknown>): Promise<T[]>;
  /** Runs fn in a transaction (nested calls become savepoints). The callback's db must be used inside. */
  tx<R>(fn: (db: ScopedDb) => Promise<R>): Promise<R>;
  /** Explicit audit_log entry for things the automatic audit cannot express (e.g. a gate decision with exception). */
  audit(entity: string, entityId: string | null, action: string, data?: AuditData): Promise<void>;
}

/** Tables whose writes are not audited automatically. */
export const NO_AUDIT_TABLES: ReadonlySet<string> = new Set(['audit_log', 'session', 'job_run', 'email_log']);
/** Columns never written to audit_log in clear. */
export const REDACTED_COLUMNS: ReadonlySet<string> = new Set(['password_hash', 'totp_secret', 'token_hash']);
export const REDACTED = '[redacted]';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_PARAMS = 60_000;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function scopedDb(orgId: string, userId: string | null = null): ScopedDb {
  if (!isUuid(orgId)) throw new Error('scopedDb: orgId must be a uuid');
  if (userId !== null && !isUuid(userId)) throw new Error('scopedDb: userId must be a uuid or null');
  return new Scoped(orgId, userId, getPool(), null, 0);
}

type Runner = Pick<Pool | PoolClient, 'query'>;

class Scoped implements ScopedDb {
  constructor(
    readonly orgId: string,
    readonly userId: string | null,
    private readonly pool: Pool,
    private readonly client: PoolClient | null,
    private readonly depth: number,
  ) {}

  private get runner(): Runner {
    return this.client ?? this.pool;
  }

  private schema(): Promise<DbSchema> {
    return loadSchema(this.pool);
  }

  private async table(name: string): Promise<TableSchema> {
    const schema = await this.schema();
    const cols = typeof name === 'string' ? schema.get(name) : undefined;
    if (!cols) throw new Error(`scopedDb: unknown table "${String(name)}"`);
    if (!cols.has('org_id') && name !== 'organization') throw new Error(`scopedDb: table "${name}" has no org_id`);
    return cols;
  }

  /** `org_id = $1` (or `id = $1` for the organization table itself). */
  private scope(table: string): string {
    return table === 'organization' ? '"id" = $1' : '"org_id" = $1';
  }

  private conditions(table: string, cols: TableSchema, where: Where | undefined, values: unknown[]): string {
    const parts = [this.scope(table)];
    for (const [col, value] of Object.entries(where ?? {})) {
      const kind = column(table, cols, col);
      if (value === undefined) throw new Error(`scopedDb: where.${col} is undefined (use null for IS NULL)`);
      if (col === 'org_id') {
        if (value !== this.orgId) parts.push('FALSE');
        continue;
      }
      if (value === null) {
        parts.push(`"${col}" IS NULL`);
      } else if (Array.isArray(value) && kind !== 'array' && kind !== 'jsonb') {
        const items = kind === 'uuid' ? value.filter(isUuid) : value;
        values.push(items);
        parts.push(`"${col}" = ANY($${values.length})`);
      } else if (kind === 'uuid' && !isUuid(value)) {
        parts.push('FALSE'); // a malformed id matches nothing (→ 404), instead of a 500 from Postgres
      } else {
        values.push(encode(kind, value));
        parts.push(`"${col}" = $${values.length}`);
      }
    }
    return parts.join(' AND ');
  }

  async list<T = Row>(table: string, where?: Where, opts: ListOptions = {}): Promise<T[]> {
    const cols = await this.table(table);
    const values: unknown[] = [this.orgId];
    let text = `SELECT * FROM "${table}" WHERE ${this.conditions(table, cols, where, values)}`;
    const order = opts.orderBy ? orderBy(table, cols, opts.orderBy) : cols.has('created_at') ? '"created_at", "id"' : '';
    if (order) text += ` ORDER BY ${order}`;
    if (opts.limit !== undefined) {
      values.push(nonNegativeInt('limit', opts.limit));
      text += ` LIMIT $${values.length}`;
    }
    if (opts.offset !== undefined) {
      values.push(nonNegativeInt('offset', opts.offset));
      text += ` OFFSET $${values.length}`;
    }
    return (await this.runner.query(text, values)).rows as T[];
  }

  async get<T = Row>(table: string, id: string): Promise<T | null> {
    return this.findOne<T>(table, { id });
  }

  async findOne<T = Row>(table: string, where: Where): Promise<T | null> {
    const rows = await this.list<T>(table, where, { limit: 1 });
    return rows[0] ?? null;
  }

  async count(table: string, where?: Where): Promise<number> {
    const cols = await this.table(table);
    const values: unknown[] = [this.orgId];
    const text = `SELECT count(*)::int AS n FROM "${table}" WHERE ${this.conditions(table, cols, where, values)}`;
    return (await this.runner.query(text, values)).rows[0].n as number;
  }

  async insert<T = Row>(table: string, data: Row): Promise<T> {
    const rows = await this.insertMany<T>(table, [data]);
    return rows[0] as T;
  }

  async insertMany<T = Row>(table: string, rows: Row[]): Promise<T[]> {
    if (!Array.isArray(rows)) throw new Error('scopedDb.insertMany: rows must be an array');
    if (rows.length === 0) return [];
    const cols = await this.table(table);
    if (table === 'organization') throw new Error('scopedDb: organizations are not created through the scoped layer');

    const prepared = rows.map((row) => {
      const out: Row = {};
      for (const [col, value] of Object.entries(row)) {
        const kind = column(table, cols, col);
        if (value === undefined) continue;
        if (col === 'org_id') {
          if (value !== this.orgId) throw new Error('scopedDb: org_id cannot be set to another organization');
          continue;
        }
        out[col] = encode(kind, value);
      }
      out.org_id = this.orgId;
      if (cols.has('created_by') && !('created_by' in out)) out.created_by = this.userId;
      return out;
    });
    const names = [...new Set(prepared.flatMap((r) => Object.keys(r)))];
    const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / names.length));

    return this.atomic(async (db) => {
      const inserted: Row[] = [];
      for (let i = 0; i < prepared.length; i += chunkSize) {
        const values: unknown[] = [];
        const tuples = prepared.slice(i, i + chunkSize).map((row) => {
          const cells = names.map((name) => {
            if (!(name in row)) return 'DEFAULT';
            values.push(row[name]);
            return `$${values.length}`;
          });
          return `(${cells.join(', ')})`;
        });
        const text = `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`;
        inserted.push(...(await db.runner.query(text, values)).rows);
      }
      if (!NO_AUDIT_TABLES.has(table)) {
        await db.writeAudit(inserted.map((row) => ({ entity: table, row, action: 'create', before: null, after: row })));
      }
      return inserted as T[];
    });
  }

  async update<T = Row>(table: string, id: string, patch: Row): Promise<T | null> {
    const cols = await this.table(table);
    const sets: string[] = [];
    const values: unknown[] = [this.orgId];
    for (const [col, value] of Object.entries(patch ?? {})) {
      const kind = column(table, cols, col);
      if (value === undefined) continue;
      if (col === 'id' || col === 'org_id') throw new Error(`scopedDb: ${col} cannot be updated`);
      if (col === 'updated_at') continue;
      values.push(encode(kind, value));
      sets.push(`"${col}" = $${values.length}`);
    }
    if (cols.has('updated_at')) sets.push('"updated_at" = now()');
    if (!isUuidOrText(cols, id)) return null;

    return this.atomic(async (db) => {
      const scope = db.scope(table);
      const before = (await db.runner.query(`SELECT * FROM "${table}" WHERE ${scope} AND "id" = $2 FOR UPDATE`, [db.orgId, id]))
        .rows[0] as Row | undefined;
      if (!before) return null;
      if (sets.length === 0) return before as T;
      values.push(id);
      const after = (
        await db.runner.query(`UPDATE "${table}" SET ${sets.join(', ')} WHERE ${scope} AND "id" = $${values.length} RETURNING *`, values)
      ).rows[0] as Row;
      if (!NO_AUDIT_TABLES.has(table)) {
        const changedBefore: Row = {};
        const changedAfter: Row = {};
        for (const col of Object.keys(after)) {
          if (col === 'updated_at') continue;
          if (JSON.stringify(before[col]) !== JSON.stringify(after[col])) {
            changedBefore[col] = before[col];
            changedAfter[col] = after[col];
          }
        }
        if (Object.keys(changedAfter).length > 0) {
          await db.writeAudit([{ entity: table, row: after, action: 'update', before: changedBefore, after: changedAfter }]);
        }
      }
      return after as T;
    });
  }

  async remove(table: string, id: string): Promise<boolean> {
    const cols = await this.table(table);
    if (table === 'organization') throw new Error('scopedDb: organizations are not removed through the scoped layer');
    if (!isUuidOrText(cols, id)) return false;
    return this.atomic(async (db) => {
      const { rows } = await db.runner.query(`DELETE FROM "${table}" WHERE ${db.scope(table)} AND "id" = $2 RETURNING *`, [db.orgId, id]);
      const row = rows[0] as Row | undefined;
      if (!row) return false;
      if (!NO_AUDIT_TABLES.has(table)) {
        await db.writeAudit([{ entity: table, row, action: 'delete', before: row, after: null }]);
      }
      return true;
    });
  }

  async sql<T = Row>(text: string, params: Record<string, unknown> = {}): Promise<T[]> {
    if ('org_id' in params && params.org_id !== this.orgId) {
      throw new Error('scopedDb.sql: org_id is bound automatically and cannot be overridden');
    }
    const compiled = compileNamed(text, { ...params, org_id: this.orgId });
    if (!compiled.names.includes('org_id')) {
      throw new Error('scopedDb.sql: the statement must be scoped with :org_id');
    }
    return (await this.runner.query(compiled.text, compiled.values)).rows as T[];
  }

  async tx<R>(fn: (db: ScopedDb) => Promise<R>): Promise<R> {
    if (this.client) {
      // Nested: savepoint, so a caught failure inside does not poison the outer transaction.
      const name = `sp_${this.depth + 1}_${Math.random().toString(36).slice(2, 10)}`;
      await this.client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(new Scoped(this.orgId, this.userId, this.pool, this.client, this.depth + 1));
        await this.client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        throw err;
      }
    }
    await this.schema(); // fail early (and outside the transaction) when the schema is missing
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new Scoped(this.orgId, this.userId, this.pool, client, 1));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async audit(entity: string, entityId: string | null, action: string, data: AuditData = {}): Promise<void> {
    await this.runner.query(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, tender_id, action, before, after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        this.orgId,
        this.userId,
        entity,
        entityId,
        isUuid(data.tenderId) ? data.tenderId : null,
        action,
        toAuditJson(data.before),
        toAuditJson(data.after),
      ],
    );
  }

  /** Data change + its audit rows commit together. */
  private atomic<R>(fn: (db: Scoped) => Promise<R>): Promise<R> {
    if (this.client) return fn(this);
    return this.tx((db) => fn(db as Scoped));
  }

  private async writeAudit(entries: { entity: string; row: Row; action: string; before: Row | null; after: Row | null }[]): Promise<void> {
    const perRow = 8;
    const chunk = Math.floor(MAX_PARAMS / perRow);
    for (let i = 0; i < entries.length; i += chunk) {
      const values: unknown[] = [];
      const tuples = entries.slice(i, i + chunk).map((e) => {
        const tenderId = e.entity === 'tender' ? e.row.id : isUuid(e.row.tender_id) ? e.row.tender_id : null;
        values.push(this.orgId, this.userId, e.entity, e.row.id == null ? null : String(e.row.id), tenderId, e.action, toAuditJson(e.before), toAuditJson(e.after));
        const n = values.length;
        return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await this.runner.query(
        `INSERT INTO audit_log (org_id, user_id, entity, entity_id, tender_id, action, before, after) VALUES ${tuples.join(', ')}`,
        values,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------

function column(table: string, cols: TableSchema, name: string): ColumnKind {
  const kind = typeof name === 'string' && IDENT_RE.test(name) ? cols.get(name) : undefined;
  if (!kind) throw new Error(`scopedDb: unknown column "${String(name)}" on table "${table}"`);
  return kind;
}

/** JS value → pg parameter. jsonb columns get JSON text (so arrays are not mistaken for Postgres arrays). */
function encode(kind: ColumnKind, value: unknown): unknown {
  if (value === null) return null;
  if (kind === 'jsonb') return JSON.stringify(value);
  if (kind === 'array') {
    if (!Array.isArray(value)) throw new Error('scopedDb: array column expects an array');
    return value;
  }
  if (typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    throw new Error('scopedDb: objects/arrays can only be written to jsonb or array columns');
  }
  return value;
}

function isUuidOrText(cols: TableSchema, id: unknown): boolean {
  if (typeof id !== 'string' || id === '') return false;
  return cols.get('id') === 'uuid' ? isUuid(id) : true;
}

function nonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`scopedDb: ${name} must be a non-negative integer`);
  return value;
}

function orderBy(table: string, cols: TableSchema, spec: string): string {
  return spec
    .split(',')
    .map((part) => {
      const m = /^\s*([a-z_][a-z0-9_]*)(?:\s+(asc|desc))?(?:\s+nulls\s+(first|last))?\s*$/i.exec(part);
      if (!m) throw new Error(`scopedDb: invalid orderBy "${spec}"`);
      column(table, cols, m[1] as string);
      return `"${m[1]}"${m[2] ? ` ${m[2].toUpperCase()}` : ''}${m[3] ? ` NULLS ${m[3].toUpperCase()}` : ''}`;
    })
    .join(', ');
}

function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return value;
  const out: Row = {};
  for (const [k, v] of Object.entries(value as Row)) {
    out[k] = REDACTED_COLUMNS.has(k) && v != null ? REDACTED : v;
  }
  return out;
}

function toAuditJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(redact(value));
}

/**
 * `:name` placeholders → `$n`. Skips string literals, quoted identifiers, comments, dollar-quoted bodies and
 * `::casts`. Exported for tests.
 */
export function compileNamed(text: string, params: Record<string, unknown>): { text: string; values: unknown[]; names: string[] } {
  const names: string[] = [];
  const values: unknown[] = [];
  let out = '';
  let i = 0;
  const n = text.length;
  const copyUntil = (end: number) => {
    out += text.slice(i, end);
    i = end;
  };
  while (i < n) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== ch) j++;
      copyUntil(Math.min(j + 1, n));
    } else if (ch === '-' && next === '-') {
      const j = text.indexOf('\n', i);
      copyUntil(j === -1 ? n : j);
    } else if (ch === '/' && next === '*') {
      const j = text.indexOf('*/', i + 2);
      copyUntil(j === -1 ? n : j + 2);
    } else if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (m) {
        const j = text.indexOf(m[0], i + m[0].length);
        copyUntil(j === -1 ? n : j + m[0].length);
      } else {
        if (/[0-9]/.test(next ?? '')) throw new Error('scopedDb.sql: use named params (:name), not positional ($1)');
        copyUntil(i + 1);
      }
    } else if (ch === ':' && next === ':') {
      copyUntil(i + 2);
    } else if (ch === ':' && /[A-Za-z_]/.test(next ?? '')) {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i)) as RegExpExecArray;
      const name = m[1] as string;
      if (!Object.hasOwn(params, name) || params[name] === undefined) {
        throw new Error(`scopedDb.sql: missing value for :${name}`);
      }
      let index = names.indexOf(name);
      if (index === -1) {
        names.push(name);
        values.push(encodeParam(params[name]));
        index = names.length - 1;
      }
      out += `$${index + 1}`;
      i += m[0].length;
    } else {
      copyUntil(i + 1);
    }
  }
  return { text: out, values, names };
}

function encodeParam(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}
