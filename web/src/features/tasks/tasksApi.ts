/**
 * Tasks, checklists and handoffs of a tender (server: server/src/modules/tasks/routes.ts).
 *
 *   GET    /api/tenders/:id/tasks?section=&status=&owner_user_id=&owner_role_key=&milestone_id=&overdue=&mine=
 *            → { items: TaskView[], roles: RoleView[], me: { role_keys, can_manage }, today }
 *   POST   /api/tenders/:id/tasks            { title, description?, section?, owner_user_id? | owner_role_key?, due_date?,
 *                                              milestone_id?, handoff_from_role?, handoff_to_role? } → TaskView
 *   PATCH  /api/tenders/:id/tasks/:taskId    any of the above (not section) + status → TaskView
 *   DELETE /api/tenders/:id/tasks/:taskId    → 204 (template checklist lines / handoffs: 422, use status `na`)
 *   POST   …/tasks/:taskId/deliver { note? } · /undo-deliver · /receive { note? } · /undo-receive → TaskView
 */
import { api } from '@/api/client';
import type { DateString, ID, MilestoneKind, TaskSection, TaskStatus, Timestamp } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export interface RoleView {
  key: string;
  name: string;
  user_ids: ID[];
}

export type HandoffState = 'pending' | 'delivered' | 'received';

export interface HandoffInfo {
  state: HandoffState;
  delivered_at: Timestamp | null;
  delivered_by: ID | null;
  delivery_note: string | null;
  receive_note: string | null;
  received_by_override: boolean;
  can_deliver: boolean;
  can_receive: boolean;
  /** bid manager / admin confirming for a role they do not hold: the server wants a note */
  receive_needs_note: boolean;
  can_undo_receive: boolean;
}

export interface TaskView {
  id: ID;
  tender_id: ID;
  milestone_id: ID | null;
  key: string | null;
  title: string;
  description: string | null;
  owner_user_id: ID | null;
  owner_role_key: string | null;
  due_date: DateString | null;
  status: TaskStatus;
  section: TaskSection;
  handoff_from_role: string | null;
  handoff_to_role: string | null;
  received_by: ID | null;
  received_at: Timestamp | null;
  done_at: Timestamp | null;
  sort: number;
  overdue: boolean;
  from_template: boolean;
  milestone: { id: ID; key: string; name: string; kind: MilestoneKind; due_date: DateString | null; done_at: Timestamp | null } | null;
  handoff: HandoffInfo | null;
}

export interface TaskList {
  items: TaskView[];
  roles: RoleView[];
  me: { role_keys: string[]; can_manage: boolean };
  today: DateString;
}

export interface TaskInput {
  title?: string;
  description?: string | null;
  section?: TaskSection;
  owner_user_id?: ID | null;
  owner_role_key?: string | null;
  due_date?: DateString | null;
  milestone_id?: ID | null;
  handoff_from_role?: string | null;
  handoff_to_role?: string | null;
  status?: TaskStatus;
}

export type HandoffAction = 'deliver' | 'undo-deliver' | 'receive' | 'undo-receive';

export const tasksKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'tasks'] as const };

export const listTasks = (tenderId: ID) => api.get<TaskList>(`/tenders/${tenderId}/tasks`);
export const createTask = (tenderId: ID, body: TaskInput) => api.post<TaskView>(`/tenders/${tenderId}/tasks`, body);
export const updateTask = (tenderId: ID, taskId: ID, body: TaskInput) => api.patch<TaskView>(`/tenders/${tenderId}/tasks/${taskId}`, body);
export const deleteTask = (tenderId: ID, taskId: ID) => api.del(`/tenders/${tenderId}/tasks/${taskId}`);
export const handoffAction = (tenderId: ID, taskId: ID, action: HandoffAction, note?: string) =>
  api.post<TaskView>(`/tenders/${tenderId}/tasks/${taskId}/${action}`, note ? { note } : {});
