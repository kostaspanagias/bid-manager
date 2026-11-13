import { describe, expect, it } from 'vitest';
import { addMember, createOrg, createTender, createUser, dbFor, missingId } from '../test/harness.js';
import { compileNamed, REDACTED, scopedDb } from './scoped.js';

describe('scoped data layer — basics', () => {
  it('insert sets org_id and created_by, and returns the row', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'admin');
    const db = dbFor(org, user);
    const row = await db.insert('holiday', { date: '2031-03-03', name: 'Test' });
    expect(row).toMatchObject({ org_id: org.id, created_by: user.id, date: '2031-03-03', name: 'Test', source: 'manual' });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('date columns come back as YYYY-MM-DD strings, numerics as numbers', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const tender = await createTender(org, { guarantee_valid_until: '2027-12-31', budget_net: 1234567.89 });
    const row = await db.get('tender', tender.id);
    expect(row?.guarantee_valid_until).toBe('2027-12-31');
    expect(row?.budget_net).toBe(1234567.89);
    expect(row?.submission_deadline_at).toBeInstanceOf(Date);
  });

  it('serialises jsonb objects and arrays, and text[] columns', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const tender = await createTender(org, {
      cpv: ['30200000-1', '48000000-8'],
      lots: [{ no: 1, title: 'Τμήμα 1', budget: 1000 }],
      template_snapshot: { roles: ['A', 'B'], nested: { ok: true } },
    });
    const row = await db.get('tender', tender.id);
    expect(row?.cpv).toEqual(['30200000-1', '48000000-8']);
    expect(row?.lots).toEqual([{ no: 1, title: 'Τμήμα 1', budget: 1000 }]);
    expect(row?.template_snapshot).toEqual({ roles: ['A', 'B'], nested: { ok: true } });

    const updated = await db.update('tender', tender.id, { cpv: [], lots: [], template_snapshot: ['x', 1] });
    expect(updated?.cpv).toEqual([]);
    expect(updated?.lots).toEqual([]);
    expect(updated?.template_snapshot).toEqual(['x', 1]);

    const role = await db.insert('tender_role', { tender_id: tender.id, key: 'C', name: 'Οικονομική', payload: { financial: true } });
    expect(role.payload).toEqual({ financial: true });
    const str = await db.insert('tender_role', { tender_id: tender.id, key: 'S', name: 'String', payload: 'plain' });
    expect(str.payload).toBe('plain');
  });

  it('list supports where (null, arrays), orderBy, limit and offset', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const tender = await createTender(org);
    await db.insertMany('task', [
      { tender_id: tender.id, title: 'a', sort: 3, due_date: '2027-01-03', status: 'open' },
      { tender_id: tender.id, title: 'b', sort: 1, due_date: null, status: 'done' },
      { tender_id: tender.id, title: 'c', sort: 2, due_date: '2027-01-01', status: 'open' },
    ]);
    const where = { tender_id: tender.id };
    expect((await db.list('task', where, { orderBy: 'sort' })).map((t) => t.title)).toEqual(['b', 'c', 'a']);
    expect((await db.list('task', where, { orderBy: 'due_date desc nulls last, title' })).map((t) => t.title)).toEqual(['a', 'c', 'b']);
    expect((await db.list('task', where, { orderBy: 'sort', limit: 1, offset: 1 })).map((t) => t.title)).toEqual(['c']);
    expect((await db.list('task', { ...where, due_date: null })).map((t) => t.title)).toEqual(['b']);
    expect((await db.list('task', { ...where, status: ['open', 'in_progress'] }, { orderBy: 'title' })).map((t) => t.title)).toEqual(['a', 'c']);
    expect(await db.list('task', { ...where, status: [] })).toEqual([]);
    expect(await db.count('task', where)).toBe(3);
    expect(await db.count('task', { ...where, status: 'done' })).toBe(1);
    expect((await db.findOne('task', { ...where, title: 'c' }))?.sort).toBe(2);
    expect(await db.findOne('task', { ...where, title: 'zzz' })).toBeNull();
  });

  it('insertMany fills missing keys with column defaults and handles empty input', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const tender = await createTender(org);
    expect(await db.insertMany('risk', [])).toEqual([]);
    const rows = await db.insertMany('risk', [
      { tender_id: tender.id, title: 'r1', status: 'closed' },
      { tender_id: tender.id, title: 'r2', trigger: 'T-3' },
    ]);
    expect(rows.map((r) => [r.title, r.status, r.trigger])).toEqual([
      ['r1', 'closed', null],
      ['r2', 'open', 'T-3'],
    ]);
  });

  it('update sets updated_at, ignores undefined, returns null for unknown ids; remove returns a boolean', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const h = await db.insert('holiday', { date: '2031-04-04', name: 'Old' });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await db.update('holiday', h.id, { name: 'New', date: undefined });
    expect(updated).toMatchObject({ name: 'New', date: '2031-04-04' });
    expect(updated?.updated_at.getTime()).toBeGreaterThan(h.updated_at.getTime());
    expect(await db.update('holiday', missingId(), { name: 'x' })).toBeNull();
    expect(await db.update('holiday', 'not-a-uuid', { name: 'x' })).toBeNull();
    expect(await db.get('holiday', 'not-a-uuid')).toBeNull();
    expect(await db.remove('holiday', h.id)).toBe(true);
    expect(await db.remove('holiday', h.id)).toBe(false);
    expect(await db.remove('holiday', 'not-a-uuid')).toBe(false);
  });

  it('the organization row is reachable only as the current org', async () => {
    const org = await createOrg({ name: 'Mine' });
    const other = await createOrg({ name: 'Theirs' });
    const db = dbFor(org);
    expect((await db.get('organization', org.id))?.name).toBe('Mine');
    expect(await db.get('organization', other.id)).toBeNull();
    expect((await db.list('organization')).map((o) => o.id)).toEqual([org.id]);
    expect(await db.update('organization', other.id, { name: 'Hacked' })).toBeNull();
    expect((await db.update('organization', org.id, { retention_days: 365, settings: { a: 1 } }))?.settings).toEqual({ a: 1 });
    await expect(db.insert('organization', { name: 'New' })).rejects.toThrow(/not created through/);
    await expect(db.remove('organization', org.id)).rejects.toThrow(/not removed through/);
    expect((await dbFor(other).get('organization', other.id))?.name).toBe('Theirs');
  });
});

