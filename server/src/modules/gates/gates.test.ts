import { describe, expect, it } from 'vitest';
import { flushEvents, on } from '../../core/events.js';
import { addMember, as, createOrg, createUser, dbFor, missingId, seedHolidays } from '../../test/harness.js';
import { addHandoff, addRequirement, addTask, addWatchItem, createGatedTender, linkDocument, type GatedTender } from './testFactory.js';

const JUST_19 = 'Δεκαεννέα χαρακτ.19'; // 19 characters
const JUST_20 = 'Είκοσι χαρακτήρες.20'; // 20 characters
const GOOD = 'Το MAF έρχεται αύριο, επιβεβαιωμένο γραπτά από τον vendor.';

type Crit = { id: string; key: string; satisfied: boolean; checked_at: string | null; detail: { code: string; missing: number; items: string[] } | null };
const crit = (gate: { criteria: Crit[] }, key: string): Crit => gate.criteria.find((c) => c.key === key)!;

/** Checks every manual criterion of a gate directly in the database. */
async function checkAllManual(g: GatedTender, gateKey: string): Promise<void> {
  const db = dbFor({ id: g.tender.org_id });
  for (const c of g.criteria[gateKey]!.filter((c) => c.type === 'manual')) {
    await db.update('gate_criterion', c.id, { checked_by: g.approver.id, checked_at: new Date() });
  }
}

