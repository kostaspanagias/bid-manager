import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushEvents, on } from '../../core/events.js';
import { seedTemplateL11 } from '../../db/seed.js';
import { greekHolidays } from '../../domain/calendar.js';
import { lastRequestDate } from '../../domain/watch.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId, seedHolidays, type TestOrg, type TestUser } from '../../test/harness.js';

// The scenarios are pinned to the spec's dates (T = Fri 07/05/2027), so "today" is pinned too: Fri 13/11/2026.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T10:00:00Z') });
});
afterAll(() => {
  vi.useRealTimers();
});

const holidays = new Set([2026, 2027].flatMap((y) => greekHolidays(y).map((h) => h.date)));

interface World {
  org: TestOrg;
  admin: TestUser;
  templateId: string;
}
async function world(): Promise<World> {
  const org = await createOrg();
  await seedHolidays(org, [2026, 2027]);
  const { template } = await seedTemplateL11(dbFor(org));
  return { org, admin: await createUser(org, 'admin'), templateId: template.id };
}

const body = (w: World, overrides: Record<string, unknown> = {}) => ({
  title: 'Προμήθεια εξοπλισμού πληροφορικής',
  authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης',
  adam: '27PROC012345678',
  esidis_no: '345678',
  cpv: ['30200000-1', '72000000-5'],
  budget_net: 1_000_000,
  budget_gross: 1_240_000,
  lots: [
    { no: 1, title: 'Εξυπηρετητές', budget_net: 600_000 },
    { no: 2, title: 'Σταθμοί εργασίας', budget_net: 400_000 },
  ],
  t0_published_at: '2027-03-01',
  questions_deadline_at: '2027-04-20T12:00:00Z',
  submission_deadline_at: '2027-05-07T12:00:00Z', // Fri 07/05/2027 15:00 Athens
  guarantee_amount: 20_000,
  offer_validity_days: 180,
  template_id: w.templateId,
  ...overrides,
});

