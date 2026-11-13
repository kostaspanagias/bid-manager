// The database side of the reverse scheduler (F3): loads a tender's schedule state, plans a recomputation with the
// pure domain/scheduler.ts and applies it — milestones first, then everything that mirrors a milestone date
// (handoff tasks, watch items, dated template tasks). Used by the tenders and milestones modules.
import type { Row, ScopedDb } from '../../db/scoped.js';
import type { Holidays } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import {
  recompute,
  scheduleItemFromComputed,
  toScheduleItems,
  type CurrentMilestone,
  type Recomputed,
  type ScheduleItem,
  type TemplateItemLike,
} from '../../domain/scheduler.js';
import { athensDate, todayAthens } from '../../domain/time.js';

export interface SnapshotItem extends TemplateItemLike {
  owner_role_key?: string | null;
}
/** Shape of `tender.template_snapshot` (F2): the full copy of the template the tender was created from. */
export interface TemplateSnapshot {
  template: { id: string; name: string; version: string; description?: string | null };
  applied_at: string;
  items: SnapshotItem[];
}

export function snapshotOf(tender: Row): TemplateSnapshot | null {
  const s = tender.template_snapshot as TemplateSnapshot | null | undefined;
  return s && Array.isArray(s.items) ? s : null;
}

/** T and T0 as Athens-local dates (R3). */
export function tenderDates(tender: Row): { T: string; T0: string | null } {
  return { T: athensDate(tender.submission_deadline_at), T0: tender.t0_published_at ? athensDate(tender.t0_published_at) : null };
}

/** Gate decisions after which the gate's milestone counts as completed (R10). A rejected gate is still to be passed. */
const GATE_DONE = new Set(['approved', 'approved_with_exception', 'go', 'no_go']);

export interface MilestoneRow extends Row {
  id: string;
  key: string;
  kind: string;
  name: string;
  due_date: string | null;
  computed_from: unknown;
  sort: number;
  is_manual: boolean;
  needs_review: boolean;
  done_at: Date | null;
  gate_id: string | null;
  gate_decision: string | null;
  handoff_task_id: string | null;
  handoff_status: string | null;
  handoff_received_at: Date | null;
  handoff_from_role: string | null;
  handoff_to_role: string | null;
}

/** R10: completed = done_at, or a decided gate, or a received handoff (whoever recorded it). */
export function isDone(m: MilestoneRow): boolean {
  return m.done_at != null || (m.gate_decision != null && GATE_DONE.has(m.gate_decision)) || m.handoff_received_at != null;
}

export async function loadMilestones(db: ScopedDb, tenderId: string): Promise<MilestoneRow[]> {
  return db.sql<MilestoneRow>(
    `SELECT m.*, g.id AS gate_id, g.decision AS gate_decision,
            h.id AS handoff_task_id, h.status AS handoff_status, h.received_at AS handoff_received_at,
            h.handoff_from_role, h.handoff_to_role
       FROM milestone m
       LEFT JOIN gate g ON g.org_id = m.org_id AND g.milestone_id = m.id
       LEFT JOIN LATERAL (
         SELECT t.id, t.status, t.received_at, t.handoff_from_role, t.handoff_to_role FROM task t
          WHERE t.org_id = m.org_id AND t.milestone_id = m.id AND t.section = 'handoff'
          ORDER BY t.created_at LIMIT 1
       ) h ON true
      WHERE m.org_id = :org_id AND m.tender_id = :tender_id
      ORDER BY m.due_date NULLS LAST, m.sort, m.key`,
    { tender_id: tenderId },
  );
}

export interface ScheduleState {
  holidays: Holidays;
  items: ScheduleItem[];
  milestones: MilestoneRow[];
  current: CurrentMilestone[];
}

/**
 * The scheduler's input for a tender: rules from the template snapshot (condition-filtered by the tender's flags);
 * milestones the snapshot does not know fall back to the rule stored in their own `computed_from`.
 */
export async function loadScheduleState(db: ScopedDb, tender: Row, holidays?: Holidays): Promise<ScheduleState> {
  const milestones = await loadMilestones(db, tender.id);
  const snapshot = snapshotOf(tender);
  const items = snapshot ? toScheduleItems(snapshot.items, { has_demo: Boolean(tender.has_demo), has_partners: Boolean(tender.has_partners) }) : [];
  const known = new Set(items.map((i) => i.key));
  for (const m of milestones) {
    if (known.has(m.key)) continue;
    const item = scheduleItemFromComputed(m);
    if (item) items.push(item);
  }
  const current = milestones.map((m) => ({
    key: m.key,
    kind: m.kind as CurrentMilestone['kind'],
    name: m.name,
    due_date: m.due_date,
    is_manual: m.is_manual,
    done: isDone(m),
    needs_review: m.needs_review,
  }));
  return { holidays: holidays ?? (await loadHolidays(db)), items, milestones, current };
}

