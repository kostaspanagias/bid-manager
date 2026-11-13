// Daily digest: which items go to which user (F9). Pure selection over a Snapshot — no I/O here.
import { addWorkingDays, isWorkingDay, workingDaysBetween } from '../../domain/calendar.js';
import { expiringWithin } from '../../domain/validity.js';
import { lastRequestDate } from '../../domain/watch.js';
import {
  canAccess,
  type DocRow,
  isDelivered,
  membershipOf,
  type Snapshot,
  type TenderTab,
  type TenderView,
  type TenderWarning,
} from './snapshot.js';

/** "Next 3 working days" of the digest (F9). */
export const UPCOMING_WORKING_DAYS = 3;
/** R15: org documents expiring within this many days go to the admin's digest. */
export const ORG_DOCS_DAYS = 30;

export type Bucket = 'overdue' | 'today' | 'upcoming' | 'waiting';
export type ItemKind = 'task' | 'checklist' | 'handoff_deliver' | 'handoff_receive' | 'gate' | 'watch_request' | 'watch_arrival';

export interface DigestItem {
  kind: ItemKind;
  id: string;
  /** Task title / watch item name / gate name — never requirement text or file names. */
  title: string;
  /** The date the bucket is based on (due date, gate date, last request day, expected arrival). */
  date: string | null;
  bucket: Bucket;
  /** Working days from today to `date` (negative = overdue). */
  inWorkingDays: number | null;
  tab: TenderTab;
  /** Gate key (G2), handoff roles. */
  gateKey?: string;
  from?: string | null;
  to?: string | null;
  requested?: boolean;
}

export interface DigestTender {
  id: string;
  title: string;
  authority: string | null;
  T: string;
  deadlineTime: string;
  tMinus: number;
  nextGate: { key: string; name: string; dueDate: string | null; inWorkingDays: number | null; overdue: boolean } | null;
  /** Tender-level warnings — only for users who may write in the tender. */
  warnings: TenderWarning[];
  /** Whole-team overdue counts — only for admin / bid_manager. */
  team: { overdueTasks: number; overdueHandoffs: number } | null;
  items: DigestItem[];
}

export interface Digest {
  date: string;
  workingDay: boolean;
  tenders: DigestTender[];
  /** Admin only (R15): company documents expired or expiring within 30 days. */
  orgDocuments: DocRow[];
  totals: { overdue: number; today: number; upcoming: number; waiting: number; warnings: number };
}

export interface DigestUser {
  id: string;
  org_role: string;
}

export interface DigestPrefs {
  digest: boolean;
  immediate: boolean;
}

/** `"user".settings.notifications` → preferences; everything defaults to on. */
export function readPrefs(settings: unknown): DigestPrefs {
  const n = (settings as { notifications?: { digest?: unknown; immediate?: unknown } } | null)?.notifications ?? {};
  return { digest: n.digest !== false, immediate: n.immediate !== false };
}

const BUCKET_ORDER: Record<Bucket, number> = { overdue: 0, today: 1, upcoming: 2, waiting: 3 };

/**
 * Builds the digest of one user for `snap.today`:
 * - tasks / checklist items the user owns directly, or through a tender role when nobody owns them directly;
 * - handoffs the user has to deliver (from-role) and delivered handoffs awaiting the user's receipt (to-role);
 * - undecided gates whose approver is the user;
 * - watch items the user owns: last request day (R6) while nothing was requested, expected arrival afterwards;
 * - tender-level warnings (non-viewers) and, for admins, expiring company documents (R15).
 * Dated items are kept when overdue, due today or due within the next 3 working days; a delivered handoff or a
 * gate whose approval was requested is kept regardless of its date ("waiting").
 */
