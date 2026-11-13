import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { createOrg, createTender, dbFor } from '../test/harness.js';
import { migrate } from './migrate.js';
import { getPool } from './pool.js';

// Schema conventions from ARCHITECTURE.md, checked against the live (migrated) test database.

const SPEC_TABLES = [
  'organization', 'user', 'holiday', 'template', 'template_item', 'tender', 'tender_member', 'milestone', 'gate',
  'gate_criterion', 'requirement', 'task', 'watch_item', 'risk', 'change_entry', 'company_document', 'file', 'lesson', 'audit_log',
];
const EXTRA_TABLES = ['session', 'invitation', 'tender_role', 'tender_document', 'change_entry_requirement', 'job_run', 'email_log'];

async function columns(): Promise<Map<string, Map<string, { nullable: boolean; type: string }>>> {
  const { rows } = await getPool().query(
    `SELECT table_name, column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = current_schema()`,
  );
  const out = new Map<string, Map<string, { nullable: boolean; type: string }>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Map());
    out.get(r.table_name)!.set(r.column_name, { nullable: r.is_nullable === 'YES', type: r.udt_name });
  }
  return out;
}

describe('schema', () => {
  it('has every table of the spec and of ARCHITECTURE.md', async () => {
    const cols = await columns();
    for (const t of [...SPEC_TABLES, ...EXTRA_TABLES]) expect(cols.has(t), `table ${t}`).toBe(true);
  });

  it('every table has org_id uuid NOT NULL (except organization) and the standard columns', async () => {
    const cols = await columns();
    for (const [table, c] of cols) {
      if (table === 'schema_migrations') continue;
      if (table !== 'organization') {
        expect(c.get('org_id'), `${table}.org_id`).toEqual({ nullable: false, type: 'uuid' });
      }
      if (table === 'audit_log') {
        expect(c.has('at')).toBe(true);
        continue;
      }
      expect(c.get('created_at')?.type, `${table}.created_at`).toBe('timestamptz');
      expect(c.get('updated_at')?.type, `${table}.updated_at`).toBe('timestamptz');
      expect(c.get('created_by')?.type, `${table}.created_by`).toBe('uuid');
      expect(c.get('id')?.type, `${table}.id`).toBe(table === 'session' ? 'text' : 'uuid');
    }
  });

  it('org_id references organization on every table', async () => {
    const { rows } = await getPool().query(
      `SELECT c.conrelid::regclass::text AS tbl
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'organization'::regclass AND a.attname = 'org_id'`,
    );
    const withFk = new Set(rows.map((r) => String(r.tbl).replace(/"/g, '')));
    for (const t of [...SPEC_TABLES, ...EXTRA_TABLES]) if (t !== 'organization') expect(withFk.has(t), `${t}.org_id FK`).toBe(true);
  });

  it('every unique constraint includes org_id', async () => {
    const { rows } = await getPool().query(
      `SELECT c.conrelid::regclass::text AS tbl, c.conname,
              array_agg(a.attname::text) AS cols
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'u' AND c.connamespace = current_schema()::regnamespace
        GROUP BY 1, 2`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(r.cols, `${r.tbl}.${r.conname}`).toContain('org_id');
  });

  it('has the columns the features rely on', async () => {
    const cols = await columns();
    const expectCols = (table: string, names: string[]) => {
      for (const n of names) expect(cols.get(table)?.has(n), `${table}.${n}`).toBe(true);
    };
    expectCols('tender', ['title', 'authority', 'adam', 'esidis_no', 'cpv', 'budget_net', 'budget_gross', 'lots', 't0_published_at',
      'questions_deadline_at', 'submission_deadline_at', 'guarantee_amount', 'guarantee_valid_until', 'offer_validity_days', 'has_demo',
      'has_partners', 'status', 'compressed_mode', 'template_id', 'template_version', 'guarantee_margin_days', 'template_snapshot', 'closed_at']);
    expectCols('requirement', ['code', 'source_ref', 'text', 'type', 'folder', 'owner_user_id', 'response_ref', 'evidence_ref', 'status', 'deviation_note', 'weight']);
    expectCols('task', ['title', 'owner_user_id', 'owner_role_key', 'due_date', 'status', 'handoff_from_role', 'handoff_to_role', 'received_by',
      'received_at', 'section', 'milestone_id', 'sort', 'done_at']);
    expectCols('milestone', ['key', 'name', 'kind', 'due_date', 'computed_from', 'is_manual', 'done_at', 'needs_review', 'sort']);
    expectCols('gate', ['milestone_id', 'approver_user_id', 'decision', 'justification', 'decided_by', 'decided_at', 'requested_at']);
    expectCols('gate_criterion', ['gate_id', 'text', 'type', 'auto_rule', 'checked_by', 'checked_at', 'sort', 'key']);
    expectCols('watch_item', ['name', 'owner_user_id', 'lead_value', 'lead_unit', 'requested_at', 'expected_at', 'arrived_at', 'notes', 'needed_at', 'needed_milestone_key', 'checks']);
    expectCols('template', ['name', 'version', 'status', 'parent_template_id']);
    expectCols('template_item', ['template_id', 'kind', 'key', 'name', 'owner_role_key', 'offset_value', 'offset_unit', 'anchor', 'condition', 'sort', 'payload']);
    expectCols('file', ['storage_key', 'filename', 'mime', 'size', 'sha256', 'folder', 'confidentiality', 'uploaded_by', 'tender_id', 'deleted_at', 'enc']);
    expectCols('company_document', ['type', 'title', 'file_id', 'issued_at', 'expires_at', 'person_name']);
    expectCols('lesson', ['tender_id', 'text', 'category', 'changes_template', 'applied_in_version']);
    expectCols('risk', ['title', 'trigger', 'mitigation', 'owner_user_id', 'status']);
    expectCols('change_entry', ['date', 'source', 'description', 'kind', 'owner_user_id']);
    expectCols('user', ['email', 'name', 'org_role', 'totp_secret', 'active', 'password_hash', 'totp_enabled_at', 'last_login_at']);
    expectCols('organization', ['name', 'timezone', 'settings', 'retention_days']);
    expectCols('session', ['user_id', 'totp_verified', 'csrf_token', 'last_seen_at', 'expires_at']);
    expectCols('invitation', ['email', 'org_role', 'token_hash', 'expires_at', 'accepted_at']);
    expectCols('tender_role', ['tender_id', 'key', 'name', 'payload']);
    expectCols('job_run', ['job', 'run_date', 'status', 'started_at', 'finished_at', 'detail']);
    expectCols('email_log', ['user_id', 'kind', 'dedupe_key', 'subject', 'body', 'sent_at']);
    expectCols('audit_log', ['user_id', 'entity', 'entity_id', 'action', 'before', 'after', 'at']);
  });

  it('enforces enum CHECKs, per-org unique keys and the deviation-note rule', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const a = dbFor(orgA);
    const tender = await createTender(orgA);
    await expect(a.insert('tender', { title: 'x', submission_deadline_at: new Date(), status: 'Σε εξέλιξη' })).rejects.toMatchObject({ code: '23514' });
    await expect(a.insert('user', { email: 'x@example.com', name: 'x', org_role: 'root' })).rejects.toMatchObject({ code: '23514' });
    await expect(a.insert('user', { email: 'Upper@Example.com', name: 'x' })).rejects.toMatchObject({ code: '23514' });
    await expect(a.insert('gate_criterion', { tender_id: tender.id, gate_id: tender.id, text: 'x', type: 'auto' })).rejects.toMatchObject({ code: '23514' });

    await a.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-001' });
    await expect(a.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-001' })).rejects.toMatchObject({ code: '23505' });
    await expect(a.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-002', status: 'deviation' })).rejects.toMatchObject({ code: '23514' });
    await expect(a.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-002', status: 'deviation', deviation_note: '  ' })).rejects.toMatchObject({ code: '23514' });
    expect((await a.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-002', status: 'deviation', deviation_note: 'Εγκρίθηκε στο G2' })).status).toBe('deviation');

    await a.insert('user', { email: 'same@example.com', name: 'A' });
    await expect(a.insert('user', { email: 'same@example.com', name: 'A2' })).rejects.toMatchObject({ code: '23505' });
    expect((await dbFor(orgB).insert('user', { email: 'same@example.com', name: 'B' })).org_id).toBe(orgB.id);
  });

  it('deleting a tender cascades to its children', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const tender = await createTender(org);
    const ms = await db.insert('milestone', { tender_id: tender.id, key: 'G1', name: 'G1', kind: 'gate' });
    const gate = await db.insert('gate', { tender_id: tender.id, milestone_id: ms.id });
    await db.insert('gate_criterion', { tender_id: tender.id, gate_id: gate.id, text: 'c' });
    const req = await db.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-001' });
    const change = await db.insert('change_entry', { tender_id: tender.id, description: 'd' });
    await db.insert('change_entry_requirement', { tender_id: tender.id, change_entry_id: change.id, requirement_id: req.id });
    await db.insert('task', { tender_id: tender.id, title: 't', milestone_id: ms.id });
    await db.insert('watch_item', { tender_id: tender.id, name: 'w' });
    await db.insert('risk', { tender_id: tender.id, title: 'r' });
    await db.insert('lesson', { tender_id: tender.id, text: 'l' });
    await db.insert('tender_role', { tender_id: tender.id, key: 'A', name: 'A' });
    const doc = await db.insert('company_document', { title: 'ISO 9001', type: 'iso' });
    await db.insert('tender_document', { tender_id: tender.id, company_document_id: doc.id });
    await db.insert('file', { tender_id: tender.id, storage_key: 'k1', filename: 'f.pdf' });

    expect(await db.remove('tender', tender.id)).toBe(true);
    for (const t of ['milestone', 'gate', 'gate_criterion', 'requirement', 'change_entry', 'change_entry_requirement', 'task', 'watch_item', 'risk',
      'lesson', 'tender_role', 'tender_document', 'file']) {
      expect(await db.count(t), t).toBe(0);
    }
    expect(await db.count('company_document')).toBe(1);
  });

  it('updated_at is maintained by trigger even for raw SQL updates', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const h = await db.insert('holiday', { date: '2032-01-02', name: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    const [row] = await db.sql<{ updated_at: Date }>("UPDATE holiday SET name = 'y' WHERE org_id = :org_id AND id = :id RETURNING updated_at", { id: h.id });
    expect(row!.updated_at.getTime()).toBeGreaterThan(h.updated_at.getTime());
  });

  it('migrate() is idempotent', async () => {
    expect(await migrate(config.databaseUrl)).toEqual([]);
    const { rows } = await getPool().query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows[0]?.name).toBe('001_init.sql');
  });
});
