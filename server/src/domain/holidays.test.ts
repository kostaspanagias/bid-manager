import { describe, expect, it } from 'vitest';
import { createOrg, dbFor, seedHolidays } from '../test/harness.js';
import { addCalendarDays, addWorkingDays, greekHolidays } from './calendar.js';
import { loadHolidays, seedHolidaysForYear } from './holidays.js';

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
    expect(a.size).toBe(24);
    expect(a.has('2027-04-30')).toBe(true);
    expect(a.has('2027-05-04')).toBe(false);
    expect([...b]).toEqual(['2027-05-04']);
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
