/**
 * Decision gates G0–G4 (F4) — server/src/modules/gates/routes.ts
 *
 *   GET    /api/tenders/:tenderId/gates                                → { items: Gate[] } (date order)
 *   GET    /api/tenders/:tenderId/gates/:gateId                        → Gate
 *   PATCH  /api/tenders/:tenderId/gates/:gateId  { approver_user_id }  → Gate   (bid_manager / admin)
 *   PATCH  /api/tenders/:tenderId/gates/:gateId/criteria/:criterionId  { checked?, note? } → Gate
 *   POST   /api/tenders/:tenderId/gates/:gateId/request                → Gate
 *   POST   /api/tenders/:tenderId/gates/:gateId/decision  { decision, justification? }
 *                                                                      → { gate, tender_status, cancelled_tasks }
 *   POST   /api/tenders/:tenderId/gates/:gateId/reopen    { reason }   → Gate   (bid_manager / admin)
 *
 * 422 codes: criteria_unmet, justification_too_short, decision_not_allowed, criterion_not_manual, gate_no_approver,
 * approver_invalid, approver_not_member, approver_is_viewer · 409: gate_already_decided, gate_not_decided,
 * tender_closed, no_go_final · 403: not_gate_approver, approver_change_forbidden, reopen_forbidden.
 */
import { api, type ListResponse } from '@/api/client';
import type { AutoRule, DateString, GateDecision, ID, TenderStatus, Timestamp } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export const MIN_JUSTIFICATION = 20;

/** Why an automatic criterion is (not) satisfied; `code` is translated under gates:detail.<code>. */
export interface RuleDetail {
  code: string;
  message: string;
  total: number;
  missing: number;
  /** a few codes / names of what is missing */
  items: string[];
}

export interface GateCriterionView {
  id: ID;
  key: string | null;
  text: string;
  type: 'manual' | 'auto';
  auto_rule: AutoRule | null;
  sort: number;
  satisfied: boolean;
  detail: RuleDetail | null;
  checked_by: ID | null;
  checked_at: Timestamp | null;
  note: string | null;
}

export interface GateSnapshot {
  at: Timestamp;
  met: number;
  total: number;
  criteria: GateCriterionView[];
}

export interface GateHistoryEntry {
  decision: GateDecision;
  justification: string | null;
  exception: boolean;
  decided_by: ID | null;
  decided_at: Timestamp | null;
  reopened_by: ID | null;
  reopened_at: Timestamp;
  reason: string;
}

export interface GateView {
  id: ID;
  tender_id: ID;
  milestone_id: ID;
  key: string | null;
  name: string;
  due_date: DateString | null;
  /** n of «T−n» for the gate's own date */
  t_minus: number | null;
  decision_mode: 'approval' | 'go_no_go';
  approver_user_id: ID | null;
  approver_role_key: string | null;
  approver: { id: ID; name: string; active: boolean } | null;
  decision: GateDecision;
  justification: string | null;
  exception: boolean;
  decided_by: ID | null;
  decided_at: Timestamp | null;
  requested_at: Timestamp | null;
  requested_by: ID | null;
  criteria: GateCriterionView[];
  progress: { met: number; total: number };
  all_met: boolean;
  snapshot: GateSnapshot | null;
  history: GateHistoryEntry[];
  allowed_decisions: GateDecision[];
  permissions: { can_check: boolean; can_request: boolean; can_change_approver: boolean; can_decide: boolean; can_reopen: boolean };
}

export interface DecisionResponse {
  gate: GateView;
  tender_status: TenderStatus;
  cancelled_tasks: number;
}

export const gatesKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'gates'] as const };

const base = (tenderId: ID) => `/tenders/${tenderId}/gates`;

export const listGates = (tenderId: ID) => api.get<ListResponse<GateView>>(base(tenderId)).then((r) => r.items);

export const setApprover = (tenderId: ID, gateId: ID, approverUserId: ID | null) =>
  api.patch<GateView>(`${base(tenderId)}/${gateId}`, { approver_user_id: approverUserId });

export const setCriterion = (tenderId: ID, gateId: ID, criterionId: ID, body: { checked?: boolean; note?: string | null }) =>
  api.patch<GateView>(`${base(tenderId)}/${gateId}/criteria/${criterionId}`, body);

export const requestApproval = (tenderId: ID, gateId: ID) => api.post<GateView>(`${base(tenderId)}/${gateId}/request`);

export const decideGate = (tenderId: ID, gateId: ID, body: { decision: GateDecision; justification?: string | null }) =>
  api.post<DecisionResponse>(`${base(tenderId)}/${gateId}/decision`, body);

export const reopenGate = (tenderId: ID, gateId: ID, reason: string) => api.post<GateView>(`${base(tenderId)}/${gateId}/reopen`, { reason });
