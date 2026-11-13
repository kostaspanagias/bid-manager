import { describe, expect, it } from 'vitest';
import { todayAthens } from '../../domain/time.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';

async function setup() {
  const org = await createOrg();
  const db = dbFor(org);
  const manager = await createUser(org, 'bid_manager');
  const member = await createUser(org, 'member');
  const viewer = await createUser(org, 'viewer');
  const outsider = await createUser(org, 'member');
  const tender = await createTender(org);
  await addMember(tender, member, 'B');
  await addMember(tender, viewer);
  const req = (code: string, status = 'open', tenderId = tender.id) =>
    db.insert('requirement', { tender_id: tenderId, code, text: `Απαίτηση ${code}`, type: 'exclusion', status, ...(status === 'deviation' ? { deviation_note: 'σημείωση' } : {}) });
  return { org, db, manager, member, viewer, outsider, tender, req, url: `/api/tenders/${tender.id}/changes` };
}

describe('/api/tenders/:id/changes', () => {
  it('create with affected requirements; list is newest first with the ΥΠ codes', async () => {
    const s = await setup();
    const r1 = await s.req('ΥΠ-001');
    const r2 = await s.req('ΥΠ-002');
    const api = await as(s.member);
    const created = await api.post(s.url).send({
      date: '2027-04-15',
      source: 'esidis',
      kind: 'clarification',
      description: 'Διευκρίνιση για την εγγύηση καλής λειτουργίας',
      reference: 'ΑΔΑΜ 27PROC000123',
      owner_user_id: s.member.id,
      requirement_ids: [r2.id, r1.id, r1.id],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ date: '2027-04-15', source: 'esidis', kind: 'clarification', kind_locked: false, owner_user_id: s.member.id, reopened: 0 });
    expect(created.body.requirements.map((r: { code: string }) => r.code)).toEqual(['ΥΠ-001', 'ΥΠ-002']);
    expect(await s.db.count('change_entry_requirement', { tender_id: s.tender.id })).toBe(2);

    const defaults = await api.post(s.url).send({ description: 'Χωρίς στοιχεία' });
    expect(defaults.body).toMatchObject({ date: todayAthens(), source: 'other', kind: 'clarification', requirement_ids: [] });
    await api.post(s.url).send({ description: 'Παλιά', date: '2027-04-01', kind: 'amendment' });

    const list = await as(s.viewer).get(s.url);
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: { description: string }) => e.description)).toEqual(['Διευκρίνιση για την εγγύηση καλής λειτουργίας', 'Παλιά', 'Χωρίς στοιχεία'].sort((a, b) => {
      const d: Record<string, string> = { 'Διευκρίνιση για την εγγύηση καλής λειτουργίας': '2027-04-15', Παλιά: '2027-04-01', 'Χωρίς στοιχεία': todayAthens() };
      return d[b]!.localeCompare(d[a]!);
    }));
    expect(list.body.items.find((e: { id: string }) => e.id === created.body.id).requirement_ids).toEqual([r1.id, r2.id]);
  });

  it('requirement ids must belong to this tender (other tender, other org, unknown → 422, nothing written)', async () => {
    const s = await setup();
    const own = await s.req('ΥΠ-001');
    const otherTender = await createTender(s.org);
    const sibling = await s.req('ΥΠ-001', 'open', otherTender.id);
    const foreignOrg = await createOrg();
    const foreignTender = await createTender(foreignOrg);
    const foreignReq = await dbFor(foreignOrg).insert('requirement', { tender_id: foreignTender.id, code: 'ΥΠ-001', text: 'x' });
    const api = await as(s.member);

    for (const bad of [sibling.id, foreignReq.id, missingId()]) {
      const res = await api.post(s.url).send({ description: 'x', requirement_ids: [own.id, bad] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('requirement_not_in_tender');
      expect(res.body.error.details.missing).toEqual([bad]);
    }
    expect(await s.db.count('change_entry', { tender_id: s.tender.id })).toBe(0);
    expect((await api.post(s.url).send({ description: 'x', requirement_ids: ['nope'] })).status).toBe(400);

    const entry = (await api.post(s.url).send({ description: 'x', requirement_ids: [own.id] })).body;
    const patch = await api.patch(`${s.url}/${entry.id}`).send({ requirement_ids: [sibling.id] });
    expect(patch.status).toBe(422);
    expect((await api.get(s.url)).body.items[0].requirement_ids).toEqual([own.id]);
    expect(await dbFor(foreignOrg).count('change_entry_requirement')).toBe(0);
  });

  it('edit replaces the set of affected requirements', async () => {
    const s = await setup();
    const [r1, r2, r3] = [await s.req('ΥΠ-001'), await s.req('ΥΠ-002'), await s.req('ΥΠ-003')];
    const api = await as(s.member);
    const entry = (await api.post(s.url).send({ description: 'x', requirement_ids: [r1.id, r2.id] })).body;
    const patched = await api.patch(`${s.url}/${entry.id}`).send({ description: 'y', source: 'adam', requirement_ids: [r2.id, r3.id] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ description: 'y', source: 'adam' });
    expect(patched.body.requirements.map((r: { code: string }) => r.code)).toEqual(['ΥΠ-002', 'ΥΠ-003']);
    // fields only: links untouched
    expect((await api.patch(`${s.url}/${entry.id}`).send({ reference: 'ref' })).body.requirement_ids).toEqual([r2.id, r3.id]);
    expect((await api.patch(`${s.url}/${entry.id}`).send({ requirement_ids: [] })).body.requirement_ids).toEqual([]);
    expect((await api.delete(`${s.url}/${entry.id}`)).status).toBe(204);
    expect(await s.db.count('change_entry', { tender_id: s.tender.id })).toBe(0);
  });

  it('reopen_requirements (default off) sets covered / verified rows back to in_progress', async () => {
    const s = await setup();
    const covered = await s.req('ΥΠ-001', 'covered');
    const verified = await s.req('ΥΠ-002', 'verified');
    const open = await s.req('ΥΠ-003', 'open');
    const deviation = await s.req('ΥΠ-004', 'deviation');
    const untouched = await s.req('ΥΠ-005', 'covered');
    const ids = [covered.id, verified.id, open.id, deviation.id];
    const api = await as(s.member);
    const status = async (id: string) => (await s.db.get('requirement', id))?.status;

    const off = await api.post(s.url).send({ description: 'χωρίς επανέλεγχο', requirement_ids: ids });
    expect(off.body.reopened).toBe(0);
    expect(await status(covered.id)).toBe('covered');

    const on = await api.post(s.url).send({ description: 'με επανέλεγχο', requirement_ids: ids, reopen_requirements: true });
    expect(on.status).toBe(201);
    expect(on.body.reopened).toBe(2);
    expect(await Promise.all([covered, verified, open, deviation, untouched].map((r) => status(r.id)))).toEqual(['in_progress', 'in_progress', 'open', 'deviation', 'covered']);

    // on edit: applies to the rows linked after the edit
    const viaPatch = await api.patch(`${s.url}/${off.body.id}`).send({ requirement_ids: [untouched.id], reopen_requirements: true });
    expect(viaPatch.body.reopened).toBe(1);
    expect(await status(untouched.id)).toBe('in_progress');
  });

  it('extension entries come from the deadline flow: shown, kind locked, not creatable here', async () => {
    const s = await setup();
    const ext = await s.db.insert('change_entry', { tender_id: s.tender.id, kind: 'extension', source: 'esidis', date: '2027-04-20', description: 'Παράταση', payload: { oldT: '2027-05-07', newT: '2027-05-14' } });
    const api = await as(s.member);
    const list = await api.get(s.url);
    expect(list.body.items[0]).toMatchObject({ kind: 'extension', kind_locked: true, payload: { oldT: '2027-05-07', newT: '2027-05-14' } });

    const create = await api.post(s.url).send({ description: 'x', kind: 'extension' });
    expect(create.status).toBe(422);
    expect(create.body.error.code).toBe('extension_via_deadline');
    const retype = await api.patch(`${s.url}/${ext.id}`).send({ kind: 'amendment' });
    expect(retype.status).toBe(422);
    expect(retype.body.error.code).toBe('extension_kind_locked');
    const other = (await api.post(s.url).send({ description: 'x' })).body;
    expect((await api.patch(`${s.url}/${other.id}`).send({ kind: 'extension' })).body.error.code).toBe('extension_via_deadline');
    expect((await api.patch(`${s.url}/${other.id}`).send({ kind: 'amendment' })).body.kind).toBe('amendment');

    // the rest of an extension entry stays editable (description, affected rows, same kind sent back)
    const r1 = await s.req('ΥΠ-001');
    const edited = await api.patch(`${s.url}/${ext.id}`).send({ kind: 'extension', description: 'Παράταση 5 εργάσιμων', requirement_ids: [r1.id] });
    expect(edited.body).toMatchObject({ kind: 'extension', description: 'Παράταση 5 εργάσιμων', requirement_ids: [r1.id] });

    const denied = await api.delete(`${s.url}/${ext.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('extension_manager_only');
    expect((await as(s.manager).delete(`${s.url}/${ext.id}`)).status).toBe(204);
  });

  it('validates input', async () => {
    const s = await setup();
    const api = await as(s.member);
    expect((await api.post(s.url).send({})).status).toBe(400);
    expect((await api.post(s.url).send({ description: '  ' })).status).toBe(400);
    expect((await api.post(s.url).send({ description: 'x', source: 'fax' })).status).toBe(400);
    expect((await api.post(s.url).send({ description: 'x', date: '15/04/2027' })).status).toBe(400);
    expect((await api.post(s.url).send({ description: 'x', owner_user_id: missingId() })).body.error.code).toBe('unknown_user');
    expect((await api.post(s.url).send({ description: 'x', tender_id: missingId() })).status).toBe(400);
    expect((await api.patch(`${s.url}/${missingId()}`).send({ description: 'x' })).status).toBe(404);
  });

  it('viewer is read-only, a non-member gets 403, a closed tender is read-only', async () => {
    const s = await setup();
    const row = await s.db.insert('change_entry', { tender_id: s.tender.id, description: 'x' });
    const viewer = await as(s.viewer);
    expect((await viewer.post(s.url).send({ description: 'y' })).status).toBe(403);
    expect((await viewer.patch(`${s.url}/${row.id}`).send({ description: 'y' })).status).toBe(403);
    expect((await viewer.delete(`${s.url}/${row.id}`)).status).toBe(403);
    const outsider = await as(s.outsider);
    expect((await outsider.get(s.url)).status).toBe(403);
    expect((await outsider.post(s.url).send({ description: 'y' })).status).toBe(403);

    await s.db.update('tender', s.tender.id, { status: 'submitted' });
    const manager = await as(s.manager);
    expect((await manager.get(s.url)).body.items).toHaveLength(1);
    for (const res of [
      await manager.post(s.url).send({ description: 'y' }),
      await manager.patch(`${s.url}/${row.id}`).send({ description: 'y' }),
      await manager.delete(`${s.url}/${row.id}`),
    ]) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('tender_closed');
    }
  });

  it('never leaks across organizations or tenders', async () => {
    const s = await setup();
    const r1 = await s.req('ΥΠ-001');
    const row = await s.db.insert('change_entry', { tender_id: s.tender.id, description: 'secret' });
    await s.db.insert('change_entry_requirement', { tender_id: s.tender.id, change_entry_id: row.id, requirement_id: r1.id });
    const otherTender = await createTender(s.org);
    const foreignOrg = await createOrg();
    const foreign = await as(await createUser(foreignOrg, 'admin'));
    const foreignTender = await createTender(foreignOrg);
    expect((await foreign.get(s.url)).status).toBe(404);
    expect((await foreign.post(s.url).send({ description: 'x' })).status).toBe(404);
    expect((await foreign.patch(`${s.url}/${row.id}`).send({ description: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${s.url}/${row.id}`)).status).toBe(404);
    const own = `/api/tenders/${foreignTender.id}/changes`;
    expect((await foreign.get(own)).body.items).toEqual([]);
    expect((await foreign.patch(`${own}/${row.id}`).send({ description: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${own}/${row.id}`)).status).toBe(404);
    expect((await foreign.post(own).send({ description: 'x', requirement_ids: [r1.id] })).status).toBe(422);
    expect((await as(s.manager).patch(`/api/tenders/${otherTender.id}/changes/${row.id}`).send({ description: 'x' })).status).toBe(404);
    expect((await s.db.get('change_entry', row.id))?.description).toBe('secret');
    expect(await dbFor(foreignOrg).count('change_entry')).toBe(0);
  });
});