describe('gates: list and get', () => {
  it('lists G0–G4 in date order with date, T−n, approver, decision, criteria and progress', async () => {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const g = await createGatedTender(org);
    const res = await as(await createUser(org, 'bid_manager')).get(g.url());
    expect(res.status).toBe(200);
    const items = res.body.items;
    expect(items.map((i: { key: string }) => i.key)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4']);
    // spec acceptance: T = Fri 07/05/2027 → G4 T−2, G3 T−3, G2 T−4, G1 T−8, G0 T−10
    expect(items.map((i: { t_minus: number }) => i.t_minus)).toEqual([10, 8, 4, 3, 2]);
    expect(items[0]).toMatchObject({
      id: g.gates.G0!.id,
      name: 'G0 Go/No-Go',
      due_date: '2027-04-21',
      decision_mode: 'go_no_go',
      decision: 'pending',
      approver_user_id: g.approver.id,
      approver: { id: g.approver.id, name: g.approver.name, active: true },
      approver_role_key: 'MGMT',
      progress: { met: 0, total: 2 },
      all_met: false,
      snapshot: null,
      allowed_decisions: ['go', 'no_go'],
      permissions: { can_check: true, can_request: true, can_change_approver: true, can_decide: false, can_reopen: false },
    });
    expect(items[1].allowed_decisions).toEqual(['approved', 'approved_with_exception', 'rejected']);
    expect(items[1].criteria.map((c: { key: string; type: string }) => [c.key, c.type])).toEqual([
      ['g1_bom', 'manual'],
      ['g1_exclusion', 'auto'],
      ['g1_handoffs', 'auto'],
    ]);
    expect(crit(items[1], 'g1_bom')).toMatchObject({ satisfied: false, detail: null, checked_by: null, checked_at: null });
    expect(crit(items[1], 'g1_exclusion')).toMatchObject({ satisfied: false, detail: { code: 'exclusion_none' } });

    const one = await as(g.approver).get(g.url(`/${g.gates.G4!.id}`));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ key: 'G4', due_date: '2027-05-05', permissions: { can_decide: true, can_change_approver: false } });
    expect((await as(g.approver).get(g.url(`/${missingId()}`))).status).toBe(404);
    expect((await as(g.approver).get(g.url('/not-a-uuid'))).status).toBe(404);
  });

  it('evaluates every auto rule live against the tender data (R13)', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const api = await as(await createUser(org, 'admin'));
    const db = dbFor(org);
    const byKey = async () => Object.fromEntries((await api.get(g.url())).body.items.map((i: { key: string }) => [i.key, i]));

    const r1 = await addRequirement(g.tender, 'ΥΠ-001', { evidence_ref: 'Παράρτημα Β.3, σελ. 12' });
    const r2 = await addRequirement(g.tender, 'ΥΠ-002', { status: 'in_progress' });
    await addRequirement(g.tender, 'ΥΠ-003', { type: 'scored', status: 'open' });
    const h1 = await addHandoff(g.tender, 'Β → Α λίστα πιστοποιητικών', { due_date: '2027-04-23' });
    await addHandoff(g.tender, 'Β → Γ BOM', { due_date: '2027-04-24' }); // after G1: not counted for G1
    const guarantee = await addWatchItem(g.tender, 'guarantee');
    await addWatchItem(g.tender, 'maf');
    const iso = await linkDocument(g.tender, 'ISO 9001', '2027-05-06');
    await linkDocument(g.tender, 'ISO 27001', '2027-05-07');
    await db.insert('company_document', { type: 'iso', title: 'Unlinked, expired', expires_at: '2020-01-01' });

    let gates = await byKey();
    expect(crit(gates.G1, 'g1_exclusion')).toMatchObject({ satisfied: false, detail: { code: 'exclusion_missing_evidence', total: 2, missing: 1, items: ['ΥΠ-002'] } });
    expect(crit(gates.G1, 'g1_handoffs')).toMatchObject({ satisfied: false, detail: { code: 'handoffs_pending', total: 1, missing: 1, items: ['Β → Α λίστα πιστοποιητικών'] } });
    expect(crit(gates.G3, 'g3_register')).toMatchObject({ satisfied: false, detail: { code: 'register_open_rows', total: 3, missing: 2, items: ['ΥΠ-002', 'ΥΠ-003'] } });
    expect(crit(gates.G4, 'g4_guarantee')).toMatchObject({ satisfied: false, detail: { code: 'guarantee_not_arrived' } });
    // acceptance: a document expiring before T linked to the tender → docs_valid_on_T fails
    expect(crit(gates.G4, 'g4_docs')).toMatchObject({ satisfied: false, detail: { code: 'docs_expired', total: 2, missing: 1, items: ['ISO 9001'] } });
    expect(gates.G1.progress).toEqual({ met: 0, total: 3 });

    await db.update('requirement', r2.id, { evidence_ref: 'Datasheet σελ. 3', status: 'covered' });
    await db.update('requirement', (await db.findOne('requirement', { tender_id: g.tender.id, code: 'ΥΠ-003' }))!.id, { status: 'verified' });
    await db.update('task', h1.id, { received_at: new Date(), status: 'done' });
    await db.update('watch_item', guarantee.id, { arrived_at: '2027-05-03' });
    await db.update('company_document', iso.id, { expires_at: '2028-05-06' });

    gates = await byKey();
    expect(crit(gates.G1, 'g1_exclusion')).toMatchObject({ satisfied: true, detail: { code: 'exclusion_all_evidenced', total: 2 } });
    expect(crit(gates.G1, 'g1_handoffs')).toMatchObject({ satisfied: true, detail: { code: 'handoffs_all_received' } });
    expect(crit(gates.G3, 'g3_register')).toMatchObject({ satisfied: true, detail: { code: 'register_all_closed' } });
    expect(crit(gates.G4, 'g4_guarantee')).toMatchObject({ satisfied: true });
    expect(crit(gates.G4, 'g4_docs')).toMatchObject({ satisfied: true, detail: { code: 'docs_all_valid' } });
    expect(gates.G1.progress).toEqual({ met: 2, total: 3 });
    expect(r1.id).toBeTruthy();
  });

  it('an extension that moves T past a document expiry flips docs_valid_on_T (R15 follows T)', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    await linkDocument(g.tender, 'Φορολογική ενημερότητα', '2027-05-10');
    const api = await as(g.approver);
    expect(crit((await api.get(g.url(`/${g.gates.G4!.id}`))).body, 'g4_docs').satisfied).toBe(true);
    await dbFor(org).update('tender', g.tender.id, { submission_deadline_at: '2027-05-14T12:00:00Z' });
    expect(crit((await api.get(g.url(`/${g.gates.G4!.id}`))).body, 'g4_docs')).toMatchObject({ satisfied: false, detail: { items: ['Φορολογική ενημερότητα'] } });
  });
});

