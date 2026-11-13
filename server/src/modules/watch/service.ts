// Watchlist view logic (R6). Shared with /api/my.
import type { Row } from '../../db/scoped.js';
import { addWorkingDays, nextWorkingDay, shiftDays, type Holidays, type OffsetUnit } from '../../domain/calendar.js';
import { lastRequestDate, requestOverdue } from '../../domain/watch.js';

export type WatchState = 'not_requested' | 'requested' | 'late' | 'arrived';

/**
 * Expected arrival proposed when an item is requested: requested + lead time, counted forward.
 * Working days per R4; calendar days land on the next working day when they fall on a non-working one
 * (the forward mirror of R5 — an arrival is never promised earlier than the lead time).
 */
export function proposeExpected(requestedAt: string, leadValue: number | null, leadUnit: OffsetUnit | null, holidays: Holidays): string | null {
  if (leadValue == null) return null;
  if ((leadUnit ?? 'working') === 'working') return addWorkingDays(requestedAt, leadValue, holidays);
  return nextWorkingDay(shiftDays(requestedAt, leadValue), holidays);
}

/** The date an item is needed: its milestone's current date when it is tied to one, else the stored date. */
export function effectiveNeededAt(item: Row, milestonesByKey: Map<string, Row>): string | null {
  const m = item.needed_milestone_key ? milestonesByKey.get(item.needed_milestone_key) : undefined;
  return (m?.due_date as string | null | undefined) ?? (item.needed_at as string | null) ?? null;
}

export function watchState(item: { requested_at: string | null; expected_at: string | null; arrived_at: string | null }, today: string): WatchState {
  if (item.arrived_at) return 'arrived';
  if (!item.requested_at) return 'not_requested';
  return item.expected_at && item.expected_at < today ? 'late' : 'requested';
}

export function watchView(item: Row, milestonesByKey: Map<string, Row>, holidays: Holidays, today: string) {
  const needed_at = effectiveNeededAt(item, milestonesByKey);
  const timing = {
    needed_at,
    lead_value: item.lead_value as number | null,
    lead_unit: item.lead_unit as OffsetUnit | null,
    requested_at: item.requested_at as string | null,
    arrived_at: item.arrived_at as string | null,
  };
  const m = item.needed_milestone_key ? milestonesByKey.get(item.needed_milestone_key) : undefined;
  const expected_at = item.expected_at as string | null;
  return {
    id: item.id,
    tender_id: item.tender_id,
    key: item.key,
    name: item.name,
    owner_user_id: item.owner_user_id,
    owner_role_key: item.owner_role_key,
    lead_value: item.lead_value,
    lead_unit: item.lead_unit,
    needed_at,
    needed_milestone_key: item.needed_milestone_key,
    needed_milestone_name: (m?.name as string | undefined) ?? null,
    requested_at: item.requested_at,
    expected_at,
    arrived_at: item.arrived_at,
    checks: item.checks,
    notes: item.notes,
    sort: item.sort,
    from_template: item.key != null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    /** R6: needed date − lead time; null for an open lead time or no needed date */
    last_request_date: lastRequestDate(timing, holidays),
    /** R6 red warning */
    request_overdue: requestOverdue(timing, today, holidays),
    state: watchState({ requested_at: timing.requested_at, expected_at, arrived_at: timing.arrived_at }, today),
    /** orange: expected (or actual) arrival is after the date the item is needed */
    arrives_after_needed: !!needed_at && ((item.arrived_at ?? expected_at) as string | null) != null && ((item.arrived_at ?? expected_at) as string) > needed_at,
  };
}
