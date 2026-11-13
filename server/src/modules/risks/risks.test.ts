import { describe, expect, it } from 'vitest';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';
import { DEFAULT_RISKS } from './routes.js';

async function setup() {
  const org = await createOrg();
  const manager = await createUser(org, 'bid_manager');
  const member = await createUser(org, 'member');
  const viewer = await createUser(org, 'viewer');
  const outsider = await createUser(org, 'member');
  const tender = await createTender(org);
  await addMember(tender, member, 'B');
  await addMember(tender, viewer);
  return { org, db: dbFor(org), manager, member, viewer, outsider, tender, url: `/api/tenders/${tender.id}/risks` };
}

describe('/api/tenders/:id/risks', () => {
  it('a member adds, edits and removes a risk', async () => {
    const s = await setup();
    const api = await as(s.member);
    const created = await api.post(s.url).send({ title: 'Εγγυητική αργεί', trigger: 'Δεν έχει εκδοθεί στο T−3', mitigation: 'Κλιμάκωση στην τράπεζα', owner_user_id: s.member.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Εγγυητική αργεί', trigger: 'Δεν έχει εκδοθεί στο T−3', status: 'open', owner_user_id: s.member.id, is_default: false });
    const id = created.body.id;
    const patched = await api.patch(`${s.url}/${id}`).send({ status: 'mitigating', mitigation: '', owner_user_id: null });
    expect(patched.body).toMatchObject({ status: 'mitigating', mitigation: null, owner_user_id: null });
    expect((await api.get(s.url)).body.items).toHaveLength(1);

    expect((await api.post(s.url).send({ trigger: 'x' })).status).toBe(400);
    expect((await api.post(s.url).send({ title: 'x', status: 'nope' })).status).toBe(400);
    expect((await api.post(s.url).send({ title: 'x', owner_user_id: missingId() })).body.error.code).toBe('unknown_user');
    expect((await api.patch(`${s.url}/${missingId()}`).send({ title: 'x' })).status).toBe(404);

    expect((await api.delete(`${s.url}/${id}`)).status).toBe(204);
    expect(await s.db.count('risk', { tender_id: s.tender.id })).toBe(0);
  });

  it('seed-defaults adds the six usual risks of the blueprint, once; bid manager / admin only', async () => {
    const s = await setup();
    expect((await as(s.member).post(`${s.url}/seed-defaults`)).status).toBe(403);
    // a risk the team already typed with the same title is not duplicated
    await s.db.insert('risk', { tender_id: s.tender.id, title: 'Φωτογραφική απαίτηση', status: 'mitigating' });

    const api = await as(s.manager);
    const first = await api.post(`${s.url}/seed-defaults`);
    expect(first.status).toBe(200);
    expect(first.body.added).toBe(5);
    expect(first.body.items[0]).toMatchObject({ title: 'Εγγυητική αργεί', trigger: 'Δεν έχει εκδοθεί στο T−3', status: 'open', is_default: true });
    const second = await api.post(`${s.url}/seed-defaults`);
    expect(second.body).toEqual({ added: 0, items: [] });

    const list = (await api.get(s.url)).body.items;
    expect(list).toHaveLength(6);
    expect(list.map((r: { title: string }) => r.title).sort()).toEqual(DEFAULT_RISKS.map((d) => d.title).sort());

    // a default that was renamed is still recognised; one that was deleted comes back
    await api.patch(`${s.url}/${first.body.items[0].id}`).send({ title: 'Η εγγυητική αργεί (Τράπεζα Χ)' });
    await api.delete(`${s.url}/${first.body.items[1].id}`);
    const third = await api.post(`${s.url}/seed-defaults`);
    expect(third.body.added).toBe(1);
    expect(await s.db.count('risk', { tender_id: s.tender.id })).toBe(6);
  });

  it('viewer is read-only, a non-member gets 403, a closed tender is read-only', async () => {
    const s = await setup();
    const row = await s.db.insert('risk', { tender_id: s.tender.id, title: 'x' });
    const viewer = await as(s.viewer);
    expect((await viewer.get(s.url)).status).toBe(200);
    expect((await viewer.post(s.url).send({ title: 'y' })).status).toBe(403);
    expect((await viewer.patch(`${s.url}/${row.id}`).send({ title: 'y' })).status).toBe(403);
    expect((await viewer.delete(`${s.url}/${row.id}`)).status).toBe(403);
    const outsider = await as(s.outsider);
    expect((await outsider.get(s.url)).status).toBe(403);
    expect((await outsider.post(s.url).send({ title: 'y' })).status).toBe(403);

    await s.db.update('tender', s.tender.id, { status: 'cancelled' });
    const manager = await as(s.manager);
    expect((await manager.get(s.url)).body.items).toHaveLength(1);
    for (const res of [
      await manager.post(s.url).send({ title: 'y' }),
      await manager.post(`${s.url}/seed-defaults`),
      await manager.patch(`${s.url}/${row.id}`).send({ title: 'y' }),
      await manager.delete(`${s.url}/${row.id}`),
    ]) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('tender_closed');
    }
  });

  it('never leaks across organizations or tenders', async () => {
    const s = await setup();
    const row = await s.db.insert('risk', { tender_id: s.tender.id, title: 'secret' });
    const otherTender = await createTender(s.org);
    const foreignOrg = await createOrg();
    const foreign = await as(await createUser(foreignOrg, 'admin'));
    const foreignTender = await createTender(foreignOrg);
    expect((await foreign.get(s.url)).status).toBe(404);
    expect((await foreign.post(s.url).send({ title: 'x' })).status).toBe(404);
    expect((await foreign.post(`${s.url}/seed-defaults`)).status).toBe(404);
    expect((await foreign.patch(`${s.url}/${row.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${s.url}/${row.id}`)).status).toBe(404);
    expect((await foreign.get(`/api/tenders/${foreignTender.id}/risks`)).body.items).toEqual([]);
    expect((await foreign.patch(`/api/tenders/${foreignTender.id}/risks/${row.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await foreign.delete(`/api/tenders/${foreignTender.id}/risks/${row.id}`)).status).toBe(404);
    expect((await as(s.manager).patch(`/api/tenders/${otherTender.id}/risks/${row.id}`).send({ title: 'x' })).status).toBe(404);
    expect((await s.db.get('risk', row.id))?.title).toBe('secret');
    expect(await dbFor(foreignOrg).count('risk')).toBe(0);
  });
});
