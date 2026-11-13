import ExcelJS from 'exceljs';
import type { Test } from 'supertest';
import { describe, expect, it } from 'vitest';
import { addMember, addRole, as, createOrg, createTender, createUser, dbFor, missingId, type Agent, type TestTender, type TestUser } from '../../test/harness.js';

const HEADERS = ['Κωδικός', 'Πηγή', 'Κείμενο', 'Τύπος', 'Φάκελος', 'Συντελεστής', 'Υπεύθυνος', 'Απάντηση', 'Τεκμήριο', 'Κατάσταση', 'Αιτιολόγηση απόκλισης'];
const quote = (v: string, d: string) => (v.includes(d) || /["\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csv = (rows: string[][], { delimiter = ',', bom = false, eol = '\n' } = {}) =>
  Buffer.from((bom ? '﻿' : '') + rows.map((r) => r.map((c) => quote(c, delimiter)).join(delimiter)).join(eol) + eol, 'utf8');
/** Reads a binary (XLSX) response body into a Buffer. */
const binary = (r: Test): Test =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

interface World {
  org: Awaited<ReturnType<typeof createOrg>>;
  tender: TestTender;
  manager: TestUser;
  member: TestUser;
  api: Agent;
  base: string;
}
async function world(): Promise<World> {
  const org = await createOrg();
  const manager = await createUser(org, 'bid_manager', { name: 'Μαρία Αντωνίου' });
  const member = await createUser(org, 'member', { name: 'Γιώργος Δημητρίου' });
  const tender = await createTender(org);
  await addRole(tender, 'A', { folder: 'participation' }, 'Δικαιολογητικά');
  await addRole(tender, 'B', { folder: 'technical' }, 'Τεχνική');
  await addRole(tender, 'C', { folder: 'financial', financial: true }, 'Οικονομική');
  await addMember(tender, member, 'B');
  return { org, tender, manager, member, api: await as(manager), base: `/api/tenders/${tender.id}/requirements` };
}
const upload = (api: Agent, url: string, file: Buffer, name = 'register.csv', fields: Record<string, string> = {}) => {
  let req = api.post(url).attach('file', file, name);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req;
};

describe('requirements — CRUD and R17', () => {
  it('creates rows with a canonical, unique code and suggests the next free one', async () => {
    const w = await world();
    expect((await w.api.get(`${w.base}/next-code`)).body).toEqual({ code: 'ΥΠ-001' });

    const first = await w.api.post(w.base).send({ code: 'YΠ-1', text: 'Πιστοποίηση ISO 9001', type: 'exclusion', folder: 'participation', owner_role_key: 'A', source_ref: ' §2.2.7 ' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ code: 'ΥΠ-001', text: 'Πιστοποίηση ISO 9001', type: 'exclusion', folder: 'participation', owner_role_key: 'A', owner_user_id: null, status: 'open', source_ref: '§2.2.7', changes: [] });

    // the same code in other spellings is the same row → 409, never a second row
    for (const code of ['ΥΠ-001', 'υπ 001', 'YP-1', '1']) {
      const dup = await w.api.post(w.base).send({ code, text: 'x' });
      expect([dup.status, dup.body.error.code], code).toEqual([409, 'requirement_code_exists']);
    }
    const bad = await w.api.post(w.base).send({ code: 'REQ-7', text: 'x' });
    expect([bad.status, bad.body.error.code]).toEqual([422, 'requirement_code_invalid']);
    expect((await w.api.post(w.base).send({ code: 'ΥΠ-002' })).status).toBe(400); // text is required
    expect((await w.api.post(w.base).send({ text: 'x', type: 'optional' })).status).toBe(400);

    // no code → the suggested one
    const auto = await w.api.post(w.base).send({ text: 'Δεύτερη' });
    expect(auto.body.code).toBe('ΥΠ-002');
    await w.api.post(w.base).send({ code: 'ΥΠ-040', text: 'Τεσσαρακοστή' });
    expect((await w.api.get(`${w.base}/next-code`)).body).toEqual({ code: 'ΥΠ-041' });
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(3);

    // the same code may exist in another tender
    const other = await createTender(w.org);
    expect((await w.api.post(`/api/tenders/${other.id}/requirements`).send({ code: 'ΥΠ-001', text: 'x' })).status).toBe(201);

    // renaming onto an existing code is a conflict; renaming to a free one canonicalises
    const clash = await w.api.patch(`${w.base}/${auto.body.id}`).send({ code: 'yp 40' });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'requirement_code_exists']);
    expect((await w.api.patch(`${w.base}/${auto.body.id}`).send({ code: 'υπ-7' })).body.code).toBe('ΥΠ-007');
    expect((await w.api.patch(`${w.base}/${auto.body.id}`).send({ code: 'ΥΠ-007', text: 'ίδιος κωδικός' })).status).toBe(200);
    expect(await dbFor(w.org).findOne('audit_log', { entity: 'requirement', entity_id: first.body.id, action: 'create' })).toMatchObject({ user_id: w.manager.id, tender_id: w.tender.id });
  });

  it('R17: the status "deviation" needs a non-blank note', async () => {
    const w = await world();
    const row = (await w.api.post(w.base).send({ text: 'Εγγύηση 5 ετών', type: 'scored', weight: 'Κ3 – 10%' })).body;
    expect(row.weight).toBe('Κ3 – 10%');

    for (const body of [{ status: 'deviation' }, { status: 'deviation', deviation_note: '   ' }, { status: 'deviation', deviation_note: null }]) {
      const res = await w.api.patch(`${w.base}/${row.id}`).send(body);
      expect([res.status, res.body.error.code]).toEqual([422, 'deviation_note_required']);
    }
    const created = await w.api.post(w.base).send({ text: 'x', status: 'deviation' });
    expect([created.status, created.body.error.code]).toEqual([422, 'deviation_note_required']);

    const ok = await w.api.patch(`${w.base}/${row.id}`).send({ status: 'deviation', deviation_note: 'Προσφέρουμε 3 έτη' });
    expect(ok.body).toMatchObject({ status: 'deviation', deviation_note: 'Προσφέρουμε 3 έτη' });
    // removing the note while still a deviation is refused; leaving the status keeps the note
    const cleared = await w.api.patch(`${w.base}/${row.id}`).send({ deviation_note: '' });
    expect([cleared.status, cleared.body.error.code]).toEqual([422, 'deviation_note_required']);
    expect((await w.api.patch(`${w.base}/${row.id}`).send({ status: 'covered' })).body).toMatchObject({ status: 'covered', deviation_note: 'Προσφέρουμε 3 έτη' });
  });

  it('validates owners: an active user of the org and/or a role of the tender', async () => {
    const w = await world();
    const stranger = await createUser(await createOrg(), 'member');
    const inactive = await createUser(w.org, 'member', { active: false });
    const ok = await w.api.post(w.base).send({ text: 'x', owner_user_id: w.member.id, owner_role_key: 'B' });
    expect(ok.body).toMatchObject({ owner_user_id: w.member.id, owner_role_key: 'B' });
    for (const [body, code] of [
      [{ owner_user_id: stranger.id }, 'owner_user_unknown'],
      [{ owner_user_id: inactive.id }, 'owner_user_unknown'],
      [{ owner_user_id: missingId() }, 'owner_user_unknown'],
      [{ owner_role_key: 'Z' }, 'owner_role_unknown'],
    ] as const) {
      const res = await w.api.patch(`${w.base}/${ok.body.id}`).send(body);
      expect([res.status, res.body.error.code]).toEqual([422, code]);
    }
    expect((await w.api.patch(`${w.base}/${ok.body.id}`).send({ owner_user_id: null, owner_role_key: null })).body).toMatchObject({ owner_user_id: null, owner_role_key: null });
  });

  it('lists with filters, search and sorting; coverage and owners come alongside', async () => {
    const w = await world();
    const db = dbFor(w.org, w.manager);
    const mk = (code: string, over: Record<string, unknown>) => ({ tender_id: w.tender.id, code, text: `Απαίτηση ${code}`, ...over });
    await db.insertMany('requirement', [
      mk('ΥΠ-002', { type: 'exclusion', folder: 'participation', status: 'covered', evidence_ref: 'Παρ. Α', owner_role_key: 'A', source_ref: 'Άρθρο 2.2.4' }),
      mk('ΥΠ-001', { type: 'exclusion', folder: 'technical', status: 'open', owner_role_key: 'B' }),
      mk('ΥΠ-010', { type: 'scored', folder: 'technical', status: 'verified', owner_user_id: w.member.id, text: 'Χρόνος απόκρισης 4 ώρες' }),
      mk('ΥΠ-1000', { type: 'scored', folder: 'technical', status: 'in_progress' }),
      mk('ΥΠ-101', { type: 'formal', folder: 'financial', status: 'deviation', deviation_note: 'λόγος', owner_user_id: w.manager.id }),
      mk('ΥΠ-003', { type: 'formal', folder: null, status: 'open' }),
    ]);
    const codes = async (query: string) => {
      const res = await w.api.get(`${w.base}?${query}`);
      expect(res.status, query).toBe(200);
      return res.body.items.map((r: { code: string }) => r.code);
    };

    const all = await w.api.get(w.base);
    expect(all.body.items.map((r: { code: string }) => r.code)).toEqual(['ΥΠ-001', 'ΥΠ-002', 'ΥΠ-003', 'ΥΠ-010', 'ΥΠ-101', 'ΥΠ-1000']); // numeric order
    expect(all.body.total).toBe(6);
    expect(all.body.nextCode).toBe('ΥΠ-1001');
    expect(all.body.owners.roles).toEqual([
      { key: 'A', name: 'Δικαιολογητικά', user_ids: [] },
      { key: 'B', name: 'Τεχνική', user_ids: [w.member.id] },
      { key: 'C', name: 'Οικονομική', user_ids: [] },
    ]);
    expect(all.body.owners.users.map((u: { id: string }) => u.id).sort()).toEqual([w.manager.id, w.member.id].sort());
    expect(Object.keys(all.body.owners.users[0]).sort()).toEqual(['email', 'id', 'name']);
    expect(all.body.items[0].changes).toEqual([]);

    expect(await codes('type=exclusion')).toEqual(['ΥΠ-001', 'ΥΠ-002']);
    expect(await codes('type=exclusion,formal&status=open')).toEqual(['ΥΠ-001', 'ΥΠ-003']);
    expect(await codes('type=scored&type=formal&dir=desc')).toEqual(['ΥΠ-1000', 'ΥΠ-101', 'ΥΠ-010', 'ΥΠ-003']);
    expect(await codes('folder=technical')).toEqual(['ΥΠ-001', 'ΥΠ-010', 'ΥΠ-1000']);
    expect(await codes('folder=none')).toEqual(['ΥΠ-003']);
    expect(await codes('status=covered,verified')).toEqual(['ΥΠ-002', 'ΥΠ-010']);
    expect(await codes('owner=role:A')).toEqual(['ΥΠ-002']);
    expect(await codes(`owner=${w.manager.id}`)).toEqual(['ΥΠ-101']);
    expect(await codes(`owner=${w.member.id}`)).toEqual(['ΥΠ-001', 'ΥΠ-010']); // own rows + rows of the role held (B)
    expect(await codes('owner=me')).toEqual(['ΥΠ-101']);
    expect(await codes('owner=none')).toEqual(['ΥΠ-003', 'ΥΠ-1000']);
    expect(await codes('missing_evidence=true')).toEqual(['ΥΠ-001']);
    expect(await codes(`q=${encodeURIComponent('απόκρισης')}`)).toEqual(['ΥΠ-010']);
    expect(await codes(`q=${encodeURIComponent('ΑΠΑΊΤΗΣΗ ΥΠ-00')}`)).toEqual(['ΥΠ-001', 'ΥΠ-002', 'ΥΠ-003']);
    expect(await codes(`q=${encodeURIComponent('2.2.4')}`)).toEqual(['ΥΠ-002']);
    expect(await codes('q=yp-10')).toEqual(['ΥΠ-010']); // a code typed with Latin letters
    expect(await codes(`q=${encodeURIComponent('100%_')}`)).toEqual([]); // wildcards are literal
    expect(await codes('sort=status')).toEqual(['ΥΠ-001', 'ΥΠ-003', 'ΥΠ-1000', 'ΥΠ-101', 'ΥΠ-002', 'ΥΠ-010']);
    expect(await codes('sort=type&dir=desc')).toEqual(['ΥΠ-003', 'ΥΠ-101', 'ΥΠ-010', 'ΥΠ-1000', 'ΥΠ-001', 'ΥΠ-002']);
    expect(await codes('limit=2&offset=1')).toEqual(['ΥΠ-002', 'ΥΠ-003']);
    for (const bad of ['type=nope', 'sort=password', 'owner=someone', 'dir=up', 'limit=0']) expect((await w.api.get(`${w.base}?${bad}`)).status, bad).toBe(400);
  });

  it('R17 coverage = (covered + verified) / total per type, with the G1/G3 blockers', async () => {
    const w = await world();
    expect((await w.api.get(`${w.base}/coverage`)).body).toEqual({
      exclusion: { total: 0, covered: 0, ratio: null }, scored: { total: 0, covered: 0, ratio: null }, formal: { total: 0, covered: 0, ratio: null },
      all: { total: 0, covered: 0, ratio: null }, exclusionWithoutEvidence: 0, open: 0, deviations: 0,
    });
    const rows: [string, string, string | null][] = [
      ['exclusion', 'covered', 'Β.1'], ['exclusion', 'verified', 'Β.2'], ['exclusion', 'open', null], ['exclusion', 'in_progress', '  '],
      ['scored', 'verified', null], ['scored', 'deviation', null],
      ['formal', 'open', null], ['formal', 'in_progress', null], ['formal', 'covered', null],
    ];
    await dbFor(w.org).insertMany('requirement', rows.map(([type, status, evidence_ref], i) => ({
      tender_id: w.tender.id, code: `ΥΠ-${String(i + 1).padStart(3, '0')}`, text: 'x', type, status, evidence_ref, deviation_note: status === 'deviation' ? 'λόγος' : null,
    })));
    const expected = {
      exclusion: { total: 4, covered: 2, ratio: 0.5 }, scored: { total: 2, covered: 1, ratio: 0.5 }, formal: { total: 3, covered: 1, ratio: 1 / 3 },
      all: { total: 9, covered: 4, ratio: 4 / 9 }, exclusionWithoutEvidence: 2, open: 4, deviations: 1,
    };
    expect((await w.api.get(`${w.base}/coverage`)).body).toEqual(expected);
    // the list returns the coverage of the whole tender, whatever the filter
    expect((await w.api.get(`${w.base}?type=formal`)).body).toMatchObject({ coverage: expected, total: 9 });
  });

  it('bulk update changes status / owner / folder of a set of rows, all or nothing', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) ids.push((await w.api.post(w.base).send({ text: `Γραμμή ${i}` })).body.id);
    const other = await createTender(w.org);
    const foreign = (await w.api.post(`/api/tenders/${other.id}/requirements`).send({ text: 'x' })).body.id;

    const ok = await w.api.post(`${w.base}/bulk`).send({ ids: ids.slice(0, 3), patch: { status: 'covered', owner_role_key: 'B', folder: 'technical' } });
    expect([ok.status, ok.body]).toEqual([200, { updated: 3 }]);
    const rows = (await w.api.get(w.base)).body.items;
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['covered', 'covered', 'covered', 'open']);
    expect(rows.slice(0, 3).every((r: { owner_role_key: string; folder: string }) => r.owner_role_key === 'B' && r.folder === 'technical')).toBe(true);
    // each row has its own audit entry with only the changed columns
    const audit = await dbFor(w.org).findOne('audit_log', { entity: 'requirement', entity_id: ids[0], action: 'update' });
    expect(audit).toMatchObject({ user_id: w.manager.id, tender_id: w.tender.id, before: { status: 'open', owner_role_key: null, folder: null }, after: { status: 'covered', owner_role_key: 'B', folder: 'technical' } });

    // a deviation without a note fails for the whole set …
    const dev = await w.api.post(`${w.base}/bulk`).send({ ids, patch: { status: 'deviation' } });
    expect([dev.status, dev.body.error.code, dev.body.error.details.count]).toEqual([422, 'deviation_note_required', 4]);
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id, status: 'deviation' })).toBe(0);
    // … and passes with one
    expect((await w.api.post(`${w.base}/bulk`).send({ ids, patch: { status: 'deviation', deviation_note: 'Απόφαση G2' } })).body).toEqual({ updated: 4 });

    // ids of another tender (or unknown) → nothing changes
    const mixed = await w.api.post(`${w.base}/bulk`).send({ ids: [ids[0], foreign], patch: { status: 'open' } });
    expect([mixed.status, mixed.body.error.code]).toEqual([404, 'requirement_not_found']);
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id, status: 'deviation' })).toBe(4);
    expect((await w.api.post(`${w.base}/bulk`).send({ ids, patch: {} })).status).toBe(400);
    expect((await w.api.post(`${w.base}/bulk`).send({ ids, patch: { text: 'x' } })).status).toBe(400);
    expect((await w.api.post(`${w.base}/bulk`).send({ ids, patch: { owner_role_key: 'Z' } })).body.error.code).toBe('owner_role_unknown');
  });

  it('shows the linked change-log entries read-only', async () => {
    const w = await world();
    const row = (await w.api.post(w.base).send({ text: 'x' })).body;
    const db = dbFor(w.org, w.manager);
    const entry = await db.insert('change_entry', { tender_id: w.tender.id, date: '2026-11-10', source: 'esidis', kind: 'clarification', description: 'Διευκρίνιση για ΥΠ-001', reference: 'Αρ. 12' });
    await db.insert('change_entry_requirement', { tender_id: w.tender.id, change_entry_id: entry.id, requirement_id: row.id });
    const expected = [{ id: entry.id, date: '2026-11-10', kind: 'clarification', source: 'esidis', description: 'Διευκρίνιση για ΥΠ-001', reference: 'Αρ. 12' }];
    expect((await w.api.get(w.base)).body.items[0].changes).toEqual(expected);
    expect((await w.api.get(`${w.base}/${row.id}`)).body.changes).toEqual(expected);
    // not writable through this module
    expect((await w.api.patch(`${w.base}/${row.id}`).send({ changes: [] })).status).toBe(400);
  });
});

