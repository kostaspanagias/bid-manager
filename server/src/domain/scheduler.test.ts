import { describe, expect, it } from 'vitest';
import { TEMPLATE_L11_ITEMS } from '../db/seeds/templateL11.js';
import { addWorkingDays, greekHolidays, isWorkingDay, workingDaysBetween } from './calendar.js';
import {
  COMPRESSED_BELOW,
  computeSchedule,
  conditionApplies,
  GUARANTEE_RISK_BELOW,
  recompute,
  scheduleItemFromComputed,
  scheduleMode,
  toScheduleItems,
  type CurrentMilestone,
  type ScheduleItem,
} from './scheduler.js';
import { lastRequestDate } from './watch.js';

const holidays = new Set([2026, 2027, 2028].flatMap((y) => greekHolidays(y).map((h) => h.date)));
const T = '2027-05-07'; // Friday; Good Friday 30/04 and Easter Monday 03/05 fall inside the schedule
const FLAGS = { has_demo: false, has_partners: false };
const L11 = toScheduleItems(TEMPLATE_L11_ITEMS, FLAGS);
const tMinus = (n: number, from = T) => addWorkingDays(from, -n, holidays);

const item = (key: string, anchor: string, offset_value: number, extra: Partial<ScheduleItem> = {}): ScheduleItem => ({
  key,
  kind: 'milestone',
  name: key,
  sort: 0,
  anchor,
  offset_value,
  offset_unit: 'working',
  ...extra,
});

