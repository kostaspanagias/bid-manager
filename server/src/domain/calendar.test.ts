import { describe, expect, it } from 'vitest';
import {
  addCalendarDays, addWorkingDays, applyOffset, dayOfWeek, daysBetween, greekHolidays, isWorkingDay, nextWorkingDay, orthodoxEaster,
  previousWorkingDay, shiftDays, workingDaysBetween,
} from './calendar.js';

const holidays = (...years: number[]) => new Set(years.flatMap((y) => greekHolidays(y).map((h) => h.date)));
const NONE: ReadonlySet<string> = new Set();

describe('R2 — Orthodox Easter (Meeus Julian + 13 days)', () => {
  it('spec acceptance: 2026 → 12/04, 2027 → 02/05', () => {
    expect(orthodoxEaster(2026)).toBe('2026-04-12');
    expect(orthodoxEaster(2027)).toBe('2027-05-02');
  });

  it('matches known dates and always falls on a Sunday', () => {
    const known: Record<number, string> = {
      2019: '2019-04-28', 2020: '2020-04-19', 2021: '2021-05-02', 2022: '2022-04-24', 2023: '2023-04-16', 2024: '2024-05-05',
      2025: '2025-04-20', 2028: '2028-04-16', 2029: '2029-04-08', 2030: '2030-04-28', 2035: '2035-04-29',
    };
    for (const [year, date] of Object.entries(known)) expect(orthodoxEaster(Number(year)), year).toBe(date);
    for (let y = 1900; y <= 2099; y++) expect(dayOfWeek(orthodoxEaster(y)), String(y)).toBe(0);
  });

  it('rejects years outside 1900–2099', () => {
    expect(() => orthodoxEaster(1899)).toThrow();
    expect(() => orthodoxEaster(2100)).toThrow();
    expect(() => orthodoxEaster(2026.5)).toThrow();
  });
});

describe('R2 — Greek holidays of a year', () => {
  it('2027: 8 fixed + Clean Monday, Good Friday, Easter Monday, Whit Monday', () => {
    const list = greekHolidays(2027);
    expect(list.filter((h) => h.source === 'national').map((h) => h.date)).toEqual([
      '2027-01-01', '2027-01-06', '2027-03-25', '2027-05-01', '2027-08-15', '2027-10-28', '2027-12-25', '2027-12-26',
    ]);
    const movable = Object.fromEntries(list.filter((h) => h.source === 'movable').map((h) => [h.name, h.date]));
    expect(movable).toEqual({
      'Καθαρά Δευτέρα': '2027-03-15', // Π−48
      'Μεγάλη Παρασκευή': '2027-04-30', // Π−2
      'Δευτέρα του Πάσχα': '2027-05-03', // Π+1
      'Αγίου Πνεύματος': '2027-06-21', // Π+50
    });
    expect(list).toHaveLength(12);
    expect(list.map((h) => h.date)).toEqual([...list.map((h) => h.date)].sort());
  });

  it('2026: movable dates from Easter 12/04', () => {
    const byName = Object.fromEntries(greekHolidays(2026).map((h) => [h.name, h.date]));
    expect(byName['Καθαρά Δευτέρα']).toBe('2026-02-23');
    expect(byName['Μεγάλη Παρασκευή']).toBe('2026-04-10');
    expect(byName['Δευτέρα του Πάσχα']).toBe('2026-04-13');
    expect(byName['Αγίου Πνεύματος']).toBe('2026-06-01');
  });

  it('movable holidays land on the right weekday; a collision with a fixed date keeps one entry', () => {
    for (let y = 2000; y <= 2060; y++) {
      const list = greekHolidays(y);
      const byName = Object.fromEntries(list.map((h) => [h.name, h.date]));
      expect(new Set(list.map((h) => h.date)).size).toBe(list.length);
      if (byName['Καθαρά Δευτέρα']) expect(dayOfWeek(byName['Καθαρά Δευτέρα'])).toBe(1);
      if (byName['Μεγάλη Παρασκευή']) expect(dayOfWeek(byName['Μεγάλη Παρασκευή'])).toBe(5);
      if (byName['Δευτέρα του Πάσχα']) expect(dayOfWeek(byName['Δευτέρα του Πάσχα'])).toBe(1);
      if (byName['Αγίου Πνεύματος']) expect(dayOfWeek(byName['Αγίου Πνεύματος'])).toBe(1);
    }
    // 2013: Easter 5 May → Good Friday 3 May, Easter Monday 6 May (no collision). 2040: Easter 6 May.
    // 2021: Easter 2 May → Good Friday 30 April. 2059: Easter 4 May → Good Friday 2 May.
    // 2002: Easter 5 May, Good Friday 3 May. A real collision: 2024? Easter 5 May → no. 1983: Easter 8 May → no.
    // Easter on 3 May gives Good Friday on 1 May (e.g. 2043): 11 entries, the fixed one wins.
    expect(orthodoxEaster(2043)).toBe('2043-05-03');
    const y2043 = greekHolidays(2043);
    expect(y2043).toHaveLength(11);
    expect(y2043.find((h) => h.date === '2043-05-01')).toMatchObject({ name: 'Πρωτομαγιά', source: 'national' });
  });
});