export function buildDigest(snap: Snapshot, views: readonly TenderView[], user: DigestUser, companyDocs: readonly DocRow[] = []): Digest {
  const { today, holidays } = snap;
  const horizon = addWorkingDays(today, UPCOMING_WORKING_DAYS, holidays);
  const bucketOf = (date: string | null): Bucket | null => {
    if (!date) return null;
    if (date < today) return 'overdue';
    if (date === today) return 'today';
    return date <= horizon ? 'upcoming' : null;
  };
  const membership = membershipOf(snap, user.id);
  const isManager = user.org_role === 'admin' || user.org_role === 'bid_manager';
  const canWrite = user.org_role !== 'viewer';

  const tenders: DigestTender[] = [];
  for (const view of views) {
    const tenderId = view.tender.id;
    if (!canAccess(user, membership, tenderId)) continue;
    const keys = membership.roleKeys.get(tenderId) ?? new Set<string>();
    const holds = (key: string | null): boolean => key !== null && keys.has(key);
    const owns = (row: { owner_user_id: string | null; owner_role_key: string | null }): boolean =>
      row.owner_user_id === user.id || (row.owner_user_id === null && holds(row.owner_role_key));

    const items: DigestItem[] = [];
    const add = (item: Omit<DigestItem, 'inWorkingDays'>) =>
      items.push({ ...item, inWorkingDays: item.date ? workingDaysBetween(today, item.date, holidays) : null });

    for (const t of view.tasks) {
      if (t.section === 'handoff') {
        if (t.received_at !== null) continue;
        const roles = { from: t.handoff_from_role, to: t.handoff_to_role };
        if (isDelivered(t)) {
          if (holds(t.handoff_to_role)) {
            add({ kind: 'handoff_receive', id: t.id, title: t.title, date: t.due_date, bucket: bucketOf(t.due_date) ?? 'waiting', tab: 'tasks', ...roles });
          }
        } else if (owns(t) || holds(t.handoff_from_role)) {
          const bucket = bucketOf(t.due_date);
          if (bucket) add({ kind: 'handoff_deliver', id: t.id, title: t.title, date: t.due_date, bucket, tab: 'tasks', ...roles });
        }
        continue;
      }
      if (!owns(t)) continue;
      const bucket = bucketOf(t.due_date);
      if (bucket) add({ kind: t.section === 'checklist' ? 'checklist' : 'task', id: t.id, title: t.title, date: t.due_date, bucket, tab: 'tasks' });
    }

    for (const g of view.gates) {
      if (g.decision !== 'pending' || g.approver_user_id !== user.id) continue;
      const requested = g.requested_at !== null;
      const bucket = bucketOf(g.due_date) ?? (requested ? 'waiting' : null);
      if (bucket) add({ kind: 'gate', id: g.id, title: g.name, date: g.due_date, bucket, tab: 'gates', gateKey: g.key, requested });
    }

    for (const w of view.watch) {
      if (w.arrived_at || !owns(w)) continue;
      const last = lastRequestDate(w, holidays); // R6
      if (!w.requested_at && last) {
        const bucket = bucketOf(last);
        if (bucket) add({ kind: 'watch_request', id: w.id, title: w.name, date: last, bucket, tab: 'watch' });
      } else {
        const date = w.expected_at ?? w.needed_at;
        const bucket = bucketOf(date);
        if (bucket) add({ kind: 'watch_arrival', id: w.id, title: w.name, date, bucket, tab: 'watch', requested: w.requested_at !== null });
      }
    }

    items.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.title.localeCompare(b.title, 'el'));
    const warnings = canWrite ? view.warnings : [];
    if (items.length === 0 && warnings.length === 0) continue;
    tenders.push({
      id: tenderId,
      title: view.tender.title,
      authority: view.tender.authority,
      T: view.T,
      deadlineTime: view.deadlineTime,
      tMinus: view.tMinus,
      nextGate: view.nextGate && {
        key: view.nextGate.key,
        name: view.nextGate.name,
        dueDate: view.nextGate.dueDate,
        inWorkingDays: view.nextGate.inWorkingDays,
        overdue: view.nextGate.overdue,
      },
      warnings,
      team: isManager ? { overdueTasks: view.counts.overdueTasks, overdueHandoffs: view.counts.overdueHandoffs } : null,
      items,
    });
  }

  const orgDocuments = user.org_role === 'admin' ? expiringWithin(companyDocs, today, ORG_DOCS_DAYS) : [];
  const count = (bucket: Bucket) => tenders.reduce((n, t) => n + t.items.filter((i) => i.bucket === bucket).length, 0);
  return {
    date: today,
    workingDay: isWorkingDay(today, holidays),
    tenders,
    orgDocuments,
    totals: {
      overdue: count('overdue'),
      today: count('today'),
      upcoming: count('upcoming'),
      waiting: count('waiting'),
      warnings: tenders.reduce((n, t) => n + t.warnings.length, 0),
    },
  };
}

export type SkipReason = 'opted_out' | 'nothing' | 'quiet_day';

/**
 * Whether the digest goes out:
 * - never when the user switched it off;
 * - never when there is nothing actionable (items, actionable warnings, admin documents). Compressed mode alone is
 *   context and does not cause a daily mail;
 * - on weekends and holidays only when something is overdue or due that very day.
 */
export function decideDigest(digest: Digest, prefs: DigestPrefs): { send: true } | { send: false; reason: SkipReason } {
  if (!prefs.digest) return { send: false, reason: 'opted_out' };
  const { totals } = digest;
  const items = totals.overdue + totals.today + totals.upcoming + totals.waiting;
  const actionableWarnings = digest.tenders.some((t) => t.warnings.some((w) => w.actionable));
  if (items === 0 && !actionableWarnings && digest.orgDocuments.length === 0) return { send: false, reason: 'nothing' };
  if (!digest.workingDay && totals.overdue + totals.today === 0) return { send: false, reason: 'quiet_day' };
  return { send: true };
}