export interface ReschedulePlan {
  state: ScheduleState;
  result: Recomputed;
  T: string;
  T0: string | null;
  today: string;
}

/**
 * Recomputes without persisting (R9 preview). `T`/`T0` default to the tender's current values. Pass
 * `compressed: tender.compressed_mode` for anything that is not a deadline change, so R8 is not re-evaluated.
 */
export async function planReschedule(
  db: ScopedDb,
  tender: Row,
  opts: { T?: string; T0?: string | null; flagManual: boolean; today?: string; holidays?: Holidays; compressed?: boolean },
): Promise<ReschedulePlan> {
  const state = await loadScheduleState(db, tender, opts.holidays);
  const dates = tenderDates(tender);
  const T = opts.T ?? dates.T;
  const T0 = opts.T0 === undefined ? dates.T0 : opts.T0;
  const today = opts.today ?? todayAthens();
  const result = recompute({ items: state.items, current: state.current, T, T0, today, holidays: state.holidays, flagManual: opts.flagManual, compressed: opts.compressed });
  return { state, result, T, T0, today };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Persists a plan inside the caller's transaction: milestone dates / computed_from / needs_review, then the rows
 * that mirror milestone dates. Does not touch the tender row (the caller owns it). Returns how many milestones moved.
 */
export async function applyReschedule(tx: ScopedDb, tender: Row, plan: ReschedulePlan): Promise<{ moved: number }> {
  const byKey = new Map(plan.state.milestones.map((m) => [m.key, m]));
  let moved = 0;
  for (const row of plan.result.diff) {
    const m = byKey.get(row.key);
    if (!m) continue;
    const patch: Row = {};
    if (row.changed) patch.due_date = row.new_date;
    if ((row.status === 'moved' || row.status === 'unchanged') && row.computed_from && !same(row.computed_from, m.computed_from)) {
      patch.computed_from = row.computed_from;
    }
    if (row.needs_review !== m.needs_review) patch.needs_review = row.needs_review;
    if (Object.keys(patch).length === 0) continue;
    await tx.update('milestone', m.id, patch);
    if (row.changed) moved++;
  }
  await syncDerived(tx, tender.id, plan.result.dates);
  return { moved };
}

/**
 * Keeps everything that mirrors a milestone date in step with the milestones as they are now:
 *  - handoff tasks: `due_date` = their milestone's date;
 *  - watch items with `needed_milestone_key`: `needed_at` = that milestone's date (R6 input);
 *  - dated template tasks (payload.computed_from): follow their anchor as long as nobody changed the date by hand
 *    and the task is still open.
 */
export async function syncDerived(tx: ScopedDb, tenderId: string, dates?: Readonly<Record<string, string | null>>): Promise<void> {
  const handoffs = await tx.sql<{ id: string; due_date: string | null }>(
    `SELECT t.id, m.due_date FROM task t JOIN milestone m ON m.org_id = t.org_id AND m.id = t.milestone_id
      WHERE t.org_id = :org_id AND t.tender_id = :tender_id AND t.section = 'handoff' AND t.due_date IS DISTINCT FROM m.due_date`,
    { tender_id: tenderId },
  );
  for (const h of handoffs) await tx.update('task', h.id, { due_date: h.due_date });

  const watch = await tx.sql<{ id: string; due_date: string | null }>(
    `SELECT w.id, m.due_date FROM watch_item w JOIN milestone m ON m.org_id = w.org_id AND m.tender_id = w.tender_id AND m.key = w.needed_milestone_key
      WHERE w.org_id = :org_id AND w.tender_id = :tender_id AND w.needed_at IS DISTINCT FROM m.due_date`,
    { tender_id: tenderId },
  );
  for (const w of watch) await tx.update('watch_item', w.id, { needed_at: w.due_date });

  if (!dates) return;
  const tasks = await tx.sql<{ id: string; key: string; due_date: string | null; payload: Row }>(
    `SELECT id, key, due_date, payload FROM task
      WHERE org_id = :org_id AND tender_id = :tender_id AND section = 'task' AND key IS NOT NULL
        AND status IN ('open', 'in_progress') AND payload->'computed_from' IS NOT NULL`,
    { tender_id: tenderId },
  );
  for (const t of tasks) {
    const next = dates[t.key];
    if (next == null || next === t.due_date) continue;
    if ((t.payload.computed_due ?? null) !== t.due_date) continue; // somebody set this date by hand: leave it
    await tx.update('task', t.id, { due_date: next, payload: { ...t.payload, computed_due: next } });
  }
}
