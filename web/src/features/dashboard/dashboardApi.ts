/**
 * Dashboard + notification endpoints (slice 7).
 *
 * GET  /api/dashboard                      → Dashboard
 * GET  /api/notifications/preferences      → NotificationPrefs
 * PUT  /api/notifications/preferences      { digest?, immediate? } → NotificationPrefs
 * POST /api/notifications/digest/preview   → DigestPreview (nothing is sent)
 * POST /api/notifications/digest/run       → DigestRun (admin; idempotent per day)
 */
import { api } from '@/api/client';
import type { ID } from '@/api/types';

export type WarningCode =
  | 'deadline_passed'
  | 'guarantee_urgent'
  | 'documents_expiring'
  | 'watch_request_overdue'
  | 'gate_overdue'
  | 'compressed'
  | 'guarantee_validity';
export type WarningTone = 'red' | 'orange';
export type TenderTab = 'overview' | 'schedule' | 'gates' | 'register' | 'tasks' | 'watch' | 'documents';

export interface DashboardWarning {
  code: WarningCode;
  tone: WarningTone;
  /** Tender tab that resolves the warning */
  tab: TenderTab;
  params: Record<string, string | number | string[] | null>;
}
export interface AttentionItem extends DashboardWarning {
  tenderId: ID;
  tenderTitle: string;
}
export interface Coverage {
  total: number;
  covered: number;
  ratio: number | null;
}
export interface NextGate {
  id: ID;
  key: string;
  name: string;
  dueDate: string | null;
  /** n of the gate's own "T−n" */
  tMinus: number | null;
  /** Working days from today to the gate (negative = overdue) */
  inWorkingDays: number | null;
  overdue: boolean;
  requested: boolean;
  decisionMode: string;
  approver: { id: ID; name: string | null } | null;
}
export interface DashboardTender {
  id: ID;
  title: string;
  authority: string | null;
  status: string;
  deadlineAt: string;
  T: string;
  tMinus: number;
  compressedMode: boolean;
  nextGate: NextGate | null;
  coverage: Record<'exclusion' | 'scored' | 'formal' | 'all', Coverage>;
  counts: { overdueTasks: number; overdueHandoffs: number; watchRequestOverdue: number };
  warnings: DashboardWarning[];
  canWrite: boolean;
}
export interface OrgDocument {
  id: ID;
  title: string;
  type: string;
  expires_at: string;
  expired: boolean;
  daysLeft: number;
}
export interface Dashboard {
  today: string;
  tenders: DashboardTender[];
  attention: AttentionItem[];
  org: { documents: { expired: number; expiring: number; items: OrgDocument[] } } | null;
  my: { overdue: number; today: number; upcoming: number; waiting: number };
  recentlyClosed: { id: ID; title: string; authority: string | null; status: string; closedAt: string | null; T: string }[];
  permissions: { canCreateTender: boolean };
}

export interface NotificationPrefs {
  digest: boolean;
  immediate: boolean;
  email: string;
}
export type DigestSkipReason = 'opted_out' | 'nothing' | 'quiet_day' | 'already_sent';
export interface DigestPreview {
  date: string;
  workingDay: boolean;
  wouldSend: boolean;
  reason: DigestSkipReason | null;
  subject: string;
  text: string;
  html: string;
  totals: { overdue: number; today: number; upcoming: number; waiting: number; warnings: number };
}
export interface DigestRun {
  date: string;
  status: 'ok' | 'failed' | 'skipped' | 'running';
  alreadyRan: boolean;
  detail: { sent?: number; alreadySent?: number; failed?: number; error?: string } | null;
}

export const dashboardKeys = {
  all: ['dashboard'] as const,
  prefs: ['notifications', 'preferences'] as const,
};

export const fetchDashboard = () => api.get<Dashboard>('/dashboard');
export const fetchPrefs = () => api.get<NotificationPrefs>('/notifications/preferences');
export const savePrefs = (body: Partial<Pick<NotificationPrefs, 'digest' | 'immediate'>>) => api.put<NotificationPrefs>('/notifications/preferences', body);
export const previewDigest = () => api.post<DigestPreview>('/notifications/digest/preview', {});
export const runDigest = () => api.post<DigestRun>('/notifications/digest/run', {});
