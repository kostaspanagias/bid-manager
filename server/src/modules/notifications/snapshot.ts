// What the dashboard and the daily digest both need to know about the active tenders of an organization.
// Loaded with a fixed number of queries (one per concern, never per tender) and then evaluated in memory.
// Confidentiality: nothing here reads `file`, requirement text, prices or amounts — titles, codes, dates, counts only.
import type { ScopedDb } from '../../db/scoped.js';
import { type Holidays, type OffsetUnit, workingDaysBetween } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { coverageByType, type CoverageByType } from '../../domain/register.js';
import { athensDate, athensTime } from '../../domain/time.js';
import { expiredOnT, guaranteeWarning } from '../../domain/validity.js';
import { lastRequestDate, requestOverdue } from '../../domain/watch.js';

export const ACTIVE_TENDER_STATUSES = ['evaluation', 'in_progress'] as const;
export const OPEN_TASK_STATUSES = ['open', 'in_progress'] as const;
/** Key of the participation-guarantee watch item (ARCHITECTURE.md). */
export const GUARANTEE_KEY = 'guarantee';
/** R8: fewer working days than this to T → the guarantee cannot make it without an immediate request. */
export const GUARANTEE_URGENT_DAYS = 10;

export interface TenderRow {
  id: string;
  title: string;
  authority: string | null;
  status: string;
  submission_deadline_at: Date;
  t0_published_at: Date | null;
  guarantee_valid_until: string | null;
  guarantee_margin_days: number | null;
  offer_validity_days: number | null;
  compressed_mode: boolean;
}
export interface GateRow {
  id: string;
  tender_id: string;
  key: string;
  name: string;
  due_date: string | null;
  sort: number;
  decision: string;
  decision_mode: string;
  approver_user_id: string | null;
  approver_name: string | null;
  requested_at: Date | null;
}
export interface TaskRow {
  id: string;
  tender_id: string;
  title: string;
  section: 'task' | 'checklist' | 'handoff';
  status: string;
  due_date: string | null;
  owner_user_id: string | null;
  owner_role_key: string | null;
  handoff_from_role: string | null;
  handoff_to_role: string | null;
  received_at: Date | null;
  payload: Record<string, unknown> | null;
}
export interface WatchRow {
  id: string;
  tender_id: string;
  key: string | null;
  name: string;
  owner_user_id: string | null;
  owner_role_key: string | null;
  lead_value: number | null;
  lead_unit: OffsetUnit | null;
  needed_at: string | null;
  requested_at: string | null;
  expected_at: string | null;
  arrived_at: string | null;
}
export interface DocRow {
  id: string;
  title: string;
  type: string;
  expires_at: string | null;
}
export interface LinkedDocRow extends DocRow {
  tender_id: string;
}
export interface MemberRow {
  tender_id: string;
  user_id: string;
  tender_role_key: string | null;
}
export interface RoleRow {
  tender_id: string;
  key: string;
  name: string;
}

export interface Snapshot {
  today: string;
  holidays: Holidays;
  tenders: TenderRow[];
  gates: GateRow[];
  tasks: TaskRow[];
  watch: WatchRow[];
  linkedDocs: LinkedDocRow[];
  members: MemberRow[];
  roles: RoleRow[];
  requirementCounts: { tender_id: string; type: string; status: string; n: number }[];
}

/**
 * Loads everything about the org's active tenders (`tenderIds = null`) or the given subset of them.
 * Nine queries regardless of the number of tenders.
 */
