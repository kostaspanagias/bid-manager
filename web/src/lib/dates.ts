/**
 * Date helpers (spec R3): the API speaks UTC timestamps (ISO strings) and pure dates ('YYYY-MM-DD').
 * The UI shows everything in Europe/Athens as dd/mm/yyyy [HH:mm].
 *
 * Pure dates are handled as strings end-to-end — never `new Date('YYYY-MM-DD')` in feature code,
 * because that silently applies the browser's time zone.
 */

export const ATHENS_TZ = 'Europe/Athens';

/** 'YYYY-MM-DD' */
export type DateString = string;
/** ISO-8601 timestamp, e.g. '2027-05-07T09:00:00.000Z' */
export type Timestamp = string;

const PURE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS_SHORT = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'] as const;

const athensPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATHENS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function athensParts(d: Date): Parts {
  const out: Record<string, number> = {};
  for (const p of athensPartsFmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as unknown as Parts;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function isPureDate(value: string): boolean {
  return PURE_DATE_RE.test(value);
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Athens-local calendar date of a timestamp (or the date itself if already pure). */
export function athensDate(value: string | Date | null | undefined): DateString | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && isPureDate(value)) return value;
  const d = toDate(value);
  if (!d) return null;
  const p = athensParts(d);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today in Athens as 'YYYY-MM-DD'. */
export function todayAthens(): DateString {
  return athensDate(new Date()) as DateString;
}

/** 'YYYY-MM-DD' or timestamp → 'dd/mm/yyyy' (Athens). Returns '' for empty/invalid input. */
export function formatDate(value: string | Date | null | undefined): string {
  const iso = athensDate(value);
  if (!iso) return '';
  const m = PURE_DATE_RE.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Athens wall-clock time 'HH:mm' of a timestamp. '' for pure dates. */
export function formatTime(value: string | Date | null | undefined): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && isPureDate(value)) return '';
  const d = toDate(value);
  if (!d) return '';
  const p = athensParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Timestamp → 'dd/mm/yyyy HH:mm' (Athens). Pure dates format as the date only. */
export function formatDateTime(value: string | Date | null | undefined): string {
  const date = formatDate(value);
  const time = formatTime(value);
  return time ? `${date} ${time}` : date;
}

/** Short Greek weekday ('Παρ') of a date / timestamp (Athens). */
export function weekdayShort(value: string | Date | null | undefined): string {
  const iso = athensDate(value);
  return iso ? WEEKDAYS_SHORT[weekday(iso)]! : '';
}

/** 'dd/mm/yyyy' (also d/m/yyyy, dots or dashes) → 'YYYY-MM-DD'; null if not a real date. */
export function parseDisplayDate(text: string): DateString | null {
  const m = /^\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\s*$/.exec(text);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  return isValidDate(iso) ? iso : null;
}

export function isValidDate(value: string): boolean {
  const m = PURE_DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/* ---- Pure-date arithmetic (UTC-based, so DST never interferes) ---- */

function dateToUtcMs(date: DateString): number {
  const m = PURE_DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function utcMsToDate(ms: number): DateString {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

export function addDays(date: DateString, n: number): DateString {
  return utcMsToDate(dateToUtcMs(date) + n * DAY_MS);
}

/** b − a in calendar days (positive when b is later). */
export function diffCalendarDays(a: DateString, b: DateString): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / DAY_MS);
}

/** -1 / 0 / 1 — 'YYYY-MM-DD' strings also compare correctly with < and >. */
export function compareDates(a: DateString, b: DateString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: DateString): number {
  return new Date(dateToUtcMs(date)).getUTCDay();
}

export function isWeekend(date: DateString): boolean {
  const wd = weekday(date);
  return wd === 0 || wd === 6;
}

/** R1: Monday–Friday and not in the holiday set. */
export function isWorkingDay(date: DateString, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

/**
 * Signed count of working days d with from ≤ d < to (negative when `to` is before `from`).
 * With `to = T` this is the n of "T−n": T−1 is the last working day before T, T itself is 0.
 * The server's scheduler is the source of truth; this is only for display of "days left".
 */
export function workingDaysBetween(from: DateString, to: DateString, holidays: ReadonlySet<string>): number {
  if (from === to) return 0;
  if (from > to) return -workingDaysBetween(to, from, holidays);
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    if (isWorkingDay(d, holidays)) n++;
  }
  return n;
}

/** n → 'T−n' (true minus sign), 0 → 'T', negative n (deadline passed) → 'T+n'. */
export function formatTMinus(n: number): string {
  if (n === 0) return 'T';
  return n > 0 ? `T−${n}` : `T+${-n}`;
}

/* ---- datetime-local <-> UTC ISO, interpreting the wall clock as Athens time ---- */

/** Offset (ms) of Athens from UTC at the given instant. */
function athensOffsetMs(instant: Date): number {
  const p = athensParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** UTC timestamp → 'YYYY-MM-DDTHH:mm' Athens wall clock (the value format of <input type="datetime-local">). */
export function isoToAthensLocal(value: string | null | undefined): string {
  if (!value) return '';
  const d = toDate(value);
  if (!d) return '';
  const p = athensParts(d);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** 'YYYY-MM-DDTHH:mm' Athens wall clock → UTC ISO timestamp; null if empty/invalid. */
export function athensLocalToIso(local: string | null | undefined): Timestamp | null {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes handle the DST boundaries.
  let utc = wall - athensOffsetMs(new Date(wall));
  utc = wall - athensOffsetMs(new Date(utc));
  return new Date(utc).toISOString();
}

/** Athens date + 'HH:mm' → UTC ISO timestamp. */
export function athensDateTimeToIso(date: DateString, time = '00:00'): Timestamp | null {
  return athensLocalToIso(`${date}T${time}`);
}