describe('gates: manual criteria', () => {
  it('a member checks and unchecks with who/when and a note; auto criteria cannot be checked', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const member = await createUser(org, 'member');
    await addMember(g.tender, member, 'B');
    const api = await as(member);
    const [bom, exclusion] = g.criteria.G1!;
    const path = g.url(`/${g.gates.G1!.id}/criteria/${bom!.id}`);

    const checked = await api.patch(path).send({ checked: true, note: '  BOM v3  ' });
    expect(checked.status).toBe(200);
    expect(crit(checked.body, 'g1_bom')).toMatchObject({ satisfied: true, checked_by: member.id, checked_at: expect.any(String), note: 'BOM v3' });
    expect(checked.body.progress).toEqual({ met: 2, total: 3 }); // + handoffs_received: none due

    const again = await api.patch(path).send({ checked: true }); // idempotent: keeps the first who/when
    expect(crit(again.body, 'g1_bom').checked_at).toBe(crit(checked.body, 'g1_bom').checked_at);

    const unchecked = await api.patch(path).send({ checked: false, note: null });
    expect(crit(unchecked.body, 'g1_bom')).toMatchObject({ satisfied: false, checked_by: null, checked_at: null, note: null });

    const auto = await api.patch(g.url(`/${g.gates.G1!.id}/criteria/${exclusion!.id}`)).send({ checked: true });
    expect([auto.status, auto.body.error.code]).toEqual([422, 'criterion_not_manual']);
    expect((await api.patch(path).send({})).status).toBe(400);
    expect((await api.patch(path).send({ checked: 'yes' })).status).toBe(400);
    // a criterion of another gate is not found under this gate
    expect((await api.patch(g.url(`/${g.gates.G2!.id}/criteria/${bom!.id}`)).send({ checked: true })).status).toBe(404);
    expect(await dbFor(org).count('audit_log', { entity: 'gate_criterion', entity_id: bom!.id, action: 'update' })).toBe(2);
  });

  it('criteria are locked once the gate is decided', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    await checkAllManual(g, 'G2');
    const api = await as(g.approver);
    expect((await api.post(g.url(`/${g.gates.G2!.id}/decision`)).send({ decision: 'approved' })).status).toBe(200);
    const res = await api.patch(g.url(`/${g.gates.G2!.id}/criteria/${g.criteria.G2![0]!.id}`)).send({ checked: false });
    expect([res.status, res.body.error.code]).toEqual([409, 'gate_already_decided']);
  });
});

describe('gates: approver (R11) and approval request', () => {
  it('bid_manager / admin change the approver; others cannot; the approver must be an active user who reaches the tender', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const manager = await createUser(org, 'bid_manager');
    const member = await createUser(org, 'member');
    await addMember(g.tender, member, 'B');
    const path = g.url(`/${g.gates.G1!.id}`);

    for (const user of [member, g.approver]) {
      const res = await as(user).patch(path).send({ approver_user_id: member.id });
      expect([res.status, res.body.error.code]).toEqual([403, 'approver_change_forbidden']);
    }
    const api = await as(manager);
    const ok = await api.patch(path).send({ approver_user_id: member.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ approver_user_id: member.id, approver: { name: member.name } });
    expect((await as(await createUser(org, 'admin')).patch(path).send({ approver_user_id: manager.id })).body.approver_user_id).toBe(manager.id);

    const inactive = await createUser(org, 'approver', { active: false });
    const outsider = await createUser(org, 'approver'); // not a member of the tender
    const viewer = await createUser(org, 'viewer');
    await addMember(g.tender, viewer);
    const foreigner = await createUser(await createOrg(), 'admin');
    const cases: [string, string][] = [[inactive.id, 'approver_invalid'], [foreigner.id, 'approver_invalid'], [missingId(), 'approver_invalid'], [outsider.id, 'approver_not_member'], [viewer.id, 'approver_is_viewer']];
    for (const [id, code] of cases) {
      const res = await api.patch(path).send({ approver_user_id: id });
      expect([res.status, res.body.error.code]).toEqual([422, code]);
    }
    expect((await api.patch(path).send({ approver_user_id: 'x' })).status).toBe(400);
    expect((await api.patch(path).send({ approver_user_id: member.id, decision: 'approved' })).status).toBe(400);
    expect((await api.patch(path).send({ approver_user_id: null })).body).toMatchObject({ approver_user_id: null, approver: null, permissions: { can_request: false } });
  });

  it('request approval stamps requested_at/by and emits gate.approval_requested; changing the approver clears the request', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const member = await createUser(org, 'member');
    await addMember(g.tender, member, 'B');
    const events: unknown[] = [];
    const off = on('gate.approval_requested', (_ctx, payload) => void events.push(payload));

    const res = await as(member).post(g.url(`/${g.gates.G1!.id}/request`));
    await flushEvents();
    off();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requested_by: member.id, requested_at: expect.any(String), decision: 'pending' });
    expect(events).toEqual([{ tenderId: g.tender.id, gateId: g.gates.G1!.id, approverUserId: g.approver.id }]);

    const manager = await as(await createUser(org, 'bid_manager'));
    const changed = await manager.patch(g.url(`/${g.gates.G1!.id}`)).send({ approver_user_id: member.id });
    expect(changed.body).toMatchObject({ requested_at: null, requested_by: null });

    await manager.patch(g.url(`/${g.gates.G2!.id}`)).send({ approver_user_id: null });
    const none = await as(member).post(g.url(`/${g.gates.G2!.id}/request`));
    expect([none.status, none.body.error.code]).toEqual([422, 'gate_no_approver']);
  });
});

