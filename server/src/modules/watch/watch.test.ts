import { describe, expect, it } from 'vitest';
import { greekHolidays, shiftDays } from '../../domain/calendar.js';
import { todayAthens } from '../../domain/time.js';
import { lastRequestDate, requestOverdue, type WatchTiming } from '../../domain/watch.js';
import { addMember, addRole, as, createOrg, createTender, createUser, dbFor, missingId, seedHolidays } from '../../test/harness.js';
import { proposeExpected, watchState } from './service.js';

const H2027 = new Set(greekHolidays(2027).map((h) => h.date));
const item = (over: Partial<WatchTiming> = {}): WatchTiming => ({
  needed_at: '2027-05-05',
  lead_value: 10,
  lead_unit: 'calendar',
  requested_at: null,
  arrived_at: null,
  ...over,
});

describe('R6 — last request date of a watch item', () => {
  it('acceptance: G4 = Wed 05/05/2027, lead 10 calendar → Sun 25/04 → Fri 23/04', () => {
    expect(lastRequestDate(item(), H2027)).toBe('2027-04-23');
  });

  it('working-day lead times skip weekends and holidays (R4)', () => {
    // 8 working days before Wed 05/05/2027: skips Easter Monday 03/05, Good Friday 30/04 and two weekends
    expect(lastRequestDate(item({ lead_value: 8, lead_unit: 'working' }), H2027)).toBe('2027-04-21');
    expect(lastRequestDate(item({ lead_value: 0, lead_unit: 'working' }), H2027)).toBe('2027-05-05');
    // a missing unit counts as working days
    expect(lastRequestDate(item({ lead_value: 1, lead_unit: null }), H2027)).toBe('2027-05-04');
  });

  it('a calendar lead that lands on a holiday rolls back to the previous working day (R5)', () => {
    // 05/05 − 2 calendar = Mon 03/05 (Easter Monday) → Sun, Sat, Fri 30/04 (Good Friday) → Thu 29/04
    expect(lastRequestDate(item({ lead_value: 2 }), H2027)).toBe('2027-04-29');
  });

  it('is null for an open lead time or when no date is needed', () => {
    expect(lastRequestDate(item({ lead_value: null }), H2027)).toBeNull();
    expect(lastRequestDate(item({ needed_at: null }), H2027)).toBeNull();
  });

  it('red warning only once the last request day has passed without a request', () => {
    expect(requestOverdue(item(), '2027-04-22', H2027)).toBe(false);
    expect(requestOverdue(item(), '2027-04-23', H2027)).toBe(false); // the last day itself is still in time
    expect(requestOverdue(item(), '2027-04-24', H2027)).toBe(true);
    expect(requestOverdue(item({ requested_at: '2027-04-26' }), '2027-04-27', H2027)).toBe(false);
    expect(requestOverdue(item({ arrived_at: '2027-04-26' }), '2027-04-27', H2027)).toBe(false);
    expect(requestOverdue(item({ lead_value: null }), '2027-06-01', H2027)).toBe(false);
  });
});

describe('watch helpers', () => {
  it('proposes the expected arrival forward from the request date', () => {
    expect(proposeExpected('2027-04-22', 10, 'calendar', H2027)).toBe('2027-05-04'); // Sun 02/05 (Easter), Mon 03/05 holiday → Tue
    expect(proposeExpected('2027-04-22', 3, 'working', H2027)).toBe('2027-04-27');
    expect(proposeExpected('2027-04-22', 3, null, H2027)).toBe('2027-04-27');
    expect(proposeExpected('2027-04-22', null, 'calendar', H2027)).toBeNull();
  });

  it('state: not requested / requested / late vs expected / arrived', () => {
    const base = { requested_at: null, expected_at: null, arrived_at: null };
    expect(watchState(base, '2027-04-20')).toBe('not_requested');
    expect(watchState({ ...base, requested_at: '2027-04-19', expected_at: '2027-04-20' }, '2027-04-20')).toBe('requested');
    expect(watchState({ ...base, requested_at: '2027-04-19', expected_at: '2027-04-20' }, '2027-04-21')).toBe('late');
    expect(watchState({ ...base, requested_at: '2027-04-19' }, '2027-06-01')).toBe('requested');
    expect(watchState({ requested_at: '2027-04-19', expected_at: '2027-04-20', arrived_at: '2027-04-25' }, '2027-06-01')).toBe('arrived');
  });
});

async function setup() {
  const org = await createOrg();
  await seedHolidays(org, [2026, 2027]);
  const manager = await createUser(org, 'bid_manager');
  const member = await createUser(org, 'member');
  const viewer = await createUser(org, 'viewer');
  const outsider = await createUser(org, 'member');
  const tender = await createTender(org, { submission_deadline_at: '2027-05-07T09:00:00Z' });
  await addRole(tender, 'A', { folder: 'participation' }, 'Δικαιολογητικά');
  await addMember(tender, member, 'A');
  await addMember(tender, viewer);
  const g4 = await dbFor(org).insert('milestone', { tender_id: tender.id, key: 'G4', name: 'G4 Final sign-off', kind: 'gate', due_date: '2027-05-05' });
  return { org, manager, member, viewer, outsider, tender, g4, url: `/api/tenders/${tender.id}/watch` };
}

