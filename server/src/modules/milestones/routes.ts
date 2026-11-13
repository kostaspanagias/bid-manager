// Mounted at /api/tenders/:tenderId/milestones — mergeParams; tender access already checked, tender row on req.tender.
// F3: the tender's schedule. Dates are computed by domain/scheduler.ts; here a date can be pinned by hand (flag
// «χειροκίνητο», never recomputed), released again, and a plain milestone marked done (R10).
import { Router } from 'express';
import { z } from 'zod';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { zDate } from '../../core/http.js';
import { hasRole } from '../../core/permissions.js';
import type { Ctx } from '../../core/types.js';
import type { Row } from '../../db/scoped.js';
import { isWorkingDay, workingDaysBetween } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { todayAthens } from '../../domain/time.js';
import { applyReschedule, isDone, loadMilestones, planReschedule, tenderDates, type MilestoneRow } from '../tenders/schedule.js';
import { assertOpen } from '../tenders/service.js';

export const router: Router = Router({ mergeParams: true });

const patchBody = z
  .object({
    /** pins the milestone on this date (is_manual = true) */
    due_date: zDate.optional(),
    /** plain milestones only — gates are completed by their decision, handoffs by their receipt */
    done: z.boolean().optional(),
    /** only `false`: the manual date was checked after an extension */
    needs_review: z.literal(false).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

function assertManager(ctx: Ctx): void {
  if (!hasRole(ctx, 'admin', 'bid_manager')) throw forbidden('Only a bid manager changes the schedule', 'schedule_manager_only');
}

async function listView(ctx: Ctx, tender: Row) {
  const { db } = ctx;
  const holidays = await loadHolidays(db);
  const { T, T0 } = tenderDates(tender);
  const today = todayAthens();
  const rows = await loadMilestones(db, tender.id);
  const plan = await planReschedule(db, tender, { flagManual: false, holidays, today, compressed: Boolean(tender.compressed_mode) });
  const computed = new Map(plan.result.diff.map((d) => [d.key, d.computed_date]));
  const view = (m: MilestoneRow) => ({
    id: m.id,
    tender_id: m.tender_id,
    key: m.key,
    name: m.name,
    kind: m.kind,
    due_date: m.due_date,
    computed_from: m.computed_from,
    /** where the rules put it now — differs from due_date only for manual / done milestones */
    computed_date: computed.get(m.key) ?? null,
    is_manual: m.is_manual,
    needs_review: m.needs_review,
    done_at: m.done_at,
    /** done_at, a decided gate or a received handoff (R10: such milestones never move) */
    done: isDone(m),
    sort: m.sort,
    /** working days from the milestone to T — the n of T−n (negative: after T) */
    tMinus: m.due_date ? workingDaysBetween(m.due_date, T, holidays) : null,
    is_working_day: m.due_date ? isWorkingDay(m.due_date, holidays) : null,
    overdue: m.due_date != null && m.due_date < today && !isDone(m),
    gate: m.gate_id ? { id: m.gate_id, decision: m.gate_decision } : null,
    handoff: m.handoff_task_id
      ? { task_id: m.handoff_task_id, status: m.handoff_status, received_at: m.handoff_received_at, from_role: m.handoff_from_role, to_role: m.handoff_to_role }
      : null,
  });
  return { items: rows.map(view), T, T0, today, tMinus: workingDaysBetween(today, T, holidays), compressed_mode: Boolean(tender.compressed_mode) };
}

router.get('/', async (req, res) => {
  res.json(await listView(req.ctx, req.tender));
});

async function milestoneOr404(ctx: Ctx, tender: Row, id: string): Promise<MilestoneRow> {
  const rows = await loadMilestones(ctx.db, tender.id);
  const row = rows.find((m) => m.id === id);
  if (!row) throw notFound('Milestone not found', 'milestone_not_found');
  return row;
}

/** Dependents (G0+2 …) follow the milestone's new date; handoff tasks and watch items are re-synced. */
async function reflow(tx: Ctx['db'], tender: Row): Promise<void> {
  const plan = await planReschedule(tx, tender, { flagManual: false, compressed: Boolean(tender.compressed_mode) });
  await applyReschedule(tx, tender, plan);
}

router.patch('/:milestoneId', async (req, res) => {
  const { ctx, tender } = req;
  const body = patchBody.parse(req.body);
  assertOpen(tender);
  const milestone = await milestoneOr404(ctx, tender, String(req.params.milestoneId));
  if (body.due_date !== undefined || body.needs_review !== undefined) assertManager(ctx);

  const patch: Row = {};
  if (body.done !== undefined) {
    if (milestone.kind !== 'milestone') {
      throw unprocessable('A gate is completed by its decision and a handoff by its receipt', { kind: milestone.kind }, 'done_managed_elsewhere');
    }
    if (body.done !== (milestone.done_at != null)) patch.done_at = body.done ? new Date() : null;
  }
  if (body.due_date !== undefined && body.due_date !== milestone.due_date) {
    const stillDone = body.done === undefined ? isDone(milestone) : body.done;
    if (stillDone) throw unprocessable('A completed milestone is not moved', undefined, 'milestone_done');
    patch.due_date = body.due_date;
    patch.is_manual = true;
    patch.needs_review = false;
  }
  if (body.needs_review === false && milestone.needs_review) patch.needs_review = false;

  if (Object.keys(patch).length > 0) {
    await ctx.db.tx(async (tx) => {
      await tx.update('milestone', milestone.id, patch);
      await reflow(tx, tender);
    });
  }
  res.json(await listView(ctx, tender));
});

/** Back to the computed date: clears the manual flag and recomputes the milestone (and whatever hangs on it). */
router.post('/:milestoneId/reset', async (req, res) => {
  const { ctx, tender } = req;
  assertManager(ctx);
  assertOpen(tender);
  const milestone = await milestoneOr404(ctx, tender, String(req.params.milestoneId));
  if (isDone(milestone)) throw unprocessable('A completed milestone is not moved', undefined, 'milestone_done');
  if (milestone.is_manual || milestone.needs_review) {
    await ctx.db.tx(async (tx) => {
      await tx.update('milestone', milestone.id, { is_manual: false, needs_review: false });
      await reflow(tx, tender);
    });
  }
  res.json(await listView(ctx, tender));
});