describe('scoped data layer — identifier allowlist and input safety', () => {
  it('rejects unknown tables and columns (no SQL injection through identifiers)', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await expect(db.list('pg_user')).rejects.toThrow(/unknown table/);
    await expect(db.list('schema_migrations')).rejects.toThrow(/unknown table/);
    await expect(db.list('holiday; DROP TABLE holiday')).rejects.toThrow(/unknown table/);
    await expect(db.list('holiday', { 'name = name OR 1': 1 })).rejects.toThrow(/unknown column/);
    await expect(db.insert('holiday', { date: '2031-01-01', name: 'x', nope: 1 })).rejects.toThrow(/unknown column/);
    await expect(db.update('holiday', missingId(), { 'name"': 'x' })).rejects.toThrow(/unknown column/);
    await expect(db.list('holiday', {}, { orderBy: 'date; DROP TABLE holiday' })).rejects.toThrow(/orderBy/);
    await expect(db.list('holiday', {}, { orderBy: 'nope' })).rejects.toThrow(/unknown column/);
    await expect(db.list('holiday', {}, { limit: -1 })).rejects.toThrow(/limit/);
    await expect(db.list('holiday', {}, { limit: 1.5 })).rejects.toThrow(/limit/);
  });

  it('rejects undefined in where (it would silently drop the filter)', async () => {
    const db = dbFor(await createOrg());
    await expect(db.list('task', { tender_id: undefined })).rejects.toThrow(/undefined/);
  });

  it('refuses to write objects into non-json columns and to change id/org_id', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const db = dbFor(org);
    const h = await db.insert('holiday', { date: '2031-05-05', name: 'x' });
    await expect(db.insert('holiday', { date: '2031-05-06', name: { a: 1 } })).rejects.toThrow(/jsonb/);
    await expect(db.update('holiday', h.id, { org_id: other.id })).rejects.toThrow(/cannot be updated/);
    await expect(db.update('holiday', h.id, { id: missingId() })).rejects.toThrow(/cannot be updated/);
    await expect(db.insert('holiday', { date: '2031-05-07', name: 'x', org_id: other.id })).rejects.toThrow(/another organization/);
    expect(() => scopedDb('nope')).toThrow(/uuid/);
  });
});