describe('requirements — permissions and isolation', () => {
  it('members of the tender edit; only bid_manager/admin delete; a viewer is read-only; non-members get 403', async () => {
    const w = await world();
    const row = (await w.api.post(w.base).send({ text: 'x' })).body;
    const file = csv([HEADERS.slice(0, 3), ['ΥΠ-050', '', 'από αρχείο']]);

    const member = await as(w.member);
    expect((await member.get(w.base)).status).toBe(200);
    expect((await member.patch(`${w.base}/${row.id}`).send({ status: 'in_progress' })).status).toBe(200);
    expect((await member.post(w.base).send({ text: 'του μέλους' })).status).toBe(201);
    expect((await member.post(`${w.base}/bulk`).send({ ids: [row.id], patch: { folder: 'technical' } })).status).toBe(200);
    expect((await upload(member, `${w.base}/import/preview`, file)).status).toBe(200);
    expect((await member.delete(`${w.base}/${row.id}`)).status).toBe(403);

    const viewer = await createUser(w.org, 'viewer');
    await addMember(w.tender, viewer);
    const v = await as(viewer);
    for (const path of ['', '/coverage', '/next-code', `/${row.id}`, '/export.xlsx', '/template.xlsx']) expect((await v.get(`${w.base}${path}`)).status, path).toBe(200);
    expect((await v.post(w.base).send({ text: 'x' })).status).toBe(403);
    expect((await v.patch(`${w.base}/${row.id}`).send({ status: 'covered' })).status).toBe(403);
    expect((await v.post(`${w.base}/bulk`).send({ ids: [row.id], patch: { status: 'covered' } })).status).toBe(403);
    expect((await v.delete(`${w.base}/${row.id}`)).status).toBe(403);
    expect((await upload(v, `${w.base}/import/preview`, file)).status).toBe(403);
    expect((await upload(v, `${w.base}/import/commit`, file)).status).toBe(403);

    for (const role of ['member', 'approver', 'viewer'] as const) {
      const outsider = await as(await createUser(w.org, role));
      expect((await outsider.get(w.base)).status, role).toBe(403);
      expect((await outsider.get(`${w.base}/export.xlsx`)).status, role).toBe(403);
      expect((await outsider.post(w.base).send({ text: 'x' })).status, role).toBe(403);
      expect((await upload(outsider, `${w.base}/import/commit`, file)).status, role).toBe(403);
    }
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(2);

    const admin = await as(await createUser(w.org, 'admin'));
    expect((await admin.delete(`${w.base}/${row.id}`)).status).toBe(204);
    expect((await admin.delete(`${w.base}/${row.id}`)).status).toBe(404);
    expect((await w.api.get(`${w.base}/${missingId()}`)).body.error.code).toBe('requirement_not_found');
    expect((await w.api.get(`${w.base}/not-a-uuid`)).status).toBe(404);
  });

  it('a closed tender is read-only', async () => {
    const w = await world();
    const row = (await w.api.post(w.base).send({ text: 'x' })).body;
    await dbFor(w.org).update('tender', w.tender.id, { status: 'submitted' });
    for (const res of [
      await w.api.post(w.base).send({ text: 'y' }),
      await w.api.patch(`${w.base}/${row.id}`).send({ status: 'covered' }),
      await w.api.delete(`${w.base}/${row.id}`),
      await w.api.post(`${w.base}/bulk`).send({ ids: [row.id], patch: { status: 'covered' } }),
      await upload(w.api, `${w.base}/import/commit`, csv([HEADERS.slice(0, 3), ['ΥΠ-050', '', 'x']])),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([422, 'tender_closed']);
    }
    expect((await w.api.get(w.base)).body.items).toHaveLength(1);
    expect((await w.api.get(`${w.base}/export.xlsx`)).status).toBe(200);
  });

  it('cross-org: every endpoint answers 404 and nothing leaks or changes', async () => {
    const w = await world();
    const row = (await w.api.post(w.base).send({ text: 'Εμπιστευτική απαίτηση', evidence_ref: 'Β.1' })).body;
    const foreignOrg = await createOrg();
    const foreign = await as(await createUser(foreignOrg, 'admin'));
    const file = csv([HEADERS.slice(0, 3), ['ΥΠ-001', '', 'παραβίαση'], ['ΥΠ-002', '', 'νέα']]);

    const responses = [
      await foreign.get(w.base),
      await foreign.get(`${w.base}/coverage`),
      await foreign.get(`${w.base}/next-code`),
      await foreign.get(`${w.base}/export.xlsx`),
      await foreign.get(`${w.base}/template.xlsx`),
      await foreign.get(`${w.base}/${row.id}`),
      await foreign.post(w.base).send({ text: 'x' }),
      await foreign.patch(`${w.base}/${row.id}`).send({ text: 'x' }),
      await foreign.delete(`${w.base}/${row.id}`),
      await foreign.post(`${w.base}/bulk`).send({ ids: [row.id], patch: { status: 'covered' } }),
      await upload(foreign, `${w.base}/import/preview`, file),
      await upload(foreign, `${w.base}/import/commit`, file),
    ];
    expect(responses.map((r) => r.status)).toEqual(Array(responses.length).fill(404));
    expect(JSON.stringify(responses.map((r) => r.body))).not.toContain('Εμπιστευτική');

    // the foreign org's own tender never reaches rows, owners or roles of the first org — not even by id
    const theirs = await createTender(foreignOrg);
    const theirBase = `/api/tenders/${theirs.id}/requirements`;
    expect((await foreign.get(`${theirBase}/${row.id}`)).status).toBe(404);
    expect((await foreign.patch(`${theirBase}/${row.id}`).send({ text: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${theirBase}/${row.id}`)).status).toBe(404);
    expect((await foreign.post(`${theirBase}/bulk`).send({ ids: [row.id], patch: { status: 'covered' } })).status).toBe(404);
    expect((await foreign.post(theirBase).send({ text: 'x', owner_user_id: w.member.id })).body.error.code).toBe('owner_user_unknown');
    const list = await foreign.get(theirBase);
    expect(list.body).toMatchObject({ items: [], total: 0, nextCode: 'ΥΠ-001' });
    expect(JSON.stringify(list.body.owners)).not.toContain(w.member.id);
    // importing the same codes there creates their own rows and leaves ours alone
    const imported = await upload(foreign, `${theirBase}/import/commit`, csv([[...HEADERS.slice(0, 3), 'Υπεύθυνος'], ['ΥΠ-001', '', 'δικό τους', w.member.email]]));
    expect(imported.body).toMatchObject({ created: 1, updated: 0 });
    expect(await dbFor(foreignOrg).findOne('requirement', { tender_id: theirs.id })).toMatchObject({ text: 'δικό τους', owner_user_id: null });
    expect(await dbFor(w.org).get('requirement', row.id)).toMatchObject({ text: 'Εμπιστευτική απαίτηση', status: 'open' });
    expect(await dbFor(w.org).count('requirement')).toBe(1);
  });
});

describe('requirements — import', () => {
  const sample = [
    HEADERS,
    ['ΥΠ-001', 'Παράρτημα Ι, §2.4.3, σελ. 45', 'Ο ανάδοχος διαθέτει ISO 9001, ISO 27001', 'Αποκλεισμού', 'Συμμετοχής', '', 'A', '', '', 'Ανοιχτή', ''],
    ['YΠ-2', '§3.1', 'Χρόνος απόκρισης "4 ώρες"; με ποινική ρήτρα', 'Βαθμολογούμενη', 'Τεχνική', 'Κ2 – 15%', 'Β', 'Κεφ. 3.2', 'Παράρτημα Β.3, σελ. 12', 'Καλύφθηκε', ''],
    ['υπ 003', '', 'Υπογραφή νόμιμου εκπροσώπου\nσε κάθε σελίδα', 'Τυπική', 'Οικονομική', '', '', '', '', '', ''],
  ];

  it('preview: detects columns, suggests the mapping, validates each row and counts new vs updated', async () => {
    const w = await world();
    await w.api.post(w.base).send({ code: 'ΥΠ-002', text: 'παλιό κείμενο', type: 'formal' });
    const file = csv([
      ['Κωδικός', 'Source', 'ΚΕΙΜΕΝΟ', 'Τύπος', 'Φάκελος', 'Υπεύθυνος', 'Σχόλια', 'Κατάσταση'],
      ['ΥΠ-001', '§1', 'Πρώτη', 'Αποκλεισμού', 'Συμμετοχής', 'A', 'άσχετο', ''],
      ['YΠ-2', '§2', 'Δεύτερη', 'scored', 'technical', w.member.email, '', 'in_progress'],
      ['', '§3', 'Χωρίς κωδικό', '', '', '', '', ''],
      ['ΥΠ-004', '§4', '', 'Κάτι άλλο', 'Αποθήκη', 'Άγνωστος', '', 'τελείωσε'],
      ['', '', '', '', '', '', '', ''],
      ['ΥΠ-001', '§5', 'Διπλή στο αρχείο', '', '', '', '', ''],
    ]);
    const res = await upload(w.api, `${w.base}/import/preview`, file, 'μητρώο.csv');
    expect(res.status).toBe(200);
    expect(res.body.file).toEqual({ name: 'μητρώο.csv', format: 'csv', encoding: 'utf-8', delimiter: ',', sheets: [], sheet: null, rows: 5 });
    expect(res.body.columns.map((c: { header: string }) => c.header)).toEqual(['Κωδικός', 'Source', 'ΚΕΙΜΕΝΟ', 'Τύπος', 'Φάκελος', 'Υπεύθυνος', 'Σχόλια', 'Κατάσταση']);
    expect(res.body.columns[2]).toEqual({ index: 2, header: 'ΚΕΙΜΕΝΟ', sample: ['Πρώτη', 'Δεύτερη', 'Χωρίς κωδικό'] });
    const mapping = { code: 0, source_ref: 1, text: 2, type: 3, folder: 4, weight: null, owner: 5, response_ref: null, evidence_ref: null, status: 7, deviation_note: null };
    expect(res.body.suggestedMapping).toEqual(mapping);
    expect(res.body.mapping).toEqual(mapping);
    expect(res.body.summary).toEqual({ total: 5, create: 1, update: 1, unchanged: 0, errors: 3, warnings: 1, kept: 0 });
    expect(res.body.rows.map((r: { row: number; code: string; action: string }) => [r.row, r.code, r.action])).toEqual([
      [2, 'ΥΠ-001', 'create'], [3, 'ΥΠ-002', 'update'], [4, null, 'error'], [5, 'ΥΠ-004', 'error'], [7, 'ΥΠ-001', 'error'],
    ]);
    expect(res.body.rows[1]).toMatchObject({ changed: expect.arrayContaining(['text', 'type', 'folder', 'status', 'owner_user_id']), values: { type: 'scored', folder: 'technical', status: 'in_progress', owner: 'Γιώργος Δημητρίου' } });
    expect(res.body.rows[3].errors.map((e: { code: string }) => e.code)).toEqual(['missing_text', 'unknown_type', 'unknown_folder', 'unknown_status']);
    expect(res.body.rows[3].warnings).toEqual([{ field: 'owner', code: 'unknown_owner', value: 'Άγνωστος' }]);
    expect(res.body.rows[4].errors).toEqual([{ field: 'code', code: 'duplicate_code_in_file', value: 'ΥΠ-001', firstRow: 2 }]);
    expect(res.body.rows[0]).not.toHaveProperty('data');
    // nothing was written
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(1);

    // a different mapping chosen by the user is applied
    const remapped = await upload(w.api, `${w.base}/import/preview`, file, 'μητρώο.csv', { mapping: JSON.stringify({ code: 0, text: 6 }) });
    expect(remapped.body.mapping).toMatchObject({ code: 0, text: 6, source_ref: null, type: null });
    expect(remapped.body.suggestedMapping).toEqual(mapping);
    expect(remapped.body.rows[0]).toMatchObject({ action: 'create', values: { code: 'ΥΠ-001', text: 'άσχετο' } });
    for (const bad of ['{"code": 99}', '{"nope": 1}', 'not json', '{"code": "A"}']) {
      const r = await upload(w.api, `${w.base}/import/preview`, file, 'x.csv', { mapping: bad });
      expect(r.body.error?.code, bad).toBe('import_bad_mapping');
    }
  });

  it('commit refuses a file with errors unless skip_invalid, and needs the code column', async () => {
    const w = await world();
    const file = csv([HEADERS.slice(0, 3), ['ΥΠ-001', '', 'ok'], ['ΥΠ-002', '', ''], ['bad', '', 'x']]);
    const refused = await upload(w.api, `${w.base}/import/commit`, file);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'import_has_errors']);
    expect(refused.body.error.details.summary).toMatchObject({ errors: 2, create: 1 });
    expect(refused.body.error.details.rows.map((r: { row: number }) => r.row)).toEqual([3, 4]);
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(0);

    const skipped = await upload(w.api, `${w.base}/import/commit`, file, 'x.csv', { skip_invalid: 'true' });
    expect(skipped.body).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 2, total: 3, overwrite: false });

    const noCode = await upload(w.api, `${w.base}/import/commit`, csv([['Α/Α', 'Περιγραφή'], ['1', 'x']]), 'x.csv', { skip_invalid: 'true' });
    expect([noCode.status, noCode.body.error.code]).toEqual([422, 'import_code_column_required']);
    expect((await w.api.post(`${w.base}/import/commit`).send({})).body.error.code).toBe('import_file_required');
  });

  it('acceptance: importing the same file twice creates no duplicate rows ("0 new, n unchanged")', async () => {
    const w = await world();
    const file = csv(sample);
    const first = await upload(w.api, `${w.base}/import/commit`, file);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ created: 3, updated: 0, unchanged: 0, skipped: 0, total: 3, overwrite: false });

    const rows = (await w.api.get(w.base)).body.items;
    expect(rows.map((r: { code: string }) => r.code)).toEqual(['ΥΠ-001', 'ΥΠ-002', 'ΥΠ-003']);
    expect(rows[0]).toMatchObject({ source_ref: 'Παράρτημα Ι, §2.4.3, σελ. 45', type: 'exclusion', folder: 'participation', owner_role_key: 'A', status: 'open', weight: null });
    expect(rows[1]).toMatchObject({ text: 'Χρόνος απόκρισης "4 ώρες"; με ποινική ρήτρα', type: 'scored', folder: 'technical', weight: 'Κ2 – 15%', owner_role_key: 'B', response_ref: 'Κεφ. 3.2', evidence_ref: 'Παράρτημα Β.3, σελ. 12', status: 'covered' });
    expect(rows[2]).toMatchObject({ text: 'Υπογραφή νόμιμου εκπροσώπου\nσε κάθε σελίδα', type: 'formal', folder: 'financial', source_ref: null, status: 'open' });

    const auditBefore = await dbFor(w.org).count('audit_log', { entity: 'requirement', action: ['create', 'update'] });
    const preview = await upload(w.api, `${w.base}/import/preview`, file);
    expect(preview.body.summary).toEqual({ total: 3, create: 0, update: 0, unchanged: 3, errors: 0, warnings: 0, kept: 0 });
    const second = await upload(w.api, `${w.base}/import/commit`, file);
    expect(second.body).toEqual({ created: 0, updated: 0, unchanged: 3, skipped: 0, total: 3, overwrite: false });
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(3);
    expect(await dbFor(w.org).count('audit_log', { entity: 'requirement', action: ['create', 'update'] })).toBe(auditBefore);
    // the import itself is logged
    expect(await dbFor(w.org).count('audit_log', { entity: 'requirement', action: 'import', tender_id: w.tender.id })).toBe(2);

    // the same content with other spellings of the codes, a BOM, ";" and CRLF is still the same three rows
    const respelled = csv([sample[0] as string[], ...sample.slice(1).map((r, i) => [['yp-1', 'ΥΠ – 002', '3'][i] as string, ...r.slice(1)])], { delimiter: ';', bom: true, eol: '\r\n' });
    const third = await upload(w.api, `${w.base}/import/commit`, respelled);
    expect(third.body).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(3);
  });

  it('merge: file-owned fields follow the file; team-owned fields are kept unless overwrite; rows are never deleted', async () => {
    const w = await world();
    await upload(w.api, `${w.base}/import/commit`, csv(sample));
    const byCode = async () => Object.fromEntries((await w.api.get(w.base)).body.items.map((r: { code: string }) => [r.code, r]));
    const before = await byCode();
    // the team works in the app
    await w.api.patch(`${w.base}/${before['ΥΠ-001'].id}`).send({ response_ref: 'Κεφ. 1.4', evidence_ref: 'Παράρτημα Α.2', status: 'verified', owner_user_id: w.member.id });
    const manual = (await w.api.post(w.base).send({ code: 'ΥΠ-099', text: 'Προστέθηκε με το χέρι' })).body;

    // a new version of the analysis: reworded text, other values for the team's fields, ΥΠ-003 dropped, ΥΠ-004 new
    const v2 = csv([
      HEADERS,
      ['ΥΠ-001', 'Παράρτημα Ι, §2.4.3, σελ. 46', 'Ο ανάδοχος διαθέτει ISO 9001 και ISO 27001', 'Αποκλεισμού', 'Τεχνική', '', 'C', 'Κεφ. 9', 'Παράρτημα Ω', 'Σε εξέλιξη', ''],
      ['ΥΠ-002', '§3.1', sample[2]?.[2] as string, 'Βαθμολογούμενη', 'Τεχνική', 'Κ2 – 20%', 'Β', '', '', '', ''],
      ['ΥΠ-004', '§5', 'Νέα απαίτηση', 'Τυπική', '', '', '', '', '', '', ''],
    ]);
    const preview = await upload(w.api, `${w.base}/import/preview`, v2);
    expect(preview.body.summary).toEqual({ total: 3, create: 1, update: 2, unchanged: 0, errors: 0, warnings: 0, kept: 1 });
    expect(preview.body.rows[0].kept.sort()).toEqual(['evidence_ref', 'owner', 'response_ref', 'status']);
    expect(preview.body.rows[0].changed.sort()).toEqual(['folder', 'source_ref', 'text']);

    const merged = await upload(w.api, `${w.base}/import/commit`, v2);
    expect(merged.body).toEqual({ created: 1, updated: 2, unchanged: 0, skipped: 0, total: 3, overwrite: false });
    let now = await byCode();
    expect(Object.keys(now).sort()).toEqual(['ΥΠ-001', 'ΥΠ-002', 'ΥΠ-003', 'ΥΠ-004', 'ΥΠ-099']); // nothing deleted
    expect(now['ΥΠ-001']).toMatchObject({
      id: before['ΥΠ-001'].id, source_ref: 'Παράρτημα Ι, §2.4.3, σελ. 46', text: 'Ο ανάδοχος διαθέτει ISO 9001 και ISO 27001', folder: 'technical',
      response_ref: 'Κεφ. 1.4', evidence_ref: 'Παράρτημα Α.2', status: 'verified', owner_user_id: w.member.id, owner_role_key: 'A',
    });
    expect(now['ΥΠ-002']).toMatchObject({ weight: 'Κ2 – 20%', response_ref: 'Κεφ. 3.2', evidence_ref: 'Παράρτημα Β.3, σελ. 12', status: 'covered' }); // empty cells clear nothing
    expect(now['ΥΠ-003']).toEqual(before['ΥΠ-003']);
    expect(now['ΥΠ-099']).toMatchObject({ id: manual.id, text: 'Προστέθηκε με το χέρι' });
    const audit = await dbFor(w.org).list('audit_log', { entity: 'requirement', entity_id: before['ΥΠ-001'].id, action: 'update' }, { orderBy: 'at desc' });
    expect(audit[0]).toMatchObject({ user_id: w.manager.id, before: { folder: 'participation' }, after: { folder: 'technical', source_ref: 'Παράρτημα Ι, §2.4.3, σελ. 46' } });
    expect(Object.keys(audit[0]?.after).sort()).toEqual(['folder', 'source_ref', 'text']);

    // with "overwrite" the file wins for the team's fields too
    const over = await upload(w.api, `${w.base}/import/commit`, v2, 'v2.csv', { overwrite: 'true' });
    expect(over.body).toEqual({ created: 0, updated: 1, unchanged: 2, skipped: 0, total: 3, overwrite: true });
    now = await byCode();
    expect(now['ΥΠ-001']).toMatchObject({ response_ref: 'Κεφ. 9', evidence_ref: 'Παράρτημα Ω', status: 'in_progress', owner_user_id: null, owner_role_key: 'C' });
    expect(Object.keys(now)).toHaveLength(5);
  });

  it('reads CSV with BOM and ";" delimiter, UTF-16 and Windows-1253; rejects what it cannot read with a clear code', async () => {
    const w = await world();
    const rows = [HEADERS.slice(0, 5), ['ΥΠ-001', 'Άρθρο 2; παρ. 3', 'Κείμενο με ; και "εισαγωγικά"', 'Αποκλεισμού', 'Τεχνική'], ['ΥΠ-002', '', 'Δεύτερη, με κόμμα', 'Τυπική', '']];

    const semi = await upload(w.api, `${w.base}/import/preview`, csv(rows, { delimiter: ';', bom: true, eol: '\r\n' }));
    expect(semi.body.file).toMatchObject({ format: 'csv', encoding: 'utf-8', delimiter: ';', rows: 2 });
    expect(semi.body.columns[0].header).toBe('Κωδικός'); // BOM stripped
    expect(semi.body.summary).toMatchObject({ create: 2, errors: 0 });
    expect(semi.body.rows[0].values).toMatchObject({ source_ref: 'Άρθρο 2; παρ. 3', text: 'Κείμενο με ; και "εισαγωγικά"', type: 'exclusion', folder: 'technical' });
    expect(semi.body.rows[1].values.text).toBe('Δεύτερη, με κόμμα');

    // Windows-1253 (what Greek Excel writes for plain "CSV")
    const greek = 'ΆΈΉΊΌΎΏΐ' + String.fromCharCode(...Array.from({ length: 0x3ce - 0x391 + 1 }, (_, i) => 0x391 + i).filter((c) => c !== 0x3a2));
    const to1253 = (s: string) => Buffer.from([...s].map((ch) => {
      const c = ch.codePointAt(0) as number;
      if (c < 0x80) return c;
      if (c === 0x386) return 0xa2;
      if (c >= 0x388 && c <= 0x3ce) return c - 0x388 + 0xb8;
      throw new Error(`cannot encode ${ch}`);
    }));
    expect(new TextDecoder('windows-1253').decode(to1253(greek))).toBe(greek);
    const cp = await upload(w.api, `${w.base}/import/preview`, to1253('Κωδικός;Κείμενο;Τύπος\r\nΥΠ-001;Υπεύθυνη δήλωση;Τυπική\r\n'));
    expect(cp.status).toBe(200);
    expect(cp.body.file).toMatchObject({ encoding: 'windows-1253', delimiter: ';' });
    expect(cp.body.rows[0]).toMatchObject({ action: 'create', values: { code: 'ΥΠ-001', text: 'Υπεύθυνη δήλωση', type: 'formal' } });

    // UTF-16LE with tabs (Excel "Unicode text")
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Κωδικός\tΚείμενο\r\nΥΠ-001\tΚείμενο\r\n', 'utf16le')]);
    expect((await upload(w.api, `${w.base}/import/preview`, utf16)).body.file).toMatchObject({ encoding: 'utf-16le', delimiter: '\t', rows: 1 });

    const codeOf = async (buf: Buffer, name = 'x.csv') => {
      const r = await upload(w.api, `${w.base}/import/preview`, buf, name);
      return [r.status, r.body.error?.code];
    };
    expect(await codeOf(Buffer.from([0x4b, 0xf9, 0x81, 0x8d, 0x90, 0x0a]))).toEqual([422, 'import_bad_encoding']);
    expect(await codeOf(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'old.xls')).toEqual([422, 'import_unsupported_file']);
    expect(await codeOf(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]), 'x.pdf')).toEqual([422, 'import_unsupported_file']);
    expect(await codeOf(Buffer.from('PK\u0003\u0004 not really a workbook'), 'x.xlsx')).toEqual([422, 'import_unreadable_file']);
    expect(await codeOf(Buffer.from('\n\n  \n'))).toEqual([422, 'import_empty_file']);
    expect(await codeOf(Buffer.alloc(0))).toEqual([expect.any(Number), expect.stringMatching(/import_empty_file|import_file_required/)]);
    expect(await codeOf(Buffer.alloc(5 * 1024 * 1024 + 10, 0x61))).toEqual([413, 'import_file_too_large']);

    // review M1 — a zip bomb: ~200 kB on the wire that inflates to 200 MB, with a central directory that lies
    // about the size. Refused before the workbook is loaded, with the existing "too large" code.
    const { deflateRawSync } = await import('node:zlib');
    const bomb = (claimedSize: number) => {
      const data = deflateRawSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 });
      const name = Buffer.from('xl/worksheets/sheet1.xml');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(claimedSize, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(claimedSize, 24);
      central.writeUInt16LE(name.length, 28);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(46 + name.length, 12);
      eocd.writeUInt32LE(30 + name.length + data.length, 16);
      return Buffer.concat([local, name, data, central, name, eocd]);
    };
    const small = bomb(1000);
    expect(small.length).toBeLessThan(1024 * 1024);
    const heapBefore = process.memoryUsage().rss;
    expect(await codeOf(small, 'bomb.xlsx')).toEqual([413, 'import_file_too_large']);
    expect(await codeOf(bomb(200 * 1024 * 1024), 'bomb.xlsx')).toEqual([413, 'import_file_too_large']);
    expect(process.memoryUsage().rss - heapBefore).toBeLessThan(150 * 1024 * 1024);
    expect((await upload(w.api, `${w.base}/import/commit`, small, 'bomb.xlsx')).status).toBe(413);
    expect(await codeOf(csv([['Κωδικός', 'Κείμενο'], ...Array.from({ length: 5001 }, (_, i) => [`ΥΠ-${i + 1}`, 'x'])]))).toEqual([422, 'import_too_many_rows']);
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(0);
  });

  it('XLSX: export → import round-trips unchanged; the compliance sheet has Greek headers, a frozen header and filters', async () => {
    const w = await world();
    const db = dbFor(w.org, w.manager);
    const twin = await createUser(w.org, 'member', { name: 'Γιώργος Δημητρίου' }); // same name as w.member → exported by e-mail
    await db.insertMany('requirement', [
      { tender_id: w.tender.id, code: 'ΥΠ-001', source_ref: 'Παράρτημα Ι, §2.4.3, σελ. 45', text: 'Πολλές\nγραμμές, "εισαγωγικά"; και =SUM(A1)', type: 'exclusion', folder: 'participation', owner_role_key: 'A', owner_user_id: w.manager.id, response_ref: 'Κεφ. 2', evidence_ref: 'Παράρτημα Β.3, σελ. 12', status: 'verified' },
      { tender_id: w.tender.id, code: 'ΥΠ-002', text: '0042', type: 'scored', folder: 'technical', weight: 'Κ1 – 20%', owner_user_id: twin.id, status: 'deviation', deviation_note: 'Προσφέρουμε ισοδύναμο' },
      { tender_id: w.tender.id, code: 'ΥΠ-003', text: 'Χωρίς τίποτα άλλο', type: 'formal', folder: null, status: 'open' },
      { tender_id: w.tender.id, code: 'ΥΠ-004', text: '2026-11-13', type: 'formal', folder: 'financial', owner_role_key: 'C', status: 'in_progress', source_ref: '12' },
      { tender_id: w.tender.id, code: 'ΥΠ-1200', text: 'Τελευταία', type: 'scored', folder: 'technical', owner_user_id: w.member.id, status: 'covered' },
    ]);
    const before = (await w.api.get(w.base)).body.items;

    const res = await binary(w.api.get(`${w.base}/export.xlsx`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Φύλλο συμμόρφωσης')}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const ws = wb.worksheets[0] as ExcelJS.Worksheet;
    expect(ws.name).toBe('Φύλλο συμμόρφωσης');
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(HEADERS);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.rowCount).toBe(6);
    expect((ws.getRow(2).values as unknown[]).slice(1)).toEqual(['ΥΠ-001', 'Παράρτημα Ι, §2.4.3, σελ. 45', 'Πολλές\nγραμμές, "εισαγωγικά"; και =SUM(A1)', 'Αποκλεισμού', 'Συμμετοχής', '', 'A; Μαρία Αντωνίου', 'Κεφ. 2', 'Παράρτημα Β.3, σελ. 12', 'Ελέγχθηκε', '']);
    expect(ws.getRow(2).getCell(3).type).toBe(ExcelJS.ValueType.String); // never a formula
    expect(ws.getRow(3).getCell(7).value).toBe(twin.email);
    expect(ws.getRow(3).getCell(10).value).toBe('Απόκλιση');
    expect(ws.getColumn(3).width).toBeGreaterThan(40);

    // importing our own export changes nothing — with and without "overwrite"
    for (const overwrite of ['false', 'true']) {
      const preview = await upload(w.api, `${w.base}/import/preview`, res.body, 'export.xlsx', { overwrite });
      expect(preview.body.file).toMatchObject({ format: 'xlsx', sheets: ['Φύλλο συμμόρφωσης'], sheet: 'Φύλλο συμμόρφωσης', rows: 5 });
      expect(preview.body.summary).toEqual({ total: 5, create: 0, update: 0, unchanged: 5, errors: 0, warnings: 0, kept: 0 });
      expect((await upload(w.api, `${w.base}/import/commit`, res.body, 'export.xlsx', { overwrite })).body).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    }
    expect((await w.api.get(w.base)).body.items).toEqual(before);

    // … and into an empty tender (same roles) it reproduces the register exactly
    const copy = await createTender(w.org);
    for (const key of ['A', 'B', 'C']) await addRole(copy, key);
    const copyBase = `/api/tenders/${copy.id}/requirements`;
    expect((await upload(w.api, `${copyBase}/import/commit`, res.body, 'export.xlsx')).body).toMatchObject({ created: 5, skipped: 0 });
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ id: _i, tender_id: _t, created_at: _c, updated_at: _u, created_by: _b, sort: _s, changes: _ch, ...rest }) => rest);
    expect(strip((await w.api.get(copyBase)).body.items)).toEqual(strip(before));
    const again = await binary(w.api.get(`${copyBase}/export.xlsx`));
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(again.body as unknown as ArrayBuffer);
    for (let r = 1; r <= 6; r++) expect(wb2.worksheets[0]?.getRow(r).values).toEqual(ws.getRow(r).values);

    // the export takes the list's filters
    const filtered = await binary(w.api.get(`${w.base}/export.xlsx?type=scored`));
    const wb3 = new ExcelJS.Workbook();
    await wb3.xlsx.load(filtered.body as unknown as ArrayBuffer);
    expect(wb3.worksheets[0]?.rowCount).toBe(3);
  });

  it('XLSX: the template is an empty register sheet plus a sheet of instructions; a chosen sheet can be imported', async () => {
    const w = await world();
    const res = await binary(w.api.get(`${w.base}/template.xlsx`));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Απαιτήσεις', 'Οδηγίες']);
    expect((wb.worksheets[0]?.getRow(1).values as unknown[]).slice(1)).toEqual(HEADERS);
    expect(wb.worksheets[0]?.rowCount).toBe(1);
    const help = JSON.stringify(wb.worksheets[1]?.getSheetValues());
    for (const word of ['Αποκλεισμού (exclusion)', 'Οικονομική (financial)', 'Ελέγχθηκε (verified)', 'ΥΠ-001', 'source_ref', 'B (Τεχνική)']) expect(help).toContain(word);

    // the empty template has nothing to import
    const empty = await upload(w.api, `${w.base}/import/preview`, res.body, 'template.xlsx');
    expect(empty.body).toMatchObject({ file: { format: 'xlsx', sheets: ['Απαιτήσεις', 'Οδηγίες'], sheet: 'Απαιτήσεις', rows: 0 }, summary: { total: 0 } });

    // fill the template (numbers and rich text included) and import it
    const ws = wb.worksheets[0] as ExcelJS.Worksheet;
    ws.addRow(['ΥΠ-001', 'Άρθρο 2', { richText: [{ text: 'Πλούσιο ' }, { font: { bold: true }, text: 'κείμενο' }] }, 'Αποκλεισμού', 'Τεχνική', '', 'Β', '', '', '', '']);
    ws.addRow([2, 45, 'Αριθμητικός κωδικός', 'Τυπική', '', 15.5, '', '', '', '', '']);
    const other = wb.addWorksheet('Άλλο φύλλο');
    other.addRow(['code', 'text']);
    other.addRow(['ΥΠ-900', 'Από το τρίτο φύλλο']);
    const filled = Buffer.from(await wb.xlsx.writeBuffer());
    const preview = await upload(w.api, `${w.base}/import/preview`, filled, 'filled.xlsx');
    expect(preview.body.summary).toMatchObject({ total: 2, create: 2, errors: 0 });
    expect(preview.body.rows.map((r: { row: number; values: unknown }) => [r.row, r.values])).toEqual([
      [2, { code: 'ΥΠ-001', source_ref: 'Άρθρο 2', text: 'Πλούσιο κείμενο', type: 'exclusion', folder: 'technical', owner: 'B' }],
      [3, { code: 'ΥΠ-002', source_ref: '45', text: 'Αριθμητικός κωδικός', type: 'formal', weight: '15.5' }],
    ]);
    const third = await upload(w.api, `${w.base}/import/preview`, filled, 'filled.xlsx', { sheet: 'Άλλο φύλλο' });
    expect(third.body).toMatchObject({ file: { sheet: 'Άλλο φύλλο', rows: 1 }, rows: [{ code: 'ΥΠ-900', action: 'create' }] });
    const missing = await upload(w.api, `${w.base}/import/preview`, filled, 'filled.xlsx', { sheet: 'Δεν υπάρχει' });
    expect([missing.status, missing.body.error.code, missing.body.error.details.sheets]).toEqual([422, 'import_unknown_sheet', ['Απαιτήσεις', 'Οδηγίες', 'Άλλο φύλλο']]);
  });

  it('performance sanity: 1,000 rows import, list and export well within a couple of seconds', async () => {
    const w = await world();
    const rows = [HEADERS, ...Array.from({ length: 1000 }, (_, i) => [
      `ΥΠ-${String(i + 1).padStart(3, '0')}`, `Παράρτημα Ι, §${(i % 40) + 1}.${(i % 7) + 1}, σελ. ${i + 10}`,
      `Η προσφερόμενη λύση οφείλει να καλύπτει την απαίτηση ${i + 1} όπως περιγράφεται αναλυτικά στο αντίστοιχο άρθρο της διακήρυξης.`,
      ['Αποκλεισμού', 'Βαθμολογούμενη', 'Τυπική'][i % 3] as string, ['Συμμετοχής', 'Τεχνική', 'Οικονομική'][i % 3] as string, i % 3 === 1 ? `Κ${i % 9} – 5%` : '', ['A', 'B', 'C'][i % 3] as string, '', '', 'Ανοιχτή', '',
    ])];
    const file = csv(rows);
    const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
      const t = performance.now();
      const out = await fn();
      return [out, performance.now() - t];
    };
    await w.api.get(w.base); // warm-up (schema cache, session)

    const [preview, tPreview] = await time(() => upload(w.api, `${w.base}/import/preview`, file));
    expect(preview.body.summary).toMatchObject({ total: 1000, create: 1000, errors: 0 });
    const [commit, tCommit] = await time(() => upload(w.api, `${w.base}/import/commit`, file));
    expect(commit.body).toMatchObject({ created: 1000, updated: 0 });
    const [again, tAgain] = await time(() => upload(w.api, `${w.base}/import/commit`, file));
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 1000 });
    expect(await dbFor(w.org).count('requirement', { tender_id: w.tender.id })).toBe(1000);

    // 1,000 updates in one go (reworded text), then a bulk status change on every row
    const v2 = csv(rows.map((r, i) => (i === 0 ? r : r.map((c, j) => (j === 2 ? `${c} (αναθ.)` : c)))));
    const [updated, tUpdate] = await time(() => upload(w.api, `${w.base}/import/commit`, v2));
    expect(updated.body).toMatchObject({ created: 0, updated: 1000, unchanged: 0 });
    const [list, tList] = await time(() => w.api.get(w.base));
    expect(list.body.items).toHaveLength(1000);
    expect(list.body.items[999]).toMatchObject({ code: 'ΥΠ-1000', text: expect.stringContaining('(αναθ.)') });
    expect(list.body.coverage.all).toEqual({ total: 1000, covered: 0, ratio: 0 });
    const [filtered, tFilter] = await time(() => w.api.get(`${w.base}?type=scored&owner=role:B&q=${encodeURIComponent('απαίτηση 5')}&sort=text&dir=desc`));
    expect(filtered.body.items.length).toBeGreaterThan(0);
    const ids = list.body.items.map((r: { id: string }) => r.id);
    const [bulk, tBulk] = await time(() => w.api.post(`${w.base}/bulk`).send({ ids, patch: { status: 'in_progress' } }));
    expect(bulk.body).toEqual({ updated: 1000 });
    expect(await dbFor(w.org).count('audit_log', { entity: 'requirement', action: 'update', tender_id: w.tender.id })).toBe(2000);
    const [exported, tExport] = await time(async () => binary(w.api.get(`${w.base}/export.xlsx`)));
    const [round, tRound] = await time(() => upload(w.api, `${w.base}/import/preview`, exported.body, 'export.xlsx'));
    expect(round.body.summary).toMatchObject({ total: 1000, unchanged: 1000 });

    const timings = { tPreview, tCommit, tAgain, tUpdate, tList, tFilter, tBulk, tExport, tRound };
    console.log('1,000-row timings (ms):', Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])));
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(2000);
    expect(tList).toBeLessThan(1000);
  });
});
