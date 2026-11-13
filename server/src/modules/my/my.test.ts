import { describe, expect, it } from 'vitest';
import { addWorkingDays, shiftDays } from '../../domain/calendar.js';
import { todayAthens } from '../../domain/time.js';
import { addMember, addRole, anon, as, createOrg, createTender, createUser, dbFor, seedHolidays } from '../../test/harness.js';
import { bucketOf, type MyItem } from './routes.js';

const NO_HOLIDAYS = new Set<string>();

describe('my work — buckets', () => {
  it('overdue / today / next 3 working days / later', () => {
    // Thu 22/04/2027; Good Friday 30/04 irrelevant here. Horizon = Tue 27/04 (Fri, Mon, Tue).
    const today = '2027-04-22';
    const horizon = addWorkingDays(today, 3, NO_HOLIDAYS);
    expect(horizon).toBe('2027-04-27');
    expect(bucketOf('2027-04-21', today, horizon)).toBe('overdue');
    expect(bucketOf('2027-04-22', today, horizon)).toBe('today');
    expect(bucketOf('2027-04-23', today, horizon)).toBe('soon');
    expect(bucketOf('2027-04-25', today, horizon)).toBe('soon'); // a Sunday inside the window
    expect(bucketOf('2027-04-27', today, horizon)).toBe('soon');
    expect(bucketOf('2027-04-28', today, horizon)).toBe('later');
    expect(bucketOf(null, today, horizon)).toBe('later');
  });

  it('the window counts working days with the org holidays', () => {
    const holidays = new Set(['2027-04-30', '2027-05-03']); // Good Friday, Easter Monday
    expect(addWorkingDays('2027-04-29', 3, holidays)).toBe('2027-05-06');
  });
});

async function setup() {
  const org = await createOrg();
  const db = dbFor(org);
  const today = todayAthens();
  await seedHolidays(org, [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]);
  const me = await createUser(org, 'member');
  const colleague = await createUser(org, 'member');
  const manager = await createUser(org, 'bid_manager');
  const tender = await createTender(org, { title: 'Διαγωνισμός Α' });
  for (const key of ['A', 'B', 'C']) await addRole(tender, key);
  await addMember(tender, me, 'A');
  await addMember(tender, colleague, 'B');
  const holidays = new Set((await db.list<{ date: string }>('holiday')).map((h) => h.date));
  const dates = {
    today,
    yesterday: shiftDays(today, -1),
    soon: addWorkingDays(today, 2, holidays),
    edge: addWorkingDays(today, 3, holidays),
    later: addWorkingDays(today, 4, holidays),
  };
  return { org, db, me, colleague, manager, tender, dates, holidays };
}

const titles = (items: MyItem[]) => items.map((i) => i.title);

