import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedTemplateL11 } from '../../db/seed.js';
import { addMember, as, createOrg, createUser, dbFor, missingId, seedHolidays, type TestOrg, type TestUser } from '../../test/harness.js';

// Pinned clock: Fri 13/11/2026 (the scenarios use the spec's T = Fri 07/05/2027).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T10:00:00Z') });
});
afterAll(() => {
  vi.useRealTimers();
});

interface World {
  org: TestOrg;
  admin: TestUser;
  tenderId: string;
  url: string;
}
async function world(overrides: Record<string, unknown> = {}): Promise<World> {
  const org = await createOrg();
  await seedHolidays(org, [2026, 2027]);
  const { template } = await seedTemplateL11(dbFor(org));
  const admin = await createUser(org, 'admin');
  const res = await as(admin)
    .post('/api/tenders')
    .send({
      title: 'Διαγωνισμός',
      authority: 'Αναθέτουσα',
      t0_published_at: '2027-03-01',
      submission_deadline_at: '2027-05-07T12:00:00Z',
      offer_validity_days: 180,
      template_id: template.id,
      ...overrides,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { org, admin, tenderId: res.body.tender.id, url: `/api/tenders/${res.body.tender.id}/milestones` };
}

type Item = Record<string, any>;
const byKey = (items: Item[]) => Object.fromEntries(items.map((m) => [m.key, m])) as Record<string, Item>;
const row = async (w: World, key: string) => (await dbFor(w.org).findOne('milestone', { tender_id: w.tenderId, key })) as Item;

describe('GET /api/tenders/:tenderId/milestones', () => {
  it('lists the schedule by date with T−n per row', async () => {
    const w = await world();
    const res = await as(w.admin).get(w.url);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ T: '2027-05-07', T0: '2027-03-01', today: '2026-11-13', tMinus: 118, compressed_mode: false });
    const items: Item[] = res.body.items;
    expect(items.map((m) => m.key)).toEqual(['G0', 'H1', 'H2', 'H5', 'H4', 'G1', 'H3', 'G2', 'G3', 'G4', 'UPLOAD']);
    expect(items.map((m) => m.due_date)).toEqual([...items.map((m) => m.due_date)].sort());
    const m = byKey(items);
    expect(m.G4).toEqual({
      id: expect.any(String),
      tender_id: w.tenderId,
      key: 'G4',
      name: 'G4 Final sign-off',
      kind: 'gate',
      due_date: '2027-05-05',
      computed_from: { anchor: 'T', offset_value: -2, offset_unit: 'working', rule: 'offset' },
      computed_date: '2027-05-05',
      is_manual: false,
      needs_review: false,
      done_at: null,
      done: false,
      sort: expect.any(Number),
      tMinus: 2,
      is_working_day: true,
      overdue: false,
      gate: { id: expect.any(String), decision: 'pending' },
      handoff: null,
    });
    expect(m.H3).toMatchObject({ kind: 'handoff', due_date: '2027-04-23', tMinus: 8, gate: null, handoff: { task_id: expect.any(String), status: 'open', received_at: null, from_role: 'B', to_role: 'C' } });
    expect(m.UPLOAD).toMatchObject({ kind: 'milestone', tMinus: 1, gate: null, handoff: null });
    expect(m.G0).toMatchObject({ due_date: '2027-03-04', tMinus: 42 });
  });

  it('a decided gate and a received handoff count as done; past open milestones are overdue', async () => {
    const w = await world({ t0_published_at: '2026-11-02', submission_deadline_at: '2026-12-18T12:00:00Z' });
    const db = dbFor(w.org);
    const before = byKey((await as(w.admin).get(w.url)).body.items);
    expect(before.G0).toMatchObject({ due_date: '2026-11-05', overdue: true, done: false }); // T0+3, a week ago
    const gate = await db.findOne('gate', { tender_id: w.tenderId, key: 'G0' });
    await db.update('gate', gate?.id, { decision: 'go' });
    const task = await db.findOne('task', { tender_id: w.tenderId, key: 'H1' });
    await db.update('task', task?.id, { received_at: new Date(), status: 'done' });
    const after = byKey((await as(w.admin).get(w.url)).body.items);
    expect(after.G0).toMatchObject({ done: true, overdue: false, done_at: null, gate: { decision: 'go' } });
    expect(after.H1).toMatchObject({ done: true, overdue: false, handoff: { status: 'done' } });
    expect(after.H2).toMatchObject({ done: false, overdue: true });
  });
});

