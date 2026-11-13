// Decision gates G0–G4 (F4, R11–R14). Reads milestone / gate / gate_criterion rows created by the tenders slice and
// the register, tasks, watchlist and documents of the other slices through the scoped data layer.
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { hasRole } from '../../core/permissions.js';
import type { Ctx } from '../../core/types.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { workingDaysBetween } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { athensDate } from '../../domain/time.js';
import { evaluateRule, loadRuleData, type RuleDetail } from './rules.js';

export const MIN_JUSTIFICATION = 20;
export const CLOSED_STATUSES: readonly string[] = ['submitted', 'no_go', 'cancelled'];
export const DECISIONS_BY_MODE: Record<string, readonly string[]> = {
  approval: ['approved', 'approved_with_exception', 'rejected'],
  go_no_go: ['go', 'no_go'],
};
const POSITIVE = new Set(['approved', 'approved_with_exception', 'go']);

export interface CriterionView {
  id: string;
  key: string | null;
  text: string;
  type: 'manual' | 'auto';
  auto_rule: string | null;
  sort: number;
  /** manual: checked; auto: the live evaluation */
  satisfied: boolean;
  /** auto criteria only */
  detail: RuleDetail | null;
  checked_by: string | null;
  checked_at: Date | null;
  note: string | null;
}

/** What the approver saw when deciding — stored in gate.payload.snapshot. */
export interface GateSnapshot {
  at: string;
  met: number;
  total: number;
  criteria: CriterionView[];
}

export interface GateView {
  id: string;
  tender_id: string;
  milestone_id: string;
  key: string | null;
  name: string;
  due_date: string | null;
  /** n of "T−n": working days from the gate's date to T (negative when the gate is after T); null without a date */
  t_minus: number | null;
  decision_mode: 'approval' | 'go_no_go';
  approver_user_id: string | null;
  approver_role_key: string | null;
  approver: { id: string; name: string; active: boolean } | null;
  decision: string;
  justification: string | null;
  /** true when the decision was taken while criteria were unmet (R12) */
  exception: boolean;
  decided_by: string | null;
  decided_at: Date | null;
  requested_at: Date | null;
  requested_by: string | null;
  criteria: CriterionView[];
  progress: { met: number; total: number };
  all_met: boolean;
  snapshot: GateSnapshot | null;
  /** earlier decisions that were reopened (newest last) */
  history: Row[];
  allowed_decisions: readonly string[];
  permissions: { can_check: boolean; can_request: boolean; can_change_approver: boolean; can_decide: boolean; can_reopen: boolean };
}

type GateCtx = Pick<Ctx, 'user' | 'db'>;

export const isClosed = (tender: Row): boolean => CLOSED_STATUSES.includes(String(tender.status));

function assertOpen(tender: Row): void {
  if (isClosed(tender)) throw unprocessable('The tender is closed and read-only', undefined, 'tender_closed');
}