describe('computeSchedule — offsets (R4, R5) and the L v1.1 defaults (R7)', () => {
  it('acceptance: T = Fri 07/05/2027 → G4 05/05, G3 04/05, G2 29/04, G1 23/04, G0 latest 21/04, upload 06/05', () => {
    const s = computeSchedule({ items: L11, T, T0: '2027-03-01', today: '2026-11-13', holidays });
    expect(s.mode.compressed).toBe(false);
    expect(s.dates).toMatchObject({ G4: '2027-05-05', G3: '2027-05-04', G2: '2027-04-29', G1: '2027-04-23', UPLOAD: '2027-05-06' });
    const g0 = s.entries.find((e) => e.key === 'G0');
    expect(g0?.computed_from).toMatchObject({ anchor: 'T', offset_value: -10, offset_unit: 'working', rule: 'target', latest_date: '2027-04-21', target_date: '2027-03-04' });
    expect(g0?.due_date).toBe('2027-03-04'); // target T0+3 = Thu 04/03
    expect(s.warnings).toEqual([]);
  });

  it('acceptance: last request day of the guarantee = G4 − 10 calendar days = Sun 25/04 → Fri 23/04 (R6)', () => {
    const s = computeSchedule({ items: L11, T, T0: '2027-03-01', today: '2026-11-13', holidays });
    const guarantee = TEMPLATE_L11_ITEMS.find((i) => i.kind === 'watch_item' && i.key === 'guarantee');
    expect(guarantee?.payload).toMatchObject({ lead_value: 10, lead_unit: 'calendar', needed_milestone_key: 'G4' });
    expect(lastRequestDate({ needed_at: s.dates.G4 ?? null, lead_value: 10, lead_unit: 'calendar', requested_at: null, arrived_at: null }, holidays)).toBe('2027-04-23');
  });

  it('T−n is the n-th working day before T, T0+n the n-th after T0, skipping weekends and holidays', () => {
    const s = computeSchedule({ items: [item('a', 'T', -4), item('b', 'T0', 3), item('c', 'T', 0), item('d', 'T', 3)], T, T0: '2027-04-28', today: '2027-01-04', holidays });
    expect(s.dates).toEqual({ a: '2027-04-29', b: '2027-05-05', c: T, d: '2027-05-12' }); // T0+3: Thu 29/04, [30/04, 03/05 holidays], Tue 04/05, Wed 05/05
    for (const d of Object.values(s.dates)) expect(isWorkingDay(d as string, holidays)).toBe(true);
  });

  it('calendar offsets roll back to the previous working day (R5)', () => {
    const s = computeSchedule({ items: [item('g4', 'T', -2), item('req', 'g4', -10, { offset_unit: 'calendar' })], T, T0: null, today: '2027-01-04', holidays });
    expect(s.dates).toEqual({ g4: '2027-05-05', req: '2027-04-23' });
  });

  it('an item anchored on another item counts from that item, whatever the order of the items (G0+2, G0+3, G1)', () => {
    const s = computeSchedule({ items: [...L11].reverse(), T, T0: '2027-03-01', today: '2026-11-13', holidays });
    expect(s.dates.G0).toBe('2027-03-04');
    expect(s.dates.H1).toBe(addWorkingDays('2027-03-04', 2, holidays)); // B → A, G0+2
    expect(s.dates.H2).toBe(addWorkingDays('2027-03-04', 3, holidays)); // A → B, G0+3
    expect(s.dates.H5).toBe(s.dates.H2); // A → C, G0+3
    expect(s.dates.H3).toBe(s.dates.G1); // B → C at G1
    expect(s.dates.H4).toBe(tMinus(9)); // C → B by T−9
    expect(s.dates.H4).toBe('2027-04-22');
  });

  it('G0 = target T0+3 but never later than T−10; warns when the target is after T−12', () => {
    const at = (T0: string | null) => {
      const s = computeSchedule({ items: L11, T, T0, today: '2026-11-13', holidays });
      return { g0: s.entries.find((e) => e.key === 'G0'), warnings: s.warnings };
    };
    // T−12 = Mon 19/04, T−10 = Wed 21/04
    const early = at('2027-04-13'); // target Fri 16/04 ≤ T−12
    expect([early.g0?.due_date, early.g0?.computed_from.rule, early.warnings]).toEqual(['2027-04-16', 'target', []]);
    const onLimit = at('2027-04-14'); // target Mon 19/04 = T−12: no warning
    expect([onLimit.g0?.due_date, onLimit.warnings]).toEqual(['2027-04-19', []]);
    const tight = at('2027-04-15'); // target Tue 20/04: after T−12 but before T−10
    expect(tight.g0?.due_date).toBe('2027-04-20');
    expect(tight.warnings).toEqual([{ code: 'target_after_limit', key: 'G0', target: '2027-04-20', limit: '2027-04-19', latest: '2027-04-21' }]);
    const exact = at('2027-04-16'); // target Wed 21/04 = T−10
    expect([exact.g0?.due_date, exact.g0?.computed_from.rule]).toEqual(['2027-04-21', 'target']);
    const late = at('2027-04-19'); // target Thu 22/04 > T−10 → capped
    expect([late.g0?.due_date, late.g0?.computed_from.rule, late.g0?.computed_from.target_date]).toEqual(['2027-04-21', 'latest', '2027-04-22']);
    expect(late.warnings).toHaveLength(1);
    const unknownT0 = at(null); // no publication date: the binding date
    expect([unknownT0.g0?.due_date, unknownT0.g0?.computed_from.rule, unknownT0.warnings]).toEqual(['2027-04-21', 'latest', []]);
  });

  it('unknown anchors, cycles and a missing T0 give a null date and a warning instead of throwing', () => {
    const s = computeSchedule({
      items: [item('a', 'nope', 1), item('b', 'c', 1), item('c', 'b', 1), item('d', 'T0', 2), item('e', 'a', 1), item('ok', 'T', -1)],
      T,
      T0: null,
      today: '2027-01-04',
      holidays,
    });
    expect(s.dates).toEqual({ a: null, b: null, c: null, d: null, e: null, ok: '2027-05-06' });
    expect(s.warnings.map((w) => `${w.code}:${w.key}`).sort()).toEqual(['a', 'b', 'c', 'd', 'e'].map((k) => `unresolved_anchor:${k}`));
  });

  it('a fixed (manual / done) item keeps its date and its dependents count from it', () => {
    const s = computeSchedule({ items: L11, T, T0: '2027-03-01', today: '2026-11-13', holidays, fixed: { G0: '2027-03-10' } });
    const g0 = s.entries.find((e) => e.key === 'G0');
    expect([g0?.due_date, g0?.computed_date]).toEqual(['2027-03-10', '2027-03-04']);
    expect(s.dates.H1).toBe('2027-03-12');
    expect(s.dates.H2).toBe('2027-03-16'); // Mon 15/03 is Clean Monday
  });
});

