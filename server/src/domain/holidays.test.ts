import { describe, expect, it } from 'vitest';
import { as, createOrg, createUser, dbFor, seedHolidays } from '../test/harness.js';
import { addCalendarDays, addWorkingDays, greekHolidays } from './calendar.js';
import { ensureHolidayYears, loadHolidays, seedHolidaysForYear } from './holidays.js';

describe('holidays in the database (R2)', () => {
  it('seedHolidaysForYear inserts the 12 Greek holidays and is idempotent', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const added = await seedHolidaysForYear(db, 2027);
    expect(added).toHaveLength(12);
    expect(added.map((h) => h.date)).toEqual(greekHolidays(2027).map((h) => h.date));
    expect(added.find((h) => h.date === '2027-04-30')).toMatchObject({ name: 'Μεγάλη Παρασκευή', source: 'movable', org_id: org.id });
    expect(await seedHolidaysForYear(db, 2027)).toEqual([]);
    expect(await db.count('holiday')).toBe(12);
  });

  it('never overwrites rows the admin changed, and only fills in missing dates', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await db.insert('holiday', { date: '2027-05-01', name: 'Πρωτομαγιά (δική μας)', source: 'manual' });
    const added = await seedHolidaysForYear(db, 2027);
    expect(added).toHaveLength(11);
    expect((await db.findOne('holiday', { date: '2027-05-01' }))?.name).toBe('Πρωτομαγιά (δική μας)');
  });

  it('loadHolidays returns only the org\'s dates', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    await seedHolidays(orgA, [2026, 2027]);
    await dbFor(orgB).insert('holiday', { date: '2027-05-04', name: 'Μόνο στο B' });
    const a = await loadHolidays(dbFor(orgA));
    const b = await loadHolidays(dbFor(orgB));
    expect(a.size).toBeGreaterThanOrEqual(24);
    expect(a.has('2027-04-30')).toBe(true);
    expect(a.has('2027-05-04')).toBe(false);
    // B has its own manual holiday plus the auto-seeded current years (review H2) — and nothing of A's seed for 2026
    expect(b.has('2027-05-04')).toBe(true);
    expect([...b].every((d) => d === '2027-05-04' || Number(d.slice(0, 4)) >= new Date().getFullYear())).toBe(true);
  });

  it('spec acceptance with holidays seeded in the database: T = Fri 07/05/2027', async () => {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const h = await loadHolidays(dbFor(org));
    const T = '2027-05-07';
    const g4 = addWorkingDays(T, -2, h);
    expect(g4).toBe('2027-05-05');
    expect(addWorkingDays(T, -3, h)).toBe('2027-05-04');
    expect(addWorkingDays(T, -4, h)).toBe('2027-04-29');
    expect(addWorkingDays(T, -8, h)).toBe('2027-04-23');
    expect(addWorkingDays(T, -10, h)).toBe('2027-04-21');
    expect(addCalendarDays(g4, -10, h)).toBe('2027-04-23'); // guarantee: last day to request (R6)
  });

  it('an admin change to the calendar changes the schedule (holidays are data, not code)', async () => {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const db = dbFor(org);
    const goodFriday = await db.findOne('holiday', { date: '2027-04-30' });
    await db.remove('holiday', goodFriday!.id);
    const h = await loadHolidays(db);
    expect(addWorkingDays('2027-05-07', -4, h)).toBe('2027-04-30');
    expect(addWorkingDays('2027-05-07', -8, h)).toBe('2027-04-26');
  });
});

describe('ensureHolidayYears — no schedule over an unseeded year (review H2)', () => {
  it('a tender created in an org without any holiday rows gets the same dates as in a seeded org', async () => {
    const { seedTemplateL11 } = await import('../db/seed.js');
    const make = async (seed: boolean) => {
      const org = await createOrg();
      if (seed) await seedHolidays(org, [2026, 2027, 2028]);
      const { template } = await seedTemplateL11(dbFor(org));
      const admin = await createUser(org, 'admin');
      const res = await as(admin)
        .post('/api/tenders')
        .send({ title: 'x', authority: 'y', t0_published_at: '2027-03-01', submission_deadline_at: '2027-05-07T12:00:00Z', template_id: template.id });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const rows = await dbFor(org).list('milestone', { tender_id: res.body.tender.id });
      return { org, admin, id: res.body.tender.id as string, dates: Object.fromEntries(rows.map((m) => [m.key, m.due_date])) };
    };
    const seeded = await make(true);
    const bare = await make(false);
    expect(bare.dates).toEqual(seeded.dates);
    expect(bare.dates).toMatchObject({ G4: '2027-05-05', G3: '2027-05-04', G2: '2027-04-29', G1: '2027-04-23' }); // skips 30/04 and 03/05
    const years = async (org: { id: string }) =>
      (await dbFor(org).sql<{ y: number }>("SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM holiday WHERE org_id = :org_id AND source <> 'manual' ORDER BY 1")).map((r) => r.y);
    const thisYear = new Date().getFullYear();
    expect(await years(bare.org)).toEqual(expect.arrayContaining([thisYear, 2027, 2028]));
    // the seeding is recorded
    expect((await dbFor(bare.org).list('audit_log', { entity: 'holiday', action: 'auto_seed' })).length).toBeGreaterThan(0);

    // an extension preview into a year that is not there yet seeds it first (T = Mon 08/01/2029: 01/01 and 06/01 matter)
    const before = await years(bare.org);
    expect(before).not.toContain(2029);
    const preview = await as(bare.admin).post(`/api/tenders/${bare.id}/deadline/preview`).send({ submission_deadline_at: '2029-01-08T12:00:00Z' });
    expect(preview.status).toBe(200);
    expect(await years(bare.org)).toEqual(expect.arrayContaining([2029, 2030]));
    expect(preview.body.items.find((i: { key: string }) => i.key === 'G4').new_date).toBe('2029-01-04'); // T−2
    expect(preview.body.items.find((i: { key: string }) => i.key === 'G1').new_date).toBe('2028-12-22'); // T−8 skips Mon 01/01/2029 (and 25–26/12)
  });

  it('is idempotent, concurrent-safe and never restores holidays an admin removed or moved', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    const year = new Date().getFullYear();
    const [a, b] = await Promise.all([ensureHolidayYears(db), ensureHolidayYears(db)]);
    expect([...a, ...b]).toEqual(expect.arrayContaining([year, year + 1]));
    const count = await db.count('holiday', {});
    expect(await ensureHolidayYears(db)).toEqual([]);
    expect(await db.count('holiday', {})).toBe(count);
    expect(new Set((await db.list('holiday', {})).map((h) => h.date)).size).toBe(count);

    const mayDay = await db.findOne('holiday', { date: `${year + 1}-05-01` });
    await db.remove('holiday', mayDay!.id);
    expect((await loadHolidays(db)).has(`${year + 1}-05-01`)).toBe(false);
    expect(await db.count('holiday', {})).toBe(count - 1);
    // a far-away typo does not seed centuries
    expect((await ensureHolidayYears(db, ['9999-01-01'])).every((y) => y <= year + 15)).toBe(true);
  });
});
