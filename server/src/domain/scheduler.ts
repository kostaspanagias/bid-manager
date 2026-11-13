// Reverse scheduler (F3, R4–R10). Pure: no database, no clock — everything comes in as arguments and every date
// is a 'YYYY-MM-DD' string. Offsets, targets and the compressed-mode positions are DATA (template items); the only
// constants here are the two R8 thresholds.
import { applyOffset, workingDaysBetween, type Holidays, type OffsetUnit } from './calendar.js';

/** R8: fewer working days than this from max(T0, today) to T → compressed mode. */
export const COMPRESSED_BELOW = 15;
/** R8: fewer than this → "the guarantee will not make it without an immediate request". */
export const GUARANTEE_RISK_BELOW = 10;

export interface OffsetSpec {
  /** 'T' | 'T0' | key of another item */
  anchor: string;
  /** signed: −8 with anchor T = T−8, 3 with anchor T0 = T0+3 */
  offset_value: number;
  offset_unit: OffsetUnit;
}

export type ScheduleKind = 'gate' | 'milestone' | 'handoff' | 'task';

/** One dated thing of a tender's schedule. `anchor/offset_*` is the binding ("latest") rule. */
export interface ScheduleItem extends OffsetSpec {
  key: string;
  kind: ScheduleKind;
  name: string;
  sort: number;
  /** Earlier wish date (G0: T0+3); the item lands on min(target, binding rule). */
  target?: OffsetSpec;
  /** R7: warn when the target falls after this (G0: T−12). */
  warn_if_target_after?: OffsetSpec;
  /** R8: replaces the binding rule in compressed mode (G1, G2: T−5); the target is ignored then. */
  compressed?: OffsetSpec;
}

/** What `milestone.computed_from` stores: the rule itself (enough to recompute) plus how it was resolved. */
export interface ComputedFrom extends OffsetSpec {
  target?: OffsetSpec;
  warn_if_target_after?: OffsetSpec;
  compressed?: OffsetSpec;
  /** which rule produced the date */
  rule: 'offset' | 'target' | 'latest' | 'compressed';
  /** date of the binding rule (G0: T−10) and of the target (G0: T0+3), when the item has a target */
  latest_date?: string | null;
  target_date?: string | null;
}

export interface ScheduleMode {
  /** max(T0, today) — the day the count starts from */
  from: string;
  /** working days in (from, T] */
  workingDays: number;
  compressed: boolean;
  guaranteeAtRisk: boolean;
}

export type ScheduleWarning =
  | { code: 'target_after_limit'; key: string; target: string; limit: string; latest: string | null }
  | { code: 'unresolved_anchor'; key: string; anchor: string };

export interface ScheduleEntry {
  key: string;
  kind: ScheduleKind;
  name: string;
  sort: number;
  /** effective date: the fixed date when the item is pinned, the computed one otherwise */
  due_date: string | null;
  /** what the rules give, even for a pinned item */
  computed_date: string | null;
  computed_from: ComputedFrom;
}

export interface ScheduleInput {
  items: readonly ScheduleItem[];
  /** Athens date of the submission deadline */
  T: string;
  /** Athens date of publication; null when unknown (T0-anchored rules then do not resolve) */
  T0: string | null;
  today: string;
  holidays: Holidays;
  /** key → date of items that must stay where they are (manual / done); their dependents count from that date. */
  fixed?: Readonly<Record<string, string | null>>;
  /**
   * Use this compressed-mode value instead of evaluating R8 now. Recomputations that are not a deadline change
   * (a manual date, a reset) pass the tender's stored flag, so the mere passing of days never merges G1 and G2.
   */
  compressed?: boolean;
}

export interface Schedule {
  mode: ScheduleMode;
  entries: ScheduleEntry[];
  /** key → effective date */
  dates: Record<string, string | null>;
  warnings: ScheduleWarning[];
}

/** R8: working days from max(T0, today) to T decide compressed mode and the guarantee alarm. */
export function scheduleMode(T: string, T0: string | null, today: string, holidays: Holidays): ScheduleMode {
  const from = T0 !== null && T0 > today ? T0 : today;
  const workingDays = workingDaysBetween(from, T, holidays);
  return { from, workingDays, compressed: workingDays < COMPRESSED_BELOW, guaranteeAtRisk: workingDays < GUARANTEE_RISK_BELOW };
}

const RESERVED = new Set(['T', 'T0']);

/**
 * Computes every item's date (R4/R5 through calendar.ts) in dependency order: an item anchored on another item
 * counts from that item's effective date. Items whose anchor cannot be resolved (unknown key, cycle, T0 missing)
 * get a null date and an `unresolved_anchor` warning instead of throwing — a broken template row must not make a
 * tender uncreatable.
 */