export async function loadSnapshot(db: ScopedDb, today: string, tenderIds: string[] | null): Promise<Snapshot> {
  const [holidays, tenders] = await Promise.all([
    loadHolidays(db),
    db.sql<TenderRow>(
      `SELECT id, title, authority, status, submission_deadline_at, t0_published_at, guarantee_valid_until,
              guarantee_margin_days, offer_validity_days, compressed_mode
         FROM tender
        WHERE org_id = :org_id AND status = ANY(:active) ${tenderIds ? 'AND id = ANY(:ids)' : ''}
        ORDER BY submission_deadline_at, title`,
      { active: [...ACTIVE_TENDER_STATUSES], ...(tenderIds ? { ids: tenderIds } : {}) },
    ),
  ]);
  const ids = tenders.map((t) => t.id);
  if (ids.length === 0) {
    return { today, holidays, tenders, gates: [], tasks: [], watch: [], linkedDocs: [], members: [], roles: [], requirementCounts: [] };
  }
  const [gates, tasks, watch, linkedDocs, members, roles, requirementCounts] = await Promise.all([
    db.sql<GateRow>(
      `SELECT g.id, g.tender_id, COALESCE(g.key, m.key) AS key, m.name, m.due_date, m.sort, g.decision, g.decision_mode,
              g.approver_user_id, u.name AS approver_name, g.requested_at
         FROM gate g
         JOIN milestone m ON m.id = g.milestone_id AND m.org_id = g.org_id
         LEFT JOIN "user" u ON u.id = g.approver_user_id AND u.org_id = g.org_id
        WHERE g.org_id = :org_id AND g.tender_id = ANY(:ids)
        ORDER BY m.due_date NULLS LAST, m.sort, m.key`,
      { ids },
    ),
    db.sql<TaskRow>(
      `SELECT id, tender_id, title, section, status, due_date, owner_user_id, owner_role_key, handoff_from_role,
              handoff_to_role, received_at, payload
         FROM task
        WHERE org_id = :org_id AND tender_id = ANY(:ids) AND status = ANY(:open)
        ORDER BY due_date NULLS LAST, sort, title`,
      { ids, open: [...OPEN_TASK_STATUSES] },
    ),
    db.sql<WatchRow>(
      `SELECT id, tender_id, key, name, owner_user_id, owner_role_key, lead_value, lead_unit, needed_at, requested_at,
              expected_at, arrived_at
         FROM watch_item
        WHERE org_id = :org_id AND tender_id = ANY(:ids)
        ORDER BY sort, name`,
      { ids },
    ),
    db.sql<LinkedDocRow>(
      `SELECT td.tender_id, d.id, d.title, d.type, d.expires_at
         FROM tender_document td
         JOIN company_document d ON d.id = td.company_document_id AND d.org_id = td.org_id
        WHERE td.org_id = :org_id AND td.tender_id = ANY(:ids) AND d.expires_at IS NOT NULL
        ORDER BY d.expires_at, d.title`,
      { ids },
    ),
    db.sql<MemberRow>('SELECT tender_id, user_id, tender_role_key FROM tender_member WHERE org_id = :org_id AND tender_id = ANY(:ids)', { ids }),
    db.sql<RoleRow>('SELECT tender_id, key, name FROM tender_role WHERE org_id = :org_id AND tender_id = ANY(:ids)', { ids }),
    db.sql<{ tender_id: string; type: string; status: string; n: number }>(
      `SELECT tender_id, type, status, count(*)::int AS n
         FROM requirement
        WHERE org_id = :org_id AND tender_id = ANY(:ids)
        GROUP BY tender_id, type, status`,
      { ids },
    ),
  ]);
  return { today, holidays, tenders, gates, tasks, watch, linkedDocs, members, roles, requirementCounts };
}