describe('gates: decision (R11, R12)', () => {
  it('R11: only approver_user_id decides — not the bid manager, not even an admin', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    await checkAllManual(g, 'G2');
    const member = await createUser(org, 'member');
    await addMember(g.tender, member, 'B');
    const otherApprover = await createUser(org, 'approver');
    await addMember(g.tender, otherApprover, 'MGMT');
    const path = g.url(`/${g.gates.G2!.id}/decision`);
    for (const user of [await createUser(org, 'admin'), await createUser(org, 'bid_manager'), member, otherApprover]) {
      const res = await as(user).post(path).send({ decision: 'approved' });
      expect([res.status, res.body.error.code]).toEqual([403, 'not_gate_approver']);
    }
    expect((await dbFor(org).get('gate', g.gates.G2!.id))!.decision).toBe('pending');

    const events: unknown[] = [];
    const off = on('gate.decided', (_ctx, payload) => void events.push(payload));
    const ok = await as(g.approver).post(path).send({ decision: 'approved' });
    await flushEvents();
    off();
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      tender_status: 'in_progress',
      cancelled_tasks: 0,
      gate: { decision: 'approved', decided_by: g.approver.id, decided_at: expect.any(String), justification: null, exception: false, permissions: { can_decide: false } },
    });
    expect(events).toEqual([{ tenderId: g.tender.id, gateId: g.gates.G2!.id, decision: 'approved' }]);
    expect((await dbFor(org).get('milestone', g.milestones.G2!.id))!.done_at).toBeInstanceOf(Date);

    // an admin who IS the approver may decide
    const admin = await createUser(org, 'admin');
    await as(admin).patch(g.url(`/${g.gates.G0!.id}`)).send({ approver_user_id: admin.id });
    expect((await as(admin).post(g.url(`/${g.gates.G0!.id}/decision`)).send({ decision: 'go', justification: GOOD })).status).toBe(200);
  });

  it('R12: an unmet criterion refuses plain approval; exception needs ≥ 20 characters and lands in the audit log', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const api = await as(g.approver);
    const db = dbFor(org);
    const gateId = g.gates.G1!.id;
    const path = g.url(`/${gateId}/decision`);
    await db.update('gate_criterion', g.criteria.G1![0]!.id, { checked_by: g.approver.id, checked_at: new Date() }); // manual met
    await addRequirement(g.tender, 'ΥΠ-001', { evidence_ref: null }); // auto exclusion_evidence_100 unmet

    const plain = await api.post(path).send({ decision: 'approved' });
    expect([plain.status, plain.body.error.code]).toEqual([422, 'criteria_unmet']);
    expect(plain.body.error.details.unmet).toEqual([expect.objectContaining({ key: 'g1_exclusion', auto_rule: 'exclusion_evidence_100', detail: expect.objectContaining({ items: ['ΥΠ-001'] }) })]);
    // acceptance: unmet criterion without justification → rejected by the API
    const withJust = await api.post(path).send({ decision: 'approved', justification: GOOD });
    expect([withJust.status, withJust.body.error.code]).toEqual([422, 'criteria_unmet']);

    for (const justification of [undefined, null, '', '   ', JUST_19, `   ${JUST_19}   `]) {
      const res = await api.post(path).send({ decision: 'approved_with_exception', justification });
      expect([res.status, res.body.error.code]).toEqual([422, 'justification_too_short']);
      expect(res.body.error.details).toMatchObject({ min: 20 });
    }
    expect(JUST_19).toHaveLength(19);
    expect(JUST_20).toHaveLength(20);
    expect((await db.get('gate', gateId))!.decision).toBe('pending');
    expect((await db.get('milestone', g.milestones.G1!.id))!.done_at).toBeNull();

    const ok = await api.post(path).send({ decision: 'approved_with_exception', justification: `  ${JUST_20} ` });
    expect(ok.status).toBe(200);
    expect(ok.body.gate).toMatchObject({ decision: 'approved_with_exception', justification: JUST_20, exception: true, decided_by: g.approver.id });
    expect((await db.get('milestone', g.milestones.G1!.id))!.done_at).toBeInstanceOf(Date);

    const audit = await db.list('audit_log', { entity: 'gate', entity_id: gateId });
    const update = audit.find((a) => a.action === 'update' && a.after?.decision === 'approved_with_exception');
    expect(update).toMatchObject({ user_id: g.approver.id, tender_id: g.tender.id, before: { decision: 'pending', justification: null }, after: { justification: JUST_20 } });
    const exception = audit.find((a) => a.action === 'exception');
    expect(exception).toMatchObject({ user_id: g.approver.id, tender_id: g.tender.id, after: { decision: 'approved_with_exception', justification: JUST_20 } });
    expect(exception!.after.unmet.map((u: { auto_rule: string }) => u.auto_rule)).toEqual(['exclusion_evidence_100']);

    const twice = await api.post(path).send({ decision: 'approved_with_exception', justification: GOOD });
    expect([twice.status, twice.body.error.code]).toEqual([409, 'gate_already_decided']);
  });

  it('R12 applies to unchecked manual criteria too; rejection always needs a justification', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const api = await as(g.approver);
    const path = g.url(`/${g.gates.G2!.id}/decision`);
    await dbFor(org).update('gate_criterion', g.criteria.G2![0]!.id, { checked_by: g.approver.id, checked_at: new Date() }); // 1 of 2
    const plain = await api.post(path).send({ decision: 'approved' });
    expect([plain.status, plain.body.error.code]).toEqual([422, 'criteria_unmet']);
    expect(plain.body.error.details.unmet.map((u: { key: string }) => u.key)).toEqual(['g2_budget']);

    for (const justification of [undefined, JUST_19]) {
      const res = await api.post(path).send({ decision: 'rejected', justification });
      expect([res.status, res.body.error.code]).toEqual([422, 'justification_too_short']);
    }
    const rejected = await api.post(path).send({ decision: 'rejected', justification: GOOD });
    expect(rejected.body.gate).toMatchObject({ decision: 'rejected', justification: GOOD, exception: false });
    expect((await dbFor(org).get('milestone', g.milestones.G2!.id))!.done_at).toBeNull(); // a rejection does not complete the milestone
    expect((await dbFor(org).get('tender', g.tender.id))!.status).toBe('in_progress');
  });

  it('decisions must match the gate mode; bad input is a 400', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const api = await as(g.approver);
    for (const [gate, decision] of [['G0', 'approved'], ['G0', 'rejected'], ['G2', 'go'], ['G2', 'no_go']] as const) {
      const res = await api.post(g.url(`/${g.gates[gate]!.id}/decision`)).send({ decision, justification: GOOD });
      expect([res.status, res.body.error.code]).toEqual([422, 'decision_not_allowed']);
    }
    for (const body of [{}, { decision: 'pending' }, { decision: 'maybe' }, { decision: 'approved', extra: 1 }]) {
      expect((await api.post(g.url(`/${g.gates.G2!.id}/decision`)).send(body)).status).toBe(400);
    }
  });

  it('stores the criteria as evaluated at decision time in the snapshot — later changes do not rewrite history', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const db = dbFor(org);
    const requirement = await addRequirement(g.tender, 'ΥΠ-007', { status: 'open' });
    const api = await as(g.approver);
    const res = await api.post(g.url(`/${g.gates.G3!.id}/decision`)).send({ decision: 'approved_with_exception', justification: GOOD });
    expect(res.body.gate.snapshot).toMatchObject({ at: expect.any(String), met: 0, total: 2 });
    await db.update('requirement', requirement.id, { status: 'verified' });

    const later = (await api.get(g.url(`/${g.gates.G3!.id}`))).body;
    expect(crit(later, 'g3_register').satisfied).toBe(true); // live
    expect(crit(later.snapshot, 'g3_register')).toMatchObject({ satisfied: false, detail: { code: 'register_open_rows', items: ['ΥΠ-007'] } }); // as seen
    expect((await db.get('gate', g.gates.G3!.id))!.payload).toMatchObject({ exception: true, snapshot: { total: 2 } });
  });
});

