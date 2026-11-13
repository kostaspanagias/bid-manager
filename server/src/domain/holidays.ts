import type { ScopedDb } from '../db/scoped.js';
import { greekHolidays, type HolidayDef } from './calendar.js';
import { athensDate, todayAthens } from './time.js';

export interface HolidayRow extends HolidayDef {
  id: string;
}

/** Auto-seeding never reaches further than this from the current year (a typo in a deadline must not seed centuries). */
const MAX_YEARS_BACK = 5;
const MAX_YEARS_AHEAD = 15;

/**
 * Guarantees that every year the org's schedules can touch has its Greek holidays (R2): from the earliest
 * publication date (or today) to the year after the latest submission deadline, plus the years of `dates`
 * (a prospective deadline that is not stored yet). A year counts as present when it has at least one national or
 * movable row, so holidays the admin removed or moved are never put back. Idempotent and safe under concurrency
 * (INSERT … ON CONFLICT DO NOTHING). Without this, working-day arithmetic over an unseeded year silently treats
 * Easter Monday, 25/3, 15/8 … as working days and every gate date is wrong.
 */
export async function ensureHolidayYears(db: ScopedDb, dates: readonly (string | null | undefined)[] = []): Promise<number[]> {
  const thisYear = Number(todayAthens().slice(0, 4));
  const [range] = await db.sql<{ lo: Date | null; hi: Date | null }>(
    'SELECT min(LEAST(t0_published_at, submission_deadline_at)) AS lo, max(submission_deadline_at) AS hi FROM tender WHERE org_id = :org_id',
  );
  const years = [thisYear, ...dates.filter((d): d is string => typeof d === 'string' && /^\d{4}-/.test(d)).map((d) => Number(d.slice(0, 4)))];
  if (range?.lo) years.push(Number(athensDate(range.lo).slice(0, 4)));
  if (range?.hi) years.push(Number(athensDate(range.hi).slice(0, 4)));
  const from = Math.max(Math.min(...years), thisYear - MAX_YEARS_BACK);
  const to = Math.min(Math.max(...years) + 1, thisYear + MAX_YEARS_AHEAD);
  const present = new Set(
    (
      await db.sql<{ y: number }>(
        `SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM holiday
          WHERE org_id = :org_id AND source IN ('national', 'movable') AND date >= :lo AND date <= :hi`,
        { lo: `${from}-01-01`, hi: `${to}-12-31` },
      )
    ).map((r) => r.y),
  );
  const seeded: number[] = [];
  for (let year = from; year <= to; year++) {
    if (present.has(year)) continue;
    const defs = greekHolidays(year);
    const added = await db.sql<{ id: string }>(
      `INSERT INTO holiday (org_id, date, name, source)
       SELECT :org_id, d.date, d.name, d.source
         FROM jsonb_to_recordset(CAST(:defs AS jsonb)) AS d(date date, name text, source text)
       ON CONFLICT (org_id, date) DO NOTHING
       RETURNING id`,
      { defs: JSON.stringify(defs) },
    );
    await db.audit('holiday', null, 'auto_seed', { after: { year, added: added.length } });
    seeded.push(year);
  }
  return seeded;
}

/**
 * The org's holiday dates as a Set of 'YYYY-MM-DD' — the `holidays` argument of every calendar function.
 * Always goes through ensureHolidayYears(), so no schedule is ever computed over a year without holidays;
 * pass `dates` for dates that are not stored on a tender yet (e.g. the new deadline of an extension preview).
 */
export async function loadHolidays(db: ScopedDb, dates: readonly (string | null | undefined)[] = []): Promise<Set<string>> {
  await ensureHolidayYears(db, dates);
  const rows = await db.sql<{ date: string }>('SELECT date FROM holiday WHERE org_id = :org_id');
  return new Set(rows.map((r) => r.date));
}

/**
 * R2 seed: inserts the Greek holidays of `year` that are not in the table yet. Idempotent, and it never touches
 * existing rows — a date the admin already has (moved, renamed, manual) is left alone. Returns the rows added.
 */
export async function seedHolidaysForYear(db: ScopedDb, year: number): Promise<HolidayRow[]> {
  return db.tx(async (tx) => {
    const defs = greekHolidays(year);
    const existing = await tx.list<{ date: string }>('holiday', { date: defs.map((d) => d.date) });
    const have = new Set(existing.map((r) => r.date));
    return tx.insertMany<HolidayRow>(
      'holiday',
      defs.filter((d) => !have.has(d.date)),
    );
  });
}
