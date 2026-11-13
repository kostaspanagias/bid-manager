// Requirements register (F5, R17): queries and writes. Reads tender_role / tender_member / "user" /
// change_entry(_requirement) of other slices through the scoped layer only.
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { coverageByType, type CoverageByType } from '../../domain/register.js';
import { canonicalCode, nextCode } from './codes.js';
import { parseImportFile, type ParsedFile } from './importFile.js';
import {
  IMPORT_FIELDS,
  buildPlan,
  suggestMapping,
  type ColumnPatch,
  type ExistingRow,
  type ImportField,
  type Mapping,
  type OwnerDirectory,
  type PlanRow,
  type PlanSummary,
} from './importPlan.js';

// ---------------------------------------------------------------------------------------------------- directory

/** Who can own a row: the tender's roles and the active users of the organization. */
export async function loadOwners(db: ScopedDb, tenderId: string): Promise<OwnerDirectory & { roles: { key: string; name: string; user_ids: string[] }[] }> {
  // One after the other: this also runs inside import transactions, where all statements share a connection.
  const roles = await db.list<{ key: string; name: string }>('tender_role', { tender_id: tenderId }, { orderBy: 'sort, key' });
  const members = await db.list<{ user_id: string; tender_role_key: string | null }>('tender_member', { tender_id: tenderId });
  const users = await db.sql<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM "user" WHERE org_id = :org_id AND active AND anonymized_at IS NULL ORDER BY name, email`,
  );
  return {
    roles: roles.map((r) => ({ key: r.key, name: r.name, user_ids: members.filter((m) => m.tender_role_key === r.key).map((m) => m.user_id) })),
    users,
  };
}

// --------------------------------------------------------------------------------------------------------- list

export interface ListFilters {
  type?: string[];
  folder?: string[];
  status?: string[];
  /** a user id, `role:<key>`, `me` or `none` */
  owner?: string;
  q?: string;
  /** exclusion rows without evidence (the G1 blocker) */
  missingEvidence?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const CODE_ORDER = `NULLIF(regexp_replace(r.code, '\\D', '', 'g'), '')::numeric`;
const SORTS: Record<string, string> = {
  code: `${CODE_ORDER} :dir NULLS LAST, r.code :dir`,
  source_ref: `r.source_ref :dir NULLS LAST`,
  text: `r.text :dir`,
  type: `array_position(ARRAY['exclusion','scored','formal'], r.type) :dir`,
  folder: `array_position(ARRAY['participation','technical','financial'], r.folder) :dir NULLS LAST`,
  owner: `COALESCE(r.owner_role_key, '') :dir, (SELECT u.name FROM "user" u WHERE u.org_id = r.org_id AND u.id = r.owner_user_id) :dir NULLS LAST`,
  response_ref: `r.response_ref :dir NULLS LAST`,
  evidence_ref: `r.evidence_ref :dir NULLS LAST`,
  status: `array_position(ARRAY['open','in_progress','deviation','covered','verified'], r.status) :dir`,
  updated_at: `r.updated_at :dir`,
};
export const SORT_KEYS = Object.keys(SORTS);

const CHANGES_JOIN = `
  LEFT JOIN (
    SELECT cer.requirement_id,
           json_agg(json_build_object('id', ce.id, 'date', ce.date, 'kind', ce.kind, 'source', ce.source,
                                      'description', ce.description, 'reference', ce.reference)
                    ORDER BY ce.date DESC, ce.created_at DESC) AS changes
      FROM change_entry_requirement cer
      JOIN change_entry ce ON ce.id = cer.change_entry_id AND ce.org_id = cer.org_id
     WHERE cer.org_id = :org_id AND cer.tender_id = :tender_id
     GROUP BY cer.requirement_id
  ) c ON c.requirement_id = r.id`;

const COLUMNS = `r.id, r.tender_id, r.code, r.source_ref, r.text, r.type, r.folder, r.weight, r.owner_user_id, r.owner_role_key,
  r.response_ref, r.evidence_ref, r.status, r.deviation_note, r.sort, r.created_at, r.updated_at, r.created_by`;

function whereOf(filters: ListFilters, userId: string | null, params: Record<string, unknown>): string {
  const parts = ['r.org_id = :org_id', 'r.tender_id = :tender_id'];
  for (const column of ['type', 'folder', 'status'] as const) {
    const values = filters[column];
    if (!values || values.length === 0) continue;
    params[column] = values.filter((v) => v !== 'none');
    parts.push(values.includes('none') && column === 'folder' ? `(r.folder = ANY(:folder) OR r.folder IS NULL)` : `r.${column} = ANY(:${column})`);
  }
  if (filters.owner) {
    if (filters.owner === 'none') parts.push('r.owner_user_id IS NULL AND r.owner_role_key IS NULL');
    else if (filters.owner.startsWith('role:')) {
      params.owner_role = filters.owner.slice(5);
      parts.push('r.owner_role_key = :owner_role');
    } else {
      // A person owns the rows assigned to them and the rows assigned to a role they hold in this tender.
      params.owner_user = filters.owner === 'me' ? userId : filters.owner;
      parts.push(`(r.owner_user_id = :owner_user OR r.owner_role_key IN (
        SELECT m.tender_role_key FROM tender_member m
         WHERE m.org_id = :org_id AND m.tender_id = :tender_id AND m.user_id = :owner_user AND m.tender_role_key IS NOT NULL))`);
    }
  }
  if (filters.missingEvidence) parts.push(`r.type = 'exclusion' AND btrim(coalesce(r.evidence_ref, '')) = ''`);
  const q = filters.q?.trim();
  if (q) {
    params.q = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.q_code = canonicalCode(q) ?? '';
    parts.push(`(r.code ILIKE :q OR r.text ILIKE :q OR r.source_ref ILIKE :q OR r.code = :q_code)`);
  }
  return parts.join(' AND ');
}

export async function listRequirements(db: ScopedDb, tenderId: string, filters: ListFilters = {}): Promise<Row[]> {
  const params: Record<string, unknown> = { tender_id: tenderId };
  const where = whereOf(filters, db.userId, params);
  const dir = filters.dir === 'desc' ? 'DESC' : 'ASC';
  const order = (SORTS[filters.sort ?? 'code'] ?? (SORTS.code as string)).replaceAll(':dir', dir);
  let text = `SELECT ${COLUMNS}, COALESCE(c.changes, '[]'::json) AS changes
    FROM requirement r ${CHANGES_JOIN}
   WHERE ${where}
   ORDER BY ${order}, ${CODE_ORDER} NULLS LAST, r.code, r.id`;
  if (filters.limit !== undefined) {
    params.limit = filters.limit;
    params.offset = filters.offset ?? 0;
    text += ' LIMIT :limit OFFSET :offset';
  }
  return db.sql(text, params);
}

export async function getRequirement(db: ScopedDb, tenderId: string, id: string): Promise<Row> {
  const row = await db.findOne('requirement', { id, tender_id: tenderId });
  if (!row) throw notFound('Requirement not found', 'requirement_not_found');
  const changes = await db.sql(
    `SELECT ce.id, ce.date, ce.kind, ce.source, ce.description, ce.reference
       FROM change_entry_requirement cer JOIN change_entry ce ON ce.id = cer.change_entry_id AND ce.org_id = cer.org_id
      WHERE cer.org_id = :org_id AND cer.requirement_id = :id ORDER BY ce.date DESC, ce.created_at DESC`,
    { id: row.id },
  );
  return { ...row, changes };
}

// ----------------------------------------------------------------------------------------------------- coverage

export interface RegisterCoverage extends CoverageByType {
  /** Exclusion rows without an evidence reference — they block G1 (auto rule exclusion_evidence_100). */
  exclusionWithoutEvidence: number;
  /** Rows still open / in progress — they block G3 (auto rule register_no_open). */
  open: number;
  deviations: number;
}

export async function registerCoverage(db: ScopedDb, tenderId: string): Promise<RegisterCoverage> {
  const groups = await db.sql<{ type: string; status: string; n: number; no_evidence: number }>(
    `SELECT type, status, count(*)::int AS n, (count(*) FILTER (WHERE btrim(coalesce(evidence_ref, '')) = ''))::int AS no_evidence
       FROM requirement WHERE org_id = :org_id AND tender_id = :tender_id GROUP BY type, status`,
    { tender_id: tenderId },
  );
  const rows: { type: string; status: string }[] = [];
  let exclusionWithoutEvidence = 0;
  let open = 0;
  let deviations = 0;
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) rows.push(g);
    if (g.type === 'exclusion') exclusionWithoutEvidence += g.no_evidence;
    if (g.status === 'open' || g.status === 'in_progress') open += g.n;
    if (g.status === 'deviation') deviations += g.n;
  }
  return { ...coverageByType(rows), exclusionWithoutEvidence, open, deviations };
}

// ------------------------------------------------------------------------------------------------------- writes

type CodeIndex = Map<string, { id: string; code: string }>;

async function codeIndex(db: ScopedDb, tenderId: string): Promise<CodeIndex> {
  const rows = await db.sql<{ id: string; code: string }>(`SELECT id, code FROM requirement WHERE org_id = :org_id AND tender_id = :tender_id`, {
    tender_id: tenderId,
  });
  return new Map(rows.map((r) => [canonicalCode(r.code) ?? r.code, r]));
}

export async function suggestNextCode(db: ScopedDb, tenderId: string): Promise<string> {
  return nextCode((await codeIndex(db, tenderId)).keys());
}

function requireCode(input: string): string {
  const code = canonicalCode(input);
  if (!code) throw unprocessable('The code must look like ΥΠ-001', { code: input }, 'requirement_code_invalid');
  return code;
}

const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';

/** R17: the status "deviation" needs a note. */
function assertDeviationNote(row: { status?: unknown; deviation_note?: unknown }, details?: unknown): void {
  if (row.status === 'deviation' && blank(row.deviation_note)) {
    throw unprocessable('A deviation needs a justification note', details, 'deviation_note_required');
  }
}

async function assertOwner(db: ScopedDb, tenderId: string, owner: { owner_user_id?: string | null; owner_role_key?: string | null }): Promise<void> {
  if (owner.owner_user_id) {
    const user = await db.findOne<{ active: boolean }>('user', { id: owner.owner_user_id });
    if (!user || !user.active) throw unprocessable('The owner is not an active user of the organization', undefined, 'owner_user_unknown');
  }
  if (owner.owner_role_key) {
    if (!(await db.findOne('tender_role', { tender_id: tenderId, key: owner.owner_role_key }))) {
      throw unprocessable('The tender has no such role', { role: owner.owner_role_key }, 'owner_role_unknown');
    }
  }
}

export interface RequirementInput {
  code?: string;
  source_ref?: string | null;
  text?: string;
  type?: string;
  folder?: string | null;
  weight?: string | null;
  owner_user_id?: string | null;
  owner_role_key?: string | null;
  response_ref?: string | null;
  evidence_ref?: string | null;
  status?: string;
  deviation_note?: string | null;
}

export async function createRequirement(db: ScopedDb, tenderId: string, input: RequirementInput): Promise<Row> {
  await assertOwner(db, tenderId, input);
  assertDeviationNote(input);
  const row = await db.tx(async (tx) => {
    const index = await codeIndex(tx, tenderId);
    const code = input.code ? requireCode(input.code) : nextCode(index.keys());
    if (index.has(code)) throw conflict(`${code} already exists in this tender`, { code }, 'requirement_code_exists');
    return tx.insert('requirement', { ...input, code, tender_id: tenderId });
  });
  return { ...row, changes: [] };
}

export async function updateRequirement(db: ScopedDb, tenderId: string, id: string, patch: RequirementInput): Promise<Row> {
  await assertOwner(db, tenderId, patch);
  await db.tx(async (tx) => {
    const current = await tx.findOne('requirement', { id, tender_id: tenderId });
    if (!current) throw notFound('Requirement not found', 'requirement_not_found');
    const next: RequirementInput = { ...patch };
    if (patch.code !== undefined) {
      next.code = requireCode(patch.code);
      const clash = (await codeIndex(tx, tenderId)).get(next.code);
      if (clash && clash.id !== current.id) throw conflict(`${next.code} already exists in this tender`, { code: next.code }, 'requirement_code_exists');
    }
    assertDeviationNote({ ...current, ...next });
    await tx.update('requirement', current.id, next);
  });
  return getRequirement(db, tenderId, id);
}

export async function removeRequirement(db: ScopedDb, tenderId: string, id: string): Promise<void> {
  const current = await db.findOne('requirement', { id, tender_id: tenderId });
  if (!current || !(await db.remove('requirement', current.id))) throw notFound('Requirement not found', 'requirement_not_found');
}

const PATCHABLE = ['code', 'source_ref', 'text', 'type', 'folder', 'weight', 'response_ref', 'evidence_ref', 'status', 'deviation_note', 'owner_role_key'] as const;

/**
 * Applies many small patches with one UPDATE and one audit INSERT (the scoped layer's `update` costs three
 * statements per row, too slow for 1,000 rows). `before` is the row as read inside the same transaction.
 */
async function applyPatches(tx: ScopedDb, tenderId: string, changes: { before: Row; patch: ColumnPatch }[]): Promise<void> {
  const effective = changes
    .map(({ before, patch }) => {
      const changed = Object.entries(patch).filter(([col, value]) => (before[col] ?? null) !== (value ?? null));
      return { id: before.id as string, patch: Object.fromEntries(changed), before: Object.fromEntries(changed.map(([col]) => [col, before[col] ?? null])) };
    })
    .filter((c) => Object.keys(c.patch).length > 0);
  if (effective.length === 0) return;
  const sets = PATCHABLE.map((col) => `${col} = CASE WHEN x.patch ? '${col}' THEN x.patch->>'${col}' ELSE r.${col} END`);
  sets.push(`owner_user_id = CASE WHEN x.patch ? 'owner_user_id' THEN (x.patch->>'owner_user_id')::uuid ELSE r.owner_user_id END`);
  const CHUNK = 500;
  for (let i = 0; i < effective.length; i += CHUNK) {
    const rows = JSON.stringify(effective.slice(i, i + CHUNK));
    await tx.sql(
      `UPDATE requirement r SET ${sets.join(', ')}
         FROM jsonb_to_recordset(:rows::jsonb) AS x(id uuid, patch jsonb)
        WHERE r.org_id = :org_id AND r.tender_id = :tender_id AND r.id = x.id`,
      { rows, tender_id: tenderId },
    );
    await tx.sql(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, tender_id, action, before, after)
       SELECT :org_id, :user_id, 'requirement', x.id, :tender_id, 'update', x.before, x.patch
         FROM jsonb_to_recordset(:rows::jsonb) AS x(id text, patch jsonb, before jsonb)`,
      { rows, tender_id: tenderId, user_id: tx.userId },
    );
  }
}

