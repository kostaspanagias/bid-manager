// Digest run (per organization and date) and the immediate e-mails behind the app events.
import type { AppEvents, EventCtx } from '../../core/events.js';
import type { ScopedDb } from '../../db/scoped.js';
import { workingDaysBetween } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { athensDate, formatDate, formatDateTime, todayAthens } from '../../domain/time.js';
import { deliver } from './deliver.js';
import { buildDigest, decideDigest, type Digest, readPrefs, type SkipReason } from './digest.js';
import {
  type RenderedMail,
  renderApprovalRequested,
  renderDigest,
  renderGateDecided,
  renderHandoffDelivered,
  renderTenderExtended,
} from './render.js';
import { evaluateTenders, loadCompanyDocs, loadSnapshot } from './snapshot.js';

export const DIGEST_JOB = 'daily-digest';
export const digestKey = (userId: string, date: string): string => `digest:${date}:${userId}`;

interface Recipient {
  id: string;
  email: string;
  name: string;
  org_role: string;
  settings: unknown;
}

/** Users who can receive mail at all: active, not anonymized (GDPR), with an address. */
function loadRecipients(db: ScopedDb, userIds?: string[]): Promise<Recipient[]> {
  return db.sql<Recipient>(
    `SELECT id, email, name, org_role, settings
       FROM "user"
      WHERE org_id = :org_id AND active AND anonymized_at IS NULL AND email <> '' ${userIds ? 'AND id = ANY(:ids)' : ''}
      ORDER BY email`,
    userIds ? { ids: userIds } : {},
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------------------------------------------

export interface DigestRunDetail {
  date: string;
  workingDay: boolean;
  activeTenders: number;
  users: number;
  sent: number;
  /** Already delivered by an earlier (interrupted or repeated) run for this date. */
  alreadySent: number;
  failed: number;
  skipped: Record<SkipReason, number>;
  /** One line per user, so the log says why somebody got nothing. Ids only — no personal data in job_run. */
  perUser: { userId: string; outcome: 'sent' | 'already_sent' | 'failed' | SkipReason }[];
}

/**
 * Sends today's digest to every user of the org who has something. Idempotent per user and day through
 * email_log.dedupe_key (`digest:<date>:<userId>`): a second run, or the retry of a run that crashed halfway,
 * sends only what was not sent yet. Throws at the end when a delivery failed, so job_run records the run as
 * failed and it can be retried.
 */
export async function runDigest(db: ScopedDb, runDate: string): Promise<DigestRunDetail> {
  const [snap, companyDocs, users] = await Promise.all([loadSnapshot(db, runDate, null), loadCompanyDocs(db), loadRecipients(db)]);
  const views = evaluateTenders(snap);
  const detail: DigestRunDetail = {
    date: runDate,
    workingDay: true,
    activeTenders: snap.tenders.length,
    users: users.length,
    sent: 0,
    alreadySent: 0,
    failed: 0,
    skipped: { opted_out: 0, nothing: 0, quiet_day: 0 },
    perUser: [],
  };
  for (const user of users) {
    const digest = buildDigest(snap, views, user, companyDocs);
    detail.workingDay = digest.workingDay;
    const decision = decideDigest(digest, readPrefs(user.settings));
    if (!decision.send) {
      detail.skipped[decision.reason]++;
      detail.perUser.push({ userId: user.id, outcome: decision.reason });
      continue;
    }
    const result = await deliver(db, {
      userId: user.id,
      to: user.email,
      kind: 'digest',
      dedupeKey: digestKey(user.id, runDate),
      mail: renderDigest(digest, user),
    });
    if (result === 'sent') detail.sent++;
    else if (result === 'duplicate') detail.alreadySent++;
    else detail.failed++;
    detail.perUser.push({ userId: user.id, outcome: result === 'duplicate' ? 'already_sent' : result });
  }
  if (detail.failed > 0) {
    throw new Error(
      `daily-digest ${runDate}: ${detail.failed} of ${detail.sent + detail.alreadySent + detail.failed} e-mails failed ` +
        `(sent ${detail.sent}, already sent ${detail.alreadySent}); see email_log — a retry sends only the missing ones`,
    );
  }
  return detail;
}

export interface DigestPreview {
  date: string;
  workingDay: boolean;
  wouldSend: boolean;
  /** Why nothing would be sent: opted_out | nothing | quiet_day | already_sent; null when it would be sent. */
  reason: SkipReason | 'already_sent' | null;
  mail: RenderedMail;
  digest: Digest;
}

/** What the user's digest contains today — nothing is sent or logged. */
export async function previewDigest(db: ScopedDb, userId: string, today: string = todayAthens()): Promise<DigestPreview | null> {
  const user = await db.get<Recipient>('user', userId);
  if (!user) return null;
  const [snap, companyDocs, already] = await Promise.all([
    loadSnapshot(db, today, null),
    user.org_role === 'admin' ? loadCompanyDocs(db) : Promise.resolve([]),
    db.findOne('email_log', { dedupe_key: digestKey(userId, today), status: 'sent' }),
  ]);
  const digest = buildDigest(snap, evaluateTenders(snap), user, companyDocs);
  const decision = decideDigest(digest, readPrefs(user.settings));
  const reason = !decision.send ? decision.reason : already ? 'already_sent' : null;
  return { date: today, workingDay: digest.workingDay, wouldSend: reason === null, reason, mail: renderDigest(digest, user), digest };
}

// ---------------------------------------------------------------------------------------------------------------
// Immediate e-mails (events)
// ---------------------------------------------------------------------------------------------------------------

interface TenderLite {
  id: string;
  title: string;
  submission_deadline_at: Date;
}

/** Sends one rendered mail per recipient who has immediate notifications on (default on). */
async function notify(db: ScopedDb, recipients: Recipient[], kind: string, key: (userId: string) => string, render: (r: Recipient) => RenderedMail): Promise<void> {
  for (const r of recipients) {
    if (!readPrefs(r.settings).immediate) continue;
    await deliver(db, { userId: r.id, to: r.email, kind, dedupeKey: key(r.id), mail: render(r) });
  }
}

async function tenderMembers(db: ScopedDb, tenderId: string, opts: { roleKey?: string; except?: string } = {}): Promise<Recipient[]> {
  const rows = await db.list<{ user_id: string }>('tender_member', { tender_id: tenderId, ...(opts.roleKey ? { tender_role_key: opts.roleKey } : {}) });
  const ids = [...new Set(rows.map((r) => r.user_id))].filter((id) => id !== opts.except);
  return ids.length === 0 ? [] : loadRecipients(db, ids);
}

const stamp = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''));

