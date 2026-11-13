// The landing page's data: "what needs attention today". A fixed number of queries (never per tender), then
// in-memory evaluation shared with the daily digest. Nothing from files (financial or not) is read here.
import { accessibleTenderIds, hasRole } from '../../core/permissions.js';
import type { Ctx } from '../../core/types.js';
import { daysBetween } from '../../domain/calendar.js';
import type { CoverageByType } from '../../domain/register.js';
import { athensDate, todayAthens } from '../../domain/time.js';
import { expiringWithin } from '../../domain/validity.js';
import { buildDigest, ORG_DOCS_DAYS } from '../notifications/digest.js';
import { evaluateTenders, loadCompanyDocs, loadSnapshot, type NextGate, type TenderTab, type TenderWarning } from '../notifications/snapshot.js';

export const RECENTLY_CLOSED_DAYS = 30;
const CLOSED_STATUSES = ['submitted', 'no_go', 'cancelled'];

export interface DashboardWarning {
  code: TenderWarning['code'];
  tone: 'red' | 'orange';
  tab: TenderTab;
  params: TenderWarning['params'];
}
export interface DashboardTender {
  id: string;
  title: string;
  authority: string | null;
  status: string;
  /** UTC instant of the submission deadline. */
  deadlineAt: Date;
  /** Athens date of the deadline. */
  T: string;
  /** Working days from today to T (0 on T, negative afterwards). */
  tMinus: number;
  compressedMode: boolean;
  nextGate: NextGate | null;
  coverage: CoverageByType;
  counts: { overdueTasks: number; overdueHandoffs: number; watchRequestOverdue: number };
  warnings: DashboardWarning[];
  canWrite: boolean;
}
export interface Dashboard {
  today: string;
  tenders: DashboardTender[];
  /** Every red / orange warning across the tenders, red first, each pointing at the tab that resolves it. */
  attention: (DashboardWarning & { tenderId: string; tenderTitle: string })[];
  /** Company documents (R15) — admin and bid_manager only, otherwise null. */
  org: { documents: { expired: number; expiring: number; items: { id: string; title: string; type: string; expires_at: string; expired: boolean; daysLeft: number }[] } } | null;
  /** The caller's own items, same selection as the daily digest. */
  my: { overdue: number; today: number; upcoming: number; waiting: number };
  recentlyClosed: { id: string; title: string; authority: string | null; status: string; closedAt: Date | null; T: string }[];
  permissions: { canCreateTender: boolean };
}

export async function loadDashboard(ctx: Ctx, today: string = todayAthens()): Promise<Dashboard> {
  const { db, user } = ctx;
  const ids = await accessibleTenderIds(ctx);
  const manager = hasRole(ctx, 'admin', 'bid_manager');
  const [snap, companyDocs, closed] = await Promise.all([
    loadSnapshot(db, today, ids),
    manager ? loadCompanyDocs(db) : Promise.resolve([]),
    ids !== null && ids.length === 0
      ? Promise.resolve([])
      : db.sql<{ id: string; title: string; authority: string | null; status: string; closed_at: Date | null; submission_deadline_at: Date }>(
          `SELECT id, title, authority, status, closed_at, submission_deadline_at
             FROM tender
            WHERE org_id = :org_id AND status = ANY(:closed) ${ids ? 'AND id = ANY(:ids)' : ''}
              AND COALESCE(closed_at, updated_at) >= now() - make_interval(days => :days)
            ORDER BY COALESCE(closed_at, updated_at) DESC
            LIMIT 10`,
          { closed: CLOSED_STATUSES, days: RECENTLY_CLOSED_DAYS, ...(ids ? { ids } : {}) },
        ),
  ]);
  const views = evaluateTenders(snap);
  const strip = ({ code, tone, tab, params }: TenderWarning): DashboardWarning => ({ code, tone, tab, params });

  const tenders: DashboardTender[] = views.map((v) => ({
    id: v.tender.id,
    title: v.tender.title,
    authority: v.tender.authority,
    status: v.tender.status,
    deadlineAt: v.tender.submission_deadline_at,
    T: v.T,
    tMinus: v.tMinus,
    compressedMode: v.tender.compressed_mode,
    nextGate: v.nextGate,
    coverage: v.coverage,
    counts: v.counts,
    warnings: v.warnings.map(strip),
    canWrite: user.org_role !== 'viewer',
  }));

  const attention = tenders
    .flatMap((t) => t.warnings.map((w) => ({ ...w, tenderId: t.id, tenderTitle: t.title })))
    .sort((a, b) => Number(a.tone !== 'red') - Number(b.tone !== 'red'));

  const expiring = expiringWithin(companyDocs, today, ORG_DOCS_DAYS);
  const org: Dashboard['org'] = manager
    ? {
        documents: {
          expired: expiring.filter((d) => (d.expires_at as string) < today).length,
          expiring: expiring.filter((d) => (d.expires_at as string) >= today).length,
          items: expiring.slice(0, 10).map((d) => ({
            id: d.id,
            title: d.title,
            type: d.type,
            expires_at: d.expires_at as string,
            expired: (d.expires_at as string) < today,
            daysLeft: daysBetween(today, d.expires_at as string),
          })),
        },
      }
    : null;

  const { totals } = buildDigest(snap, views, user);
  return {
    today,
    tenders,
    attention,
    org,
    my: { overdue: totals.overdue, today: totals.today, upcoming: totals.upcoming, waiting: totals.waiting },
    recentlyClosed: closed.map((t) => ({ id: t.id, title: t.title, authority: t.authority, status: t.status, closedAt: t.closed_at, T: athensDate(t.submission_deadline_at) })),
    permissions: { canCreateTender: manager },
  };
}