/** The tender's rows (optionally only `ids`), locked for the rest of the transaction unless `lock` is false. */
async function lockRows(tx: ScopedDb, tenderId: string, ids?: string[], lock = true): Promise<Row[]> {
  return tx.sql(
    `SELECT * FROM requirement WHERE org_id = :org_id AND tender_id = :tender_id ${ids ? 'AND id = ANY(:ids::uuid[])' : ''} ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
    ids ? { tender_id: tenderId, ids } : { tender_id: tenderId },
  );
}

export interface BulkPatch {
  status?: string;
  deviation_note?: string | null;
  owner_user_id?: string | null;
  owner_role_key?: string | null;
  folder?: string | null;
}

/** Same change on a set of rows, all or nothing. */
export async function bulkUpdate(db: ScopedDb, tenderId: string, ids: string[], patch: BulkPatch): Promise<{ updated: number }> {
  await assertOwner(db, tenderId, patch);
  const unique = [...new Set(ids)];
  return db.tx(async (tx) => {
    const rows = await lockRows(tx, tenderId, unique);
    if (rows.length !== unique.length) throw notFound('Some requirements do not exist in this tender', 'requirement_not_found');
    const withoutNote = rows.filter((r) => ({ ...r, ...patch }).status === 'deviation' && blank({ ...r, ...patch }.deviation_note));
    if (withoutNote.length > 0) assertDeviationNote({ status: 'deviation' }, { codes: withoutNote.slice(0, 20).map((r) => r.code), count: withoutNote.length });
    await applyPatches(tx, tenderId, rows.map((before) => ({ before, patch: patch as ColumnPatch })));
    return { updated: rows.length };
  });
}

// ------------------------------------------------------------------------------------------------------- import

export interface ImportOptions {
  sheet?: string | null;
  mapping?: Mapping | null;
  overwrite?: boolean;
}

export interface ImportPreview {
  file: Pick<ParsedFile, 'format' | 'encoding' | 'delimiter' | 'sheets' | 'sheet'> & { name: string; rows: number };
  columns: { index: number; header: string; sample: string[] }[];
  suggestedMapping: Record<ImportField, number | null>;
  mapping: Record<ImportField, number | null>;
  overwrite: boolean;
  summary: PlanSummary;
  rows: Omit<PlanRow, 'id' | 'patch' | 'data'>[];
}

function resolveMapping(parsed: ParsedFile, given: Mapping | null | undefined): { suggested: Record<ImportField, number | null>; mapping: Record<ImportField, number | null> } {
  const suggested = suggestMapping(parsed.headers);
  if (!given) return { suggested, mapping: suggested };
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as Record<ImportField, number | null>;
  for (const field of IMPORT_FIELDS) {
    const index = given[field];
    if (index === null || index === undefined) continue;
    if (!Number.isInteger(index) || index < 0 || index >= parsed.headers.length) {
      throw unprocessable(`The mapping of "${field}" points to a column the file does not have`, { field, index }, 'import_bad_mapping');
    }
    mapping[field] = index;
  }
  return { suggested, mapping };
}

async function planImport(db: ScopedDb, tenderId: string, file: { buffer: Buffer; name: string }, opts: ImportOptions, lock: boolean) {
  const parsed = await parseImportFile(file.buffer, { sheet: opts.sheet });
  const { suggested, mapping } = resolveMapping(parsed, opts.mapping);
  // Sequential on purpose: inside a transaction both run on the same connection.
  const existing = await lockRows(db, tenderId, undefined, lock);
  const owners = await loadOwners(db, tenderId);
  const plan = buildPlan({ rows: parsed.rows, rowNumbers: parsed.rowNumbers, mapping, existing: existing as ExistingRow[], owners, overwrite: Boolean(opts.overwrite) });
  return { parsed, suggested, mapping, existing, plan };
}

export async function previewImport(db: ScopedDb, tenderId: string, file: { buffer: Buffer; name: string }, opts: ImportOptions): Promise<ImportPreview> {
  const { parsed, suggested, mapping, plan } = await planImport(db, tenderId, file, opts, false);
  return {
    file: { name: file.name, format: parsed.format, encoding: parsed.encoding, delimiter: parsed.delimiter, sheets: parsed.sheets, sheet: parsed.sheet, rows: parsed.rows.length },
    columns: parsed.headers.map((header, index) => ({
      index,
      header,
      sample: parsed.rows.slice(0, 3).map((r) => (r[index] ?? '').slice(0, 120)),
    })),
    suggestedMapping: suggested,
    mapping,
    overwrite: Boolean(opts.overwrite),
    summary: plan.summary,
    rows: plan.rows.map(({ id: _id, patch: _patch, data: _data, ...row }) => row),
  };
}

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Rows left out because of errors (only with skipInvalid). */
  skipped: number;
  total: number;
  overwrite: boolean;
}

/** R17: upsert by canonical code in one transaction; never deletes. */
export async function commitImport(
  db: ScopedDb,
  tenderId: string,
  file: { buffer: Buffer; name: string },
  opts: ImportOptions & { skipInvalid?: boolean },
): Promise<ImportResult> {
  return db.tx(async (tx) => {
    const { mapping, existing, plan } = await planImport(tx, tenderId, file, opts, true);
    if (mapping.code === null) throw unprocessable('Choose the column that holds the requirement code', undefined, 'import_code_column_required');
    const { summary } = plan;
    if (summary.errors > 0 && !opts.skipInvalid) {
      throw unprocessable(`${summary.errors} row(s) have errors`, { summary, rows: plan.rows.filter((r) => r.action === 'error').slice(0, 50).map(({ row, code, errors }) => ({ row, code, errors })) }, 'import_has_errors');
    }
    const creates = plan.rows.filter((r) => r.action === 'create' && r.data);
    const updates = plan.rows.filter((r) => r.action === 'update' && r.patch && r.id);
    if (creates.length > 0) {
      await tx.insertMany('requirement', creates.map((r, i) => ({ ...r.data, tender_id: tenderId, sort: existing.length + i })));
    }
    const byId = new Map(existing.map((e) => [e.id as string, e]));
    await applyPatches(tx, tenderId, updates.map((r) => ({ before: byId.get(r.id as string) as Row, patch: r.patch as ColumnPatch })));
    const result: ImportResult = {
      created: creates.length,
      updated: updates.length,
      unchanged: summary.unchanged,
      skipped: summary.errors,
      total: summary.total,
      overwrite: Boolean(opts.overwrite),
    };
    await tx.audit('requirement', null, 'import', { tenderId, after: { file: file.name, ...result } });
    return result;
  });
}
