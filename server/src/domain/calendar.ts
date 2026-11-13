// Greek working-day calendar (R1, R2, R4, R5). Pure functions over 'YYYY-MM-DD' strings — no JS Date leaves
// this module, no time zones involved.

export type OffsetUnit = 'working' | 'calendar';
export type HolidaySource = 'national' | 'movable' | 'manual';
export interface HolidayDef {
  date: string;
  name: string;
  source: HolidaySource;
}
/** Set of 'YYYY-MM-DD' holiday dates (see holidays.ts → loadHolidays). */
export type Holidays = ReadonlySet<string>;

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtc(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (fromUtc(ms) !== date) throw new Error(`Invalid date "${date}"`);
  return ms;
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function ymd(year: number, month: number, day: number): string {
  return fromUtc(Date.UTC(year, month - 1, day));
}

/** Plain calendar arithmetic, no working-day adjustment. */
export function shiftDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}

/** Calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** R2: Orthodox Easter Sunday as a Gregorian date — Meeus' Julian algorithm + 13 days (valid 1900–2099). */
export function orthodoxEaster(year: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 2099) throw new Error(`orthodoxEaster: year ${year} out of range (1900–2099)`);
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return shiftDays(ymd(year, month, day), 13);
}

/**
 * R2: the Greek public holidays of a year — 8 fixed dates plus 4 movable ones from Orthodox Easter (Π):
 * Clean Monday (Π−48), Good Friday (Π−2), Easter Monday (Π+1), Whit Monday (Π+50). Sorted by date; when a movable
 * holiday falls on a fixed one (e.g. Good Friday on 1 May) only the fixed entry is kept.
 */
export function greekHolidays(year: number): HolidayDef[] {
  const easter = orthodoxEaster(year);
  const all: HolidayDef[] = [
    { date: ymd(year, 1, 1), name: 'Πρωτοχρονιά', source: 'national' },
    { date: ymd(year, 1, 6), name: 'Θεοφάνεια', source: 'national' },
    { date: ymd(year, 3, 25), name: 'Ευαγγελισμός της Θεοτόκου / Εθνική εορτή', source: 'national' },
    { date: ymd(year, 5, 1), name: 'Πρωτομαγιά', source: 'national' },
    { date: ymd(year, 8, 15), name: 'Κοίμηση της Θεοτόκου', source: 'national' },
    { date: ymd(year, 10, 28), name: 'Εθνική εορτή (Επέτειος του Όχι)', source: 'national' },
    { date: ymd(year, 12, 25), name: 'Χριστούγεννα', source: 'national' },
    { date: ymd(year, 12, 26), name: 'Σύναξη της Θεοτόκου', source: 'national' },
    { date: shiftDays(easter, -48), name: 'Καθαρά Δευτέρα', source: 'movable' },
    { date: shiftDays(easter, -2), name: 'Μεγάλη Παρασκευή', source: 'movable' },
    { date: shiftDays(easter, 1), name: 'Δευτέρα του Πάσχα', source: 'movable' },
    { date: shiftDays(easter, 50), name: 'Αγίου Πνεύματος', source: 'movable' },
  ];
  const byDate = new Map<string, HolidayDef>();
  for (const h of all) if (!byDate.has(h.date)) byDate.set(h.date, h);
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

/** R1: Monday–Friday and not a holiday. */
export function isWorkingDay(date: string, holidays: Holidays): boolean {
  const dow = dayOfWeek(date);
  return dow !== 0 && dow !== 6 && !holidays.has(date);
}

/** The date itself when it is a working day, otherwise the closest earlier working day. */
export function previousWorkingDay(date: string, holidays: Holidays): string {
  let d = date;
  while (!isWorkingDay(d, holidays)) d = shiftDays(d, -1);
  return d;
}

/** The date itself when it is a working day, otherwise the closest later working day. */
export function nextWorkingDay(date: string, holidays: Holidays): string {
  let d = date;
  while (!isWorkingDay(d, holidays)) d = shiftDays(d, 1);
  return d;
}

/**
 * R4: the n-th working day after (n > 0) or before (n < 0) `date`. The start date itself is never counted and
 * need not be a working day. n = 0 returns `date` unchanged.
 */
export function addWorkingDays(date: string, n: number, holidays: Holidays): string {
  if (!Number.isInteger(n)) throw new Error('addWorkingDays: n must be an integer');
  toUtc(date);
  const step = n < 0 ? -1 : 1;
  let d = date;
  for (let left = Math.abs(n); left > 0; ) {
    d = shiftDays(d, step);
    if (isWorkingDay(d, holidays)) left--;
  }
  return d;
}

/**
 * R5: shift by n calendar days (signed); when the result is not a working day, go to the PREVIOUS working day
 * (always backwards — a lead time must never be shortened).
 */
export function addCalendarDays(date: string, n: number, holidays: Holidays): string {
  if (!Number.isInteger(n)) throw new Error('addCalendarDays: n must be an integer');
  return previousWorkingDay(shiftDays(date, n), holidays);
}

/**
 * Working days in the interval (a, b]: a itself is not counted, b is. Negative when b < a.
 * Inverse of addWorkingDays: workingDaysBetween(d, addWorkingDays(d, n, h), h) === n. Used by R8.
 */
export function workingDaysBetween(a: string, b: string, holidays: Holidays): number {
  const diff = daysBetween(a, b);
  if (diff < 0) return -workingDaysBetween(b, a, holidays);
  let count = 0;
  let d = a;
  for (let i = 0; i < diff; i++) {
    d = shiftDays(d, 1);
    if (isWorkingDay(d, holidays)) count++;
  }
  return count;
}

/**
 * One scheduler offset (signed): `applyOffset('2027-05-07', -8, 'working', h)` = T−8;
 * `applyOffset(g4, -10, 'calendar', h)` = G4 − 10 calendar days, rolled back to a working day (R5/R6).
 */
export function applyOffset(anchorDate: string, value: number, unit: OffsetUnit, holidays: Holidays): string {
  if (unit === 'working') return addWorkingDays(anchorDate, value, holidays);
  if (unit === 'calendar') return addCalendarDays(anchorDate, value, holidays);
  throw new Error(`applyOffset: unknown unit "${String(unit)}"`);
}