async function create(w: World, overrides: Record<string, unknown> = {}) {
  const res = await as(w.admin).post('/api/tenders').send(body(w, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { tender: Record<string, any>; warnings: { code: string; severity: string; data: Record<string, any> }[]; [k: string]: any };
}

async function dates(w: World, tenderId: string): Promise<Record<string, string>> {
  const rows = await dbFor(w.org).list('milestone', { tender_id: tenderId });
  return Object.fromEntries(rows.map((m) => [m.key, m.due_date]));
}

describe('POST /api/tenders — create and apply the template (F1, F2)', () => {
  it('admin and bid manager create; member, approver and viewer do not', async () => {
    const w = await world();
    for (const role of ['member', 'approver', 'viewer'] as const) {
      expect((await as(await createUser(w.org, role)).post('/api/tenders').send(body(w))).status).toBe(403);
    }
    expect((await as(await createUser(w.org, 'bid_manager')).post('/api/tenders').send(body(w))).status).toBe(201);
    expect(await dbFor(w.org).count('tender')).toBe(1);
  });

  it('stores every F1 field, the template reference and the snapshot; emits tender.created', async () => {
    const w = await world();
    const created: string[] = [];
    const off = on('tender.created', (_ctx, p) => void created.push(p.tenderId));
    const res = await create(w, { guarantee_valid_until: '2028-01-31', guarantee_margin_days: 45, has_demo: true, notes: 'Σημείωση' });
    await flushEvents();
    off();
    expect(created).toEqual([res.tender.id]);

    expect(res.tender).toMatchObject({
      title: 'Προμήθεια εξοπλισμού πληροφορικής',
      authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης',
      adam: '27PROC012345678',
      esidis_no: '345678',
      cpv: ['30200000-1', '72000000-5'],
      budget_net: 1_000_000,
      budget_gross: 1_240_000,
      lots: [
        { no: 1, title: 'Εξυπηρετητές', budget_net: 600_000 },
        { no: 2, title: 'Σταθμοί εργασίας', budget_net: 400_000 },
      ],
      t0_published_at: '2027-02-28T22:00:00.000Z', // 01/03/2027 00:00 Athens
      questions_deadline_at: '2027-04-20T12:00:00.000Z',
      submission_deadline_at: '2027-05-07T12:00:00.000Z',
      guarantee_amount: 20_000,
      guarantee_valid_until: '2028-01-31',
      guarantee_margin_days: 45,
      offer_validity_days: 180,
      has_demo: true,
      has_partners: false,
      status: 'evaluation',
      compressed_mode: false,
      template_id: w.templateId,
      template_version: 'v1.1',
      template_name: 'L',
      notes: 'Σημείωση',
      closed_at: null,
    });
    expect(res.tender).not.toHaveProperty('template_snapshot');
    expect(res).toMatchObject({ T: '2027-05-07', T0: '2027-03-01', permissions: { canWrite: true, canSeeFinancial: true, canManage: true } });

    const row = await dbFor(w.org).get('tender', res.tender.id);
    expect(row?.created_by).toBe(w.admin.id);
    expect(row?.template_snapshot.template).toMatchObject({ id: w.templateId, name: 'L', version: 'v1.1' });
    expect(row?.template_snapshot.items).toHaveLength(await dbFor(w.org).count('template_item', { template_id: w.templateId }));
    expect(await dbFor(w.org).findOne('audit_log', { entity: 'tender', entity_id: res.tender.id, action: 'create' })).toMatchObject({ user_id: w.admin.id });
  });

  it('creates roles, milestones, gates with criteria, handoff tasks, tasks, checklists and watch items', async () => {
    const w = await world();
    const mgmt = await createUser(w.org, 'approver');
    const tech = await createUser(w.org, 'member');
    const tech2 = await createUser(w.org, 'member');
    const res = await create(w, {
      members: [
        { user_id: tech.id, role_key: 'B' },
        { user_id: tech2.id, role_key: 'B' },
        { user_id: mgmt.id, role_key: 'MGMT' },
        { user_id: mgmt.id, role_key: 'MGMT' }, // duplicates are ignored
      ],
    });
    const db = dbFor(w.org);
    const where = { tender_id: res.tender.id };

    const roles = await db.list('tender_role', where, { orderBy: 'sort' });
    expect(roles.map((r) => r.key)).toEqual(['A', 'B', 'C', 'MGMT']);
    expect(roles.find((r) => r.key === 'C')?.payload).toMatchObject({ folder: 'financial', financial: true });
    expect(await db.count('tender_member', where)).toBe(3);

    const milestones = await db.list('milestone', where);
    expect(milestones.map((m) => `${m.kind}:${m.key}`).sort()).toEqual(
      ['gate:G0', 'gate:G1', 'gate:G2', 'gate:G3', 'gate:G4', 'handoff:H1', 'handoff:H2', 'handoff:H3', 'handoff:H4', 'handoff:H5', 'milestone:UPLOAD'].sort(),
    );
    for (const m of milestones) expect(m).toMatchObject({ is_manual: false, needs_review: false, done_at: null });
    expect(milestones.find((m) => m.key === 'G1')?.computed_from).toMatchObject({ anchor: 'T', offset_value: -8, offset_unit: 'working', rule: 'offset' });

    const gates = await db.list('gate', where);
    const gate = (key: string) => gates.find((g) => g.key === key);
    expect(gates).toHaveLength(5);
    expect(gate('G0')).toMatchObject({ decision_mode: 'go_no_go', approver_role_key: 'MGMT', approver_user_id: mgmt.id, decision: 'pending' });
    expect(gate('G1')).toMatchObject({ decision_mode: 'approval', approver_role_key: 'B', approver_user_id: tech.id }); // first holder of the role
    expect(gate('G2')).toMatchObject({ approver_role_key: 'MGMT', approver_user_id: mgmt.id });
    expect(gate('G3')).toMatchObject({ approver_role_key: 'B' });
    expect(gate('G4')).toMatchObject({ approver_role_key: 'MGMT' });
    for (const g of gates) expect(g.milestone_id).toBe(milestones.find((m) => m.key === g.key)?.id);

    const criteria = await db.list('gate_criterion', where, { orderBy: 'sort' });
    const perGate = (key: string) => criteria.filter((c) => c.gate_id === gate(key)?.id);
    expect(['G0', 'G1', 'G2', 'G3', 'G4'].map((k) => perGate(k).length)).toEqual([6, 5, 4, 9, 6]);
    expect(criteria.filter((c) => c.type === 'auto').map((c) => `${gates.find((g) => g.id === c.gate_id)?.key}:${c.auto_rule}`)).toEqual([
      'G1:exclusion_evidence_100',
      'G1:handoffs_received',
      'G3:register_no_open',
      'G4:guarantee_arrived',
      'G4:docs_valid_on_T',
    ]);
    expect(perGate('G0')[0]).toMatchObject({ text: 'Ανάλυση διακήρυξης και cheat sheet έτοιμα', type: 'manual', auto_rule: null, checked_at: null });

    const tasks = await db.list('task', where, { orderBy: 'sort' });
    const handoffs = tasks.filter((t) => t.section === 'handoff');
    expect(handoffs.map((h) => [h.key, h.handoff_from_role, h.handoff_to_role])).toEqual([
      ['H1', 'B', 'A'],
      ['H2', 'A', 'B'],
      ['H3', 'B', 'C'],
      ['H4', 'C', 'B'],
      ['H5', 'A', 'C'],
    ]);
    for (const h of handoffs) {
      const m = milestones.find((x) => x.key === h.key);
      expect(h).toMatchObject({ milestone_id: m?.id, due_date: m?.due_date, status: 'open', received_at: null });
    }
    // no demo, no partners: the conditional lines are not created
    expect(tasks.filter((t) => t.section === 'checklist')).toHaveLength(17);
    expect(tasks.filter((t) => t.section === 'checklist').map((t) => t.owner_role_key).sort().join('')).toBe('AAAAA' + 'BBBBBB' + 'CCCCCC');
    expect(tasks.filter((t) => t.section === 'task').map((t) => t.key)).toEqual(['WP1', 'WP2', 'WP3', 'WP5', 'WP6', 'WP7', 'WP9', 'WP10', 'WP11']);
    expect(tasks.find((t) => t.key === 'WP7')).toMatchObject({ owner_role_key: 'C', due_date: '2027-04-29', milestone_id: milestones.find((m) => m.key === 'G2')?.id });
    expect(tasks.find((t) => t.key === 'WP2')).toMatchObject({ due_date: null, milestone_id: null });

    const watch = await db.list('watch_item', where, { orderBy: 'sort' });
    expect(watch.map((x) => x.key)).toEqual(['guarantee', 'maf', 'vendor_quotes', 'cvs', 'certificates', 'signatures']);
    expect(watch[0]).toMatchObject({ owner_role_key: 'A', lead_value: 10, lead_unit: 'calendar', needed_milestone_key: 'G4', needed_at: '2027-05-05', requested_at: null });
    expect(watch[1]).toMatchObject({ lead_value: null, needed_milestone_key: 'G1', needed_at: '2027-04-23' });
    expect(watch[0]?.checks).toContain('ισχύς ≥ ισχύς προσφοράς');
  });

  it('demo / partners items exist only when the flag is set (F2)', async () => {
    const w = await world();
    const count = async (id: string) => {
      const db = dbFor(w.org);
      const tasks = await db.list('task', { tender_id: id });
      return {
        checklist: tasks.filter((t) => t.section === 'checklist').length,
        tasks: tasks.filter((t) => t.section === 'task').length,
        watch: await db.count('watch_item', { tender_id: id }),
      };
    };
    expect(await count((await create(w)).tender.id)).toEqual({ checklist: 17, tasks: 9, watch: 6 });
    expect(await count((await create(w, { has_demo: true })).tender.id)).toEqual({ checklist: 19, tasks: 10, watch: 7 });
    expect(await count((await create(w, { has_partners: true })).tender.id)).toEqual({ checklist: 19, tasks: 10, watch: 7 });
    const both = await create(w, { has_demo: true, has_partners: true });
    expect(await count(both.tender.id)).toEqual({ checklist: 21, tasks: 11, watch: 8 });
    expect((await dbFor(w.org).list('watch_item', { tender_id: both.tender.id })).map((x) => x.key)).toEqual(expect.arrayContaining(['partner_docs', 'demo_unit']));
  });

  it('the snapshot protects the tender from later template changes (F2)', async () => {
    const w = await world();
    const res = await create(w);
    const db = dbFor(w.org);
    const g1 = await db.findOne('template_item', { template_id: w.templateId, kind: 'gate', key: 'G1' });
    await db.update('template_item', g1?.id, { offset_value: -6 });
    // an extension recomputes from the snapshot, not from the edited template
    const ext = await as(w.admin).post(`/api/tenders/${res.tender.id}/deadline`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' });
    expect(ext.status).toBe(200);
    expect((await dates(w, res.tender.id)).G1).toBe('2027-05-04'); // T−8 of the new T, not T−6
  });

  it('validates input and the template', async () => {
    const w = await world();
    const api = await as(w.admin);
    const bad = async (overrides: Record<string, unknown>) => (await api.post('/api/tenders').send(body(w, overrides))).status;
    expect(await bad({ title: '' })).toBe(400);
    expect(await bad({ authority: undefined })).toBe(400);
    expect(await bad({ submission_deadline_at: '2027-05-07' })).toBe(400); // needs date + time
    expect(await bad({ submission_deadline_at: undefined })).toBe(400);
    expect(await bad({ budget_net: -1 })).toBe(400);
    expect(await bad({ lots: [{ no: 1 }] })).toBe(400);
    expect(await bad({ guarantee_valid_until: '31/01/2028' })).toBe(400);
    expect(await bad({ template_id: undefined })).toBe(400);
    expect(await bad({ status: 'submitted' })).toBe(400);
    expect(await bad({ org_id: missingId() })).toBe(400);

    const code = async (overrides: Record<string, unknown>) => {
      const res = await api.post('/api/tenders').send(body(w, overrides));
      return [res.status, res.body.error?.code];
    };
    expect(await code({ template_id: missingId() })).toEqual([422, 'template_not_found']);
    const draft = await dbFor(w.org).insert('template', { name: 'Πρόχειρο', version: '0.1', status: 'draft' });
    expect(await code({ template_id: draft.id })).toEqual([422, 'template_not_published']);
    const foreign = await world();
    expect(await code({ template_id: foreign.templateId })).toEqual([422, 'template_not_found']);
    expect(await code({ t0_published_at: '2027-05-08' })).toEqual([422, 't0_after_deadline']);
    expect(await code({ questions_deadline_at: '2027-05-08T09:00:00Z' })).toEqual([422, 'questions_after_deadline']);
    expect(await code({ budget_gross: 10 })).toEqual([422, 'budget_gross_below_net']);
    expect(await code({ members: [{ user_id: missingId(), role_key: 'A' }] })).toEqual([422, 'unknown_user']);
    expect(await code({ members: [{ user_id: w.admin.id, role_key: 'Z' }] })).toEqual([422, 'unknown_tender_role']);
    expect(await code({ members: [{ user_id: foreign.admin.id, role_key: 'A' }] })).toEqual([422, 'unknown_user']);
    expect(await dbFor(w.org).count('tender')).toBe(0); // nothing half-created
    expect(await dbFor(w.org).count('milestone')).toBe(0);
  });
});

describe('scheduler through the API (F3, R4–R8)', () => {
  it('acceptance: T = Fri 07/05/2027 → G4 05/05, G3 04/05, G2 29/04, G1 23/04, G0 latest 21/04', async () => {
    const w = await world();
    const res = await create(w);
    const list = await as(w.admin).get(`/api/tenders/${res.tender.id}/milestones`);
    expect(list.status).toBe(200);
    const by = Object.fromEntries(list.body.items.map((m: { key: string }) => [m.key, m]));
    expect(by.G4).toMatchObject({ due_date: '2027-05-05', tMinus: 2, kind: 'gate' });
    expect(by.G3).toMatchObject({ due_date: '2027-05-04', tMinus: 3 });
    expect(by.G2).toMatchObject({ due_date: '2027-04-29', tMinus: 4 }); // Good Friday 30/04 and Easter Monday 03/05 are skipped
    expect(by.G1).toMatchObject({ due_date: '2027-04-23', tMinus: 8 });
    expect(by.UPLOAD).toMatchObject({ due_date: '2027-05-06', tMinus: 1, kind: 'milestone' });
    expect(by.G0.computed_from).toMatchObject({ latest_date: '2027-04-21', target_date: '2027-03-04', rule: 'target' });
    expect(by.G0.due_date).toBe('2027-03-04'); // target T0+3
    expect(by.H4).toMatchObject({ due_date: '2027-04-22', tMinus: 9, kind: 'handoff' });
    expect(res.warnings).toEqual([]);

    // with a late publication the binding date T−10 applies
    const late = await create(w, { t0_published_at: '2027-04-16', questions_deadline_at: null });
    const lateDates = await dates(w, late.tender.id);
    expect(lateDates.G0).toBe('2027-04-21');
    expect(late.tender.compressed_mode).toBe(true); // a target after T−10 implies fewer than 13 working days
  });

  it('acceptance: the last request day of the guarantee is G4 − 10 calendar days → Fri 23/04', async () => {
    const w = await world();
    const res = await create(w);
    const guarantee = await dbFor(w.org).findOne('watch_item', { tender_id: res.tender.id, key: 'guarantee' });
    expect(guarantee?.needed_at).toBe('2027-05-05');
    expect(lastRequestDate(guarantee as never, holidays)).toBe('2027-04-23');
  });

  it('acceptance: 12 working days from T0 to T → compressed_mode, G1 and G2 at T−5', async () => {
    const w = await world();
    const res = await create(w, { t0_published_at: '2027-04-19', questions_deadline_at: null });
    expect(res.tender.compressed_mode).toBe(true);
    const d = await dates(w, res.tender.id);
    expect([d.G1, d.G2]).toEqual(['2027-04-28', '2027-04-28']);
    expect(d.H3).toBe('2027-04-28');
    expect(d.G0).toBe('2027-04-21');
    const codes = res.warnings.map((x) => `${x.severity}:${x.code}`);
    expect(codes).toContain('orange:compressed_mode');
    expect(codes).not.toContain('red:guarantee_at_risk');
    expect(res.warnings.find((x) => x.code === 'compressed_mode')?.data).toMatchObject({ workingDays: 12 });
    const g1 = (await as(w.admin).get(`/api/tenders/${res.tender.id}/milestones`)).body.items.find((m: { key: string }) => m.key === 'G1');
    expect(g1).toMatchObject({ tMinus: 5, computed_from: { rule: 'compressed' } });
  });
});

describe('GET /api/tenders/:id — permissions, T−n and warnings', () => {
  it('returns { tender, permissions, tMinus, warnings } with per-role permissions', async () => {
    const w = await world();
    const res = await create(w);
    const tender = { id: res.tender.id as string, org_id: w.org.id };
    const users = {
      bid_manager: await createUser(w.org, 'bid_manager'),
      financial: await createUser(w.org, 'member'),
      technical: await createUser(w.org, 'member'),
      approver: await createUser(w.org, 'approver'),
      viewer: await createUser(w.org, 'viewer'),
    };
    await addMember(tender, users.financial, 'C');
    await addMember(tender, users.technical, 'B');
    await addMember(tender, users.approver, 'MGMT');
    await addMember(tender, users.viewer);
    const perms = async (u: TestUser) => (await as(u).get(`/api/tenders/${tender.id}`)).body.permissions;
    expect(await perms(w.admin)).toEqual({ canWrite: true, canSeeFinancial: true, canManage: true });
    expect(await perms(users.bid_manager)).toEqual({ canWrite: true, canSeeFinancial: true, canManage: true });
    expect(await perms(users.financial)).toEqual({ canWrite: true, canSeeFinancial: true, canManage: false });
    expect(await perms(users.technical)).toEqual({ canWrite: true, canSeeFinancial: false, canManage: false });
    expect(await perms(users.approver)).toEqual({ canWrite: true, canSeeFinancial: true, canManage: false });
    expect(await perms(users.viewer)).toEqual({ canWrite: false, canSeeFinancial: false, canManage: false });

    const detail = (await as(users.technical).get(`/api/tenders/${tender.id}`)).body;
    expect(detail.tMinus).toBe(118); // working days from Fri 13/11/2026 to Fri 07/05/2027
    expect(detail).toMatchObject({ T: '2027-05-07', T0: '2027-03-01', warnings: [] });
    expect(detail.nextGate).toMatchObject({ key: 'G0', name: 'G0 Go/No-Go', due_date: '2027-03-04' });
    expect(detail.tender).not.toHaveProperty('template_snapshot');
    const snap = await as(users.technical).get(`/api/tenders/${tender.id}/snapshot`);
    expect(snap.body.snapshot.template).toMatchObject({ name: 'L', version: 'v1.1' });
  });

  it('R16: warns when the guarantee is valid for less than T + offer validity + margin', async () => {
    const w = await world();
    const short = await create(w, { guarantee_valid_until: '2027-12-02', offer_validity_days: 180, guarantee_margin_days: 30 });
    // T 07/05/2027 + 180 + 30 = 03/12/2027
    expect(short.warnings).toEqual([expect.objectContaining({ code: 'guarantee_validity_short', severity: 'orange', data: { requiredUntil: '2027-12-03', validUntil: '2027-12-02', shortByDays: 1 } })]);
    expect((await create(w, { guarantee_valid_until: '2027-12-03' })).warnings).toEqual([]);
    expect((await create(w, { guarantee_valid_until: '2027-12-03', guarantee_margin_days: 31 })).warnings.map((x) => x.code)).toEqual(['guarantee_validity_short']);
    expect((await create(w, { guarantee_valid_until: '2027-06-01', offer_validity_days: null })).warnings).toEqual([]); // nothing to compare with
  });

  it('R7: warns while G0 is pending and its target T0+3 is after T−12', async () => {
    const w = await world();
    const res = await create(w, { t0_published_at: '2027-04-15', questions_deadline_at: null }); // target Tue 20/04 > T−12 Mon 19/04
    const warning = res.warnings.find((x) => x.code === 'gate_target_late');
    expect(warning).toMatchObject({ severity: 'orange', data: { key: 'G0', target: '2027-04-20', recommended: '2027-04-19', latest: '2027-04-21', due_date: '2027-04-20' } });
    const g0 = await dbFor(w.org).findOne('gate', { tender_id: res.tender.id, key: 'G0' });
    await dbFor(w.org).update('gate', g0?.id, { decision: 'go' });
    const after = await as(w.admin).get(`/api/tenders/${res.tender.id}`);
    expect(after.body.warnings.map((x: { code: string }) => x.code)).not.toContain('gate_target_late');
    expect(after.body.nextGate).toMatchObject({ key: 'G1' });
  });

  it('R8 red: fewer than 10 working days and the guarantee not requested yet', async () => {
    const w = await world();
    // today Fri 13/11/2026 → T Wed 25/11/2026: 8 working days
    const res = await create(w, { t0_published_at: '2026-11-10', questions_deadline_at: null, submission_deadline_at: '2026-11-25T10:00:00Z' });
    expect(res.tender.compressed_mode).toBe(true);
    expect(res.tMinus).toBe(8);
    expect(res.warnings.map((x) => `${x.severity}:${x.code}`)).toEqual(expect.arrayContaining(['orange:compressed_mode', 'red:guarantee_at_risk']));
    expect(res.warnings.find((x) => x.code === 'guarantee_at_risk')?.data).toMatchObject({ workingDays: 8 });
    const guarantee = await dbFor(w.org).findOne('watch_item', { tender_id: res.tender.id, key: 'guarantee' });
    await dbFor(w.org).update('watch_item', guarantee?.id, { requested_at: '2026-11-13' });
    const after = (await as(w.admin).get(`/api/tenders/${res.tender.id}`)).body.warnings.map((x: { code: string }) => x.code);
    expect(after).toContain('compressed_mode');
    expect(after).not.toContain('guarantee_at_risk');
  });

  it('R15: a linked company document that expires before T is a red warning; closed tenders have no warnings', async () => {
    const w = await world();
    const res = await create(w, { guarantee_valid_until: '2027-06-01' });
    const db = dbFor(w.org);
    const expired = await db.insert('company_document', { type: 'iso', title: 'ISO 9001', expires_at: '2027-05-06' });
    const onT = await db.insert('company_document', { type: 'tax', title: 'Φορολογική ενημερότητα', expires_at: '2027-05-07' });
    const unlinked = await db.insert('company_document', { type: 'gemi', title: 'ΓΕΜΗ', expires_at: '2027-01-01' });
    await db.insert('tender_document', { tender_id: res.tender.id, company_document_id: expired.id });
    await db.insert('tender_document', { tender_id: res.tender.id, company_document_id: onT.id });
    expect(unlinked.id).toBeTruthy();
    const detail = (await as(w.admin).get(`/api/tenders/${res.tender.id}`)).body;
    const warning = detail.warnings.find((x: { code: string }) => x.code === 'documents_expired_on_T');
    expect(warning).toMatchObject({ severity: 'red', data: { count: 1, T: '2027-05-07', documents: [{ id: expired.id, title: 'ISO 9001', expires_at: '2027-05-06' }] } });
    expect(detail.warnings.map((x: { code: string }) => x.code)).toContain('guarantee_validity_short');

    await as(w.admin).post(`/api/tenders/${res.tender.id}/status`).send({ status: 'cancelled' }).expect(200);
    expect((await as(w.admin).get(`/api/tenders/${res.tender.id}`)).body).toMatchObject({ warnings: [], permissions: { canWrite: false } });
  });
});

describe('GET /api/tenders — list', () => {
  it('admin and bid manager see every tender; the others only those they are members of', async () => {
    const w = await world();
    const a = await create(w, { title: 'Άλφα' });
    const b = await create(w, { title: 'Βήτα', submission_deadline_at: '2027-06-10T09:00:00Z' });
    const member = await createUser(w.org, 'member');
    const viewer = await createUser(w.org, 'viewer');
    await addMember({ id: b.tender.id, org_id: w.org.id }, member, 'A');
    await addMember({ id: b.tender.id, org_id: w.org.id }, member, 'B'); // two roles, still one row in the list
    const titles = async (u: TestUser, query = '') => (await as(u).get(`/api/tenders${query}`)).body.items.map((t: { title: string }) => t.title);
    expect(await titles(w.admin)).toEqual(['Άλφα', 'Βήτα']); // by deadline
    expect(await titles(await createUser(w.org, 'bid_manager'))).toEqual(['Άλφα', 'Βήτα']);
    expect(await titles(member)).toEqual(['Βήτα']);
    expect(await titles(viewer)).toEqual([]);
    expect(await titles(await createUser(w.org, 'approver'))).toEqual([]);

    const item = (await as(w.admin).get('/api/tenders')).body.items[0];
    expect(item).toMatchObject({ id: a.tender.id, T: '2027-05-07', T0: '2027-03-01', tMinus: 118, status: 'evaluation', compressed_mode: false, template_name: 'L' });
    expect(item.next_gate).toMatchObject({ key: 'G0', due_date: '2027-03-04', tMinus: 42 });
    expect(item).not.toHaveProperty('template_snapshot');
  });

  it('filters by status and text', async () => {
    const w = await world();
    const a = await create(w, { title: 'Άλφα servers' });
    await create(w, { title: 'Βήτα', authority: 'Δήμος Αθηναίων', adam: '27PROC999' });
    const api = await as(w.admin);
    await api.post(`/api/tenders/${a.tender.id}/status`).send({ status: 'in_progress' }).expect(200);
    const titles = async (query: string) => (await api.get(`/api/tenders?${query}`)).body.items.map((t: { title: string }) => t.title);
    expect(await titles('status=in_progress')).toEqual(['Άλφα servers']);
    expect(await titles('status=evaluation')).toEqual(['Βήτα']);
    expect(await titles('status=evaluation,in_progress')).toHaveLength(2);
    expect(await titles('status=active')).toHaveLength(2);
    expect(await titles('status=closed')).toEqual([]);
    expect(await titles('q=SERVERS')).toEqual(['Άλφα servers']);
    expect(await titles(`q=${encodeURIComponent('αθηναίων')}`)).toEqual(['Βήτα']);
    expect(await titles('q=27PROC999')).toEqual(['Βήτα']);
    expect(await titles('q=%25')).toEqual([]); // wildcards are literal
  });
});

describe('PATCH /api/tenders/:id — basic fields', () => {
  it('a bid manager edits fields; flags and the deadline are not editable here', async () => {
    const w = await world();
    const res = await create(w);
    const api = await as(await createUser(w.org, 'bid_manager'));
    const url = `/api/tenders/${res.tender.id}`;
    const ok = await api.patch(url).send({ title: 'Νέος τίτλος', adam: '', cpv: ['48000000-8'], guarantee_valid_until: '2028-01-31', lots: [], budget_gross: null, notes: 'ok' });
    expect(ok.status).toBe(200);
    expect(ok.body.tender).toMatchObject({ title: 'Νέος τίτλος', adam: null, cpv: ['48000000-8'], guarantee_valid_until: '2028-01-31', lots: [], budget_gross: null, notes: 'ok' });
    expect(ok.body).toHaveProperty('permissions');

    const code = async (patch: Record<string, unknown>) => {
      const r = await api.patch(url).send(patch);
      return [r.status, r.body.error?.code];
    };
    expect(await code({ has_demo: true })).toEqual([422, 'flags_immutable']);
    expect(await code({ has_partners: true })).toEqual([422, 'flags_immutable']);
    expect((await api.patch(url).send({ has_demo: false, has_partners: false })).status).toBe(200); // unchanged values are fine
    expect(await code({ submission_deadline_at: '2027-05-14T12:00:00Z' })).toEqual([422, 'use_deadline_flow']);
    expect(await code({ questions_deadline_at: '2027-05-08T12:00:00Z' })).toEqual([422, 'questions_after_deadline']);
    expect(await code({ status: 'submitted' })).toEqual([400, 'validation_error']);
    expect(await code({ template_id: w.templateId })).toEqual([400, 'validation_error']);
    expect(await code({ title: '' })).toEqual([400, 'validation_error']);
    expect((await dbFor(w.org).get('tender', res.tender.id))?.submission_deadline_at.toISOString()).toBe('2027-05-07T12:00:00.000Z');
  });

  it('a new publication date moves the T0-anchored milestones and what hangs on them', async () => {
    const w = await world();
    const res = await create(w);
    expect(await dates(w, res.tender.id)).toMatchObject({ G0: '2027-03-04', H1: '2027-03-08' });
    const patched = await as(w.admin).patch(`/api/tenders/${res.tender.id}`).send({ t0_published_at: '2027-03-08' });
    expect(patched.status).toBe(200);
    expect(patched.body.T0).toBe('2027-03-08');
    const d = await dates(w, res.tender.id);
    expect(d).toMatchObject({ G0: '2027-03-11', H1: '2027-03-16', G1: '2027-04-23' }); // 15/03 is Clean Monday
    expect((await dbFor(w.org).findOne('task', { tender_id: res.tender.id, key: 'H1' }))?.due_date).toBe('2027-03-16');
    expect((await dbFor(w.org).findOne('task', { tender_id: res.tender.id, key: 'WP1' }))?.due_date).toBe('2027-03-11');
    // a T0 that leaves only 12 working days switches compressed mode on
    const tight = await as(w.admin).patch(`/api/tenders/${res.tender.id}`).send({ t0_published_at: '2027-04-19', questions_deadline_at: null });
    expect(tight.body.tender.compressed_mode).toBe(true);
    expect((await dates(w, res.tender.id)).G2).toBe('2027-04-28');
  });

  it('members, approvers and viewers cannot edit', async () => {
    const w = await world();
    const res = await create(w);
    for (const role of ['member', 'approver', 'viewer'] as const) {
      const u = await createUser(w.org, role);
      await addMember({ id: res.tender.id, org_id: w.org.id }, u, 'B');
      expect((await as(u).patch(`/api/tenders/${res.tender.id}`).send({ title: 'x' })).status).toBe(403);
    }
    expect((await dbFor(w.org).get('tender', res.tender.id))?.title).toBe('Προμήθεια εξοπλισμού πληροφορικής');
  });
});

describe('POST /api/tenders/:id/status', () => {
  it('evaluation → in_progress → submitted; closing sets closed_at and makes the tender read-only', async () => {
    const w = await world();
    const res = await create(w);
    const api = await as(w.admin);
    const url = `/api/tenders/${res.tender.id}`;
    const go = async (status: string) => {
      const r = await api.post(`${url}/status`).send({ status });
      return [r.status, r.body.error?.code ?? r.body.tender?.status];
    };
    expect(await go('submitted')).toEqual([422, 'invalid_status_transition']); // not straight from evaluation
    expect(await go('evaluation')).toEqual([422, 'invalid_status_transition']);
    expect(await go('no_go')).toEqual([400, 'validation_error']); // No-Go is the G0 decision (R14)
    expect(await go('in_progress')).toEqual([200, 'in_progress']);
    expect((await dbFor(w.org).get('tender', res.tender.id))?.closed_at).toBeNull();
    expect(await go('submitted')).toEqual([200, 'submitted']);
    const closed = await dbFor(w.org).get('tender', res.tender.id);
    expect(closed?.closed_at).toBeInstanceOf(Date);

    // closed: read-only
    expect((await api.get(url)).body.permissions).toMatchObject({ canWrite: false, canManage: true });
    const closedCode = async (r: Promise<{ status: number; body: any }>) => {
      const x = await r;
      return [x.status, x.body.error?.code];
    };
    expect(await closedCode(api.patch(url).send({ title: 'x' }))).toEqual([422, 'tender_closed']);
    expect(await closedCode(api.put(`${url}/members`).send({ members: [] }))).toEqual([422, 'tender_closed']);
    expect(await closedCode(api.post(`${url}/deadline/preview`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' }))).toEqual([422, 'tender_closed']);
    expect(await closedCode(api.post(`${url}/deadline`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' }))).toEqual([422, 'tender_closed']);

    // a wrong click is reversible
    expect(await go('in_progress')).toEqual([200, 'in_progress']);
    expect((await dbFor(w.org).get('tender', res.tender.id))?.closed_at).toBeNull();
    expect(await go('cancelled')).toEqual([200, 'cancelled']);
    expect(await go('evaluation')).toEqual([200, 'evaluation']);
  });

  it('No-Go is final here; only admin / bid manager change the status', async () => {
    const w = await world();
    const res = await create(w);
    await dbFor(w.org).update('tender', res.tender.id, { status: 'no_go', closed_at: new Date() });
    const r = await as(w.admin).post(`/api/tenders/${res.tender.id}/status`).send({ status: 'in_progress' });
    expect([r.status, r.body.error.code]).toEqual([422, 'invalid_status_transition']);
    const other = await create(w);
    const member = await createUser(w.org, 'member');
    await addMember({ id: other.tender.id, org_id: w.org.id }, member, 'A');
    expect((await as(member).post(`/api/tenders/${other.tender.id}/status`).send({ status: 'in_progress' })).status).toBe(403);
  });
});

describe('team: GET/PUT /api/tenders/:id/members', () => {
  it('lists roles and members; the bid manager replaces the team', async () => {
    const w = await world();
    const res = await create(w);
    const url = `/api/tenders/${res.tender.id}/members`;
    const [u1, u2, u3] = [await createUser(w.org, 'member', { name: 'Άννα' }), await createUser(w.org, 'member', { name: 'Βασίλης' }), await createUser(w.org, 'approver', { name: 'Γιώργος' })];
    const api = await as(await createUser(w.org, 'bid_manager'));

    const empty = await api.get(url);
    expect(empty.body.items).toEqual([]);
    expect(empty.body.roles.map((r: { key: string; name: string }) => [r.key, r.name])).toEqual([
      ['A', 'Α — Δικαιολογητικά συμμετοχής'],
      ['B', 'Β — Τεχνική προσφορά'],
      ['C', 'Γ — Οικονομική προσφορά'],
      ['MGMT', 'Διοίκηση'],
    ]);
    expect(empty.body.roles[2].payload).toMatchObject({ financial: true });

    const put = await api.put(url).send({
      members: [
        { user_id: u1!.id, role_key: 'A' },
        { user_id: u1!.id, role_key: 'C' }, // one person, two roles
        { user_id: u2!.id, role_key: 'B' },
        { user_id: u3!.id, role_key: 'MGMT' },
        { user_id: u2!.id, role_key: null }, // plain member
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.items.map((m: any) => [m.user.name, m.tender_role_key])).toEqual([
      ['Άννα', 'A'],
      ['Άννα', 'C'],
      ['Βασίλης', null],
      ['Βασίλης', 'B'],
      ['Γιώργος', 'MGMT'],
    ]);
    expect(put.body.items[0].user).toEqual({ id: u1!.id, name: 'Άννα', email: u1!.email, org_role: 'member', active: true });

    // pending gates without approver get the role's holder
    const gates = async () => Object.fromEntries((await dbFor(w.org).list('gate', { tender_id: res.tender.id })).map((g) => [g.key, g.approver_user_id]));
    expect(await gates()).toEqual({ G0: u3!.id, G1: u2!.id, G2: u3!.id, G3: u2!.id, G4: u3!.id });
    // members can now open the tender
    expect((await as(u1!).get(`/api/tenders/${res.tender.id}`)).body.permissions).toMatchObject({ canWrite: true, canSeeFinancial: true });

    // B changes hands: pending gates follow the role, decided ones keep their approver; unchanged rows are kept
    const g1 = await dbFor(w.org).findOne('gate', { tender_id: res.tender.id, key: 'G1' });
    await dbFor(w.org).update('gate', g1?.id, { decision: 'approved', decided_by: u2!.id });
    const keptId = put.body.items[0].id;
    const next = await api.put(url).send({ members: [{ user_id: u1!.id, role_key: 'A' }, { user_id: u1!.id, role_key: 'B' }, { user_id: u3!.id, role_key: 'MGMT' }] });
    expect(next.body.items.map((m: any) => [m.user.name, m.tender_role_key])).toEqual([['Άννα', 'A'], ['Άννα', 'B'], ['Γιώργος', 'MGMT']]);
    expect(next.body.items[0].id).toBe(keptId);
    expect(await gates()).toEqual({ G0: u3!.id, G1: u2!.id, G2: u3!.id, G3: u1!.id, G4: u3!.id });
    expect((await as(u2!).get(`/api/tenders/${res.tender.id}`)).status).toBe(403); // removed from the team

    const bad = async (members: unknown) => {
      const r = await api.put(url).send({ members });
      return [r.status, r.body.error?.code];
    };
    expect(await bad([{ user_id: u1!.id, role_key: 'Z' }])).toEqual([422, 'unknown_tender_role']);
    expect(await bad([{ user_id: missingId(), role_key: 'A' }])).toEqual([422, 'unknown_user']);
    expect(await bad([{ user_id: 'x', role_key: 'A' }])).toEqual([400, 'validation_error']);
    expect(await bad('nope')).toEqual([400, 'validation_error']);
    expect(await dbFor(w.org).count('tender_member', { tender_id: res.tender.id })).toBe(3);
  });

  it('members read the team but only admin / bid manager change it', async () => {
    const w = await world();
    const res = await create(w);
    const url = `/api/tenders/${res.tender.id}/members`;
    for (const role of ['member', 'approver', 'viewer'] as const) {
      const u = await createUser(w.org, role);
      expect((await as(u).get(url)).status).toBe(403); // not a member yet
      await addMember({ id: res.tender.id, org_id: w.org.id }, u, 'A');
      const api = await as(u);
      expect((await api.get(url)).status).toBe(200);
      expect((await api.put(url).send({ members: [] })).status).toBe(403);
    }
    expect(await dbFor(w.org).count('tender_member', { tender_id: res.tender.id })).toBe(3);
  });
});

describe('deadline extension (R9, R10)', () => {
  const NEW = '2027-05-14T12:00:00Z'; // +5 working days: Fri 14/05/2027

  it('preview returns the diff and persists nothing', async () => {
    const w = await world();
    const res = await create(w, { guarantee_valid_until: '2027-12-10' });
    const before = await dates(w, res.tender.id);
    const preview = await as(w.admin).post(`/api/tenders/${res.tender.id}/deadline/preview`).send({ submission_deadline_at: NEW });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      oldT: '2027-05-07',
      newT: '2027-05-14',
      old_deadline_at: '2027-05-07T12:00:00.000Z',
      new_deadline_at: '2027-05-14T12:00:00.000Z',
      shiftWorkingDays: 5,
      compressed: { old: false, new: false },
    });
    const row = (key: string) => preview.body.items.find((i: { key: string }) => i.key === key);
    expect(row('G4')).toMatchObject({ old_date: '2027-05-05', new_date: '2027-05-12', changed: true, status: 'moved', tMinus: 2, kind: 'gate', name: 'G4 Final sign-off' });
    expect(row('G1')).toMatchObject({ old_date: '2027-04-23', new_date: '2027-05-04', tMinus: 8 });
    expect(row('G0')).toMatchObject({ changed: false, status: 'unchanged' });
    expect(row('G4').milestone_id).toEqual(expect.any(String));
    expect(preview.body.items).toHaveLength(11);
    // R16 is re-run against the new T: 14/05 + 180 + 30 = 10/12 is still fine, one more day would not be
    expect(preview.body.warnings).toEqual([]);
    const later = await as(w.admin).post(`/api/tenders/${res.tender.id}/deadline/preview`).send({ submission_deadline_at: '2027-05-17T12:00:00Z' });
    expect(later.body.warnings.map((x: { code: string }) => x.code)).toEqual(['guarantee_validity_short']);

    expect(await dates(w, res.tender.id)).toEqual(before);
    expect((await dbFor(w.org).get('tender', res.tender.id))?.submission_deadline_at.toISOString()).toBe('2027-05-07T12:00:00.000Z');
    expect(await dbFor(w.org).count('change_entry', { tender_id: res.tender.id })).toBe(0);
  });

  it('acceptance: +5 working days moves only non-manual, non-done milestones and creates a change_entry', async () => {
    const w = await world();
    const res = await create(w);
    const id = res.tender.id as string;
    const db = dbFor(w.org);
    const api = await as(w.admin);
    const milestone = async (key: string) => (await db.findOne('milestone', { tender_id: id, key })) as Record<string, any>;

    // G2 is pinned by hand, the upload is done, G1 is decided (done by its gate), H1 is received (done by its task)
    const list = await api.patch(`/api/tenders/${id}/milestones/${(await milestone('G2')).id}`).send({ due_date: '2027-04-27' });
    expect(list.status).toBe(200);
    await api.patch(`/api/tenders/${id}/milestones/${(await milestone('UPLOAD')).id}`).send({ done: true }).expect(200);
    const g1Gate = await db.findOne('gate', { tender_id: id, key: 'G1' });
    await db.update('gate', g1Gate?.id, { decision: 'approved' });
    const h1Task = await db.findOne('task', { tender_id: id, key: 'H1' });
    await db.update('task', h1Task?.id, { received_at: new Date(), status: 'done' });
    const before = await dates(w, id);

    const events: unknown[] = [];
    const off = on('tender.extended', (_ctx, p) => void events.push(p));
    const ext = await api.post(`/api/tenders/${id}/deadline`).send({ submission_deadline_at: NEW, source: 'esidis', reference: 'ΑΔΑ: 9ΤΛΠ46ΜΤΛΠ-Χ1Ψ' });
    await flushEvents();
    off();
    expect(ext.status).toBe(200);
    expect(events).toEqual([{ tenderId: id, oldT: '2027-05-07', newT: '2027-05-14' }]);

    expect(ext.body).toMatchObject({ T: '2027-05-14', tender: { submission_deadline_at: '2027-05-14T12:00:00.000Z', compressed_mode: false }, permissions: { canManage: true } });
    const after = await dates(w, id);
    // moved: everything that is neither manual nor done
    expect(after).toMatchObject({ G3: '2027-05-11', G4: '2027-05-12', H4: '2027-04-29' });
    // stayed: manual (G2), done (UPLOAD), decided (G1) and what hangs on it (H3), received (H1), T0-anchored (G0, H2, H5)
    for (const key of ['G2', 'UPLOAD', 'G1', 'H3', 'H1', 'G0', 'H2', 'H5']) expect(after[key], key).toBe(before[key]);
    expect(after.G2).toBe('2027-04-27');
    expect(Object.keys(after).filter((k) => after[k] !== before[k]).sort()).toEqual(['G3', 'G4', 'H4']);
    expect(ext.body.diff).toMatchObject({ moved: 3, shiftWorkingDays: 5 });
    expect(ext.body.diff.items.find((i: { key: string }) => i.key === 'G2')).toMatchObject({ status: 'manual', needs_review: true, computed_date: '2027-05-10' });
    expect(ext.body.diff.items.find((i: { key: string }) => i.key === 'G1')).toMatchObject({ status: 'done', needs_review: false });

    // manual milestones are flagged for review, done ones are not (R9, R10)
    expect(await milestone('G2')).toMatchObject({ is_manual: true, needs_review: true });
    expect(await milestone('UPLOAD')).toMatchObject({ needs_review: false });
    expect(await milestone('G4')).toMatchObject({ is_manual: false, needs_review: false });

    // mirrored rows follow
    expect((await db.findOne('task', { tender_id: id, key: 'H4' }))?.due_date).toBe('2027-04-29');
    expect((await db.findOne('watch_item', { tender_id: id, key: 'guarantee' }))?.needed_at).toBe('2027-05-12');
    expect((await db.findOne('watch_item', { tender_id: id, key: 'cvs' }))?.needed_at).toBe('2027-05-11');
    expect((await db.findOne('watch_item', { tender_id: id, key: 'maf' }))?.needed_at).toBe('2027-04-23'); // needed at the decided G1
    expect((await db.findOne('task', { tender_id: id, key: 'WP6' }))?.due_date).toBe('2027-05-11');
    expect((await db.findOne('task', { tender_id: id, key: 'WP11' }))?.due_date).toBe('2027-05-19');

    // the change log entry (kind = extension)
    const changes = await db.list('change_entry', { tender_id: id });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'extension',
      source: 'esidis',
      date: '2026-11-13',
      reference: 'ΑΔΑ: 9ΤΛΠ46ΜΤΛΠ-Χ1Ψ',
      owner_user_id: w.admin.id,
      description: 'Νέα προθεσμία υποβολής: 14/05/2027 15:00 (από 07/05/2027 15:00).',
      payload: { oldT: '2027-05-07', newT: '2027-05-14', moved: 3, needs_review: ['G2'] },
    });
    expect(ext.body.change_entry.id).toBe(changes[0]?.id);
  });

  it('two concurrent confirmations of the same extension: one wins, the other is refused as unchanged — one change entry (review M6)', async () => {
    const w = await world();
    const res = await create(w);
    const id = res.tender.id as string;
    const api = await as(w.admin);
    const other = await as(await createUser(w.org, 'bid_manager'));
    const send = (a: typeof api) => a.post(`/api/tenders/${id}/deadline`).send({ submission_deadline_at: NEW, source: 'esidis' });
    const results = await Promise.all([send(api), send(other), send(api), send(other)]);
    await flushEvents();
    expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422, 422]);
    for (const r of results.filter((x) => x.status === 422)) expect(r.body.error.code).toBe('deadline_unchanged');
    expect(await dbFor(w.org).count('change_entry', { tender_id: id, kind: 'extension' })).toBe(1);
    expect((await dates(w, id)).G4).toBe('2027-05-12');
  });

  it('re-evaluates compressed mode; accepts a description; rejects an unchanged or inconsistent deadline', async () => {
    const w = await world();
    const res = await create(w, { t0_published_at: '2027-04-19', questions_deadline_at: null });
    expect(res.tender.compressed_mode).toBe(true);
    const api = await as(w.admin);
    const url = `/api/tenders/${res.tender.id}/deadline`;
    const code = async (b: Record<string, unknown>) => {
      const r = await api.post(url).send(b);
      return [r.status, r.body.error?.code];
    };
    expect(await code({ submission_deadline_at: '2027-05-07T12:00:00Z' })).toEqual([422, 'deadline_unchanged']);
    expect(await code({ submission_deadline_at: '2027-04-16T12:00:00Z' })).toEqual([422, 't0_after_deadline']);
    expect(await code({ submission_deadline_at: '14/05/2027' })).toEqual([400, 'validation_error']);
    expect(await code({ submission_deadline_at: NEW, source: 'fax' })).toEqual([400, 'validation_error']);
    expect(await code({})).toEqual([400, 'validation_error']);

    const preview = await api.post(`${url}/preview`).send({ submission_deadline_at: NEW });
    expect(preview.body).toMatchObject({ compressed: { old: true, new: false }, workingDays: 17 });
    const ext = await api.post(url).send({ submission_deadline_at: NEW, description: 'Παράταση λόγω τροποποίησης τεχνικών προδιαγραφών' });
    expect(ext.body.tender.compressed_mode).toBe(false);
    expect(ext.body.warnings.map((x: { code: string }) => x.code)).not.toContain('compressed_mode');
    expect(await dates(w, res.tender.id)).toMatchObject({ G1: '2027-05-04', G2: '2027-05-10' }); // separate again
    const [change] = await dbFor(w.org).list('change_entry', { tender_id: res.tender.id });
    expect(change).toMatchObject({ kind: 'extension', source: 'other', description: 'Παράταση λόγω τροποποίησης τεχνικών προδιαγραφών' });

    // a change of the hour only: same T, nothing moves, still logged
    const sameDay = await api.post(url).send({ submission_deadline_at: '2027-05-14T09:00:00Z' });
    expect(sameDay.body.diff).toMatchObject({ moved: 0, oldT: '2027-05-14', newT: '2027-05-14' });
    expect(await dbFor(w.org).count('change_entry', { tender_id: res.tender.id })).toBe(2);
  });

  it('only admin / bid manager change the deadline', async () => {
    const w = await world();
    const res = await create(w);
    for (const role of ['member', 'approver', 'viewer'] as const) {
      const u = await createUser(w.org, role);
      await addMember({ id: res.tender.id, org_id: w.org.id }, u, 'A');
      const api = await as(u);
      expect((await api.post(`/api/tenders/${res.tender.id}/deadline/preview`).send({ submission_deadline_at: NEW })).status).toBe(403);
      expect((await api.post(`/api/tenders/${res.tender.id}/deadline`).send({ submission_deadline_at: NEW })).status).toBe(403);
    }
    expect((await as(await createUser(w.org, 'bid_manager')).post(`/api/tenders/${res.tender.id}/deadline`).send({ submission_deadline_at: NEW })).status).toBe(200);
  });

  it('works for a tender without snapshot: milestones are recomputed from their own computed_from', async () => {
    const org = await createOrg();
    await seedHolidays(org, [2026, 2027]);
    const admin = await createUser(org, 'admin');
    const tender = await createTender(org, { submission_deadline_at: '2027-05-07T12:00:00Z', t0_published_at: '2027-03-01T08:00:00Z' });
    const db = dbFor(org);
    await db.insert('milestone', { tender_id: tender.id, key: 'G4', name: 'G4', kind: 'gate', due_date: '2027-05-05', computed_from: { anchor: 'T', offset_value: -2, offset_unit: 'working' } });
    await db.insert('milestone', { tender_id: tender.id, key: 'FREE', name: 'Ελεύθερο', kind: 'milestone', due_date: '2027-04-01' });
    const ext = await as(admin).post(`/api/tenders/${tender.id}/deadline`).send({ submission_deadline_at: NEW });
    expect(ext.status).toBe(200);
    expect(await db.findOne('milestone', { tender_id: tender.id, key: 'G4' })).toMatchObject({ due_date: '2027-05-12' });
    expect(await db.findOne('milestone', { tender_id: tender.id, key: 'FREE' })).toMatchObject({ due_date: '2027-04-01' });
    expect(ext.body.diff.items.find((i: { key: string }) => i.key === 'FREE')).toMatchObject({ status: 'no_rule', changed: false });
  });
});

describe('tenant isolation and access', () => {
  it('no endpoint returns or changes data of another organization', async () => {
    const w = await world();
    const res = await create(w);
    const id = res.tender.id as string;
    const foreignWorld = await world();
    const foreign = await as(foreignWorld.admin);

    expect((await foreign.get('/api/tenders')).body.items).toEqual([]);
    const calls = [
      foreign.get(`/api/tenders/${id}`),
      foreign.get(`/api/tenders/${id}/snapshot`),
      foreign.patch(`/api/tenders/${id}`).send({ title: 'hijack' }),
      foreign.post(`/api/tenders/${id}/status`).send({ status: 'cancelled' }),
      foreign.get(`/api/tenders/${id}/members`),
      foreign.put(`/api/tenders/${id}/members`).send({ members: [] }),
      foreign.post(`/api/tenders/${id}/deadline/preview`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' }),
      foreign.post(`/api/tenders/${id}/deadline`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' }),
    ];
    for (const call of calls) expect((await call).status).toBe(404);
    expect((await foreign.get(`/api/tenders/${missingId()}`)).status).toBe(404);
    expect((await foreign.get('/api/tenders/not-a-uuid')).status).toBe(404);

    // a user of org A cannot put a user of org B in the team
    const put = await as(w.admin).put(`/api/tenders/${id}/members`).send({ members: [{ user_id: foreignWorld.admin.id, role_key: 'A' }] });
    expect([put.status, put.body.error.code]).toEqual([422, 'unknown_user']);

    const row = await dbFor(w.org).get('tender', id);
    expect(row).toMatchObject({ title: 'Προμήθεια εξοπλισμού πληροφορικής', status: 'evaluation' });
    expect(row?.submission_deadline_at.toISOString()).toBe('2027-05-07T12:00:00.000Z');
    expect(await dbFor(foreignWorld.org).count('tender')).toBe(0);
    expect(await dbFor(foreignWorld.org).count('milestone')).toBe(0);
  });

  it('a user without membership gets 403; a viewer member reads but cannot write; anonymous gets 401', async () => {
    const w = await world();
    const res = await create(w);
    const id = res.tender.id as string;
    for (const role of ['member', 'approver', 'viewer'] as const) {
      const api = await as(await createUser(w.org, role));
      expect((await api.get(`/api/tenders/${id}`)).status).toBe(403);
      expect((await api.get(`/api/tenders/${id}/snapshot`)).status).toBe(403);
      expect((await api.get(`/api/tenders/${id}/members`)).status).toBe(403);
    }
    const viewer = await createUser(w.org, 'viewer');
    await addMember({ id, org_id: w.org.id }, viewer);
    const api = await as(viewer);
    expect((await api.get(`/api/tenders/${id}`)).status).toBe(200);
    expect((await api.patch(`/api/tenders/${id}`).send({ title: 'x' })).status).toBe(403);
    expect((await api.post(`/api/tenders/${id}/status`).send({ status: 'in_progress' })).status).toBe(403);
    expect((await api.put(`/api/tenders/${id}/members`).send({ members: [] })).status).toBe(403);
    expect((await api.post(`/api/tenders/${id}/deadline`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' })).status).toBe(403);
    expect((await api.post('/api/tenders').send(body(w))).status).toBe(403);

    const { anon } = await import('../../test/harness.js');
    expect((await anon().get('/api/tenders')).status).toBe(401);
    expect((await anon().get(`/api/tenders/${id}`)).status).toBe(401);
  });
});