describe('R1 — working day', () => {
  const h = holidays(2027);
  it('Monday–Friday that is not a holiday', () => {
    expect(isWorkingDay('2027-05-07', h)).toBe(true); // Friday
    expect(isWorkingDay('2027-05-08', h)).toBe(false); // Saturday
    expect(isWorkingDay('2027-05-09', h)).toBe(false); // Sunday
    expect(isWorkingDay('2027-04-30', h)).toBe(false); // Good Friday
    expect(isWorkingDay('2027-05-03', h)).toBe(false); // Easter Monday
    expect(isWorkingDay('2027-05-03', NONE)).toBe(true);
    expect(isWorkingDay('2027-10-28', h)).toBe(false); // Thursday, national holiday
  });

  it('a manual holiday in the set is respected (e.g. 1 May moved to Monday 3 May 2027 is already off; move to Tue)', () => {
    const custom = new Set([...h, '2027-05-04']);
    expect(isWorkingDay('2027-05-04', custom)).toBe(false);
    expect(addWorkingDays('2027-05-07', -3, custom)).toBe('2027-04-29');
  });

  it('previous/next working day', () => {
    expect(previousWorkingDay('2027-05-03', h)).toBe('2027-04-29');
    expect(previousWorkingDay('2027-05-05', h)).toBe('2027-05-05');
    expect(nextWorkingDay('2027-04-30', h)).toBe('2027-05-04');
    expect(nextWorkingDay('2027-05-04', h)).toBe('2027-05-04');
  });

  it('rejects malformed dates', () => {
    expect(() => isWorkingDay('07/05/2027', h)).toThrow();
    expect(() => isWorkingDay('2027-02-30', h)).toThrow();
    expect(() => addWorkingDays('2027-13-01', 1, h)).toThrow();
  });
});

describe('R4 — offsets in working days', () => {
  const h = holidays(2026, 2027);
  const T = '2027-05-07'; // Friday

  it('spec acceptance: T = Fri 07/05/2027 → G4 05/05, G3 04/05, G2 29/04, G1 23/04, G0 latest 21/04', () => {
    expect(dayOfWeek(T)).toBe(5);
    expect(addWorkingDays(T, -1, h)).toBe('2027-05-06'); // upload day
    expect(addWorkingDays(T, -2, h)).toBe('2027-05-05'); // G4
    expect(addWorkingDays(T, -3, h)).toBe('2027-05-04'); // G3
    expect(addWorkingDays(T, -4, h)).toBe('2027-04-29'); // G2 — skips Easter Monday 03/05, the weekend, Good Friday 30/04
    expect(addWorkingDays(T, -5, h)).toBe('2027-04-28');
    expect(addWorkingDays(T, -8, h)).toBe('2027-04-23'); // G1
    expect(addWorkingDays(T, -10, h)).toBe('2027-04-21'); // G0 latest
    expect(addWorkingDays(T, -12, h)).toBe('2027-04-19');
  });

  it('1 May 2027 is a Saturday, so it removes no working day', () => {
    expect(dayOfWeek('2027-05-01')).toBe(6);
    const withoutMayDay = new Set([...h].filter((d) => d !== '2027-05-01'));
    for (const n of [-2, -3, -4, -8, -10]) expect(addWorkingDays(T, n, withoutMayDay)).toBe(addWorkingDays(T, n, h));
  });

  it('forward offsets: T0+n is the n-th working day after T0; anchor on another item (G0+2, G0+3)', () => {
    expect(addWorkingDays('2027-04-28', 3, h)).toBe('2027-05-05'); // Wed → Thu 29, [Fri hol, weekend, Mon hol], Tue 04, Wed 05
    expect(addWorkingDays('2027-04-21', 2, h)).toBe('2027-04-23');
    expect(addWorkingDays('2027-04-21', 3, h)).toBe('2027-04-26');
  });

  it('n = 0 returns the date itself; the start need not be a working day and is never counted', () => {
    expect(addWorkingDays('2027-05-08', 0, h)).toBe('2027-05-08');
    expect(addWorkingDays('2027-05-08', 1, h)).toBe('2027-05-10'); // Saturday → Monday
    expect(addWorkingDays('2027-05-08', -1, h)).toBe('2027-05-07'); // Saturday → Friday
    expect(addWorkingDays('2027-05-09', -1, h)).toBe('2027-05-07');
    expect(() => addWorkingDays(T, 1.5, h)).toThrow();
  });

  it('crosses year boundaries (Christmas / New Year / Epiphany)', () => {
    const hh = holidays(2026, 2027);
    expect(addWorkingDays('2026-12-24', 1, hh)).toBe('2026-12-28'); // Thu → 25, 26 holidays, Sun → Mon 28
    expect(addWorkingDays('2027-01-07', -1, hh)).toBe('2027-01-05'); // skips Epiphany
    expect(addWorkingDays('2027-01-04', -2, hh)).toBe('2026-12-30'); // skips 1 Jan and the weekend
  });

  it('workingDaysBetween counts (a, b] and is the inverse of addWorkingDays', () => {
    expect(workingDaysBetween('2027-04-21', T, h)).toBe(10);
    expect(workingDaysBetween('2027-04-23', T, h)).toBe(8);
    expect(workingDaysBetween(T, T, h)).toBe(0);
    expect(workingDaysBetween(T, '2027-04-21', h)).toBe(-10);
    expect(workingDaysBetween('2027-05-07', '2027-05-10', h)).toBe(1);
    expect(workingDaysBetween('2027-05-08', '2027-05-09', h)).toBe(0);
    for (const start of ['2027-03-10', '2027-04-27', '2027-05-01', '2026-12-23']) {
      for (const n of [-15, -7, -1, 0, 1, 4, 12, 15]) {
        const end = addWorkingDays(start, n, h);
        if (n !== 0) expect(isWorkingDay(end, h)).toBe(true);
        expect(workingDaysBetween(start, end, h), `${start} ${n}`).toBe(n);
      }
    }
  });

  it('R8 building block: 12 working days from T0 to T is below the compressed-mode threshold of 15', () => {
    const t0 = addWorkingDays(T, -12, h);
    expect(workingDaysBetween(t0, T, h)).toBe(12);
    expect(workingDaysBetween(t0, T, h) < 15).toBe(true);
    expect(addWorkingDays(T, -5, h)).toBe('2027-04-28'); // merged G1/G2 at T−5
  });
});