/** Not-archived company documents that have an expiry date (R15 org block / admin digest). */
export function loadCompanyDocs(db: ScopedDb): Promise<DocRow[]> {
  return db.sql<DocRow>(
    `SELECT id, title, type, expires_at
       FROM company_document
      WHERE org_id = :org_id AND archived_at IS NULL AND expires_at IS NOT NULL
      ORDER BY expires_at, title`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Per-tender evaluation
// ---------------------------------------------------------------------------------------------------------------

export type WarningCode =
  | 'deadline_passed'
  | 'guarantee_urgent'
  | 'documents_expiring'
  | 'watch_request_overdue'
  | 'gate_overdue'
  | 'compressed'
  | 'guarantee_validity';
/** Tender tab (web route segment) where the warning is resolved. */
export type TenderTab = 'overview' | 'schedule' | 'gates' | 'register' | 'tasks' | 'watch' | 'documents';

export interface TenderWarning {
  code: WarningCode;
  tone: 'red' | 'orange';
  tab: TenderTab;
  /** false = context only: shown, but never the sole reason to send a digest. */
  actionable: boolean;
  /** Numbers, dates, keys and titles only. */
  params: Record<string, string | number | string[] | null>;
}

export interface NextGate {
  id: string;
  key: string;
  name: string;
  dueDate: string | null;
  /** The gate's own position on the schedule: working days from its date to T (n of "T−n"). */
  tMinus: number | null;
  /** Working days from today to the gate date (negative = overdue). */
  inWorkingDays: number | null;
  overdue: boolean;
  requested: boolean;
  decisionMode: string;
  approver: { id: string; name: string | null } | null;
}

export interface TenderView {
  tender: TenderRow;
  /** Athens date of the submission deadline. */
  T: string;
  /** Athens wall-clock time of the deadline, 'HH:mm'. */
  deadlineTime: string;
  /** Working days from today to T (0 on T, negative after it). */
  tMinus: number;
  nextGate: NextGate | null;
  coverage: CoverageByType;
  counts: { overdueTasks: number; overdueHandoffs: number; watchRequestOverdue: number };
  warnings: TenderWarning[];
  gates: GateRow[];
  tasks: TaskRow[];
  watch: WatchRow[];
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

const max = (a: string, b: string): string => (a > b ? a : b);

/** A handoff counts as delivered once slice 5 marked it (payload.delivered_at / payload.delivered). */
export function isDelivered(task: Pick<TaskRow, 'payload'>): boolean {
  const p = task.payload ?? {};
  return Boolean(p.delivered_at) || p.delivered === true;
}

/** Evaluates every tender of the snapshot: T−n, next gate, coverage (R17), overdue counts, warnings (R6/R8/R15/R16). */
export function evaluateTenders(snap: Snapshot): TenderView[] {
  const { today, holidays } = snap;
  const gatesBy = groupBy(snap.gates, (g) => g.tender_id);
  const tasksBy = groupBy(snap.tasks, (t) => t.tender_id);
  const watchBy = groupBy(snap.watch, (w) => w.tender_id);
  const docsBy = groupBy(snap.linkedDocs, (d) => d.tender_id);
  const reqBy = groupBy(snap.requirementCounts, (r) => r.tender_id);

  return snap.tenders.map((tender) => {
    const T = athensDate(tender.submission_deadline_at);
    const tMinus = workingDaysBetween(today, T, holidays);
    const gates = gatesBy.get(tender.id) ?? [];
    const tasks = tasksBy.get(tender.id) ?? [];
    const watch = watchBy.get(tender.id) ?? [];

    const pending = gates.find((g) => g.decision === 'pending') ?? null;
    const nextGate: NextGate | null = pending && {
      id: pending.id,
      key: pending.key,
      name: pending.name,
      dueDate: pending.due_date,
      tMinus: pending.due_date ? workingDaysBetween(pending.due_date, T, holidays) : null,
      inWorkingDays: pending.due_date ? workingDaysBetween(today, pending.due_date, holidays) : null,
      overdue: pending.due_date !== null && pending.due_date < today,
      requested: pending.requested_at !== null,
      decisionMode: pending.decision_mode,
      approver: pending.approver_user_id ? { id: pending.approver_user_id, name: pending.approver_name } : null,
    };

    const coverage = coverageByType(expandCounts(reqBy.get(tender.id) ?? []));

    const isOverdue = (t: TaskRow) => t.due_date !== null && t.due_date < today;
    const overdueWatch = watch.filter((w) => requestOverdue(w, today, holidays));
    const counts = {
      overdueTasks: tasks.filter((t) => t.section !== 'handoff' && isOverdue(t)).length,
      overdueHandoffs: tasks.filter((t) => t.section === 'handoff' && t.received_at === null && isOverdue(t)).length,
      watchRequestOverdue: overdueWatch.length,
    };

    const warnings: TenderWarning[] = [];
    if (T < today) {
      warnings.push({ code: 'deadline_passed', tone: 'red', tab: 'overview', actionable: true, params: { T } });
    } else {
      // R8 red: working days from max(T0, today) to T < 10, unless the guarantee is already requested / in hand.
      const start = tender.t0_published_at ? max(athensDate(tender.t0_published_at), today) : today;
      const left = workingDaysBetween(start, T, holidays);
      const guarantee = watch.find((w) => w.key === GUARANTEE_KEY);
      if (left < GUARANTEE_URGENT_DAYS && !(guarantee && (guarantee.requested_at || guarantee.arrived_at))) {
        warnings.push({ code: 'guarantee_urgent', tone: 'red', tab: 'watch', actionable: true, params: { workingDays: left } });
      }
    }
    const expired = expiredOnT(docsBy.get(tender.id) ?? [], T); // R15
    if (expired.length > 0) {
      warnings.push({
        code: 'documents_expiring',
        tone: 'red',
        tab: 'documents',
        actionable: true,
        params: { count: expired.length, titles: expired.slice(0, 3).map((d) => d.title), firstExpiry: expired[0]?.expires_at ?? null, T },
      });
    }
    if (overdueWatch.length > 0) {
      // R6
      warnings.push({
        code: 'watch_request_overdue',
        tone: 'red',
        tab: 'watch',
        actionable: true,
        params: {
          count: overdueWatch.length,
          names: overdueWatch.slice(0, 3).map((w) => w.name),
          lastRequestDate: overdueWatch.map((w) => lastRequestDate(w, holidays)).sort()[0] ?? null,
        },
      });
    }
    if (nextGate?.overdue) {
      warnings.push({ code: 'gate_overdue', tone: 'red', tab: 'gates', actionable: true, params: { gate: nextGate.key, dueDate: nextGate.dueDate } });
    }
    if (tender.compressed_mode) {
      warnings.push({ code: 'compressed', tone: 'orange', tab: 'schedule', actionable: false, params: {} });
    }
    const gw = guaranteeWarning(tender); // R16
    if (gw) {
      warnings.push({
        code: 'guarantee_validity',
        tone: 'orange',
        tab: 'overview',
        actionable: true,
        params: { requiredUntil: gw.requiredUntil, validUntil: gw.validUntil, shortByDays: gw.shortByDays },
      });
    }

    return { tender, T, deadlineTime: athensTime(tender.submission_deadline_at), tMinus, nextGate, coverage, counts, warnings, gates, tasks, watch };
  });
}

function* expandCounts(rows: readonly { type: string; status: string; n: number }[]): Generator<{ type: string; status: string }> {
  for (const row of rows) for (let i = 0; i < row.n; i++) yield row;
}

// ---------------------------------------------------------------------------------------------------------------
// Who is who in a tender
// ---------------------------------------------------------------------------------------------------------------

export interface Membership {
  /** tender id → keys of the tender roles the user holds there (empty set = plain member). */
  roleKeys: Map<string, Set<string>>;
}

export function membershipOf(snap: Snapshot, userId: string): Membership {
  const roleKeys = new Map<string, Set<string>>();
  for (const m of snap.members) {
    if (m.user_id !== userId) continue;
    const set = roleKeys.get(m.tender_id) ?? new Set<string>();
    if (m.tender_role_key) set.add(m.tender_role_key);
    roleKeys.set(m.tender_id, set);
  }
  return { roleKeys };
}

/** Same rule as core/permissions: admin and bid_manager reach every tender, the others only where they are members. */
export function canAccess(user: { org_role: string }, membership: Membership, tenderId: string): boolean {
  return user.org_role === 'admin' || user.org_role === 'bid_manager' || membership.roleKeys.has(tenderId);
}