/** gate.approval_requested → the approver. */
export async function onApprovalRequested(ctx: EventCtx, p: AppEvents['gate.approval_requested']): Promise<void> {
  const { db } = ctx;
  const [tender, gate] = await Promise.all([db.get<TenderLite>('tender', p.tenderId), db.get('gate', p.gateId)]);
  if (!tender || !gate || gate.tender_id !== tender.id) return;
  const approverId: string | null = gate.approver_user_id ?? p.approverUserId ?? null;
  if (!approverId) return;
  const [recipients, milestone, holidays] = await Promise.all([loadRecipients(db, [approverId]), db.get('milestone', gate.milestone_id), loadHolidays(db)]);
  const dueDate: string | null = milestone?.due_date ?? null;
  const gateView = {
    key: String(gate.key ?? milestone?.key ?? ''),
    name: String(milestone?.name ?? ''),
    dueDate,
    tMinus: dueDate ? workingDaysBetween(dueDate, athensDate(tender.submission_deadline_at), holidays) : null,
  };
  await notify(db, recipients, 'gate_approval_requested', (uid) => `gate_request:${gate.id}:${stamp(gate.requested_at)}:${uid}`, (r) =>
    renderApprovalRequested({ tender, gate: gateView, recipientName: r.name, requestedBy: ctx.user?.name ?? null }),
  );
}

