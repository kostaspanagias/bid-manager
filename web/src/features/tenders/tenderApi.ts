/**
 * Tender API (server/src/modules/tenders/routes.ts).
 *
 *   GET    /api/tenders?status=&q=                → { items: TenderListItem[] }
 *   POST   /api/tenders                           → 201 TenderDetail            (admin / bid_manager)
 *   GET    /api/tenders/:id                       → TenderDetail
 *   PATCH  /api/tenders/:id                       → TenderDetail                (basic fields only)
 *   POST   /api/tenders/:id/status {status}       → TenderDetail
 *   GET    /api/tenders/:id/members               → { roles, items }
 *   PUT    /api/tenders/:id/members {members}     → { roles, items }
 *   POST   /api/tenders/:id/deadline/preview      → DeadlinePreview             (R9: diff, nothing saved)
 *   POST   /api/tenders/:id/deadline              → TenderDetail + { change_entry, diff }
 *
 * TenderDetail = { tender, permissions: { canWrite, canSeeFinancial, canManage }, T, T0, tMinus, nextGate, warnings }
 *
 * Assumed (slice 2): GET /api/templates?status=published → { items: [{ id, name, version, status, description? }] }
 */
import { api, type ListResponse } from '@/api/client';
import type { ChangeEntry, ChangeSource, DateString, ID, MilestoneKind, OrgRole, Tender, TenderLot, TenderStatus, Timestamp } from '@/api/types';

export const tenderKeys = {
  all: ['tenders'] as const,
  list: (filters?: Record<string, unknown>) => ['tenders', 'list', filters ?? {}] as const,
  /** Everything of one tender — feature queries should use [...tenderKeys.detail(id), '<feature>'] */
  detail: (id: ID) => ['tenders', id] as const,
  /** The tender record itself (the query TenderLayout owns) */
  record: (id: ID) => ['tenders', id, 'record'] as const,
  members: (id: ID) => ['tenders', id, 'members'] as const,
  templates: ['templates', 'published'] as const,
};

/* ------------------------------------------------------------------ shapes */

export type WarningCode = 'compressed_mode' | 'guarantee_at_risk' | 'gate_target_late' | 'guarantee_validity_short' | 'documents_expired_on_T';

/** Computed by the server on every read (R7, R8, R15, R16); `data` depends on the code. */
export interface TenderWarning {
  code: WarningCode | (string & {});
  severity: 'red' | 'orange';
  message: string;
  data: Record<string, unknown>;
}

export interface NextGate {
  milestone_id: ID;
  gate_id: ID;
  key: string;
  name: string;
  due_date: DateString | null;
  /** working days from the gate to T */
  tMinus: number | null;
}

/** The tender row as the server sends it: numeric columns are numbers, no template snapshot. */
export interface TenderRecord extends Tender {
  template_name: string | null;
  notes: string | null;
}

export interface TenderListItem extends TenderRecord {
  T: DateString;
  T0: DateString | null;
  /** working days from today to T (negative after the deadline) */
  tMinus: number;
  next_gate: NextGate | null;
}

export interface TenderDetail {
  tender: TenderRecord;
  canWrite: boolean;
  canSeeFinancial: boolean;
  /** admin / bid manager: basic fields, team, deadline, status, milestone dates */
  canManage: boolean;
  T: DateString;
  T0: DateString | null;
  tMinus: number | null;
  nextGate: NextGate | null;
  warnings: TenderWarning[];
}

interface TenderDetailResponse {
  tender: TenderRecord;
  permissions: { canWrite: boolean; canSeeFinancial: boolean; canManage: boolean };
  T: DateString;
  T0: DateString | null;
  tMinus: number;
  nextGate: NextGate | null;
  warnings: TenderWarning[];
}

