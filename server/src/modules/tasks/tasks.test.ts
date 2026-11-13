import { describe, expect, it } from 'vitest';
import { flushEvents, on } from '../../core/events.js';
import { shiftDays } from '../../domain/calendar.js';
import { todayAthens } from '../../domain/time.js';
import { addMember, addRole, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';
import { isOverdue } from './routes.js';

async function setup() {
  const org = await createOrg();
  const db = dbFor(org);
  const manager = await createUser(org, 'bid_manager');
  const admin = await createUser(org, 'admin');
  const a = await createUser(org, 'member'); // role A
  const b = await createUser(org, 'member'); // role B
  const ab = await createUser(org, 'member'); // holds A and B
  const viewer = await createUser(org, 'viewer');
  const outsider = await createUser(org, 'member');
  const tender = await createTender(org);
  await addRole(tender, 'A', {}, 'Δικαιολογητικά');
  await addRole(tender, 'B', {}, 'Τεχνική');
  await addRole(tender, 'C', { financial: true }, 'Οικονομική');
  await addMember(tender, a, 'A');
  await addMember(tender, b, 'B');
  await addMember(tender, ab, 'A');
  await addMember(tender, ab, 'B');
  await addMember(tender, viewer);
  const url = `/api/tenders/${tender.id}/tasks`;
  /** A template handoff B → A with its handoff milestone, as slice 1 creates it. */
  const handoff = async (over: Record<string, unknown> = {}) => {
    const key = `H${Math.random().toString(36).slice(2, 8)}`;
    const milestone = await db.insert('milestone', { tender_id: tender.id, key, name: 'Λίστα πιστοποιητικών', kind: 'handoff', due_date: '2027-04-23' });
    const task = await db.insert('task', {
      tender_id: tender.id,
      key,
      title: 'Λίστα απαιτούμενων πιστοποιητικών',
      section: 'handoff',
      milestone_id: milestone.id,
      due_date: '2027-04-23',
      handoff_from_role: 'B',
      handoff_to_role: 'A',
      ...over,
    });
    return { task, milestone };
  };
  return { org, db, manager, admin, a, b, ab, viewer, outsider, tender, url, handoff };
}

describe('tasks — overdue rule', () => {
  it('due before today (Athens) and still open / in progress', () => {
    expect(isOverdue({ due_date: '2027-04-22', status: 'open' }, '2027-04-23')).toBe(true);
    expect(isOverdue({ due_date: '2027-04-22', status: 'in_progress' }, '2027-04-23')).toBe(true);
    expect(isOverdue({ due_date: '2027-04-23', status: 'open' }, '2027-04-23')).toBe(false);
    expect(isOverdue({ due_date: null, status: 'open' }, '2027-04-23')).toBe(false);
    for (const status of ['done', 'na', 'cancelled']) expect(isOverdue({ due_date: '2027-04-01', status }, '2027-04-23')).toBe(false);
  });
});

describe('/api/tenders/:id/tasks', () => {
  it('create, edit, status transitions and delete of a plain task', async () => {
    const s = await setup();
    const api = await as(s.a);
    const created = await api.post(s.url).send({ title: '  Ανάλυση διακήρυξης ', owner_role_key: 'B', due_date: '2027-04-20', description: 'cheat sheet' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Ανάλυση διακήρυξης', section: 'task', status: 'open', owner_role_key: 'B', owner_user_id: null, due_date: '2027-04-20', overdue: false, from_template: false, handoff: null, milestone: null });
    const id = created.body.id;

    // owner: choosing a user clears the role and vice versa
    expect((await api.patch(`${s.url}/${id}`).send({ owner_user_id: s.b.id })).body).toMatchObject({ owner_user_id: s.b.id, owner_role_key: null });
    expect((await api.patch(`${s.url}/${id}`).send({ owner_role_key: 'A' })).body).toMatchObject({ owner_user_id: null, owner_role_key: 'A' });
    expect((await api.patch(`${s.url}/${id}`).send({ owner_user_id: s.b.id, owner_role_key: 'A' })).body.error.code).toBe('owner_conflict');

    expect((await api.patch(`${s.url}/${id}`).send({ status: 'in_progress' })).body).toMatchObject({ status: 'in_progress', done_at: null });
    const done = await api.patch(`${s.url}/${id}`).send({ status: 'done' });
    expect(done.body.status).toBe('done');
    expect(done.body.done_at).toEqual(expect.any(String));
    expect((await api.patch(`${s.url}/${id}`).send({ status: 'open' })).body).toMatchObject({ status: 'open', done_at: null });
    expect((await api.patch(`${s.url}/${id}`).send({ status: 'cancelled' })).body.status).toBe('cancelled');
    const na = await api.patch(`${s.url}/${id}`).send({ status: 'na' });
    expect(na.status).toBe(422);
    expect(na.body.error.code).toBe('na_only_checklist');

    expect((await api.delete(`${s.url}/${id}`)).status).toBe(204);
    expect(await s.db.count('task', { tender_id: s.tender.id })).toBe(0);
  });

  it('links a task to a milestone of the tender (and takes its date)', async () => {
    const s = await setup();
    const m = await s.db.insert('milestone', { tender_id: s.tender.id, key: 'G1', name: 'G1', kind: 'gate', due_date: '2027-04-23' });
    const other = await createTender(s.org);
    const foreignMilestone = await s.db.insert('milestone', { tender_id: other.id, key: 'G1', name: 'G1', kind: 'gate', due_date: '2027-04-23' });
    const api = await as(s.manager);
    const res = await api.post(s.url).send({ title: 'BOM', milestone_id: m.id });
    expect(res.body).toMatchObject({ milestone_id: m.id, due_date: '2027-04-23', milestone: { key: 'G1', kind: 'gate' } });
    expect((await api.post(s.url).send({ title: 'x', milestone_id: foreignMilestone.id })).body.error.code).toBe('unknown_milestone');
    expect((await api.get(`${s.url}?milestone_id=${m.id}`)).body.items).toHaveLength(1);
  });

  it('lists with filters: section, status, owner, overdue, mine', async () => {
    const s = await setup();
    const today = todayAthens();
    const base = { tender_id: s.tender.id };
    await s.db.insert('task', { ...base, title: 'late', due_date: shiftDays(today, -1), owner_role_key: 'A' });
    await s.db.insert('task', { ...base, title: 'late but done', due_date: shiftDays(today, -1), status: 'done', owner_user_id: s.b.id });
    await s.db.insert('task', { ...base, title: 'today', due_date: today, status: 'in_progress', owner_user_id: s.a.id });
    await s.db.insert('task', { ...base, title: 'tick', section: 'checklist', owner_role_key: 'B' });
    await s.handoff();
    const api = await as(s.a);
    const names = async (qs: string) => (await api.get(`${s.url}${qs}`)).body.items.map((t: { title: string }) => t.title).sort();

    const all = await api.get(s.url);
    expect(all.body.items).toHaveLength(5);
    expect(all.body.roles.map((r: { key: string }) => r.key)).toEqual(['A', 'B', 'C']);
    expect(all.body.roles[0].user_ids.sort()).toEqual([s.a.id, s.ab.id].sort());
    expect(all.body.me).toEqual({ role_keys: ['A'], can_manage: false });
    expect(await names('?section=task')).toEqual(['late', 'late but done', 'today']);
    expect(await names('?section=checklist,handoff')).toEqual(['tick', 'Λίστα απαιτούμενων πιστοποιητικών']);
    expect(await names('?status=open,in_progress&section=task')).toEqual(['late', 'today']);
    expect(await names('?overdue=true')).toEqual(['late']);
    expect(await names(`?owner_user_id=${s.b.id}`)).toEqual(['late but done']);
    expect(await names('?owner_role_key=B')).toEqual(['tick']);
    // mine: by name, through role A, or as the recipient (A) of the handoff
    expect(await names('?mine=true')).toEqual(['late', 'today', 'Λίστα απαιτούμενων πιστοποιητικών']);
    expect((await api.get(`${s.url}?section=nope`)).status).toBe(400);
  });

  it('checklists: grouped by role with progress; "Δ/Α" is a status, template lines are never deleted', async () => {
    const s = await setup();
    const base = { tender_id: s.tender.id, section: 'checklist' };
    const a1 = await s.db.insert('task', { ...base, key: 'A1', title: 'ΕΕΕΣ', owner_role_key: 'A', sort: 1 });
    const a2 = await s.db.insert('task', { ...base, key: 'A2', title: 'ΕΕΕΣ εταίρων', owner_role_key: 'A', sort: 2 });
    await s.db.insert('task', { ...base, key: 'A3', title: 'Πιστοποιητικά', owner_role_key: 'A', sort: 3 });
    await s.db.insert('task', { ...base, key: 'B1', title: 'Register', owner_role_key: 'B', sort: 4 });
    const api = await as(s.a);

    expect((await api.patch(`${s.url}/${a1.id}`).send({ status: 'done' })).body.status).toBe('done');
    const na = await api.patch(`${s.url}/${a2.id}`).send({ status: 'na' });
    expect(na.status).toBe(200);
    expect(na.body).toMatchObject({ status: 'na', done_at: null });

    const del = await api.delete(`${s.url}/${a2.id}`);
    expect(del.status).toBe(422);
    expect(del.body.error.code).toBe('checklist_use_na');
    expect(await s.db.count('task', { tender_id: s.tender.id, section: 'checklist' })).toBe(4);

    const extra = await api.post(s.url).send({ title: 'Δικό μου σημείο', section: 'checklist', owner_role_key: 'A' });
    expect(extra.status).toBe(201);

    const res = await api.get(`${s.url}/checklists`);
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { role_key: string }) => g.role_key)).toEqual(['A', 'B']);
    expect(res.body.groups[0]).toMatchObject({ role_key: 'A', role_name: 'Δικαιολογητικά', total: 4, applicable: 3, done: 1, na: 1 });
    expect(res.body.groups[0].items.map((t: { title: string }) => t.title)).toEqual(['ΕΕΕΣ', 'ΕΕΕΣ εταίρων', 'Πιστοποιητικά', 'Δικό μου σημείο']);
    expect(res.body.groups[1]).toMatchObject({ role_key: 'B', total: 1, applicable: 1, done: 0 });

    // a manually added line can be deleted; a "Δ/Α" line can be brought back
    expect((await api.delete(`${s.url}/${extra.body.id}`)).status).toBe(204);
    expect((await api.patch(`${s.url}/${a2.id}`).send({ status: 'open' })).body.status).toBe('open');
  });

  it('manual handoff: needs two different roles of the tender', async () => {
    const s = await setup();
    const api = await as(s.b);
    expect((await api.post(s.url).send({ title: 'BOM', section: 'handoff' })).body.error.code).toBe('handoff_roles_required');
    expect((await api.post(s.url).send({ title: 'BOM', section: 'handoff', handoff_from_role: 'B', handoff_to_role: 'B' })).body.error.code).toBe('handoff_same_role');
    expect((await api.post(s.url).send({ title: 'BOM', section: 'handoff', handoff_from_role: 'B', handoff_to_role: 'X' })).body.error.code).toBe('unknown_role');
    expect((await api.post(s.url).send({ title: 'BOM', handoff_from_role: 'B', handoff_to_role: 'C' })).body.error.code).toBe('not_a_handoff');
    const ok = await api.post(s.url).send({ title: 'BOM κλειδωμένο', section: 'handoff', handoff_from_role: 'B', handoff_to_role: 'C', due_date: '2027-04-23' });
    expect(ok.status).toBe(201);
    expect(ok.body.handoff).toMatchObject({ state: 'pending', can_deliver: true, can_receive: false });
    // manual handoffs (no template key) can be deleted
    expect((await api.delete(`${s.url}/${ok.body.id}`)).status).toBe(204);
  });
});