describe('scoped data layer — sql()', () => {
  it('throws without :org_id and binds it automatically otherwise', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await db.insert('holiday', { date: '2031-06-06', name: 'Mine' });
    await expect(db.sql('SELECT * FROM holiday')).rejects.toThrow(/:org_id/);
    await expect(db.sql("SELECT * FROM holiday WHERE name = ':org_id'")).rejects.toThrow(/:org_id/);
    await expect(db.sql('SELECT * FROM holiday -- :org_id')).rejects.toThrow(/:org_id/);
    await expect(db.sql('SELECT * FROM holiday /* :org_id */')).rejects.toThrow(/:org_id/);
    const rows = await db.sql<{ name: string }>('SELECT name FROM holiday WHERE org_id = :org_id AND date = :d', { d: '2031-06-06' });
    expect(rows).toEqual([{ name: 'Mine' }]);
  });

  it('org_id cannot be overridden by params; positional and missing params are rejected', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const db = dbFor(org);
    await expect(db.sql('SELECT * FROM holiday WHERE org_id = :org_id', { org_id: other.id })).rejects.toThrow(/cannot be overridden/);
    await expect(db.sql('SELECT * FROM holiday WHERE org_id = :org_id AND name = $1')).rejects.toThrow(/named params/);
    await expect(db.sql('SELECT * FROM holiday WHERE org_id = :org_id AND name = :name')).rejects.toThrow(/missing value for :name/);
    await expect(db.sql('SELECT * FROM holiday WHERE org_id = :org_id AND name = :name', { name: undefined })).rejects.toThrow(/missing value/);
  });

  it('handles casts, literals with colons, repeated names, arrays and json params', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const [row] = await db.sql(
      `SELECT :org_id::uuid AS org, '12:30' AS t, to_char(now(), 'HH24:MI') IS NOT NULL AS ok,
              :n::int + :n::int AS twice, 'x' = ANY(:arr::text[]) AS in_arr, (:obj::jsonb)->>'k' AS k`,
      { n: 21, arr: ['x', 'y'], obj: { k: 'v' } },
    );
    expect(row).toEqual({ org: org.id, t: '12:30', ok: true, twice: 42, in_arr: true, k: 'v' });
  });

  it('compileNamed leaves quoted text, comments and dollar-quoted bodies alone', () => {
    const c = compileNamed(`SELECT ':a', ":b", $$ :c $$, $tag$ :d $tag$ /* :e */ -- :f\n, :g::text, :h, :g`, { g: 1, h: 2 });
    expect(c.text).toBe(`SELECT ':a', ":b", $$ :c $$, $tag$ :d $tag$ /* :e */ -- :f\n, $1::text, $2, $1`);
    expect(c.values).toEqual([1, 2]);
    expect(c.names).toEqual(['g', 'h']);
  });
});

