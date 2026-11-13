/**
 * Schedule API (server/src/modules/milestones/routes.ts) — the dates themselves are computed by the server (R4–R10).
 *
 *   GET   /api/tenders/:id/milestones                       → ScheduleResponse (ordered by date)
 *   PATCH /api/tenders/:id/milestones/:mid {due_date?, done?, needs_review?: false} → ScheduleResponse
 *   POST  /api/tenders/:id/milestones/:mid/reset            → ScheduleResponse (back to the computed date)
 *
 * The deadline-change flow (preview + confirm) lives in features/tenders/tenderApi.ts.
 */
import { api } from '@/api/client';
import type { DateString, GateDecision, ID, MilestoneKind, OffsetUnit, TaskStatus, Timestamp } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export const scheduleKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'milestones'] as const };

export interface OffsetSpec {
  anchor: string;
  offset_value: number;
  offset_unit: OffsetUnit;
}
export interface ComputedFrom extends OffsetSpec {
  target?: OffsetSpec;
  warn_if_target_after?: OffsetSpec;
  compressed?: OffsetSpec;
  rule?: 'offset' | 'target' | 'latest' | 'compressed';
  latest_date?: DateString | null;
  target_date?: DateString | null;
}

export interface ScheduleMilestone {
  id: ID;
  tender_id: ID;
  key: string;
  name: string;
  kind: MilestoneKind;
  due_date: DateString | null;
  computed_from: ComputedFrom | null;
  /** where the rules put it now (differs from due_date only for manual / done milestones) */
  computed_date: DateString | null;
  is_manual: boolean;
  needs_review: boolean;
  done_at: Timestamp | null;
  /** done_at, a decided gate or a received handoff */
  done: boolean;
  sort: number;
  /** working days from the milestone to T (the n of T−n) */
  tMinus: number | null;
  is_working_day: boolean | null;
  overdue: boolean;
  gate: { id: ID; decision: GateDecision } | null;
  handoff: { task_id: ID; status: TaskStatus; received_at: Timestamp | null; from_role: string | null; to_role: string | null } | null;
}

export interface ScheduleResponse {
  items: ScheduleMilestone[];
  T: DateString;
  T0: DateString | null;
  today: DateString;
  tMinus: number;
  compressed_mode: boolean;
}

export const fetchSchedule = (tenderId: ID) => api.get<ScheduleResponse>(`/tenders/${tenderId}/milestones`);

export const patchMilestone = (tenderId: ID, milestoneId: ID, body: { due_date?: DateString; done?: boolean; needs_review?: false }) =>
  api.patch<ScheduleResponse>(`/tenders/${tenderId}/milestones/${milestoneId}`, body);

export const resetMilestone = (tenderId: ID, milestoneId: ID) => api.post<ScheduleResponse>(`/tenders/${tenderId}/milestones/${milestoneId}/reset`);

/** {anchor:'T', offset_value:-8} → «T−8»; {anchor:'G0', 2} → «G0+2»; 0 → the anchor itself. */
export function formatOffset(spec: OffsetSpec, calendarSuffix: string): string {
  const n = spec.offset_value;
  const base = n === 0 ? spec.anchor : `${spec.anchor}${n > 0 ? '+' : '−'}${Math.abs(n)}`;
  return spec.offset_unit === 'calendar' && n !== 0 ? `${base} ${calendarSuffix}` : base;
}