describe('handoffs (F6): deliver → receive', () => {
  it('deliver: only the sending role or the bid manager; emits handoff.delivered', async () => {
    const s = await setup();
    const { task } = await s.handoff();
    const seen: Array<{ tenderId: string; taskId: string }> = [];
    const off = on('handoff.delivered', (_ctx, payload) => void seen.push(payload));

    const denied = await as(s.a).post(`${s.url}/${task.id}/deliver`).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('handoff_not_sender');
    expect((await as(s.viewer).post(`${s.url}/${task.id}/deliver`).send({})).status).toBe(403);

    const res = await as(s.b).post(`${s.url}/${task.id}/deliver`).send({ note: 'στο κοινό drive' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'in_progress', received_at: null });
    expect(res.body.handoff).toMatchObject({ state: 'delivered', delivered_by: s.b.id, delivery_note: 'στο κοινό drive', can_deliver: false });
    expect(res.body.handoff.delivered_at).toEqual(expect.any(String));
    await flushEvents();
    off();
    expect(seen).toEqual([{ tenderId: s.tender.id, taskId: task.id }]);

    const again = await as(s.manager).post(`${s.url}/${task.id}/deliver`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('handoff_already_delivered');

    // taken back by the sender, then delivered by the bid manager
    expect((await as(s.a).post(`${s.url}/${task.id}/undo-deliver`)).status).toBe(403);
    const undone = await as(s.b).post(`${s.url}/${task.id}/undo-deliver`);
    expect(undone.body).toMatchObject({ status: 'open', handoff: { state: 'pending', delivered_at: null } });
    expect((await as(s.manager).post(`${s.url}/${task.id}/deliver`)).body.handoff.delivered_by).toBe(s.manager.id);
  });

  it('receive: only a holder of the "to" role; completes the task and its handoff milestone', async () => {
    const s = await setup();
    const { task, milestone } = await s.handoff();
    await as(s.b).post(`${s.url}/${task.id}/deliver`).send({});

    // the sender cannot confirm their own delivery; neither can a viewer or a member of another role
    const sender = await as(s.b).post(`${s.url}/${task.id}/receive`).send({});
    expect(sender.status).toBe(403);
    expect(sender.body.error.code).toBe('handoff_not_recipient');
    expect((await as(s.viewer).post(`${s.url}/${task.id}/receive`).send({})).status).toBe(403);
    expect((await s.db.get('task', task.id))?.received_at).toBeNull();
    expect((await s.db.get('milestone', milestone.id))?.done_at).toBeNull();

    const res = await as(s.a).post(`${s.url}/${task.id}/receive`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', received_by: s.a.id });
    expect(res.body.received_at).toEqual(expect.any(String));
    expect(res.body.done_at).toEqual(expect.any(String));
    expect(res.body.handoff).toMatchObject({ state: 'received', received_by_override: false, can_receive: false });
    expect(res.body.milestone.done_at).toEqual(expect.any(String));
    expect((await s.db.get('milestone', milestone.id))?.done_at).toBeInstanceOf(Date);

    const again = await as(s.ab).post(`${s.url}/${task.id}/receive`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('handoff_already_received');
    // once received it is frozen: no status change, no delete, no re-delivery
    expect((await as(s.manager).patch(`${s.url}/${task.id}`).send({ status: 'open' })).body.error.code).toBe('handoff_already_received');
    expect((await as(s.manager).post(`${s.url}/${task.id}/deliver`)).body.error.code).toBe('handoff_already_received');
  });

  it('a sender who also holds the receiving role may confirm; receipt works without a prior "deliver"', async () => {
    const s = await setup();
    const { task } = await s.handoff();
    const res = await as(s.ab).post(`${s.url}/${task.id}/receive`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', received_by: s.ab.id, handoff: { state: 'received', delivered_at: null } });
  });

  it('bid manager / admin may confirm on behalf of the recipient, with a note', async () => {
    const s = await setup();
    const { task } = await s.handoff();
    const noNote = await as(s.manager).post(`${s.url}/${task.id}/receive`).send({});
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe('handoff_override_note_required');
    const res = await as(s.admin).post(`${s.url}/${task.id}/receive`).send({ note: 'Ο Α είναι σε άδεια, το παρέλαβα εγώ' });
    expect(res.status).toBe(200);
    expect(res.body.handoff).toMatchObject({ state: 'received', received_by_override: true, receive_note: 'Ο Α είναι σε άδεια, το παρέλαβα εγώ' });
    expect(res.body.received_by).toBe(s.admin.id);
  });

  it('undo receive: bid manager / admin only; reopens the task and the milestone', async () => {
    const s = await setup();
    const { task, milestone } = await s.handoff();
    await as(s.b).post(`${s.url}/${task.id}/deliver`).send({});
    await as(s.a).post(`${s.url}/${task.id}/receive`).send({});

    expect((await as(s.a).post(`${s.url}/${task.id}/undo-receive`)).status).toBe(403);
    const res = await as(s.manager).post(`${s.url}/${task.id}/undo-receive`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'in_progress', received_by: null, received_at: null, done_at: null, handoff: { state: 'delivered' } });
    expect((await s.db.get('milestone', milestone.id))?.done_at).toBeNull();
    expect((await as(s.manager).post(`${s.url}/${task.id}/undo-receive`)).body.error.code).toBe('handoff_not_received');
  });

  it('receipt never touches a milestone that is not a handoff milestone, nor one already done', async () => {
    const s = await setup();
    const gate = await s.db.insert('milestone', { tender_id: s.tender.id, key: 'G1', name: 'G1', kind: 'gate', due_date: '2027-04-23' });
    const { task } = await s.handoff({ milestone_id: gate.id, key: null });
    await as(s.a).post(`${s.url}/${task.id}/receive`).send({});
    expect((await s.db.get('milestone', gate.id))?.done_at).toBeNull();

    const doneAt = new Date('2027-04-20T10:00:00Z');
    const second = await s.handoff();
    await s.db.update('milestone', second.milestone.id, { done_at: doneAt });
    await as(s.a).post(`${s.url}/${second.task.id}/receive`).send({});
    await as(s.manager).post(`${s.url}/${second.task.id}/undo-receive`);
    expect((await s.db.get('milestone', second.milestone.id))?.done_at).toEqual(doneAt);
  });

  it('status rules of a handoff: done only through receive; N/A, cancel and reopen by the bid manager', async () => {
    const s = await setup();
    const { task } = await s.handoff();
    const member = await as(s.b);
    expect((await member.patch(`${s.url}/${task.id}`).send({ status: 'done' })).body.error.code).toBe('handoff_use_receive');
    expect((await member.patch(`${s.url}/${task.id}`).send({ status: 'in_progress' })).body.error.code).toBe('handoff_use_deliver');
    const denied = await member.patch(`${s.url}/${task.id}`).send({ status: 'na' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('handoff_manager_only');
    expect((await member.patch(`${s.url}/${task.id}`).send({ due_date: '2027-04-26' })).body.error.code).toBe('handoff_date_from_schedule');
    expect((await member.delete(`${s.url}/${task.id}`)).body.error.code).toBe('handoff_use_na');
    expect((await member.post(`${s.url}/${missingId()}/receive`)).status).toBe(404);

    const manager = await as(s.manager);
    expect((await manager.patch(`${s.url}/${task.id}`).send({ status: 'na' })).body.status).toBe('na');
    expect((await as(s.a).post(`${s.url}/${task.id}/receive`).send({})).body.error.code).toBe('handoff_not_active');
    expect((await member.post(`${s.url}/${task.id}/deliver`).send({})).body.error.code).toBe('handoff_not_active');
    expect((await manager.patch(`${s.url}/${task.id}`).send({ status: 'open' })).body.status).toBe('open');

    const plain = await s.db.insert('task', { tender_id: s.tender.id, title: 'plain' });
    expect((await member.post(`${s.url}/${plain.id}/deliver`)).body.error.code).toBe('not_a_handoff');
    expect((await member.post(`${s.url}/${plain.id}/receive`)).body.error.code).toBe('not_a_handoff');
  });
});

describe('handoffs — re-wiring is the bid manager\'s (review H1)', () => {
  it('a member cannot change from/to role, milestone or date of a handoff — and so cannot make themselves its recipient', async () => {
    const s = await setup();
    const { task } = await s.handoff(); // B → A
    const other = await s.db.insert('milestone', { tender_id: s.tender.id, key: 'MX', name: 'Άλλο', kind: 'milestone', due_date: '2027-06-30' });
    const manual = await s.db.insert('task', { tender_id: s.tender.id, title: 'Χειροκίνητο handoff', section: 'handoff', handoff_from_role: 'A', handoff_to_role: 'C', due_date: '2027-04-20' });
    const b = await as(s.b);
    for (const [id, patch] of [
      [task.id, { handoff_to_role: 'B', handoff_from_role: 'A' }],
      [task.id, { handoff_to_role: 'C' }],
      [task.id, { handoff_from_role: 'C' }],
      [task.id, { milestone_id: other.id }],
      [task.id, { milestone_id: null }],
      [manual.id, { due_date: '2027-12-31' }],
      [manual.id, { due_date: null }],
      [manual.id, { handoff_to_role: 'B' }],
    ] as const) {
      const res = await b.patch(`${s.url}/${id}`).send(patch);
      expect([JSON.stringify(patch), res.status, res.body.error?.code]).toEqual([JSON.stringify(patch), 403, 'handoff_manager_only']);
    }
    expect(await s.db.get('task', task.id)).toMatchObject({ handoff_from_role: 'B', handoff_to_role: 'A', due_date: '2027-04-23' });
    expect(await s.db.get('task', manual.id)).toMatchObject({ handoff_to_role: 'C', due_date: '2027-04-20' });
    // B (the sender) still cannot confirm receipt of their own handoff
    expect((await b.post(`${s.url}/${task.id}/receive`).send({})).status).toBe(403);
    // harmless edits stay open to members; unchanged values are not a re-wiring
    expect((await b.patch(`${s.url}/${task.id}`).send({ description: 'σημείωση', handoff_to_role: 'A', due_date: '2027-04-23' })).status).toBe(200);
    // the bid manager re-wires
    const ok = await as(s.manager).patch(`${s.url}/${manual.id}`).send({ handoff_to_role: 'B', due_date: '2027-04-21' });
    expect([ok.status, ok.body.handoff_to_role ?? ok.body.handoff?.to_role, ok.body.due_date]).toEqual([200, 'B', '2027-04-21']);
  });
});

describe('tasks — access', () => {
  it('viewer is read-only; a non-member gets 403', async () => {
    const s = await setup();
    const task = await s.db.insert('task', { tender_id: s.tender.id, title: 'x' });
    const { task: handoff } = await s.handoff();
    const viewer = await as(s.viewer);
    expect((await viewer.get(s.url)).status).toBe(200);
    expect((await viewer.get(`${s.url}/checklists`)).status).toBe(200);
    expect((await viewer.post(s.url).send({ title: 'y' })).status).toBe(403);
    expect((await viewer.patch(`${s.url}/${task.id}`).send({ status: 'done' })).status).toBe(403);
    expect((await viewer.delete(`${s.url}/${task.id}`)).status).toBe(403);
    expect((await viewer.post(`${s.url}/${handoff.id}/receive`)).status).toBe(403);

    const outsider = await as(s.outsider);
    expect((await outsider.get(s.url)).status).toBe(403);
    expect((await outsider.get(`${s.url}/checklists`)).status).toBe(403);
    expect((await outsider.post(s.url).send({ title: 'y' })).status).toBe(403);
    expect((await outsider.patch(`${s.url}/${task.id}`).send({ status: 'done' })).status).toBe(403);
    expect((await s.db.get('task', task.id))?.status).toBe('open');
  });

  it('a closed tender is read-only', async () => {
    const s = await setup();
    const task = await s.db.insert('task', { tender_id: s.tender.id, title: 'x' });
    const { task: handoff } = await s.handoff();
    await s.db.update('tender', s.tender.id, { status: 'no_go', closed_at: new Date() });
    const api = await as(s.manager);
    const list = await api.get(s.url);
    expect(list.status).toBe(200);
    expect(list.body.items.find((t: { id: string }) => t.id === handoff.id).handoff).toMatchObject({ can_deliver: false, can_receive: false });
    for (const res of [
      await api.post(s.url).send({ title: 'y' }),
      await api.patch(`${s.url}/${task.id}`).send({ status: 'done' }),
      await api.delete(`${s.url}/${task.id}`),
      await api.post(`${s.url}/${handoff.id}/deliver`),
      await api.post(`${s.url}/${handoff.id}/receive`).send({ note: 'x' }),
    ]) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('tender_closed');
    }
  });

  it('never leaks across organizations or tenders', async () => {
    const s = await setup();
    const task = await s.db.insert('task', { tender_id: s.tender.id, title: 'secret' });
    const { task: handoff } = await s.handoff();
    const otherTender = await createTender(s.org);
    const foreignOrg = await createOrg();
    const foreignAdmin = await createUser(foreignOrg, 'admin');
    const foreignTender = await createTender(foreignOrg);
    const foreign = await as(foreignAdmin);

    expect((await foreign.get(s.url)).status).toBe(404);
    expect((await foreign.get(`${s.url}/checklists`)).status).toBe(404);
    expect((await foreign.post(s.url).send({ title: 'x' })).status).toBe(404);
    expect((await foreign.patch(`${s.url}/${task.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${s.url}/${task.id}`)).status).toBe(404);
    for (const action of ['deliver', 'undo-deliver', 'receive', 'undo-receive']) {
      expect((await foreign.post(`${s.url}/${handoff.id}/${action}`).send({ note: 'x' })).status).toBe(404);
      // …and through the foreign org's own tender
      expect((await foreign.post(`/api/tenders/${foreignTender.id}/tasks/${handoff.id}/${action}`).send({ note: 'x' })).status).toBe(404);
    }
    const own = `/api/tenders/${foreignTender.id}/tasks`;
    expect((await foreign.get(own)).body.items).toEqual([]);
    expect((await foreign.patch(`${own}/${task.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${own}/${task.id}`)).status).toBe(404);
    // a user of the other org cannot be made owner
    expect((await as(s.manager).patch(`${s.url}/${task.id}`).send({ owner_user_id: foreignAdmin.id })).body.error.code).toBe('unknown_user');
    // same org, other tender
    const sibling = `/api/tenders/${otherTender.id}/tasks`;
    expect((await as(s.manager).patch(`${sibling}/${task.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await as(s.manager).post(`${sibling}/${handoff.id}/receive`).send({ note: 'x' })).status).toBe(404);
    expect((await s.db.get('task', task.id))?.title).toBe('secret');
    expect((await s.db.get('task', handoff.id))?.received_at).toBeNull();
  });
});