export function computeSchedule(input: ScheduleInput): Schedule {
  const { items, T, T0, today, holidays, fixed = {} } = input;
  const evaluated = scheduleMode(T, T0, today, holidays);
  const mode: ScheduleMode = input.compressed === undefined ? evaluated : { ...evaluated, compressed: input.compressed };
  const byKey = new Map<string, ScheduleItem>();
  for (const item of items) if (!RESERVED.has(item.key) && !byKey.has(item.key)) byKey.set(item.key, item);

  const warnings: ScheduleWarning[] = [];
  const done = new Map<string, ScheduleEntry>();
  const visiting = new Set<string>();

  const anchorDate = (anchor: string): string | null => {
    if (anchor === 'T') return T;
    if (anchor === 'T0') return T0;
    const item = byKey.get(anchor);
    return item ? resolve(item).due_date : null;
  };
  const specDate = (spec: OffsetSpec): string | null => {
    const base = anchorDate(spec.anchor);
    return base === null ? null : applyOffset(base, spec.offset_value, spec.offset_unit, holidays);
  };

  function resolve(item: ScheduleItem): ScheduleEntry {
    const known = done.get(item.key);
    if (known) return known;
    const rule: OffsetSpec = { anchor: item.anchor, offset_value: item.offset_value, offset_unit: item.offset_unit };
    const computed_from: ComputedFrom = { ...rule, rule: 'offset' };
    if (item.target) computed_from.target = item.target;
    if (item.warn_if_target_after) computed_from.warn_if_target_after = item.warn_if_target_after;
    if (item.compressed) computed_from.compressed = item.compressed;
    const entry: ScheduleEntry = { key: item.key, kind: item.kind, name: item.name, sort: item.sort, due_date: null, computed_date: null, computed_from };

    if (visiting.has(item.key)) return entry; // cycle: the caller reports it
    visiting.add(item.key);

    let computed: string | null;
    if (mode.compressed && item.compressed) {
      computed = specDate(item.compressed);
      computed_from.rule = 'compressed';
    } else {
      computed = specDate(rule);
      if (item.target) {
        const target = specDate(item.target);
        computed_from.latest_date = computed;
        computed_from.target_date = target;
        if (target !== null && (computed === null || target <= computed)) {
          computed = target;
          computed_from.rule = 'target';
        } else {
          computed_from.rule = 'latest';
        }
        if (item.warn_if_target_after && target !== null) {
          const limit = specDate(item.warn_if_target_after);
          if (limit !== null && target > limit) {
            warnings.push({ code: 'target_after_limit', key: item.key, target, limit, latest: computed_from.latest_date ?? null });
          }
        }
      }
    }
    visiting.delete(item.key);

    if (computed === null) {
      const used = mode.compressed && item.compressed ? item.compressed.anchor : item.anchor;
      warnings.push({ code: 'unresolved_anchor', key: item.key, anchor: used });
    }
    entry.computed_date = computed;
    entry.due_date = Object.hasOwn(fixed, item.key) ? (fixed[item.key] ?? null) : computed;
    done.set(item.key, entry);
    return entry;
  }

  const entries = [...byKey.values()].map(resolve);
  const dates: Record<string, string | null> = {};
  for (const e of entries) dates[e.key] = e.due_date;
  return { mode, entries, dates, warnings };
}

/** The state of an existing milestone row, as far as recomputing is concerned. */
export interface CurrentMilestone {
  key: string;
  kind?: ScheduleKind;
  name?: string;
  due_date: string | null;
  is_manual: boolean;
  /** done_at set, gate decided or handoff received (R10) */
  done: boolean;
  needs_review?: boolean;
}

export type DiffStatus = 'moved' | 'unchanged' | 'manual' | 'done' | 'no_rule';

export interface DiffRow {
  key: string;
  kind: ScheduleKind;
  name: string;
  old_date: string | null;
  new_date: string | null;
  /** new_date differs from old_date */
  changed: boolean;
  /** moved / unchanged = recomputed; manual / done = kept on purpose; no_rule = no schedule rule known for the row */
  status: DiffStatus;
  /** what the rules would give for a manual/done row (for the reviewer) */
  computed_date: string | null;
  is_manual: boolean;
  done: boolean;
  /** value the row's needs_review flag should have after applying */
  needs_review: boolean;
  computed_from: ComputedFrom | null;
}

export interface RecomputeInput extends Omit<ScheduleInput, 'fixed'> {
  current: readonly CurrentMilestone[];
  /** R9: flag manual, not-done milestones for review (true for a deadline change). Default true. */
  flagManual?: boolean;
}

export interface Recomputed {
  mode: ScheduleMode;
  warnings: ScheduleWarning[];
  /** one row per existing milestone, in the order of `current` */
  diff: DiffRow[];
  /** effective date of every scheduled item, including ones without a milestone row (template tasks) */
  dates: Record<string, string | null>;
  entries: ScheduleEntry[];
}

/**
 * R9/R10: recompute the schedule against existing milestones WITHOUT persisting anything. Milestones that are
 * manual or done stay where they are (their dependents count from where they actually are); manual, not-done
 * ones are flagged `needs_review` when `flagManual`. Returns old → new per milestone.
 */