/** gate.decided → the tender's members (decision and who took it), except the person who decided. */
export async function onGateDecided(ctx: EventCtx, p: AppEvents['gate.decided']): Promise<void> {
  const { db } = ctx;
  const [tender, gate] = await Promise.all([db.get<TenderLite>('tender', p.tenderId), db.get('gate', p.gateId)]);
  if (!tender || !gate || gate.tender_id !== tender.id) return;
  const deciderId: string | null = gate.decided_by ?? ctx.user?.id ?? null;
  const [recipients, milestone, decider] = await Promise.all([
    tenderMembers(db, tender.id, { except: deciderId ?? undefined }),
    db.get('milestone', gate.milestone_id),
    deciderId ? db.get<{ name: string }>('user', deciderId) : Promise.resolve(null),
  ]);
  const gateView = { key: String(gate.key ?? milestone?.key ?? ''), name: String(milestone?.name ?? '') };
  await notify(db, recipients, 'gate_decided', (uid) => `gate_decided:${gate.id}:${stamp(gate.decided_at)}:${p.decision}:${uid}`, (r) =>
    renderGateDecided({ tender, gate: gateView, decision: p.decision, decidedBy: decider?.name ?? null, recipientName: r.name }),
  );
}

/** oldT / newT arrive as Athens dates or as timestamps; show whichever precision we were given. */
function showDeadline(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatDateTime(d);
}

/** tender.extended → all tender members (old and new deadline, link to the schedule), except who made the change. */
export async function onTenderExtended(ctx: EventCtx, p: AppEvents['tender.extended']): Promise<void> {
  const { db } = ctx;
  const tender = await db.get<TenderLite>('tender', p.tenderId);
  if (!tender) return;
  const [recipients, holidays] = await Promise.all([tenderMembers(db, tender.id, { except: ctx.user?.id }), loadHolidays(db)]);
  const T = athensDate(tender.submission_deadline_at);
  // The tender row already carries the new deadline: use it for the time of day when newT is that same date.
  const newIsCurrent = showDeadline(p.newT) === formatDate(T) || showDeadline(p.newT) === formatDateTime(tender.submission_deadline_at);
  const mailFor = (r: Recipient) =>
    renderTenderExtended({
      tender,
      oldDeadline: showDeadline(p.oldT),
      newDeadline: newIsCurrent ? formatDateTime(tender.submission_deadline_at) : showDeadline(p.newT),
      tMinus: newIsCurrent ? workingDaysBetween(todayAthens(), T, holidays) : null,
      recipientName: r.name,
      changedBy: ctx.user?.name ?? null,
    });
  await notify(db, recipients, 'tender_extended', (uid) => `tender_extended:${tender.id}:${p.oldT}>${p.newT}:${uid}`, mailFor);
}

/** handoff.delivered → the holders of the receiving role, except the person who delivered. */
export async function onHandoffDelivered(ctx: EventCtx, p: AppEvents['handoff.delivered']): Promise<void> {
  const { db } = ctx;
  const [tender, task] = await Promise.all([db.get<TenderLite>('tender', p.tenderId), db.get('task', p.taskId)]);
  if (!tender || !task || task.tender_id !== tender.id || !task.handoff_to_role) return;
  const [recipients, roles] = await Promise.all([
    tenderMembers(db, tender.id, { roleKey: task.handoff_to_role, except: ctx.user?.id }),
    db.list<{ key: string; name: string }>('tender_role', { tender_id: tender.id }),
  ]);
  const roleName = (key: string | null): string | null => (key ? (roles.find((r) => r.key === key)?.name ?? key) : null);
  const taskView = { title: String(task.title), from: roleName(task.handoff_from_role), to: roleName(task.handoff_to_role), dueDate: task.due_date ?? null };
  // One mail per handoff, recipient and day: delivering again the same day does not mail twice.
  await notify(db, recipients, 'handoff_delivered', (uid) => `handoff_delivered:${task.id}:${todayAthens()}:${uid}`, (r) =>
    renderHandoffDelivered({ tender, task: taskView, recipientName: r.name, deliveredBy: ctx.user?.name ?? null }),
  );
}