describe('GET /api/my', () => {
  it('groups my tasks: by name or through my tender role; never a colleague’s', async () => {
    const s = await setup();
    const base = { tender_id: s.tender.id };
    await s.db.insert('task', { ...base, title: 'εκπρόθεσμο δικό μου', owner_user_id: s.me.id, due_date: s.dates.yesterday });
    await s.db.insert('task', { ...base, title: 'σήμερα μέσω ρόλου', owner_role_key: 'A', due_date: s.dates.today, status: 'in_progress' });
    await s.db.insert('task', { ...base, title: 'σε 2 εργάσιμες', owner_user_id: s.me.id, due_date: s.dates.soon });
    await s.db.insert('task', { ...base, title: 'σε 3 εργάσιμες', owner_role_key: 'A', due_date: s.dates.edge });
    await s.db.insert('task', { ...base, title: 'σε 4 εργάσιμες', owner_user_id: s.me.id, due_date: s.dates.later });
    await s.db.insert('task', { ...base, title: 'checklist χωρίς ημερομηνία', section: 'checklist', owner_role_key: 'A' });
    // not mine
    await s.db.insert('task', { ...base, title: 'του συναδέλφου', owner_user_id: s.colleague.id, due_date: s.dates.yesterday });
    await s.db.insert('task', { ...base, title: 'ρόλου Β', owner_role_key: 'B', due_date: s.dates.today });
    await s.db.insert('task', { ...base, title: 'χωρίς υπεύθυνο', due_date: s.dates.today });
    // mine but finished
    for (const status of ['done', 'na', 'cancelled']) await s.db.insert('task', { ...base, title: `κλειστό ${status}`, owner_user_id: s.me.id, due_date: s.dates.yesterday, status });

    const res = await as(s.me).get('/api/my');
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(s.dates.today);
    expect(res.body.horizon).toBe(s.dates.edge);
    const g = res.body.groups;
    expect(titles(g.overdue)).toEqual(['εκπρόθεσμο δικό μου']);
    expect(titles(g.today)).toEqual(['σήμερα μέσω ρόλου']);
    expect(titles(g.soon)).toEqual(['σε 2 εργάσιμες', 'σε 3 εργάσιμες']);
    expect(titles(g.later)).toEqual(['σε 4 εργάσιμες', 'checklist χωρίς ημερομηνία']);
    expect(res.body.counts).toEqual({ overdue: 1, today: 1, soon: 2, later: 2, total: 6 });
    expect(g.overdue[0]).toMatchObject({ kind: 'task', tender_id: s.tender.id, tender_title: 'Διαγωνισμός Α', tab: 'tasks', via: 'user', role_key: null, bucket: 'overdue', date: s.dates.yesterday });
    expect(g.today[0]).toMatchObject({ kind: 'task', via: 'role', role_key: 'A', status: 'in_progress' });
    expect(g.later[1]).toMatchObject({ kind: 'checklist', date: null });

    // the colleague sees their own, not mine
    const theirs = (await as(s.colleague).get('/api/my')).body;
    expect(titles([...theirs.groups.overdue, ...theirs.groups.today, ...theirs.groups.soon, ...theirs.groups.later]).sort()).toEqual(['ρόλου Β', 'του συναδέλφου']);
    // a bid manager reaches every tender but owns nothing here
    expect((await as(s.manager).get('/api/my')).body.counts.total).toBe(0);
  });

  it('handoffs: waiting for my receipt (to-role) and mine to deliver (from-role)', async () => {
    const s = await setup();
    const base = { tender_id: s.tender.id, section: 'handoff' };
    await s.db.insert('task', { ...base, title: 'Β → Α παραδόθηκε', handoff_from_role: 'B', handoff_to_role: 'A', due_date: s.dates.today, status: 'in_progress', payload: { delivered_at: new Date().toISOString() } });
    await s.db.insert('task', { ...base, title: 'Α → Β προς παράδοση', handoff_from_role: 'A', handoff_to_role: 'B', due_date: s.dates.yesterday });
    await s.db.insert('task', { ...base, title: 'Α → Γ παραδόθηκε ήδη', handoff_from_role: 'A', handoff_to_role: 'C', due_date: s.dates.today, status: 'in_progress', payload: { delivered_at: new Date().toISOString() } });
    await s.db.insert('task', { ...base, title: 'Β → Γ άσχετο', handoff_from_role: 'B', handoff_to_role: 'C', due_date: s.dates.today });
    await s.db.insert('task', { ...base, title: 'Β → Α παραλήφθηκε', handoff_from_role: 'B', handoff_to_role: 'A', due_date: s.dates.today, status: 'done', received_at: new Date(), received_by: s.me.id });

    const mine = (await as(s.me).get('/api/my')).body.groups;
    expect(mine.today).toHaveLength(1);
    expect(mine.today[0]).toMatchObject({ kind: 'handoff_receive', title: 'Β → Α παραδόθηκε', role_key: 'A', info: { from_role: 'B', to_role: 'A', delivered: true } });
    expect(mine.overdue).toHaveLength(1);
    expect(mine.overdue[0]).toMatchObject({ kind: 'handoff_deliver', title: 'Α → Β προς παράδοση', role_key: 'A' });

    const theirs = (await as(s.colleague).get('/api/my')).body.groups;
    expect(theirs.overdue.map((i: MyItem) => [i.kind, i.title])).toEqual([['handoff_receive', 'Α → Β προς παράδοση']]);
    expect(theirs.today.map((i: MyItem) => [i.kind, i.title])).toEqual([['handoff_deliver', 'Β → Γ άσχετο']]);
  });

  it('watch items I own, bucketed by the last request day (R6) or the expected arrival', async () => {
    const s = await setup();
    const base = { tender_id: s.tender.id };
    // needed in 4 working days with a 1 working-day lead → last request day = +3 working days
    await s.db.insert('watch_item', { ...base, name: 'προς αίτηση', owner_role_key: 'A', lead_value: 1, lead_unit: 'working', needed_at: s.dates.later });
    await s.db.insert('watch_item', { ...base, name: 'έπρεπε να ζητηθεί', owner_user_id: s.me.id, lead_value: 2, lead_unit: 'calendar', needed_at: s.dates.today });
    await s.db.insert('watch_item', { ...base, name: 'αργεί', owner_role_key: 'A', requested_at: shiftDays(s.dates.today, -10), expected_at: s.dates.yesterday });
    await s.db.insert('watch_item', { ...base, name: 'ήρθε', owner_role_key: 'A', requested_at: s.dates.yesterday, arrived_at: s.dates.today });
    await s.db.insert('watch_item', { ...base, name: 'άλλου ρόλου', owner_role_key: 'B', needed_at: s.dates.today, lead_value: 5, lead_unit: 'working' });

    const g = (await as(s.me).get('/api/my')).body.groups;
    expect(g.soon.map((i: MyItem) => i.title)).toEqual(['προς αίτηση']);
    expect(g.soon[0]).toMatchObject({ kind: 'watch', tab: 'watch', date: s.dates.edge, status: 'not_requested', info: { request_overdue: false } });
    const overdue = Object.fromEntries(g.overdue.map((i: MyItem) => [i.title, i]));
    expect(Object.keys(overdue).sort()).toEqual(['αργεί', 'έπρεπε να ζητηθεί'].sort());
    expect(overdue['έπρεπε να ζητηθεί']).toMatchObject({ status: 'not_requested', via: 'user', info: { request_overdue: true } });
    expect(overdue['αργεί']).toMatchObject({ status: 'late', date: s.dates.yesterday });
  });

  it('gates where I am the approver and the decision is pending; a requested approval needs me today', async () => {
    const s = await setup();
    const approver = await createUser(s.org, 'approver');
    await addMember(s.tender, approver, 'MGMT');
    const gate = async (key: string, due: string, over: Record<string, unknown> = {}) => {
      const m = await s.db.insert('milestone', { tender_id: s.tender.id, key, name: `${key} πύλη`, kind: 'gate', due_date: due });
      return s.db.insert('gate', { tender_id: s.tender.id, milestone_id: m.id, key, approver_user_id: approver.id, approver_role_key: 'MGMT', ...over });
    };
    await gate('G0', s.dates.yesterday, { decision: 'go', decided_by: approver.id, decided_at: new Date() });
    await gate('G1', s.dates.later, { approver_user_id: s.me.id });
    await gate('G2', s.dates.later, { requested_at: new Date(), requested_by: s.manager.id });
    await gate('G3', s.dates.yesterday, { requested_at: new Date() });
    await gate('G4', s.dates.later);

    const g = (await as(approver).get('/api/my')).body.groups;
    expect(g.overdue.map((i: MyItem) => i.title)).toEqual(['G3 πύλη']);
    expect(g.today).toHaveLength(1);
    expect(g.today[0]).toMatchObject({ kind: 'gate', tab: 'gates', title: 'G2 πύλη', status: 'requested', date: s.dates.later, info: { gate_key: 'G2', requested: true } });
    expect(g.later.map((i: MyItem) => [i.title, i.status])).toEqual([['G4 πύλη', 'pending']]);
    expect((await as(s.me).get('/api/my')).body.groups.later.map((i: MyItem) => i.title)).toEqual(['G1 πύλη']);
  });

  it('only active tenders the user can still reach', async () => {
    const s = await setup();
    const add = async (title: string, status: string, member = true) => {
      const tender = await createTender(s.org, { title, status });
      if (member) await addMember(tender, s.me, 'A');
      await s.db.insert('task', { tender_id: tender.id, title: `task ${title}`, owner_user_id: s.me.id, due_date: s.dates.today });
      await s.db.insert('watch_item', { tender_id: tender.id, name: `watch ${title}`, owner_user_id: s.me.id, needed_at: s.dates.today });
      return tender;
    };
    await add('evaluation', 'evaluation');
    await add('submitted', 'submitted');
    await add('no_go', 'no_go');
    await add('cancelled', 'cancelled');
    await add('όχι μέλος πια', 'in_progress', false);

    const body = (await as(s.me).get('/api/my')).body;
    expect(titles(body.groups.today).sort()).toEqual(['task evaluation', 'watch evaluation']);
    expect(body.counts.total).toBe(2);
    // a bid manager reaches every tender: directly assigned work shows without a membership
    const tender = await createTender(s.org, { title: 'Χωρίς μέλη' });
    await s.db.insert('task', { tender_id: tender.id, title: 'του bid manager', owner_user_id: s.manager.id, due_date: s.dates.today });
    expect(titles((await as(s.manager).get('/api/my')).body.groups.today)).toEqual(['του bid manager']);
  });

  it('never shows another organization’s items', async () => {
    const s = await setup();
    await s.db.insert('task', { tender_id: s.tender.id, title: 'δικό μου', owner_user_id: s.me.id, due_date: s.dates.today });

    const other = await createOrg();
    const odb = dbFor(other);
    const stranger = await createUser(other, 'admin');
    const otherTender = await createTender(other);
    await addRole(otherTender, 'A');
    await addMember(otherTender, stranger, 'A');
    await odb.insert('task', { tender_id: otherTender.id, title: 'ξένο task', owner_role_key: 'A', due_date: s.dates.today });
    await odb.insert('task', { tender_id: otherTender.id, title: 'ξένο handoff', section: 'handoff', handoff_from_role: 'B', handoff_to_role: 'A', due_date: s.dates.today });
    await odb.insert('watch_item', { tender_id: otherTender.id, name: 'ξένο watch', owner_role_key: 'A', needed_at: s.dates.today });
    const m = await odb.insert('milestone', { tender_id: otherTender.id, key: 'G0', name: 'ξένη πύλη', kind: 'gate', due_date: s.dates.today });
    await odb.insert('gate', { tender_id: otherTender.id, milestone_id: m.id, key: 'G0', approver_user_id: stranger.id });

    const mine = (await as(s.me).get('/api/my')).body;
    expect(mine.counts.total).toBe(1);
    expect(JSON.stringify(mine)).not.toContain('ξέν');
    const theirs = (await as(stranger).get('/api/my')).body;
    expect(theirs.counts.total).toBe(4);
    expect(JSON.stringify(theirs)).not.toContain('δικό μου');
    expect(JSON.stringify(theirs)).not.toContain(s.tender.id);
  });

  it('needs a session; a viewer may read their list', async () => {
    const s = await setup();
    const viewer = await createUser(s.org, 'viewer');
    await addMember(s.tender, viewer);
    const res = await as(viewer).get('/api/my');
    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(0);
    expect((await anon().get('/api/my')).status).toBe(401);
  });
});
