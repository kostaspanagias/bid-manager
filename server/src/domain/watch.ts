// R6: last day a watch item can be requested = date it is needed − lead time.
import { applyOffset, type Holidays, type OffsetUnit } from './calendar.js';

export interface WatchTiming {
  needed_at: string | null;
  lead_value: number | null;
  lead_unit: OffsetUnit | null;
  requested_at: string | null;
  arrived_at: string | null;
}

/** null when the item has no needed date or an open-ended lead time. */
export function lastRequestDate(item: WatchTiming, holidays: Holidays): string | null {
  if (!item.needed_at || item.lead_value == null) return null;
  return applyOffset(item.needed_at, -Math.abs(item.lead_value), item.lead_unit ?? 'working', holidays);
}

/** R6 red warning: the last request day has passed and nothing was requested. */
export function requestOverdue(item: WatchTiming, today: string, holidays: Holidays): boolean {
  if (item.requested_at || item.arrived_at) return false;
  const last = lastRequestDate(item, holidays);
  return last != null && last < today;
}
