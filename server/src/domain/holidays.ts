import type { ScopedDb } from '../db/scoped.js';
import { greekHolidays, type HolidayDef } from './calendar.js';

export interface HolidayRow extends HolidayDef {
  id: string;
}

/** The org's holiday dates as a Set of 'YYYY-MM-DD' — the `holidays` argument of every calendar function. */
export async function loadHolidays(db: ScopedDb): Promise<Set<string>> {
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