describe('compressed mode (R8)', () => {
  it('counts working days from max(T0, today) to T', () => {
    expect(scheduleMode(T, '2027-04-19', '2026-11-13', holidays)).toEqual({ from: '2027-04-19', workingDays: 12, compressed: true, guaranteeAtRisk: false });
    expect(scheduleMode(T, '2027-03-01', '2027-04-19', holidays).workingDays).toBe(12); // today is later than T0
    expect(scheduleMode(T, null, '2027-04-19', holidays).workingDays).toBe(12);
    expect(scheduleMode(T, '2027-04-19', '2027-04-19', holidays).workingDays).toBe(workingDaysBetween('2027-04-19', T, holidays));
  });

  it(`fewer than ${COMPRESSED_BELOW} working days → compressed; fewer than ${GUARANTEE_RISK_BELOW} → guarantee at risk`, () => {
    const mode = (n: number) => scheduleMode(T, tMinus(n), '2026-11-13', holidays);
    expect(mode(15)).toMatchObject({ workingDays: 15, compressed: false, guaranteeAtRisk: false });
    expect(mode(14)).toMatchObject({ workingDays: 14, compressed: true, guaranteeAtRisk: false });
    expect(mode(10)).toMatchObject({ workingDays: 10, compressed: true, guaranteeAtRisk: false });
    expect(mode(9)).toMatchObject({ workingDays: 9, compressed: true, guaranteeAtRisk: true });
    expect(scheduleMode(T, null, '2027-05-10', holidays)).toMatchObject({ workingDays: -1, compressed: true, guaranteeAtRisk: true }); // after T
  });

  it('acceptance: 12 working days from T0 to T → compressed, G1 and G2 both at T−5', () => {
    const s = computeSchedule({ items: L11, T, T0: '2027-04-19', today: '2026-11-13', holidays });
    expect(s.mode).toMatchObject({ workingDays: 12, compressed: true });
    expect(s.dates.G1).toBe('2027-04-28');
    expect(s.dates.G2).toBe('2027-04-28');
    expect(s.dates.G1).toBe(tMinus(5));
    expect(s.entries.find((e) => e.key === 'G1')?.computed_from).toMatchObject({ rule: 'compressed', compressed: { anchor: 'T', offset_value: -5, offset_unit: 'working' } });
    expect(s.dates.H3).toBe('2027-04-28'); // BOM handoff follows G1
    expect(s.dates).toMatchObject({ G0: '2027-04-21', G3: '2027-05-04', G4: '2027-05-05' }); // the rest is unchanged
  });

  it('the stored flag can be passed in so that passing days do not re-evaluate R8', () => {
    const late = computeSchedule({ items: L11, T, T0: '2027-03-01', today: '2027-04-26', holidays, compressed: false });
    expect(late.mode).toMatchObject({ compressed: false, guaranteeAtRisk: true });
    expect(late.dates.G1).toBe('2027-04-23');
    const forced = computeSchedule({ items: L11, T, T0: '2027-03-01', today: '2026-11-13', holidays, compressed: true });
    expect(forced.dates.G2).toBe('2027-04-28');
  });
});