export function recompute(input: RecomputeInput): Recomputed {
  const { current, flagManual = true, ...rest } = input;
  const fixed: Record<string, string | null> = {};
  for (const m of current) if (m.is_manual || m.done) fixed[m.key] = m.due_date;
  const schedule = computeSchedule({ ...rest, fixed });
  const byKey = new Map(schedule.entries.map((e) => [e.key, e]));

  const diff = current.map((m): DiffRow => {
    const entry = byKey.get(m.key);
    const pinned = m.done ? 'done' : m.is_manual ? 'manual' : null;
    const base = {
      key: m.key,
      kind: entry?.kind ?? m.kind ?? 'milestone',
      name: entry?.name ?? m.name ?? m.key,
      old_date: m.due_date,
      is_manual: m.is_manual,
      done: m.done,
      computed_date: entry?.computed_date ?? null,
      computed_from: entry?.computed_from ?? null,
    };
    if (pinned || !entry || entry.computed_date === null) {
      const status: DiffStatus = pinned ?? 'no_rule';
      const needs_review = status === 'manual' ? flagManual || Boolean(m.needs_review) : status === 'done' ? false : Boolean(m.needs_review);
      return { ...base, new_date: m.due_date, changed: false, status, needs_review };
    }
    const changed = entry.computed_date !== m.due_date;
    return { ...base, new_date: entry.computed_date, changed, status: changed ? 'moved' : 'unchanged', needs_review: false };
  });

  // pinned rows without a computable rule must still anchor their dependents on the real date
  const dates = { ...schedule.dates };
  for (const row of diff) dates[row.key] = row.new_date;
  return { mode: schedule.mode, warnings: schedule.warnings, diff, dates, entries: schedule.entries };
}

/* ------------------------------------------------------------------ template items → schedule items */

/** The columns of a `template_item` (or of a row inside `tender.template_snapshot.items`) the scheduler reads. */
export interface TemplateItemLike {
  kind: string;
  key?: string | null;
  name: string;
  anchor?: string | null;
  offset_value?: number | null;
  offset_unit?: string | null;
  condition?: string | null;
  sort?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface TenderFlags {
  has_demo: boolean;
  has_partners: boolean;
}

/** F2: an item applies when its condition is `always` or the matching flag is set. */
export function conditionApplies(condition: string | null | undefined, flags: TenderFlags): boolean {
  if (condition === 'demo') return flags.has_demo;
  if (condition === 'partners') return flags.has_partners;
  return true;
}

function asSpec(value: unknown): OffsetSpec | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.anchor !== 'string' || v.anchor === '') return undefined;
  const n = Number(v.offset_value ?? 0);
  if (!Number.isInteger(n)) return undefined;
  return { anchor: v.anchor, offset_value: n, offset_unit: v.offset_unit === 'calendar' ? 'calendar' : 'working' };
}

const SCHEDULED: ReadonlySet<string> = new Set(['gate', 'milestone', 'handoff', 'task']);

/**
 * Template items (or a tender's snapshot) → the scheduler's input: gates, milestones, handoffs and dated tasks
 * whose condition applies and that have an anchor. Gate extras come from the payload (`target`,
 * `warn_if_target_after`, `compressed`).
 */
export function toScheduleItems(items: readonly TemplateItemLike[], flags: TenderFlags): ScheduleItem[] {
  const out: ScheduleItem[] = [];
  items.forEach((item, index) => {
    if (!SCHEDULED.has(item.kind) || !item.key || !conditionApplies(item.condition, flags)) return;
    const rule = asSpec({ anchor: item.anchor, offset_value: item.offset_value, offset_unit: item.offset_unit });
    if (!rule) return;
    const si: ScheduleItem = { key: item.key, kind: item.kind as ScheduleKind, name: item.name, sort: item.sort ?? index, ...rule };
    const payload = item.payload ?? {};
    const target = asSpec(payload.target);
    const warn = asSpec(payload.warn_if_target_after);
    const compressed = asSpec(payload.compressed);
    if (target) si.target = target;
    if (warn) si.warn_if_target_after = warn;
    if (compressed) si.compressed = compressed;
    out.push(si);
  });
  return out;
}

/** Rebuilds a schedule item from a stored `computed_from` (tenders whose milestones did not come from a snapshot). */
export function scheduleItemFromComputed(
  row: { key: string; kind: string; name: string; sort?: number | null; computed_from: unknown },
): ScheduleItem | null {
  const rule = asSpec(row.computed_from);
  if (!rule) return null;
  const cf = row.computed_from as Record<string, unknown>;
  const si: ScheduleItem = { key: row.key, kind: (SCHEDULED.has(row.kind) ? row.kind : 'milestone') as ScheduleKind, name: row.name, sort: row.sort ?? 0, ...rule };
  const target = asSpec(cf.target);
  const warn = asSpec(cf.warn_if_target_after);
  const compressed = asSpec(cf.compressed);
  if (target) si.target = target;
  if (warn) si.warn_if_target_after = warn;
  if (compressed) si.compressed = compressed;
  return si;
}
