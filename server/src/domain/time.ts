// R3: timestamps are stored in UTC and shown in Europe/Athens as dd/mm/yyyy.

export const ATHENS = 'Europe/Athens';

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATHENS,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(ts: Date | string): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string> {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp "${String(ts)}"`);
  const out: Record<string, string> = {};
  for (const p of partsFormat.formatToParts(date)) out[p.type] = p.value;
  return out as ReturnType<typeof parts>;
}

/** Athens-local calendar date ('YYYY-MM-DD') of a UTC instant. T = athensDate(tender.submission_deadline_at). */
export function athensDate(tsUtc: Date | string): string {
  const p = parts(tsUtc);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Athens-local wall-clock time 'HH:mm' of a UTC instant. */
export function athensTime(tsUtc: Date | string): string {
  const p = parts(tsUtc);
  return `${p.hour}:${p.minute}`;
}

/** Today's date in Athens. */
export function todayAthens(now: Date = new Date()): string {
  return athensDate(now);
}

/** 'YYYY-MM-DD' → 'dd/mm/yyyy'. */
export function formatDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** UTC instant → 'dd/mm/yyyy HH:mm' in Athens. */
export function formatDateTime(tsUtc: Date | string): string {
  return `${formatDate(athensDate(tsUtc))} ${athensTime(tsUtc)}`;
}

/**
 * Athens wall-clock date + time → the UTC instant (DST-aware). E.g. ('2027-05-07', '15:00') → 12:00Z.
 * For the non-existent hour of the spring DST switch the result is the instant one hour later.
 */
export function athensToUtc(date: string, time = '00:00'): Date {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) throw new Error(`Invalid Athens date/time "${date} ${time}"`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  const offsetAt = (instant: number) => {
    const p = parts(new Date(instant));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - instant;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc);
}