describe('scoped data layer — transactions', () => {
  it('commits on success and rolls back everything (audit rows included) on error', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const id = await db.tx(async (tx) => (await tx.insert('holiday', { date: '2031-07-07', name: 'kept' })).id);
    expect(await db.get('holiday', id)).not.toBeNull();

    const auditBefore = await db.count('audit_log');
    await expect(
      db.tx(async (tx) => {
        await tx.insert('holiday', { date: '2031-07-08', name: 'lost' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.findOne('holiday', { date: '2031-07-08' })).toBeNull();
    expect(await db.count('audit_log')).toBe(auditBefore);
  });

  it('nested tx is a savepoint: a caught inner failure does not poison the outer transaction', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await db.insert('holiday', { date: '2031-08-08', name: 'dup' });
    await db.tx(async (tx) => {
      await tx.insert('holiday', { date: '2031-08-09', name: 'outer' });
      await expect(tx.tx((inner) => inner.insert('holiday', { date: '2031-08-08', name: 'dup again' }))).rejects.toMatchObject({ code: '23505' });
      await tx.insert('holiday', { date: '2031-08-10', name: 'after' });
    });
    expect((await db.list('holiday', { date: ['2031-08-09', '2031-08-10'] })).length).toBe(2);
  });

  it('a failed single insert leaves no audit row behind', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await db.insert('holiday', { date: '2031-09-09', name: 'one' });
    const before = await db.count('audit_log');
    await expect(db.insert('holiday', { date: '2031-09-09', name: 'two' })).rejects.toMatchObject({ code: '23505' });
    expect(await db.count('audit_log')).toBe(before);
  });
});

describe('scoped data layer — audit log', () => {
  it('writes create / update / delete rows with before and after', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'admin');
    const db = dbFor(org, user);
    const h = await db.insert('holiday', { date: '2031-10-10', name: 'Old' });
    await db.update('holiday', h.id, { name: 'New' });
    await db.update('holiday', h.id, { name: 'New' }); // no change → no audit row
    await db.remove('holiday', h.id);

    const log = await db.sql('SELECT * FROM audit_log WHERE org_id = :org_id AND entity_id = :id ORDER BY at, action', { id: h.id });
    expect(log.map((l) => l.action)).toEqual(['create', 'update', 'delete']);
    for (const l of log) expect(l).toMatchObject({ entity: 'holiday', user_id: user.id, org_id: org.id });
    expect(log[0].before).toBeNull();
    expect(log[0].after).toMatchObject({ id: h.id, name: 'Old', date: '2031-10-10' });
    expect(log[1].before).toEqual({ name: 'Old' });
    expect(log[1].after).toEqual({ name: 'New' });
    expect(log[2].before).toMatchObject({ id: h.id, name: 'New' });
    expect(log[2].after).toBeNull();
  });

  it('records tender_id for tenders and their children; insertMany audits every row', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const tender = await createTender(org);
    const tasks = await db.insertMany('task', [
      { tender_id: tender.id, title: 't1' },
      { tender_id: tender.id, title: 't2' },
    ]);
    const log = await db.list('audit_log', { tender_id: tender.id });
    expect(log.filter((l) => l.entity === 'tender').map((l) => l.entity_id)).toEqual([tender.id]);
    expect(log.filter((l) => l.entity === 'task').map((l) => l.entity_id).sort()).toEqual(tasks.map((t) => t.id).sort());
  });

  it('redacts password_hash, totp_secret and token_hash', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const user = await db.insert('user', { email: 'redact@example.com', name: 'R', password_hash: 'HASH-1', totp_secret: 'SECRET-1' });
    await db.update('user', user.id, { password_hash: 'HASH-2', totp_secret: null });
    const inv = await db.insert('invitation', { email: 'inv@example.com', token_hash: 'TOKEN-HASH', expires_at: new Date(Date.now() + 1000) });
    await db.remove('invitation', inv.id);
    const log = await db.list('audit_log', { entity_id: [user.id, inv.id] });
    const text = JSON.stringify(log);
    expect(text).not.toContain('HASH-1');
    expect(text).not.toContain('HASH-2');
    expect(text).not.toContain('SECRET-1');
    expect(text).not.toContain('TOKEN-HASH');
    const create = log.find((l) => l.entity === 'user' && l.action === 'create');
    expect(create?.after).toMatchObject({ password_hash: REDACTED, totp_secret: REDACTED });
    const update = log.find((l) => l.entity === 'user' && l.action === 'update');
    expect(update?.before).toEqual({ password_hash: REDACTED, totp_secret: REDACTED });
    expect(update?.after).toEqual({ password_hash: REDACTED, totp_secret: null });
  });

  it('does not audit session, job_run, email_log and audit_log writes', async () => {
    const org = await createOrg();
    const user = await createUser(org);
    const db = dbFor(org, user);
    const before = await db.count('audit_log');
    await db.insert('session', { id: `s-${user.id}`, user_id: user.id, csrf_token: 'c', expires_at: new Date(Date.now() + 1000) });
    await db.update('session', `s-${user.id}`, { totp_verified: true });
    await db.remove('session', `s-${user.id}`);
    await db.insert('job_run', { job: 'j', run_date: '2031-01-01' });
    await db.insert('email_log', { kind: 'k', dedupe_key: 'd' });
    expect(await db.count('audit_log')).toBe(before);
    await db.insert('audit_log', { entity: 'x', action: 'manual' });
    expect(await db.count('audit_log')).toBe(before + 1);
  });

  it('audit() writes an explicit entry (redacted too)', async () => {
    const org = await createOrg();
    const user = await createUser(org);
    const db = dbFor(org, user);
    const tender = await createTender(org);
    await db.audit('gate', missingId(), 'decide', { before: { decision: 'pending' }, after: { decision: 'approved_with_exception', token_hash: 'x' }, tenderId: tender.id });
    const row = await db.findOne('audit_log', { action: 'decide' });
    expect(row).toMatchObject({ entity: 'gate', user_id: user.id, tender_id: tender.id, before: { decision: 'pending' }, after: { decision: 'approved_with_exception', token_hash: REDACTED } });
  });

  it('personal data of users and invitations never reaches the audit log — ids and field names only (review M2)', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const user = await db.insert('user', { email: 'maria.personal@example.com', name: 'Μαρία Προσωπική', org_role: 'member' });
    await db.update('user', user.id, { name: 'Μαρία Νέα-Προσωπική', email: 'maria.new@example.com', org_role: 'viewer' });
    const inv = await db.insert('invitation', { email: 'invited.personal@example.com', org_role: 'member', token_hash: 'h', expires_at: new Date(Date.now() + 1000) });
    await db.remove('invitation', inv.id);
    await db.audit('user', user.id, 'custom', { after: { ip: '10.1.2.3', user_agent: 'Firefox', to_email: 'x@personal.example.com', note: 'kept' } });
    await db.remove('user', user.id);
    const rows = await db.list('audit_log', {}, { orderBy: 'at, id' });
    const text = JSON.stringify(rows);
    for (const secret of ['maria.personal', 'maria.new', 'Προσωπική', 'invited.personal', '10.1.2.3', 'Firefox', 'personal.example.com']) {
      expect(text, secret).not.toContain(secret);
    }
    const update = rows.find((r) => r.entity === 'user' && r.action === 'update');
    expect(update).toMatchObject({ entity_id: user.id, before: { name: REDACTED, email: REDACTED, org_role: 'member' }, after: { name: REDACTED, email: REDACTED, org_role: 'viewer' } });
    expect(rows.find((r) => r.action === 'custom')?.after).toEqual({ ip: REDACTED, user_agent: REDACTED, to_email: REDACTED, note: 'kept' });
    expect(rows.find((r) => r.entity === 'invitation' && r.action === 'create')?.after).toMatchObject({ id: inv.id, email: REDACTED, org_role: 'member' });
    // other entities keep their (non-personal) names
    const tender = await createTender(org, { title: 'Τίτλος διαγωνισμού' });
    expect(JSON.stringify(await db.list('audit_log', { entity: 'tender', entity_id: tender.id }))).toContain('Τίτλος διαγωνισμού');
  });

  it('audit_log is append-only: UPDATE and DELETE are rejected by the database', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await db.insert('holiday', { date: '2031-11-11', name: 'x' });
    const entry = await db.findOne('audit_log', { entity: 'holiday' });
    await expect(db.update('audit_log', entry!.id, { action: 'tampered' })).rejects.toThrow(/append-only/);
    await expect(db.remove('audit_log', entry!.id)).rejects.toThrow(/append-only/);
    await expect(db.sql('DELETE FROM audit_log WHERE org_id = :org_id')).rejects.toThrow(/append-only/);
    await expect(db.sql("UPDATE audit_log SET action = 'x' WHERE org_id = :org_id")).rejects.toThrow(/append-only/);
    expect((await db.get('audit_log', entry!.id))?.action).toBe('create');
  });
});

