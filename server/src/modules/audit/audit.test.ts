import { describe, expect, it } from 'vitest';
import { as, createOrg, createTender, createUser, dbFor } from '../../test/harness.js';

describe('/api/audit', () => {
  async function scenario() {
    const org = await createOrg();
    const admin = await createUser(org, 'admin', { name: 'Admin' });
    const member = await createUser(org, 'member', { name: 'Member' });
    const tender = await createTender(org);
    const asMember = dbFor(org, member);
    const task = await asMember.insert('task', { tender_id: tender.id, title: 'Αίτηση εγγυητικής' });
    await asMember.update('task', task.id, { status: 'done' });
    const h = await dbFor(org, admin).insert('holiday', { date: '2035-01-02', name: 'x' });
    await dbFor(org, admin).remove('holiday', h.id);
    return { org, admin, member, tender, task, holiday: h };
  }

  it('is admin-only', async () => {
    const { org } = await scenario();
    for (const role of ['bid_manager', 'member', 'approver', 'viewer'] as const) {
      expect((await as(await createUser(org, role)).get('/api/audit')).status).toBe(403);
    }
  });

  it('lists newest first with who / what / when / before / after', async () => {
    const { admin, member, task } = await scenario();
    const res = await as(admin).get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.items.length);
    const times = res.body.items.map((i: { at: string }) => new Date(i.at).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    const update = res.body.items.find((i: { entity: string; action: string }) => i.entity === 'task' && i.action === 'update');
    expect(update).toMatchObject({
      entity_id: task.id,
      user_id: member.id,
      user_name: 'Member',
      before: { status: 'open' },
      after: { status: 'done' },
    });
    expect(Object.keys(update).sort()).toEqual(['action', 'after', 'at', 'before', 'entity', 'entity_id', 'id', 'tender_id', 'user_id', 'user_name']);
  });

  it('filters by entity, entity_id, user, tender_id and action', async () => {
    const { admin, member, tender, task, holiday } = await scenario();
    const api = await as(admin);
    const by = async (qs: string) => (await api.get(`/api/audit?${qs}`)).body;
    expect((await by('entity=holiday')).items.map((i: { action: string }) => i.action).sort()).toEqual(['create', 'delete']);
    expect((await by(`entity=task&entity_id=${task.id}`)).total).toBe(2);
    expect((await by(`entity_id=${holiday.id}`)).total).toBe(2);
    expect((await by(`user=${member.id}`)).items.every((i: { user_id: string }) => i.user_id === member.id)).toBe(true);
    expect((await by(`user=${member.id}`)).total).toBe(2);
    expect((await by(`user_id=${member.id}`)).total).toBe(2);
    expect((await by(`tender_id=${tender.id}`)).items.map((i: { entity: string }) => i.entity).sort()).toEqual(['task', 'task', 'tender']);
    expect((await by('entity=task&action=update')).total).toBe(1);
    expect((await by('entity=nothing')).items).toEqual([]);
    expect((await api.get('/api/audit?user=not-a-uuid')).status).toBe(400);
  });

  it('paginates with limit/offset and reports the total', async () => {
    const { admin } = await scenario();
    const api = await as(admin);
    const all = (await api.get('/api/audit')).body;
    expect(all.total).toBeGreaterThanOrEqual(7);
    const page1 = (await api.get('/api/audit?limit=3')).body;
    const page2 = (await api.get('/api/audit?limit=3&offset=3')).body;
    expect(page1).toMatchObject({ total: all.total, limit: 3, offset: 0 });
    expect(page1.items).toHaveLength(3);
    expect([...page1.items, ...page2.items].map((i: { id: string }) => i.id)).toEqual(all.items.slice(0, 6).map((i: { id: string }) => i.id));
    expect((await api.get('/api/audit?limit=0')).status).toBe(400);
    expect((await api.get('/api/audit?limit=100000')).status).toBe(400);
  });

  it('there is no way to change or delete entries through the API', async () => {
    const { admin } = await scenario();
    const api = await as(admin);
    const [entry] = (await api.get('/api/audit?limit=1')).body.items;
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await api[method](`/api/audit/${entry.id}`).send({})).status).toBe(404);
      expect((await api[method]('/api/audit').send({})).status).toBe(404);
    }
  });

  it('cross-org: an admin never sees another organization\'s log', async () => {
    const { tender, task, member } = await scenario();
    const foreign = await as(await createUser(await createOrg(), 'admin'));
    const all = (await foreign.get('/api/audit')).body;
    expect(JSON.stringify(all)).not.toContain(tender.id);
    expect(all.items.every((i: { entity: string }) => i.entity !== 'task' && i.entity !== 'tender')).toBe(true);
    expect((await foreign.get(`/api/audit?tender_id=${tender.id}`)).body).toMatchObject({ items: [], total: 0 });
    expect((await foreign.get(`/api/audit?entity_id=${task.id}`)).body.total).toBe(0);
    expect((await foreign.get(`/api/audit?user=${member.id}`)).body.total).toBe(0);
  });
});