describe('gates: G0 Go / No-Go (R14)', () => {
  it('Go with all criteria met needs no justification and moves an evaluation tender to in_progress', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org, { status: 'evaluation' });
    await checkAllManual(g, 'G0');
    const res = await as(g.approver).post(g.url(`/${g.gates.G0!.id}/decision`)).send({ decision: 'go' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tender_status: 'in_progress', gate: { decision: 'go', exception: false, justification: null } });
    const db = dbFor(org);
    expect((await db.get('tender', g.tender.id))!).toMatchObject({ status: 'in_progress', closed_at: null });
    expect((await db.get('milestone', g.milestones.G0!.id))!.done_at).toBeInstanceOf(Date);
  });

  it('Go with unmet criteria is an exception: refused without a ≥ 20-character justification', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const api = await as(g.approver);
    const path = g.url(`/${g.gates.G0!.id}/decision`);
    const plain = await api.post(path).send({ decision: 'go' });
    expect([plain.status, plain.body.error.code]).toEqual([422, 'criteria_unmet']);
    expect(plain.body.error.details.unmet).toHaveLength(2);
    const short = await api.post(path).send({ decision: 'go', justification: JUST_19 });
    expect([short.status, short.body.error.code]).toEqual([422, 'justification_too_short']);

    const ok = await api.post(path).send({ decision: 'go', justification: JUST_20 });
    expect(ok.status).toBe(200);
    expect(ok.body.gate).toMatchObject({ decision: 'go', justification: JUST_20, exception: true });
    const db = dbFor(org);
    expect((await db.get('gate', g.gates.G0!.id))!.payload.exception).toBe(true);
    expect(await db.findOne('audit_log', { entity: 'gate', entity_id: g.gates.G0!.id, action: 'exception' })).toMatchObject({ after: { decision: 'go', justification: JUST_20 } });
  });

  it('R14: No-Go closes the tender and cancels open / in-progress tasks, in one go', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org, { status: 'evaluation' });
    const other = await createGatedTender(org);
    const db = dbFor(org);
    const open = await addTask(g.tender, 'Ανάλυση διακήρυξης');
    const inProgress = await addTask(g.tender, 'Cheat sheet', { status: 'in_progress' });
    const handoff = await addHandoff(g.tender, 'Β → Α');
    const done = await addTask(g.tender, 'Λήψη τευχών', { status: 'done', done_at: new Date() });
    const na = await addTask(g.tender, 'Demo', { status: 'na', section: 'checklist' });
    const foreign = await addTask(other.tender, 'Άλλος διαγωνισμός');
    const api = await as(g.approver);
    const path = g.url(`/${g.gates.G0!.id}/decision`);

    const noReason = await api.post(path).send({ decision: 'no_go' });
    expect([noReason.status, noReason.body.error.code]).toEqual([422, 'justification_too_short']);
    expect((await db.get('tender', g.tender.id))!.status).toBe('evaluation');
    expect((await db.get('task', open.id))!.status).toBe('open');

    const events: { decision: string }[] = [];
    const off = on('gate.decided', (_ctx, payload) => void events.push(payload));
    const res = await api.post(path).send({ decision: 'no_go', justification: 'Το περιθώριο δεν καλύπτει το ρίσκο των ρητρών.' });
    await flushEvents();
    off();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tender_status: 'no_go', cancelled_tasks: 3, gate: { decision: 'no_go', permissions: { can_reopen: false, can_check: false } } });
    expect(events.map((e) => e.decision)).toEqual(['no_go']);

    const tender = (await db.get('tender', g.tender.id))!;
    expect(tender.status).toBe('no_go');
    expect(tender.closed_at).toBeInstanceOf(Date);
    for (const t of [open, inProgress, handoff]) expect((await db.get('task', t.id))!.status).toBe('cancelled');
    expect((await db.get('task', done.id))!.status).toBe('done');
    expect((await db.get('task', na.id))!.status).toBe('na');
    expect((await db.get('task', foreign.id))!.status).toBe('open');
    expect((await db.get('milestone', g.milestones.G0!.id))!.done_at).toBeNull();
    expect(await db.findOne('audit_log', { entity: 'tender', entity_id: g.tender.id, action: 'update' })).toMatchObject({ after: { status: 'no_go' } });
    expect(await db.count('audit_log', { entity: 'task', tender_id: g.tender.id, action: 'update' })).toBe(3);

    // the closed tender is read-only: nothing on its gates can change any more, and the No-Go cannot be reopened
    const manager = await as(await createUser(org, 'bid_manager'));
    const reopen = await manager.post(g.url(`/${g.gates.G0!.id}/reopen`)).send({ reason: 'Αλλάξαμε γνώμη' });
    expect([reopen.status, reopen.body.error.code]).toEqual([409, 'no_go_final']);
    expect((await api.get(g.url())).status).toBe(200);
  });
});