function toDetail(raw: TenderDetailResponse): TenderDetail {
  return {
    tender: raw.tender,
    canWrite: Boolean(raw.permissions?.canWrite),
    canSeeFinancial: Boolean(raw.permissions?.canSeeFinancial),
    canManage: Boolean(raw.permissions?.canManage),
    T: raw.T,
    T0: raw.T0 ?? null,
    tMinus: typeof raw.tMinus === 'number' ? raw.tMinus : null,
    nextGate: raw.nextGate ?? null,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

/** Body of POST /api/tenders; PATCH takes any subset of the basic fields (no template, flags, deadline or members). */
export interface TenderInput {
  title: string;
  authority: string;
  adam: string | null;
  esidis_no: string | null;
  cpv: string[];
  budget_net: number | null;
  budget_gross: number | null;
  lots: TenderLot[];
  /** 'YYYY-MM-DD' (publication date) or a timestamp */
  t0_published_at: DateString | Timestamp | null;
  questions_deadline_at: Timestamp | null;
  submission_deadline_at: Timestamp;
  guarantee_amount: number | null;
  guarantee_valid_until: DateString | null;
  guarantee_margin_days: number;
  offer_validity_days: number | null;
  has_demo: boolean;
  has_partners: boolean;
  notes: string | null;
  template_id: ID;
  members?: MemberInput[];
}
export type TenderPatch = Partial<Omit<TenderInput, 'template_id' | 'members' | 'has_demo' | 'has_partners' | 'submission_deadline_at'>>;

export interface TemplateOption {
  id: ID;
  name: string;
  version: string;
  status: string;
  description?: string | null;
}

export interface TenderRoleInfo {
  key: string;
  name: string;
  sort: number;
  payload: { folder?: string; financial?: boolean; management?: boolean; deliverables?: string };
}
export interface TenderMemberRow {
  id: ID;
  user_id: ID;
  tender_role_key: string | null;
  user: { id: ID; name: string; email: string | null; org_role: OrgRole; active: boolean };
}
export interface TeamResponse {
  roles: TenderRoleInfo[];
  items: TenderMemberRow[];
}
export interface MemberInput {
  user_id: ID;
  role_key: string | null;
}

export type DiffStatus = 'moved' | 'unchanged' | 'manual' | 'done' | 'no_rule';
export interface DeadlineDiffRow {
  milestone_id: ID | null;
  key: string;
  kind: MilestoneKind | 'task';
  name: string;
  old_date: DateString | null;
  new_date: DateString | null;
  changed: boolean;
  status: DiffStatus;
  /** where the rules would put a manual / done milestone */
  computed_date: DateString | null;
  is_manual: boolean;
  done: boolean;
  needs_review: boolean;
  tMinus: number | null;
}
export interface DeadlinePreview {
  old_deadline_at: Timestamp;
  new_deadline_at: Timestamp;
  oldT: DateString;
  newT: DateString;
  shiftWorkingDays: number;
  compressed: { old: boolean; new: boolean };
  workingDays: number;
  items: DeadlineDiffRow[];
  /** warnings the tender would have with the new deadline (R15 / R16 re-run) */
  warnings: TenderWarning[];
}
export interface DeadlineInput {
  submission_deadline_at: Timestamp;
  source?: ChangeSource;
  description?: string;
  reference?: string | null;
}

/* ------------------------------------------------------------------ calls */

export async function fetchTender(id: ID): Promise<TenderDetail> {
  return toDetail(await api.get<TenderDetailResponse>(`/tenders/${id}`));
}

export const listTenders = (query?: { status?: string; q?: string }) =>
  api.get<ListResponse<TenderListItem>>('/tenders', { query }).then((r) => r.items);

export const createTender = (body: TenderInput) => api.post<TenderDetailResponse>('/tenders', body).then(toDetail);

export const updateTender = (id: ID, patch: TenderPatch) => api.patch<TenderDetailResponse>(`/tenders/${id}`, patch).then(toDetail);

export const setTenderStatus = (id: ID, status: TenderStatus) => api.post<TenderDetailResponse>(`/tenders/${id}/status`, { status }).then(toDetail);

export const listPublishedTemplates = () =>
  api.get<ListResponse<TemplateOption>>('/templates', { query: { status: 'published' } }).then((r) => r.items);

export const fetchTeam = (id: ID) => api.get<TeamResponse>(`/tenders/${id}/members`);
export const saveTeam = (id: ID, members: MemberInput[]) => api.put<TeamResponse>(`/tenders/${id}/members`, { members });

export const previewDeadline = (id: ID, submission_deadline_at: Timestamp) =>
  api.post<DeadlinePreview>(`/tenders/${id}/deadline/preview`, { submission_deadline_at });

export const changeDeadline = (id: ID, body: DeadlineInput) =>
  api.post<TenderDetailResponse & { change_entry: ChangeEntry; diff: DeadlinePreview & { moved: number } }>(`/tenders/${id}/deadline`, body);

/** Status transitions the server accepts (No-Go is decided at G0 in the gates tab). */
export const STATUS_TRANSITIONS: Record<TenderStatus, TenderStatus[]> = {
  evaluation: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'cancelled'],
  submitted: ['in_progress'],
  cancelled: ['evaluation', 'in_progress'],
  no_go: [],
};