async function buildViews(ctx: GateCtx, tender: Row, gates: Row[]): Promise<GateView[]> {
  const { db, user } = ctx;
  if (gates.length === 0) return [];
  const gateIds = gates.map((g) => String(g.id));
  // Sequential on purpose: inside a transaction all queries share one connection.
  const milestones = await db.list('milestone', { id: gates.map((g) => g.milestone_id) });
  const criteria = await db.list('gate_criterion', { gate_id: gateIds }, { orderBy: 'sort, created_at, id' });
  const holidays = await loadHolidays(db);
  const milestoneById = new Map(milestones.map((m) => [String(m.id), m]));
  const approverIds = [...new Set(gates.map((g) => g.approver_user_id).filter((id): id is string => typeof id === 'string'))];
  const approvers = approverIds.length ? await db.list('user', { id: approverIds }) : [];
  const approverById = new Map(approvers.map((u) => [String(u.id), u]));

  const rules = new Set(criteria.map((c) => c.auto_rule).filter((r): r is string => typeof r === 'string'));
  const data = await loadRuleData(db, tender, rules);
  const T = athensDate(tender.submission_deadline_at);
  const closed = isClosed(tender);
  const writer = user.org_role !== 'viewer';
  const manager = hasRole(ctx, 'admin', 'bid_manager');

  const views = gates.map((gate): GateView => {
    const milestone = milestoneById.get(String(gate.milestone_id));
    const dueDate: string | null = milestone?.due_date ?? null;
    const own = criteria
      .filter((c) => c.gate_id === gate.id)
      .map((c): CriterionView => {
        const evaluation = c.type === 'auto' ? evaluateRule(String(c.auto_rule), data, dueDate) : null;
        return {
          id: c.id,
          key: c.key ?? null,
          text: c.text,
          type: c.type,
          auto_rule: c.auto_rule ?? null,
          sort: c.sort,
          satisfied: evaluation ? evaluation.satisfied : c.checked_at !== null,
          detail: evaluation ? evaluation.detail : null,
          checked_by: c.checked_by ?? null,
          checked_at: c.checked_at ?? null,
          note: c.note ?? null,
        };
      });
    const met = own.filter((c) => c.satisfied).length;
    const pending = gate.decision === 'pending';
    const approver = gate.approver_user_id ? approverById.get(String(gate.approver_user_id)) : undefined;
    const payload = (gate.payload ?? {}) as { snapshot?: GateSnapshot; exception?: boolean; history?: Row[] };
    return {
      id: gate.id,
      tender_id: gate.tender_id,
      milestone_id: gate.milestone_id,
      key: gate.key ?? milestone?.key ?? null,
      name: milestone?.name ?? gate.key ?? '',
      due_date: dueDate,
      t_minus: dueDate ? (dueDate <= T ? workingDaysBetween(dueDate, T, holidays) : -workingDaysBetween(T, dueDate, holidays)) : null,
      decision_mode: gate.decision_mode,
      approver_user_id: gate.approver_user_id ?? null,
      approver_role_key: gate.approver_role_key ?? null,
      approver: approver ? { id: approver.id, name: approver.name, active: approver.active === true } : null,
      decision: gate.decision,
      justification: gate.justification ?? null,
      exception: !pending && payload.exception === true,
      decided_by: gate.decided_by ?? null,
      decided_at: gate.decided_at ?? null,
      requested_at: gate.requested_at ?? null,
      requested_by: gate.requested_by ?? null,
      criteria: own,
      progress: { met, total: own.length },
      all_met: met === own.length,
      snapshot: !pending && payload.snapshot ? payload.snapshot : null,
      history: Array.isArray(payload.history) ? payload.history : [],
      allowed_decisions: DECISIONS_BY_MODE[String(gate.decision_mode)] ?? [],
      permissions: {
        can_check: !closed && pending && writer,
        can_request: !closed && pending && writer && Boolean(gate.approver_user_id),
        can_change_approver: !closed && pending && manager,
        can_decide: !closed && pending && writer && gate.approver_user_id === user.id,
        can_reopen: !closed && !pending && gate.decision !== 'no_go' && manager,
      },
    };
  });
  // date order; gates without a date last
  return views.sort(
    (a, b) =>
      (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
      (milestoneById.get(a.milestone_id)?.sort ?? 0) - (milestoneById.get(b.milestone_id)?.sort ?? 0) ||
      String(a.key).localeCompare(String(b.key)),
  );
}

export async function listGates(ctx: GateCtx, tender: Row): Promise<GateView[]> {
  return buildViews(ctx, tender, await ctx.db.list('gate', { tender_id: tender.id }));
}

async function loadGate(db: ScopedDb, tender: Row, gateId: string): Promise<Row> {
  const gate = await db.findOne('gate', { id: gateId, tender_id: tender.id });
  if (!gate) throw notFound('Gate not found', 'gate_not_found');
  return gate;
}

export async function getGate(ctx: GateCtx, tender: Row, gateId: string): Promise<GateView> {
  const [view] = await buildViews(ctx, tender, [await loadGate(ctx.db, tender, gateId)]);
  return view!;
}

/** Locks the gate row for the rest of the transaction and returns its current state. */
async function lockGate(tx: ScopedDb, tender: Row, gateId: string): Promise<Row> {
  const gate = await loadGate(tx, tender, gateId);
  await tx.sql('SELECT id FROM gate WHERE org_id = :org_id AND id = :id FOR UPDATE', { id: gate.id });
  return (await tx.get('gate', gate.id)) ?? gate;
}

function assertPending(gate: Row): void {
  if (gate.decision !== 'pending') throw conflict('The gate has already been decided', undefined, 'gate_already_decided');
}

/** Manual criterion: check / uncheck with an optional note. Tender writers only (guard); locked once decided. */
export async function setCriterion(
  ctx: GateCtx,
  tender: Row,
  gateId: string,
  criterionId: string,
  input: { checked?: boolean; note?: string | null },
): Promise<GateView> {
  assertOpen(tender);
  await ctx.db.tx(async (tx) => {
    const gate = await lockGate(tx, tender, gateId);
    assertPending(gate);
    const criterion = await tx.findOne('gate_criterion', { id: criterionId, gate_id: gate.id });
    if (!criterion) throw notFound('Criterion not found', 'criterion_not_found');
    if (criterion.type !== 'manual') {
      throw unprocessable('Automatic criteria are evaluated by the system and cannot be checked by hand', undefined, 'criterion_not_manual');
    }
    const patch: Row = {};
    if (input.checked === true && criterion.checked_at === null) Object.assign(patch, { checked_by: ctx.user.id, checked_at: new Date() });
    if (input.checked === false && criterion.checked_at !== null) Object.assign(patch, { checked_by: null, checked_at: null });
    if (input.note !== undefined) patch.note = input.note?.trim() ? input.note.trim() : null;
    if (Object.keys(patch).length > 0) await tx.update('gate_criterion', criterion.id, patch);
  });
  return getGate(ctx, tender, gateId);
}

/**
 * R11: bid_manager / admin change the approver. The approver must be an active, non-viewer user of the org who can
 * reach the tender (admin, bid_manager or a member of the tender) — otherwise they could never record the decision.
 * A pending approval request is cleared: it was addressed to the previous approver.
 */
export async function setApprover(ctx: GateCtx, tender: Row, gateId: string, approverUserId: string | null): Promise<GateView> {
  if (!hasRole(ctx, 'admin', 'bid_manager')) throw forbidden('Only a bid manager or admin can change the approver', 'approver_change_forbidden');
  assertOpen(tender);
  await ctx.db.tx(async (tx) => {
    const gate = await lockGate(tx, tender, gateId);
    assertPending(gate);
    if ((gate.approver_user_id ?? null) === approverUserId) return;
    if (approverUserId !== null) {
      const user = await tx.get('user', approverUserId);
      if (!user || user.active !== true || user.anonymized_at) {
        throw unprocessable('The approver must be an active user of the organization', undefined, 'approver_invalid');
      }
      if (user.org_role === 'viewer') throw unprocessable('A viewer has read-only access and cannot approve a gate', undefined, 'approver_is_viewer');
      if (user.org_role !== 'admin' && user.org_role !== 'bid_manager') {
        const member = await tx.count('tender_member', { tender_id: tender.id, user_id: user.id });
        if (member === 0) throw unprocessable('Add the user to the tender team before making them approver', undefined, 'approver_not_member');
      }
    }
    await tx.update('gate', gate.id, { approver_user_id: approverUserId, requested_at: null, requested_by: null });
  });
  return getGate(ctx, tender, gateId);
}

/** Request approval: stamps requested_at / requested_by. The caller emits `gate.approval_requested`. */
export async function requestApproval(ctx: GateCtx, tender: Row, gateId: string): Promise<GateView> {
  assertOpen(tender);
  await ctx.db.tx(async (tx) => {
    const gate = await lockGate(tx, tender, gateId);
    assertPending(gate);
    if (!gate.approver_user_id) throw unprocessable('The gate has no approver yet', undefined, 'gate_no_approver');
    await tx.update('gate', gate.id, { requested_at: new Date(), requested_by: ctx.user.id });
  });
  return getGate(ctx, tender, gateId);
}

export interface DecisionResult {
  gate: GateView;
  /** tasks cancelled by a No-Go (R14) */
  cancelledTasks: number;
  tenderStatus: string;
}

/**
 * R11 / R12 / R14. Only the gate's approver decides. With an unmet criterion a plain approval (or Go) is refused;
 * `approved_with_exception` — or, at G0, `go` — passes only with a justification of at least 20 characters, recorded
 * as an exception. `rejected` / `no_go` always need the same justification. The criteria as evaluated at this moment
 * are stored in gate.payload.snapshot.
 */
export async function decideGate(
  ctx: GateCtx,
  tender: Row,
  gateId: string,
  input: { decision: string; justification?: string | null },
): Promise<DecisionResult> {
  const { user } = ctx;
  const justification = (input.justification ?? '').trim();
  let cancelledTasks = 0;
  let tenderStatus = String(tender.status);

  await ctx.db.tx(async (tx) => {
    const gate = await lockGate(tx, tender, gateId);
    if (gate.approver_user_id !== user.id) throw forbidden('Only the approver of this gate can decide', 'not_gate_approver');
    assertOpen(tender);
    assertPending(gate);
    const allowed = DECISIONS_BY_MODE[String(gate.decision_mode)] ?? [];
    if (!allowed.includes(input.decision)) {
      throw unprocessable(`This gate accepts only: ${allowed.join(', ')}`, { allowed }, 'decision_not_allowed');
    }

    const [view] = await buildViews({ user, db: tx }, tender, [gate]);
    const unmet = view!.criteria.filter((c) => !c.satisfied);
    const unmetDetails = { unmet: unmet.map((c) => ({ id: c.id, key: c.key, text: c.text, type: c.type, auto_rule: c.auto_rule, detail: c.detail })) };
    const tooShort = () =>
      unprocessable(
        `A justification of at least ${MIN_JUSTIFICATION} characters is required`,
        { min: MIN_JUSTIFICATION, length: justification.length, ...unmetDetails },
        'justification_too_short',
      );
    const positive = POSITIVE.has(input.decision);
    let exception = false;
    if (input.decision === 'approved') {
      if (unmet.length > 0) {
        throw unprocessable('Exit criteria are not met: only "approved with exception" with a justification is possible', unmetDetails, 'criteria_unmet');
      }
    } else if (input.decision === 'go') {
      if (unmet.length > 0) {
        if (justification === '') {
          throw unprocessable('Exit criteria are not met: Go is possible only as an exception with a justification', unmetDetails, 'criteria_unmet');
        }
        if (justification.length < MIN_JUSTIFICATION) throw tooShort();
        exception = true;
      }
    } else {
      // approved_with_exception, rejected, no_go
      if (justification.length < MIN_JUSTIFICATION) throw tooShort();
      exception = input.decision === 'approved_with_exception';
    }

    const now = new Date();
    const snapshot: GateSnapshot = { at: now.toISOString(), met: view!.progress.met, total: view!.progress.total, criteria: view!.criteria };
    await tx.update('gate', gate.id, {
      decision: input.decision,
      justification: justification === '' ? null : justification,
      decided_by: user.id,
      decided_at: now,
      payload: { ...(gate.payload ?? {}), snapshot, exception },
    });
    if (exception) {
      // R12: the exception and what was unmet, as one explicit audit entry (the update above is audited as well).
      await tx.audit('gate', gate.id, 'exception', {
        tenderId: tender.id,
        after: { decision: input.decision, justification, unmet: unmet.map((c) => ({ id: c.id, text: c.text, auto_rule: c.auto_rule })) },
      });
    }
    if (positive) {
      const milestone = await tx.get('milestone', gate.milestone_id);
      if (milestone && milestone.done_at === null) await tx.update('milestone', milestone.id, { done_at: now });
      // A Go at G0 moves a tender that is still under evaluation into work.
      if (input.decision === 'go' && tender.status === 'evaluation') {
        await tx.update('tender', tender.id, { status: 'in_progress' });
        tenderStatus = 'in_progress';
      }
    }
    if (input.decision === 'no_go') {
      // R14: close the tender and cancel what is still open, atomically with the decision.
      await tx.update('tender', tender.id, { status: 'no_go', closed_at: now });
      tenderStatus = 'no_go';
      const open = await tx.list('task', { tender_id: tender.id, status: ['open', 'in_progress'] });
      for (const task of open) await tx.update('task', task.id, { status: 'cancelled' });
      cancelledTasks = open.length;
    }
  });

  const fresh = (await ctx.db.get('tender', tender.id)) ?? tender;
  return { gate: await getGate(ctx, fresh, gateId), cancelledTasks, tenderStatus };
}

/**
 * bid_manager / admin put a decided gate back to pending, with a reason. The previous decision (with its snapshot)
 * moves to gate.payload.history; the milestone is no longer done. A No-Go that closed the tender is final.
 */
export async function reopenGate(ctx: GateCtx, tender: Row, gateId: string, reason: string): Promise<GateView> {
  if (!hasRole(ctx, 'admin', 'bid_manager')) throw forbidden('Only a bid manager or admin can reopen a decision', 'reopen_forbidden');
  await ctx.db.tx(async (tx) => {
    const gate = await lockGate(tx, tender, gateId);
    if (gate.decision === 'no_go') throw conflict('A No-Go closed the tender and cannot be reopened', undefined, 'no_go_final');
    assertOpen(tender);
    if (gate.decision === 'pending') throw conflict('The gate has not been decided', undefined, 'gate_not_decided');
    const { snapshot, exception, history, ...rest } = (gate.payload ?? {}) as Row;
    const now = new Date();
    const entry = {
      decision: gate.decision,
      justification: gate.justification ?? null,
      exception: exception === true,
      decided_by: gate.decided_by ?? null,
      decided_at: gate.decided_at ?? null,
      snapshot: snapshot ?? null,
      reopened_by: ctx.user.id,
      reopened_at: now.toISOString(),
      reason,
    };
    await tx.update('gate', gate.id, {
      decision: 'pending',
      justification: null,
      decided_by: null,
      decided_at: null,
      requested_at: null,
      requested_by: null,
      payload: { ...rest, history: [...(Array.isArray(history) ? history : []), entry] },
    });
    await tx.audit('gate', gate.id, 'reopen', {
      tenderId: tender.id,
      before: { decision: gate.decision, justification: gate.justification ?? null },
      after: { decision: 'pending', reason },
    });
    const milestone = await tx.get('milestone', gate.milestone_id);
    if (milestone && milestone.done_at !== null) await tx.update('milestone', milestone.id, { done_at: null });
  });
  return getGate(ctx, tender, gateId);
}
