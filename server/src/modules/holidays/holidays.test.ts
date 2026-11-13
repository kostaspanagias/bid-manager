import { describe, expect, it } from 'vitest';
import { as, createOrg, createUser, dbFor, missingId, seedHolidays } from '../../test/harness.js';

describe('/api/holidays', () => {
  it('any authenticated user lists holidays, optionally by year', async () => {
    const org = await createOrg();
    await seedHolidays(org, [2026, 2027]);
    const viewer = await as(await createUser(org, 'viewer'));
    const all = await viewer.get('/api/holidays');
    expect(all.body.items).toHaveLength(24);
    const y2027 = await viewer.get('/api/holidays?year=2027');
    expect(y2027.status).toBe(200);
    expect(y2027.body.items).toHaveLength(12);
    expect(y2027.body.items[0]).toEqual({ id: expect.any(String), date: '2027-01-01', name: 'Πρωτοχρονιά', source: 'national' });
    expect(y2027.body.items.map((h: { date: string }) => h.date)).toContain('2027-04-30');
    expect((await viewer.get('/api/holidays?year=2030')).body.items).toEqual([]);
    expect((await viewer.get('/api/holidays?year=abc')).status).toBe(400);
  });

  it('only an admin can seed, add, move or remove', async () => {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const [h] = await dbFor(org).list('holiday', { date: '2027-05-01' });
    for (const role of ['bid_manager', 'member', 'approver', 'viewer'] as const) {
      const api = await as(await createUser(org, role));
      expect((await api.post('/api/holidays').send({ date: '2027-06-01', name: 'x' })).status).toBe(403);
      expect((await api.post('/api/holidays/seed').send({ year: 2028 })).status).toBe(403);
      expect((await api.patch(`/api/holidays/${h.id}`).send({ name: 'x' })).status).toBe(403);
      expect((await api.delete(`/api/holidays/${h.id}`)).status).toBe(403);
    }
    expect(await dbFor(org).count('holiday')).toBe(12);
  });

  it('POST /seed {year} is idempotent', async () => {
    const org = await createOrg();
    const api = await as(await createUser(org, 'admin'));
    const first = await api.post('/api/holidays/seed').send({ year: 2027 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ year: 2027, added: 12 });
    expect(first.body.items).toHaveLength(12);
    const second = await api.post('/api/holidays/seed').send({ year: 2027 });
    expect(second.body).toEqual({ year: 2027, added: 0, items: [] });
    expect((await api.get('/api/holidays?year=2027')).body.items).toHaveLength(12);
    expect((await api.post('/api/holidays/seed').send({ year: 1800 })).status).toBe(400);
    expect((await api.post('/api/holidays/seed').send({})).status).toBe(400);
  });

  it('admin adds a manual holiday; duplicates and bad input are rejected', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const api = await as(admin);
    const res = await api.post('/api/holidays').send({ date: '2027-11-17', name: 'Τοπική αργία' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), date: '2027-11-17', name: 'Τοπική αργία', source: 'manual' });
    const dup = await api.post('/api/holidays').send({ date: '2027-11-17', name: 'Ξανά' });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'holiday_exists']);
    for (const body of [{ date: '17/11/2027', name: 'x' }, { date: '2027-02-30', name: 'x' }, { date: '2027-11-18' }, { date: '2027-11-18', name: 'x', source: 'national' }]) {
      expect((await api.post('/api/holidays').send(body)).status).toBe(400);
    }
    expect(await dbFor(org).findOne('audit_log', { entity: 'holiday', entity_id: res.body.id, action: 'create' })).toMatchObject({ user_id: admin.id });
  });

  it('admin moves a holiday (e.g. 1 May transfer) — it becomes manual; renaming keeps the source', async () => {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const api = await as(await createUser(org, 'admin'));
    const mayDay = (await api.get('/api/holidays?year=2027')).body.items.find((h: { date: string }) => h.date === '2027-05-01');

    const renamed = await api.patch(`/api/holidays/${mayDay.id}`).send({ name: 'Εργατική Πρωτομαγιά' });
    expect(renamed.body).toMatchObject({ date: '2027-05-01', name: 'Εργατική Πρωτομαγιά', source: 'national' });

    const moved = await api.patch(`/api/holidays/${mayDay.id}`).send({ date: '2027-05-04' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: mayDay.id, date: '2027-05-04', source: 'manual' });
    const dates = (await api.get('/api/holidays?year=2027')).body.items.map((h: { date: string }) => h.date);
    expect(dates).toContain('2027-05-04');
    expect(dates).not.toContain('2027-05-01');

    // moving onto an existing holiday is a conflict
    const clash = await api.patch(`/api/holidays/${mayDay.id}`).send({ date: '2027-05-03' });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'holiday_exists']);
    expect((await api.patch(`/api/holidays/${missingId()}`).send({ name: 'x' })).status).toBe(404);
    expect((await api.patch(`/api/holidays/${mayDay.id}`).send({ date: 'soon' })).status).toBe(400);
  });

  it('admin removes a holiday', async () => {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const api = await as(await createUser(org, 'admin'));
    const [h] = await dbFor(org).list('holiday', { date: '2027-04-30' });
    expect((await api.delete(`/api/holidays/${h.id}`)).status).toBe(204);
    expect((await api.delete(`/api/holidays/${h.id}`)).status).toBe(404);
    expect((await api.get('/api/holidays?year=2027')).body.items).toHaveLength(11);
  });

  it('cross-org: holidays of another organization are never returned or modified', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    await seedHolidays(orgA, 2027);
    const [target] = await dbFor(orgA).list('holiday', { date: '2027-04-30' });
    const b = await as(await createUser(orgB, 'admin'));
    expect((await b.get('/api/holidays')).body.items).toEqual([]);
    expect((await b.get('/api/holidays?year=2027')).body.items).toEqual([]);
    expect((await b.patch(`/api/holidays/${target.id}`).send({ name: 'hacked', date: '2027-07-07' })).status).toBe(404);
    expect((await b.delete(`/api/holidays/${target.id}`)).status).toBe(404);
    // the same date is free in org B, and seeding B does not touch A
    expect((await b.post('/api/holidays').send({ date: '2027-04-30', name: 'B' })).status).toBe(201);
    expect((await b.post('/api/holidays/seed').send({ year: 2027 })).body.added).toBe(11);
    expect(await dbFor(orgA).get('holiday', target.id)).toMatchObject({ name: 'Μεγάλη Παρασκευή', date: '2027-04-30' });
    expect(await dbFor(orgA).count('holiday')).toBe(12);
  });
});
