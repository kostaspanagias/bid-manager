/**
 * Watchlist of a tender (server: server/src/modules/watch/routes.ts).
 *
 *   GET    /api/tenders/:id/watch            → { items: WatchView[], roles, milestones: [{key,name,kind,due_date}], today, can_manage }
 *   POST   /api/tenders/:id/watch            { name, owner_user_id? | owner_role_key?, lead_value?, lead_unit?, needed_at? |
 *                                              needed_milestone_key?, requested_at?, expected_at?, arrived_at?, checks?, notes? }
 *   PATCH  /api/tenders/:id/watch/:itemId    any of the above → WatchView (+ expected_proposed)
 *   DELETE /api/tenders/:id/watch/:itemId    → 204 (template items: bid manager / admin only)
 *
 * Computed by the server (R6): last_request_date, request_overdue (red), state, arrives_after_needed (orange).
 * Setting requested_at without expected_at makes the server propose expected_at = requested + lead time.
 */
import { api } from '@/api/client';
import type { DateString, ID, MilestoneKind, OffsetUnit } from '@/api/types';
import type { RoleView } from '@/features/tasks/tasksApi';
import { tenderKeys } from '@/features/tenders/tenderApi';

export type WatchState = 'not_requested' | 'requested' | 'late' | 'arrived';

export interface WatchView {
  id: ID;
  tender_id: ID;
  key: string | null;
  name: string;
  owner_user_id: ID | null;
  owner_role_key: string | null;
  /** null = open-ended («Ανοιχτό») */
  lead_value: number | null;
  lead_unit: OffsetUnit | null;
  needed_at: DateString | null;
  needed_milestone_key: string | null;
  needed_milestone_name: string | null;
  requested_at: DateString | null;
  expected_at: DateString | null;
  arrived_at: DateString | null;
  checks: string | null;
  notes: string | null;
  from_template: boolean;
  last_request_date: DateString | null;
  request_overdue: boolean;
  state: WatchState;
  arrives_after_needed: boolean;
  expected_proposed?: boolean;
}

export interface WatchList {
  items: WatchView[];
  roles: RoleView[];
  milestones: Array<{ key: string; name: string; kind: MilestoneKind; due_date: DateString | null }>;
  today: DateString;
  can_manage: boolean;
}

export type WatchInput = Partial<
  Pick<
    WatchView,
    'name' | 'owner_user_id' | 'owner_role_key' | 'lead_value' | 'lead_unit' | 'needed_at' | 'needed_milestone_key' | 'requested_at' | 'expected_at' | 'arrived_at' | 'checks' | 'notes'
  >
>;

export const watchKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'watch'] as const };

export const listWatch = (tenderId: ID) => api.get<WatchList>(`/tenders/${tenderId}/watch`);
export const createWatch = (tenderId: ID, body: WatchInput) => api.post<WatchView>(`/tenders/${tenderId}/watch`, body);
export const updateWatch = (tenderId: ID, itemId: ID, body: WatchInput) => api.patch<WatchView>(`/tenders/${tenderId}/watch/${itemId}`, body);
export const deleteWatch = (tenderId: ID, itemId: ID) => api.del(`/tenders/${tenderId}/watch/${itemId}`);
