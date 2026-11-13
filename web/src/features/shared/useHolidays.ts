import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { todayAthens, workingDaysBetween, type DateString } from '@/lib/dates';
import { fetchHolidays, holidaysKeys } from './holidaysApi';

/**
 * Set of holiday dates ('YYYY-MM-DD') for the given years, for client-side working-day display maths.
 * `ready` is false until every year has loaded (or failed — then weekends only are used).
 */
export function useHolidaySet(years: ReadonlyArray<number>): { holidays: ReadonlySet<string>; ready: boolean } {
  const results = useQueries({
    queries: years.map((year) => ({
      queryKey: holidaysKeys.year(year),
      queryFn: () => fetchHolidays(year),
      staleTime: 60 * 60_000,
    })),
  });
  const ready = results.every((r) => r.isSuccess || r.isError);
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  const holidays = useMemo(() => {
    const set = new Set<string>();
    for (const r of results) for (const h of r.data ?? []) set.add(h.date);
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  return { holidays, ready };
}

/**
 * Working days from today (Athens) to `date` — the n of "T−n" when `date` is T.
 * Negative when the date has passed; null while holidays load or when no date is given.
 */
export function useWorkingDaysTo(date: DateString | null | undefined): number | null {
  const today = todayAthens();
  const fromYear = Number((date && date < today ? date : today).slice(0, 4));
  const toYear = Number((date && date > today ? date : today).slice(0, 4));
  const years: number[] = [];
  for (let y = fromYear; y <= Math.min(toYear, fromYear + 3); y++) years.push(y);
  const { holidays, ready } = useHolidaySet(date ? years : []);
  if (!date || !ready) return null;
  return workingDaysBetween(today, date, holidays);
}