describe('scoped data layer — tenant isolation (a second org never sees or modifies the first org\'s rows)', () => {
  it('holds for every method', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const userA = await createUser(orgA, 'bid_manager');
    const userB = await createUser(orgB, 'admin');
    const a = dbFor(orgA, userA);
    const b = dbFor(orgB, userB);

    const tender = await createTender(orgA, { title: 'Secret tender' });
    await addMember(tender, userA, 'C');
    const req = await a.insert('requirement', { tender_id: tender.id, code: 'ΥΠ-001', text: 'Confidential price ceiling' });
    const holiday = await a.insert('holiday', { date: '2031-12-12', name: 'A only' });

    // list / get / findOne / count
    expect(await b.list('tender')).toEqual([]);
    expect(await b.list('requirement', { tender_id: tender.id })).toEqual([]);
    expect(await b.list('requirement', { id: [req.id] })).toEqual([]);
    expect(await b.get('tender', tender.id)).toBeNull();
    expect(await b.get('requirement', req.id)).toBeNull();
    expect(await b.findOne('requirement', { code: 'ΥΠ-001' })).toBeNull();
    expect(await b.findOne('user', { email: userA.email })).toBeNull();
    expect(await b.count('requirement')).toBe(0);
    expect(await b.count('tender_member', { user_id: userA.id })).toBe(0);
    expect(await b.count('audit_log', { entity_id: tender.id })).toBe(0);
    // an explicit org_id in where cannot widen the scope
    expect(await b.list('requirement', { org_id: orgA.id })).toEqual([]);
    expect(await b.count('requirement', { org_id: orgA.id })).toBe(0);

    // update / remove
    expect(await b.update('requirement', req.id, { text: 'tampered' })).toBeNull();
    expect(await b.update('tender', tender.id, { title: 'tampered' })).toBeNull();
    expect(await b.remove('requirement', req.id)).toBe(false);
    expect(await b.remove('tender', tender.id)).toBe(false);
    expect(await b.remove('holiday', holiday.id)).toBe(false);

    // sql: :org_id is always B's
    expect(await b.sql('SELECT * FROM requirement WHERE org_id = :org_id')).toEqual([]);
    expect(await b.sql('SELECT * FROM requirement WHERE org_id = :org_id AND id = :id', { id: req.id })).toEqual([]);
    expect(await b.sql('UPDATE requirement SET text = :t WHERE org_id = :org_id AND id = :id RETURNING id', { t: 'x', id: req.id })).toEqual([]);
    expect(await b.sql('DELETE FROM tender WHERE org_id = :org_id AND id = :id RETURNING id', { id: tender.id })).toEqual([]);

    // insert / insertMany always land in the caller's org; the unique key is per org
    const hb = await b.insert('holiday', { date: '2031-12-12', name: 'B only' });
    expect(hb.org_id).toBe(orgB.id);
    const many = await b.insertMany('holiday', [{ date: '2031-12-13', name: 'B1' }, { date: '2031-12-14', name: 'B2' }]);
    expect(many.every((r) => r.org_id === orgB.id)).toBe(true);
    await expect(b.insertMany('holiday', [{ date: '2031-12-15', name: 'x', org_id: orgA.id }])).rejects.toThrow(/another organization/);

    // inside a transaction too
    await b.tx(async (tx) => {
      expect(await tx.get('tender', tender.id)).toBeNull();
      expect(await tx.update('requirement', req.id, { text: 'tampered' })).toBeNull();
      expect(await tx.remove('requirement', req.id)).toBe(false);
      expect(await tx.sql('SELECT id FROM tender WHERE org_id = :org_id')).toEqual([]);
    });

    // A's data is intact and A does not see B's
    expect((await a.get('requirement', req.id))?.text).toBe('Confidential price ceiling');
    expect((await a.get('tender', tender.id))?.title).toBe('Secret tender');
    expect((await a.list('holiday')).map((h) => h.name)).toEqual(['A only']);
    expect((await b.list('holiday', {}, { orderBy: 'date' })).map((h) => h.name)).toEqual(['B only', 'B1', 'B2']);
    // B's failed attempts left no trace in A's audit log, and B's log has only B's entities
    expect((await a.list('audit_log')).every((l) => l.org_id === orgA.id)).toBe(true);
    expect((await b.list('audit_log')).every((l) => l.org_id === orgB.id && l.entity !== 'requirement')).toBe(true);
  });
});
