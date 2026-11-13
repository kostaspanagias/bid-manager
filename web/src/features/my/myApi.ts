/**
 * «Τα δικά μου» (server: server/src/modules/my/routes.ts).
 *
 *   GET /api/my → { today, horizon, counts: { overdue, today, soon, later, total }, groups: { overdue, today, soon, later: MyItem[] } }
 *
 * Across the active tenders the user can reach: tasks / checklist lines owned by name or through a tender role,
 * handoffs to deliver or waiting for the user's receipt, watch items they own, gates they approve (decision pending).
 * soon = the next 3 working days (org holidays); later also holds undated items.
 */
import { api } from '@/api/client';
import type { DateString, ID } from '@/api/types';

export type MyBucket = 'overdue' | 'today' | 'soon' | 'later';
export const MY_BUCKETS: ReadonlyArray<MyBucket> = ['overdue', 'today', 'soon', 'later'];
export type MyKind = 'task' | 'checklist' | 'handoff_deliver' | 'handoff_receive' | 'watch' | 'gate';

export interface MyItem {
  kind: MyKind;
  id: ID;
  tender_id: ID;
  tender_title: string;
  tab: 'tasks' | 'watch' | 'gates';
  title: string;
  date: DateString | null;
  bucket: MyBucket;
  status: string;
  via: 'user' | 'role';
  role_key: string | null;
  info: {
    from_role?: string | null;
    to_role?: string | null;
    delivered?: boolean;
    state?: string;
    request_overdue?: boolean;
    last_request_date?: DateString | null;
    needed_at?: DateString | null;
    requested_at?: DateString | null;
    gate_key?: string | null;
    requested?: boolean;
    [key: string]: unknown;
  };
}

export interface MyWork {
  today: DateString;
  horizon: DateString;
  counts: Record<MyBucket | 'total', number>;
  groups: Record<MyBucket, MyItem[]>;
}

export const myKeys = { all: ['my'] as const };
export const fetchMyWork = () => api.get<MyWork>('/my');