describe('recompute — extension (R9) and completed items (R10)', () => {
  const T0 = '2027-03-01';
  const today = '2027-03-08';
  const before = computeSchedule({ items: L11, T, T0, today, holidays });
  const current = (overrides: Record<string, Partial<CurrentMilestone>> = {}): CurrentMilestone[] =>
    before.entries
      .filter((e) => e.kind !== 'task')
      .map((e) => ({ key: e.key, kind: e.kind, name: e.name, due_date: e.due_date, is_manual: false, done: false, ...overrides[e.key] }));
  const newT = addWorkingDays(T, 5, holidays);

  it('+5 working days: every T-anchored milestone moves by the new offsets, T0-anchored ones stay', () => {
    expect(newT).toBe('2027-05-14');
    const r = recompute({ items: L11, current: current(), T: newT, T0, today, holidays });
    const row = (key: string) => r.diff.find((d) => d.key === key);
    expect(row('G4')).toMatchObject({ old_date: '2027-05-05', new_date: '2027-05-12', changed: true, status: 'moved', needs_review: false });
    expect(row('G3')?.new_date).toBe('2027-05-11');
    expect(row('G2')?.new_date).toBe('2027-05-10');
    expect(row('G1')?.new_date).toBe('2027-05-04');
    expect(row('UPLOAD')?.new_date).toBe('2027-05-13');
    expect(row('H3')?.new_date).toBe('2027-05-04');
    expect(row('H4')?.new_date).toBe('2027-04-29');
    expect(row('G0')).toMatchObject({ old_date: '2027-03-04', new_date: '2027-03-04', changed: false, status: 'unchanged' });
    expect(row('H1')).toMatchObject({ changed: false, status: 'unchanged' });
    expect(r.diff).toHaveLength(current().length);
    expect(r.dates.WP11).toBe(addWorkingDays(newT, 3, holidays)); // dated template tasks are computed too
  });

  it('manual milestones stay and are flagged for review; done ones stay and are not flagged', () => {
    const cur = current({
      G2: { is_manual: true, due_date: '2027-04-27' },
      G1: { done: true },
      UPLOAD: { is_manual: true, done: true, due_date: '2027-05-06' },
    });
    const snapshot = JSON.stringify(cur);
    const r = recompute({ items: L11, current: cur, T: newT, T0, today, holidays });
    const row = (key: string) => r.diff.find((d) => d.key === key);
    expect(row('G2')).toMatchObject({ old_date: '2027-04-27', new_date: '2027-04-27', changed: false, status: 'manual', needs_review: true, computed_date: '2027-05-10' });
    expect(row('G1')).toMatchObject({ old_date: '2027-04-23', new_date: '2027-04-23', changed: false, status: 'done', needs_review: false, computed_date: '2027-05-04' });
    expect(row('UPLOAD')).toMatchObject({ status: 'done', changed: false, needs_review: false });
    expect(row('H3')).toMatchObject({ new_date: '2027-04-23', changed: false }); // hangs on the done G1, so it stays with it
    expect(r.diff.filter((d) => d.changed).map((d) => d.key).sort()).toEqual(['G3', 'G4', 'H4']);
    expect(JSON.stringify(cur)).toBe(snapshot); // pure: the input is not modified
  });

  it('dependents of a manual milestone count from its manual date', () => {
    const cur = current({ G0: { is_manual: true, due_date: '2027-03-10' } });
    const r = recompute({ items: L11, current: cur, T, T0, today, holidays, flagManual: false });
    const row = (key: string) => r.diff.find((d) => d.key === key);
    expect(row('G0')).toMatchObject({ status: 'manual', needs_review: false, computed_date: '2027-03-04' });
    expect(row('H1')).toMatchObject({ old_date: '2027-03-08', new_date: '2027-03-12', status: 'moved' });
    expect(row('H2')?.new_date).toBe('2027-03-16'); // Mon 15/03 is Clean Monday
    expect(r.dates.WP1).toBe('2027-03-10');
  });

  it('flagManual = false keeps an existing review flag; a milestone without a rule is left alone', () => {
    const cur = [...current({ G2: { is_manual: true, needs_review: true } }), { key: 'CUSTOM', due_date: '2027-04-01', is_manual: false, done: false }];
    const r = recompute({ items: L11, current: cur, T: newT, T0, today, holidays, flagManual: false });
    expect(r.diff.find((d) => d.key === 'G2')).toMatchObject({ status: 'manual', needs_review: true });
    expect(r.diff.find((d) => d.key === 'CUSTOM')).toMatchObject({ status: 'no_rule', changed: false, new_date: '2027-04-01', kind: 'milestone', name: 'CUSTOM' });
  });

  it('an extension re-evaluates compressed mode: out of it, G1 and G2 separate again', () => {
    const tight = computeSchedule({ items: L11, T, T0: '2027-04-19', today: '2027-04-19', holidays });
    expect(tight.mode.compressed).toBe(true);
    const cur = tight.entries.filter((e) => e.kind !== 'task').map((e) => ({ key: e.key, due_date: e.due_date, is_manual: false, done: false }));
    const r = recompute({ items: L11, current: cur, T: newT, T0: '2027-04-19', today: '2027-04-19', holidays });
    expect(r.mode).toMatchObject({ workingDays: 17, compressed: false });
    expect(r.diff.find((d) => d.key === 'G1')).toMatchObject({ old_date: '2027-04-28', new_date: '2027-05-04' });
    expect(r.diff.find((d) => d.key === 'G2')).toMatchObject({ old_date: '2027-04-28', new_date: '2027-05-10' });
  });
});