describe('gates: closed tenders are read-only', () => {
  it('every mutation is refused with tender_closed; reads still work', async () => {
    for (const status of ['submitted', 'cancelled', 'no_go']) {
      const org = await createOrg();
      const g = await createGatedTender(org);
      await checkAllManual(g, 'G2');
      await dbFor(org).update('tender', g.tender.id, { status, closed_at: new Date() });
      const manager = await as(await createUser(org, 'bid_manager'));
      const approver = await as(g.approver);
      const gateId = g.gates.G2!.id;
      const responses = [
        await manager.patch(g.url(`/${gateId}`)).send({ approver_user_id: null }),
        await manager.patch(g.url(`/${gateId}/criteria/${g.criteria.G2![0]!.id}`)).send({ checked: false }),
        await manager.post(g.url(`/${gateId}/request`)),
        await approver.post(g.url(`/${gateId}/decision`)).send({ decision: 'approved' }),
      ];
      for (const res of responses) expect([res.status, res.body.error.code]).toEqual([422, 'tender_closed']);
      const list = await manager.get(g.url());
      expect(list.status).toBe(200);
      expect(list.body.items[2].permissions).toEqual({ can_check: false, can_request: false, can_change_approver: false, can_decide: false, can_reopen: false });
    }
  });

  it('a decided gate of a submitted tender cannot be reopened', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    await checkAllManual(g, 'G2');
    await as(g.approver).post(g.url(`/${g.gates.G2!.id}/decision`)).send({ decision: 'approved' });
    await dbFor(org).update('tender', g.tender.id, { status: 'submitted', closed_at: new Date() });
    const res = await as(await createUser(org, 'admin')).post(g.url(`/${g.gates.G2!.id}/reopen`)).send({ reason: 'Λάθος απόφαση' });
    expect([res.status, res.body.error.code]).toEqual([422, 'tender_closed']);
  });
});