describe('PATCH /api/tenders/:tenderId/milestones/:id', () => {
  it('a manual date pins the milestone; dependents, handoff tasks, tasks and watch items follow', async () => {
    const w = await world();
    const api = await as(w.admin);
    const db = dbFor(w.org);
    const g0 = await row(w, 'G0');
    const res = await api.patch(`${w.url}/${g0.id}`).send({ due_date: '2027-03-10' });
    expect(res.status).toBe(200);
    const m = byKey(res.body.items);
    expect(m.G0).toMatchObject({ due_date: '2027-03-10', is_manual: true, needs_review: false, computed_date: '2027-03-04' });
    expect(m.H1).toMatchObject({ due_date: '2027-03-12', is_manual: false }); // G0+2
    expect(m.H2).toMatchObject({ due_date: '2027-03-16' }); // G0+3 (15/03 is Clean Monday)
    expect(m.H5).toMatchObject({ due_date: '2027-03-16' });
    expect(m.G1).toMatchObject({ due_date: '2027-04-23' }); // not anchored on G0
    expect((await db.findOne('task', { tender_id: w.tenderId, key: 'H1' }))?.due_date).toBe('2027-03-12');
    expect((await db.findOne('task', { tender_id: w.tenderId, key: 'WP1' }))?.due_date).toBe('2027-03-10');
    expect(await db.findOne('audit_log', { entity: 'milestone', entity_id: g0.id, action: 'update' })).toMatchObject({ user_id: w.admin.id, tender_id: w.tenderId });

    // G4 moved by hand → the guarantee is needed on the new date (R6 input), the handoff of G1 follows G1
    const g4 = await row(w, 'G4');
    await api.patch(`${w.url}/${g4.id}`).send({ due_date: '2027-05-04' }).expect(200);
    expect((await db.findOne('watch_item', { tender_id: w.tenderId, key: 'guarantee' }))?.needed_at).toBe('2027-05-04');
    const g1 = await row(w, 'G1');
    const moved = byKey((await api.patch(`${w.url}/${g1.id}`).send({ due_date: '2027-04-22' })).body.items);
    expect(moved.H3).toMatchObject({ due_date: '2027-04-22', is_manual: false });
    expect((await db.findOne('task', { tender_id: w.tenderId, key: 'H3' }))?.due_date).toBe('2027-04-22');
    expect((await db.findOne('watch_item', { tender_id: w.tenderId, key: 'maf' }))?.needed_at).toBe('2027-04-22');
    expect((await db.findOne('task', { tender_id: w.tenderId, key: 'WP3' }))?.due_date).toBe('2027-04-22');

    // a task whose date somebody changed by hand is left alone
    const wp7 = await db.findOne('task', { tender_id: w.tenderId, key: 'WP7' });
    await db.update('task', wp7?.id, { due_date: '2027-04-26' });
    await api.patch(`${w.url}/${(await row(w, 'G2')).id}`).send({ due_date: '2027-04-28' }).expect(200);
    expect((await db.findOne('task', { tender_id: w.tenderId, key: 'WP7' }))?.due_date).toBe('2027-04-26');
  });

  it('a manual milestone is not recomputed; reset returns it to the computed date', async () => {
    const w = await world();
    const api = await as(w.admin);
    const g0 = await row(w, 'G0');
    await api.patch(`${w.url}/${g0.id}`).send({ due_date: '2027-03-10' }).expect(200);
    // moving something else does not touch the pinned G0
    await api.patch(`${w.url}/${(await row(w, 'G3')).id}`).send({ due_date: '2027-05-03' }).expect(200);
    expect(await row(w, 'G0')).toMatchObject({ due_date: '2027-03-10', is_manual: true });
    expect((await row(w, 'G3')).is_working_day).toBeUndefined();
    const list = byKey((await api.get(w.url)).body.items);
    expect(list.G3).toMatchObject({ due_date: '2027-05-03', is_working_day: false, tMinus: 4 }); // Easter Monday: allowed, but shown

    const reset = await api.post(`${w.url}/${g0.id}/reset`);
    expect(reset.status).toBe(200);
    const m = byKey(reset.body.items);
    expect(m.G0).toMatchObject({ due_date: '2027-03-04', is_manual: false, needs_review: false });
    expect(m.H1).toMatchObject({ due_date: '2027-03-08' });
    expect((await dbFor(w.org).findOne('task', { tender_id: w.tenderId, key: 'H1' }))?.due_date).toBe('2027-03-08');
    expect((await api.post(`${w.url}/${g0.id}/reset`)).status).toBe(200); // idempotent
  });

  it('needs_review is cleared after checking, or by a new manual date', async () => {
    const w = await world();
    const api = await as(w.admin);
    const g2 = await row(w, 'G2');
    const g3 = await row(w, 'G3');
    await api.patch(`${w.url}/${g2.id}`).send({ due_date: '2027-04-27' }).expect(200);
    await api.patch(`${w.url}/${g3.id}`).send({ due_date: '2027-04-28' }).expect(200);
    await api.post(`/api/tenders/${w.tenderId}/deadline`).send({ submission_deadline_at: '2027-05-14T12:00:00Z' }).expect(200);
    expect(await row(w, 'G2')).toMatchObject({ needs_review: true, due_date: '2027-04-27' });
    expect(await row(w, 'G3')).toMatchObject({ needs_review: true });

    const cleared = byKey((await api.patch(`${w.url}/${g2.id}`).send({ needs_review: false })).body.items);
    expect(cleared.G2).toMatchObject({ needs_review: false, is_manual: true, due_date: '2027-04-27', computed_date: '2027-05-10' });
    expect(cleared.G3).toMatchObject({ needs_review: true });
    const redated = byKey((await api.patch(`${w.url}/${g3.id}`).send({ due_date: '2027-05-11' })).body.items);
    expect(redated.G3).toMatchObject({ needs_review: false, is_manual: true });
    expect((await api.patch(`${w.url}/${g2.id}`).send({ needs_review: true })).status).toBe(400);
  });

  it('done / undone for plain milestones (R10); gates and handoffs are completed elsewhere', async () => {
    const w = await world();
    const api = await as(w.admin);
    const upload = await row(w, 'UPLOAD');
    const done = byKey((await api.patch(`${w.url}/${upload.id}`).send({ done: true })).body.items);
    expect(done.UPLOAD).toMatchObject({ done: true, done_at: expect.any(String) });
    const moved = await api.patch(`${w.url}/${upload.id}`).send({ due_date: '2027-05-05' });
    expect([moved.status, moved.body.error.code]).toEqual([422, 'milestone_done']);
    const reset = await api.post(`${w.url}/${upload.id}/reset`);
    expect([reset.status, reset.body.error.code]).toEqual([422, 'milestone_done']);
    const undone = byKey((await api.patch(`${w.url}/${upload.id}`).send({ done: false })).body.items);
    expect(undone.UPLOAD).toMatchObject({ done: false, done_at: null, due_date: '2027-05-06' });
    // undone and re-dated in one call
    expect(byKey((await api.patch(`${w.url}/${upload.id}`).send({ done: false, due_date: '2027-05-05' })).body.items).UPLOAD).toMatchObject({ due_date: '2027-05-05', is_manual: true });

    for (const key of ['G1', 'H1']) {
      const res = await api.patch(`${w.url}/${(await row(w, key)).id}`).send({ done: true });
      expect([res.status, res.body.error.code]).toEqual([422, 'done_managed_elsewhere']);
    }
    // a decided gate cannot be re-dated
    const gate = await dbFor(w.org).findOne('gate', { tender_id: w.tenderId, key: 'G1' });
    await dbFor(w.org).update('gate', gate?.id, { decision: 'approved' });
    const res = await api.patch(`${w.url}/${(await row(w, 'G1')).id}`).send({ due_date: '2027-04-26' });
    expect([res.status, res.body.error.code]).toEqual([422, 'milestone_done']);
  });

  it('days passing never switch compressed mode on by a manual change (R8 is evaluated on create / extension)', async () => {
    const w = await world({ t0_published_at: '2026-11-02', submission_deadline_at: '2026-12-18T12:00:00Z' }); // 34 working days at T0
    expect((await row(w, 'G1')).due_date).toBe('2026-12-08'); // T−8
    // the same tender with only 8 working days left (as if the days had passed): the stored flag still says "not compressed"
    await dbFor(w.org).update('tender', w.tenderId, { submission_deadline_at: new Date('2026-11-25T12:00:00Z') });
    const api = await as(w.admin);
    const res = byKey((await api.patch(`${w.url}/${(await row(w, 'G3')).id}`).send({ due_date: '2026-11-23' })).body.items);
    expect(res.G1).toMatchObject({ due_date: '2026-11-13', tMinus: 8 }); // T−8, not the compressed T−5
    expect(res.G2).toMatchObject({ due_date: '2026-11-19', tMinus: 4 });
    expect((await dbFor(w.org).get('tender', w.tenderId))?.compressed_mode).toBe(false);
  });

  it('validates input', async () => {
    const w = await world();
    const api = await as(w.admin);
    const id = (await row(w, 'G2')).id;
    for (const b of [{}, { due_date: '27/04/2027' }, { due_date: '2027-02-30' }, { due_date: null }, { done: 'yes' }, { is_manual: true }, { name: 'x' }]) {
      expect((await api.patch(`${w.url}/${id}`).send(b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await api.patch(`${w.url}/${missingId()}`).send({ due_date: '2027-04-27' })).status).toBe(404);
    expect((await api.post(`${w.url}/${missingId()}/reset`)).status).toBe(404);
    // a milestone of another tender of the same org is not reachable through this tender
    const other = await world();
    const foreignMilestone = await dbFor(w.org).insert('milestone', { tender_id: w.tenderId, key: 'X', name: 'X', due_date: '2027-04-01' });
    expect((await as(other.admin).patch(`${other.url}/${foreignMilestone.id}`).send({ due_date: '2027-04-02' })).status).toBe(404);
  });
});

describe('access', () => {
  it('members mark milestones done but only admin / bid manager change dates; viewers only read', async () => {
    const w = await world();
    const tender = { id: w.tenderId, org_id: w.org.id };
    const member = await createUser(w.org, 'member');
    const viewer = await createUser(w.org, 'viewer');
    const outsider = await createUser(w.org, 'member');
    await addMember(tender, member, 'A');
    await addMember(tender, viewer);
    const upload = await row(w, 'UPLOAD');
    const g2 = await row(w, 'G2');

    const m = await as(member);
    expect((await m.get(w.url)).status).toBe(200);
    const denied = await m.patch(`${w.url}/${g2.id}`).send({ due_date: '2027-04-27' });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'schedule_manager_only']);
    expect((await m.patch(`${w.url}/${g2.id}`).send({ needs_review: false })).status).toBe(403);
    expect((await m.post(`${w.url}/${g2.id}/reset`)).status).toBe(403);
    expect((await m.patch(`${w.url}/${upload.id}`).send({ done: true })).status).toBe(200);
    expect((await row(w, 'UPLOAD')).done_at).toBeInstanceOf(Date);

    const v = await as(viewer);
    expect((await v.get(w.url)).status).toBe(200);
    expect((await v.patch(`${w.url}/${upload.id}`).send({ done: false })).status).toBe(403);
    expect((await v.post(`${w.url}/${g2.id}/reset`)).status).toBe(403);

    const o = await as(outsider);
    expect((await o.get(w.url)).status).toBe(403);
    expect((await o.patch(`${w.url}/${upload.id}`).send({ done: false })).status).toBe(403);

    const bm = await as(await createUser(w.org, 'bid_manager'));
    expect((await bm.patch(`${w.url}/${g2.id}`).send({ due_date: '2027-04-27' })).status).toBe(200);
    expect(await row(w, 'G2')).toMatchObject({ due_date: '2027-04-27', is_manual: true });
  });

  it('another organization gets 404 and changes nothing', async () => {
    const w = await world();
    const foreign = await as(await createUser(await createOrg(), 'admin'));
    const g2 = await row(w, 'G2');
    expect((await foreign.get(w.url)).status).toBe(404);
    expect((await foreign.patch(`${w.url}/${g2.id}`).send({ due_date: '2027-04-27' })).status).toBe(404);
    expect((await foreign.post(`${w.url}/${g2.id}/reset`)).status).toBe(404);
    expect(await row(w, 'G2')).toMatchObject({ due_date: '2027-04-29', is_manual: false });
  });

  it('a closed tender is read-only', async () => {
    const w = await world();
    const api = await as(w.admin);
    await api.post(`/api/tenders/${w.tenderId}/status`).send({ status: 'cancelled' }).expect(200);
    const g2 = await row(w, 'G2');
    expect((await api.get(w.url)).status).toBe(200);
    const patch = await api.patch(`${w.url}/${g2.id}`).send({ due_date: '2027-04-27' });
    expect([patch.status, patch.body.error.code]).toEqual([422, 'tender_closed']);
    const reset = await api.post(`${w.url}/${g2.id}/reset`);
    expect([reset.status, reset.body.error.code]).toEqual([422, 'tender_closed']);
  });
});