describe('template items → schedule items', () => {
  it('conditions: always / demo / partners (F2)', () => {
    expect(conditionApplies('always', FLAGS)).toBe(true);
    expect(conditionApplies(null, FLAGS)).toBe(true);
    expect(conditionApplies('demo', FLAGS)).toBe(false);
    expect(conditionApplies('demo', { has_demo: true, has_partners: false })).toBe(true);
    expect(conditionApplies('partners', { has_demo: true, has_partners: false })).toBe(false);
    expect(conditionApplies('partners', { has_demo: false, has_partners: true })).toBe(true);
  });

  it('takes gates, milestones, handoffs and dated tasks; skips undated and conditional items', () => {
    const keys = (flags: typeof FLAGS) => toScheduleItems(TEMPLATE_L11_ITEMS, flags).map((i) => i.key);
    expect(keys(FLAGS)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'UPLOAD', 'H1', 'H2', 'H3', 'H4', 'H5', 'WP1', 'WP3', 'WP5', 'WP6', 'WP7', 'WP9', 'WP10', 'WP11']);
    expect(keys({ has_demo: true, has_partners: true })).toEqual(expect.arrayContaining(['WP4', 'WP8']));
    const g0 = L11.find((i) => i.key === 'G0');
    expect(g0).toMatchObject({ kind: 'gate', anchor: 'T', offset_value: -10, target: { anchor: 'T0', offset_value: 3, offset_unit: 'working' }, warn_if_target_after: { anchor: 'T', offset_value: -12 } });
    expect(L11.find((i) => i.key === 'G4')).not.toHaveProperty('compressed');
  });

  it('a stored computed_from is enough to rebuild the rule', () => {
    const s = computeSchedule({ items: L11, T, T0: '2027-03-01', today: '2026-11-13', holidays });
    const rebuilt = s.entries.map((e) => scheduleItemFromComputed({ key: e.key, kind: e.kind, name: e.name, sort: e.sort, computed_from: JSON.parse(JSON.stringify(e.computed_from)) }));
    expect(rebuilt).toEqual(L11);
    expect(scheduleItemFromComputed({ key: 'x', kind: 'milestone', name: 'x', computed_from: null })).toBeNull();
    expect(scheduleItemFromComputed({ key: 'x', kind: 'milestone', name: 'x', computed_from: { offset_value: 2 } })).toBeNull();
  });
});