describe('gates: reopen', () => {
  it('bid_manager / admin reset a decided gate to pending with an audited reason; history keeps the old decision', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const db = dbFor(org);
    const gateId = g.gates.G2!.id;
    const manager = await createUser(org, 'bid_manager');
    const path = g.url(`/${gateId}/reopen`);

    const notDecided = await as(manager).post(path).send({ reason: 'Λάθος απόφαση' });
    expect([notDecided.status, notDecided.body.error.code]).toEqual([409, 'gate_not_decided']);

    await as(g.approver).post(g.url(`/${gateId}/decision`)).send({ decision: 'approved_with_exception', justification: GOOD });
    const forbidden = await as(g.approver).post(path).send({ reason: 'Λάθος απόφαση' });
    expect([forbidden.status, forbidden.body.error.code]).toEqual([403, 'reopen_forbidden']);
    expect((await as(manager).post(path).send({ reason: ' ' })).status).toBe(400);
    expect((await as(manager).post(path).send({})).status).toBe(400);

    const res = await as(manager).post(path).send({ reason: 'Η κοστολόγηση άλλαξε μετά την έγκριση' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision: 'pending', justification: null, decided_by: null, decided_at: null, snapshot: null, exception: false, requested_at: null,
      permissions: { can_check: true, can_reopen: false },
    });
    expect(res.body.history).toEqual([
      expect.objectContaining({ decision: 'approved_with_exception', justification: GOOD, exception: true, decided_by: g.approver.id, reopened_by: manager.id, reason: 'Η κοστολόγηση άλλαξε μετά την έγκριση', snapshot: expect.objectContaining({ total: 2 }) }),
    ]);
    expect((await db.get('milestone', g.milestones.G2!.id))!.done_at).toBeNull();
    expect(await db.findOne('audit_log', { entity: 'gate', entity_id: gateId, action: 'reopen' })).toMatchObject({
      user_id: manager.id, before: { decision: 'approved_with_exception' }, after: { decision: 'pending', reason: 'Η κοστολόγηση άλλαξε μετά την έγκριση' },
    });

    // and the approver can decide again
    await checkAllManual(g, 'G2');
    const again = await as(g.approver).post(g.url(`/${gateId}/decision`)).send({ decision: 'approved' });
    expect(again.body.gate).toMatchObject({ decision: 'approved', exception: false });
    expect(again.body.gate.history).toHaveLength(1);
  });
});

