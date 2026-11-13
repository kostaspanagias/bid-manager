import { cx } from '@/lib/cx';
import { athensDate, formatDate, formatDateTime, isPureDate, weekdayShort } from '@/lib/dates';

export interface DateTextProps {
  /** 'YYYY-MM-DD' or ISO timestamp; null/'' renders the fallback */
  value: string | null | undefined;
  /** Append HH:mm (Athens) for timestamps. Ignored for pure dates. */
  withTime?: boolean;
  /** Prefix the short Greek weekday: «Παρ 07/05/2027» */
  withWeekday?: boolean;
  /** Shown when there is no value (default «—») */
  fallback?: string;
  className?: string;
}

/** Formats a date as dd/mm/yyyy [HH:mm] in Europe/Athens inside a <time> element. */
export function DateText({ value, withTime, withWeekday, fallback = '—', className }: DateTextProps) {
  if (!value) return <span className={cx('ui-date ui-date--empty', className)}>{fallback}</span>;
  const text = withTime && !isPureDate(value) ? formatDateTime(value) : formatDate(value);
  if (!text) return <span className={cx('ui-date ui-date--empty', className)}>{fallback}</span>;
  return (
    <time className={cx('ui-date', className)} dateTime={isPureDate(value) ? value : (athensDate(value) ?? undefined)}>
      {withWeekday && <span className="ui-date__wd">{weekdayShort(value)} </span>}
      {text}
    </time>
  );
}