describe('R5 — offsets in calendar days', () => {
  const h = holidays(2027);

  it('spec acceptance: G4 (05/05/2027) − 10 calendar days = Sunday 25/04 → Friday 23/04', () => {
    expect(shiftDays('2027-05-05', -10)).toBe('2027-04-25');
    expect(dayOfWeek('2027-04-25')).toBe(0);
    expect(addCalendarDays('2027-05-05', -10, h)).toBe('2027-04-23');
    expect(applyOffset('2027-05-05', -10, 'calendar', h)).toBe('2027-04-23');
  });

  it('a result on a working day is kept; a holiday rolls back to the previous working day', () => {
    expect(addCalendarDays('2027-05-07', -2, h)).toBe('2027-05-05');
    expect(addCalendarDays('2027-05-07', -4, h)).toBe('2027-04-29'); // Mon 03/05 is Easter Monday → Thu 29/04
    expect(addCalendarDays('2027-05-07', -7, h)).toBe('2027-04-29'); // Good Friday → Thursday
    expect(addCalendarDays('2027-05-07', 0, h)).toBe('2027-05-07');
  });

  it('always rolls backwards, also for positive offsets', () => {
    expect(addCalendarDays('2027-05-07', 1, h)).toBe('2027-05-07'); // Saturday → Friday
    expect(addCalendarDays('2027-05-07', 3, h)).toBe('2027-05-10');
    expect(() => addCalendarDays('2027-05-07', 0.5, h)).toThrow();
  });
});

describe('applyOffset and plain date arithmetic', () => {
  const h = holidays(2027);
  it('dispatches on the unit, with signed values', () => {
    expect(applyOffset('2027-05-07', -8, 'working', h)).toBe('2027-04-23');
    expect(applyOffset('2027-04-21', 2, 'working', h)).toBe('2027-04-23');
    expect(applyOffset('2027-05-07', -8, 'calendar', h)).toBe('2027-04-29');
    expect(() => applyOffset('2027-05-07', 1, 'weeks' as never, h)).toThrow();
  });

  it('shiftDays / daysBetween handle month ends, leap years and DST days', () => {
    expect(shiftDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(shiftDays('2027-03-28', 1)).toBe('2027-03-29'); // EU DST switch
    expect(shiftDays('2027-10-31', 1)).toBe('2027-11-01');
    expect(shiftDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(daysBetween('2027-04-25', '2027-05-05')).toBe(10);
    expect(daysBetween('2027-05-05', '2027-04-25')).toBe(-10);
  });
});