describe('gates: access', () => {
  it('a viewer reads but changes nothing', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const viewer = await createUser(org, 'viewer');
    await addMember(g.tender, viewer);
    // even a viewer who was (wrongly, straight in the database) made approver cannot decide
    await dbFor(org).update('gate', g.gates.G2!.id, { approver_user_id: viewer.id });
    await checkAllManual(g, 'G2');
    const api = await as(viewer);
    const gateId = g.gates.G2!.id;

    const list = await api.get(g.url());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(5);
    expect(list.body.items[2].permissions).toEqual({ can_check: false, can_request: false, can_change_approver: false, can_decide: false, can_reopen: false });
    expect((await api.get(g.url(`/${gateId}`))).status).toBe(200);

    const responses = [
      await api.patch(g.url(`/${gateId}`)).send({ approver_user_id: null }),
      await api.patch(g.url(`/${gateId}/criteria/${g.criteria.G2![0]!.id}`)).send({ checked: false }),
      await api.post(g.url(`/${gateId}/request`)),
      await api.post(g.url(`/${gateId}/decision`)).send({ decision: 'approved' }),
      await api.post(g.url(`/${gateId}/reopen`)).send({ reason: 'Λάθος απόφαση' }),
    ];
    for (const res of responses) expect(res.status).toBe(403);
    expect((await dbFor(org).get('gate', gateId))!.decision).toBe('pending');
  });

  it('a user of the org who is not a member of the tender gets 403 on every endpoint', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    const gateId = g.gates.G2!.id;
    for (const role of ['member', 'approver', 'viewer'] as const) {
      const api = await as(await createUser(org, role));
      const responses = [
        await api.get(g.url()),
        await api.get(g.url(`/${gateId}`)),
        await api.patch(g.url(`/${gateId}`)).send({ approver_user_id: null }),
        await api.patch(g.url(`/${gateId}/criteria/${g.criteria.G2![0]!.id}`)).send({ checked: true }),
        await api.post(g.url(`/${gateId}/request`)),
        await api.post(g.url(`/${gateId}/decision`)).send({ decision: 'approved' }),
        await api.post(g.url(`/${gateId}/reopen`)).send({ reason: 'Λάθος απόφαση' }),
      ];
      for (const res of responses) expect(res.status).toBe(403);
    }
  });

  it('cross-org isolation: another organization gets 404 on every endpoint and its own data never mixes in', async () => {
    const org = await createOrg();
    const g = await createGatedTender(org);
    await checkAllManual(g, 'G2');
    const gateId = g.gates.G2!.id;
    const otherOrg = await createOrg();
    const theirs = await createGatedTender(otherOrg);
    const foreignAdmin = await createUser(otherOrg, 'admin');
    const api = await as(foreignAdmin);

    const responses = [
      await api.get(g.url()),
      await api.get(g.url(`/${gateId}`)),
      await api.patch(g.url(`/${gateId}`)).send({ approver_user_id: foreignAdmin.id }),
      await api.patch(g.url(`/${gateId}/criteria/${g.criteria.G2![0]!.id}`)).send({ checked: false }),
      await api.post(g.url(`/${gateId}/request`)),
      await api.post(g.url(`/${gateId}/decision`)).send({ decision: 'approved' }),
      await api.post(g.url(`/${gateId}/reopen`)).send({ reason: 'Λάθος απόφαση' }),
    ];
    for (const res of responses) expect(res.status).toBe(404);

    // their own tender + our gate / criterion ids: nothing is found, nothing changes
    const mixed = [
      await api.get(theirs.url(`/${gateId}`)),
      await api.patch(theirs.url(`/${gateId}`)).send({ approver_user_id: foreignAdmin.id }),
      await api.patch(theirs.url(`/${theirs.gates.G2!.id}/criteria/${g.criteria.G2![0]!.id}`)).send({ checked: false }),
      await api.post(theirs.url(`/${gateId}/request`)),
      await api.post(theirs.url(`/${gateId}/decision`)).send({ decision: 'approved' }),
      await api.post(theirs.url(`/${gateId}/reopen`)).send({ reason: 'Λάθος απόφαση' }),
    ];
    for (const res of mixed) expect(res.status).toBe(404);
    const ours = (await dbFor(org).get('gate', gateId))!;
    expect(ours).toMatchObject({ decision: 'pending', approver_user_id: g.approver.id, requested_at: null });
    expect((await dbFor(org).get('gate_criterion', g.criteria.G2![0]!.id))!.checked_at).toBeInstanceOf(Date);

    // rule data is scoped too: our expired document and open requirement do not fail their gates, and vice versa
    await linkDocument(g.tender, 'ISO 9001 (ours, expired)', '2020-01-01');
    await addRequirement(g.tender, 'ΥΠ-001', { status: 'open', evidence_ref: null });
    await addRequirement(theirs.tender, 'ΥΠ-001', { evidence_ref: 'ok' });
    const list = (await api.get(theirs.url())).body.items;
    expect(list).toHaveLength(5);
    expect(list.every((i: { tender_id: string }) => i.tender_id === theirs.tender.id)).toBe(true);
    expect(crit(list[4], 'g4_docs')).toMatchObject({ satisfied: true, detail: { code: 'docs_none_linked' } });
    expect(crit(list[3], 'g3_register')).toMatchObject({ satisfied: true, detail: { total: 1 } });
    expect(crit(list[1], 'g1_exclusion')).toMatchObject({ satisfied: true, detail: { total: 1 } });

    // a gate of another tender in the same org is not reachable through this tender's URL
    const sibling = await createGatedTender(org);
    const admin = await as(await createUser(org, 'admin'));
    expect((await admin.get(g.url(`/${sibling.gates.G2!.id}`))).status).toBe(404);
    expect((await admin.post(g.url(`/${sibling.gates.G2!.id}/request`))).status).toBe(404);
  });
});