describe('/api/tenders/:id/watch', () => {
  it('returns each row with last_request_date, request_overdue and state (R6 acceptance through the API)', async () => {
    const s = await setup();
    const db = dbFor(s.org);
    await db.insert('watch_item', { tender_id: s.tender.id, key: 'guarantee', name: 'Εγγυητική συμμετοχής', owner_role_key: 'A', lead_value: 10, lead_unit: 'calendar', needed_milestone_key: 'G4', needed_at: '2027-05-05' });
    await db.insert('watch_item', { tender_id: s.tender.id, name: 'MAF', lead_value: null, needed_at: '2027-05-05', sort: 5 });
    const past = shiftDays(todayAthens(), -20);
    await db.insert('watch_item', { tender_id: s.tender.id, name: 'Παλιό', lead_value: 2, lead_unit: 'calendar', needed_at: past, sort: 9 });

    const res = await as(s.viewer).get(s.url);
    expect(res.status).toBe(200);
    const [guarantee, maf, old] = res.body.items;
    expect(guarantee).toMatchObject({ key: 'guarantee', needed_at: '2027-05-05', needed_milestone_name: 'G4 Final sign-off', last_request_date: '2027-04-23', request_overdue: false, state: 'not_requested', from_template: true });
    expect(maf).toMatchObject({ lead_value: null, last_request_date: null, request_overdue: false });
    expect(old).toMatchObject({ request_overdue: true, state: 'not_requested' });
    expect(res.body.roles).toEqual([{ key: 'A', name: 'Δικαιολογητικά', user_ids: [s.member.id] }]);
    expect(res.body.milestones).toEqual([{ key: 'G4', name: 'G4 Final sign-off', kind: 'gate', due_date: '2027-05-05' }]);
  });

  it('follows the milestone when the schedule moved (needed_milestone_key wins over a stale needed_at)', async () => {
    const s = await setup();
    const db = dbFor(s.org);
    await db.insert('watch_item', { tender_id: s.tender.id, name: 'x', lead_value: 1, lead_unit: 'working', needed_milestone_key: 'G4', needed_at: '2027-04-01' });
    const res = await as(s.manager).get(s.url);
    expect(res.body.items[0]).toMatchObject({ needed_at: '2027-05-05', last_request_date: '2027-05-04' });
  });

  it('create / edit; requesting with a lead time proposes expected_at; clearing the request clears it', async () => {
    const s = await setup();
    const api = await as(s.member);
    const created = await api.post(s.url).send({ name: 'Εγγυητική', owner_role_key: 'A', lead_value: 10, lead_unit: 'calendar', needed_milestone_key: 'G4', checks: 'Ποσό, δικαιούχος' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ needed_at: '2027-05-05', last_request_date: '2027-04-23', state: 'not_requested', expected_at: null, expected_proposed: false });
    const id = created.body.id;

    const requested = await api.patch(`${s.url}/${id}`).send({ requested_at: '2027-04-22' });
    expect(requested.body).toMatchObject({ requested_at: '2027-04-22', expected_at: '2027-05-04', expected_proposed: true, request_overdue: false });

    const explicit = await api.patch(`${s.url}/${id}`).send({ requested_at: '2027-04-21', expected_at: '2027-04-28' });
    expect(explicit.body).toMatchObject({ expected_at: '2027-04-28', expected_proposed: false });
    expect((await api.patch(`${s.url}/${id}`).send({ expected_at: '2027-04-01' })).body.error.code).toBe('expected_before_requested');

    const late = await api.patch(`${s.url}/${id}`).send({ expected_at: '2027-05-06' });
    expect(late.body.arrives_after_needed).toBe(true);

    const arrived = await api.patch(`${s.url}/${id}`).send({ arrived_at: '2027-05-04' });
    expect(arrived.body).toMatchObject({ state: 'arrived', arrives_after_needed: false });

    const cleared = await api.patch(`${s.url}/${id}`).send({ arrived_at: null, requested_at: null });
    expect(cleared.body).toMatchObject({ requested_at: null, expected_at: null, state: 'not_requested' });

    // an explicit date replaces the milestone link; a user owner replaces the role owner
    const manual = await api.patch(`${s.url}/${id}`).send({ needed_at: '2027-04-30', owner_user_id: s.member.id });
    expect(manual.body).toMatchObject({ needed_at: '2027-04-30', needed_milestone_key: null, owner_user_id: s.member.id, owner_role_key: null });

    // open lead time: nothing to propose; a lead value without a unit defaults to working days
    const open = await api.post(s.url).send({ name: 'MAF', requested_at: '2027-04-22' });
    expect(open.body).toMatchObject({ lead_value: null, expected_at: null, last_request_date: null });
    expect((await api.post(s.url).send({ name: 'Quotes', lead_value: 3 })).body.lead_unit).toBe('working');
  });

  it('validates input', async () => {
    const s = await setup();
    const api = await as(s.member);
    expect((await api.post(s.url).send({})).status).toBe(400);
    expect((await api.post(s.url).send({ name: 'x', lead_value: -1 })).status).toBe(400);
    expect((await api.post(s.url).send({ name: 'x', needed_at: '2027-02-30' })).status).toBe(400);
    expect((await api.post(s.url).send({ name: 'x', needed_milestone_key: 'NOPE' })).body.error.code).toBe('unknown_milestone');
    expect((await api.post(s.url).send({ name: 'x', owner_role_key: 'Z' })).body.error.code).toBe('unknown_role');
    expect((await api.post(s.url).send({ name: 'x', owner_user_id: missingId() })).body.error.code).toBe('unknown_user');
    expect((await api.post(s.url).send({ name: 'x', owner_user_id: s.member.id, owner_role_key: 'A' })).body.error.code).toBe('owner_conflict');
    expect((await api.post(s.url).send({ name: 'x', org_id: missingId() })).status).toBe(400);
    expect((await api.patch(`${s.url}/${missingId()}`).send({ name: 'y' })).status).toBe(404);
  });

  it('template items are removed by the bid manager only; manual ones by any member', async () => {
    const s = await setup();
    const db = dbFor(s.org);
    const tpl = await db.insert('watch_item', { tender_id: s.tender.id, key: 'guarantee', name: 'Εγγυητική' });
    const manual = await db.insert('watch_item', { tender_id: s.tender.id, name: 'Άλλο' });
    const res = await as(s.member).delete(`${s.url}/${tpl.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('watch_template_item');
    expect((await as(s.member).delete(`${s.url}/${manual.id}`)).status).toBe(204);
    expect((await as(s.manager).delete(`${s.url}/${tpl.id}`)).status).toBe(204);
    expect(await db.count('watch_item', { tender_id: s.tender.id })).toBe(0);
  });

  it('viewer is read-only, a non-member gets 403, a closed tender is read-only', async () => {
    const s = await setup();
    const db = dbFor(s.org);
    const row = await db.insert('watch_item', { tender_id: s.tender.id, name: 'x' });
    const viewer = await as(s.viewer);
    expect((await viewer.post(s.url).send({ name: 'y' })).status).toBe(403);
    expect((await viewer.patch(`${s.url}/${row.id}`).send({ name: 'y' })).status).toBe(403);
    expect((await viewer.delete(`${s.url}/${row.id}`)).status).toBe(403);
    const outsider = await as(s.outsider);
    expect((await outsider.get(s.url)).status).toBe(403);
    expect((await outsider.post(s.url).send({ name: 'y' })).status).toBe(403);

    await db.update('tender', s.tender.id, { status: 'submitted' });
    const manager = await as(s.manager);
    expect((await manager.get(s.url)).status).toBe(200);
    for (const res of [
      await manager.post(s.url).send({ name: 'y' }),
      await manager.patch(`${s.url}/${row.id}`).send({ name: 'y' }),
      await manager.delete(`${s.url}/${row.id}`),
    ]) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('tender_closed');
    }
    expect((await db.get('watch_item', row.id))?.name).toBe('x');
  });

  it('never leaks across organizations or tenders', async () => {
    const s = await setup();
    const db = dbFor(s.org);
    const row = await db.insert('watch_item', { tender_id: s.tender.id, name: 'secret' });
    const otherTender = await createTender(s.org);
    const foreignOrg = await createOrg();
    const foreign = await as(await createUser(foreignOrg, 'admin'));
    const foreignTender = await createTender(foreignOrg);
    expect((await foreign.get(s.url)).status).toBe(404);
    expect((await foreign.post(s.url).send({ name: 'x' })).status).toBe(404);
    expect((await foreign.patch(`${s.url}/${row.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${s.url}/${row.id}`)).status).toBe(404);
    // the row id under the foreign org's own tender, or under another tender of the same org
    expect((await foreign.patch(`/api/tenders/${foreignTender.id}/watch/${row.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await foreign.get(`/api/tenders/${foreignTender.id}/watch`)).body.items).toEqual([]);
    expect((await as(s.manager).patch(`/api/tenders/${otherTender.id}/watch/${row.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await as(s.manager).delete(`/api/tenders/${otherTender.id}/watch/${row.id}`)).status).toBe(404);
    expect((await db.get('watch_item', row.id))?.name).toBe('secret');
  });
});
