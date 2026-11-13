import { describe, expect, it } from 'vitest';
import { createOrg, dbFor } from '../../test/harness.js';
import { seedTemplateL11, TEMPLATE_L11_ITEMS } from './templateL11.js';

describe('seedTemplateL11 — template «L v1.1» (F2, R7, R13)', () => {
  it('creates a published template with every blueprint item, idempotently and per organization', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const db = dbFor(org);
    const first = await seedTemplateL11(db);
    expect(first).toMatchObject({ created: true, items: TEMPLATE_L11_ITEMS.length });
    expect(first.template).toMatchObject({ name: 'L', version: 'v1.1', status: 'published' });
    expect(first.template.published_at).toBeInstanceOf(Date);

    const second = await seedTemplateL11(db);
    expect(second).toMatchObject({ created: false, items: TEMPLATE_L11_ITEMS.length });
    expect(second.template.id).toBe(first.template.id);
    expect(await db.count('template')).toBe(1);
    expect(await db.count('template_item')).toBe(TEMPLATE_L11_ITEMS.length);
    expect(await dbFor(other).count('template')).toBe(0);

    const items = await db.list('template_item', { template_id: first.template.id }, { orderBy: 'sort' });
    expect(items.map((i) => i.key)).toEqual(TEMPLATE_L11_ITEMS.map((i) => i.key));
    const count = (kind: string, condition?: string) => items.filter((i) => i.kind === kind && (!condition || i.condition === condition)).length;
    expect({ role: count('role'), gate: count('gate'), criterion: count('gate_criterion'), milestone: count('milestone'), handoff: count('handoff') }).toEqual({
      role: 4,
      gate: 5,
      criterion: 30,
      milestone: 1,
      handoff: 5,
    });
    expect([count('checklist_item'), count('checklist_item', 'partners'), count('checklist_item', 'demo')]).toEqual([21, 2, 2]);
    expect([count('watch_item'), count('watch_item', 'partners'), count('watch_item', 'demo')]).toEqual([8, 1, 1]);
    expect([count('task'), count('task', 'partners'), count('task', 'demo')]).toEqual([11, 1, 1]);
  });

  it('roles: C is the financial role, MGMT is management', () => {
    const roles = TEMPLATE_L11_ITEMS.filter((i) => i.kind === 'role');
    expect(roles.map((r) => [r.key, r.payload?.folder ?? null])).toEqual([
      ['A', 'participation'],
      ['B', 'technical'],
      ['C', 'financial'],
      ['MGMT', null],
    ]);
    expect(roles.find((r) => r.key === 'C')?.payload).toMatchObject({ financial: true });
    expect(roles.find((r) => r.key === 'MGMT')?.payload).toMatchObject({ management: true });
    expect(roles.filter((r) => r.payload?.financial)).toHaveLength(1);
  });

  it('gates: offsets of R7, approver roles, decision modes and the compressed position of R8', () => {
    const gates = Object.fromEntries(TEMPLATE_L11_ITEMS.filter((i) => i.kind === 'gate').map((g) => [g.key, g]));
    const rule = (key: string) => [gates[key]?.anchor, gates[key]?.offset_value, gates[key]?.offset_unit, gates[key]?.owner_role_key];
    expect(rule('G0')).toEqual(['T', -10, 'working', 'MGMT']);
    expect(rule('G1')).toEqual(['T', -8, 'working', 'B']);
    expect(rule('G2')).toEqual(['T', -4, 'working', 'MGMT']);
    expect(rule('G3')).toEqual(['T', -3, 'working', 'B']);
    expect(rule('G4')).toEqual(['T', -2, 'working', 'MGMT']);
    expect(gates.G0?.payload).toMatchObject({
      decision_mode: 'go_no_go',
      target: { anchor: 'T0', offset_value: 3, offset_unit: 'working' },
      warn_if_target_after: { anchor: 'T', offset_value: -12, offset_unit: 'working' },
    });
    for (const key of ['G1', 'G2']) expect(gates[key]?.payload).toMatchObject({ decision_mode: 'approval', compressed: { anchor: 'T', offset_value: -5, offset_unit: 'working' } });
    for (const key of ['G3', 'G4']) expect(gates[key]?.payload).not.toHaveProperty('compressed');
    expect(TEMPLATE_L11_ITEMS.find((i) => i.kind === 'milestone')).toMatchObject({ key: 'UPLOAD', anchor: 'T', offset_value: -1, offset_unit: 'working' });
  });

  it('exit criteria: every gate has its own; the R13 auto rules sit on the right gates', () => {
    const criteria = TEMPLATE_L11_ITEMS.filter((i) => i.kind === 'gate_criterion');
    const perGate = (key: string) => criteria.filter((c) => c.payload?.gate_key === key).length;
    expect(['G0', 'G1', 'G2', 'G3', 'G4'].map(perGate)).toEqual([6, 5, 4, 9, 6]);
    const auto = criteria.filter((c) => c.payload?.type === 'auto').map((c) => [c.payload?.gate_key, c.payload?.auto_rule]);
    expect(auto).toEqual([
      ['G1', 'exclusion_evidence_100'],
      ['G1', 'handoffs_received'],
      ['G3', 'register_no_open'],
      ['G4', 'guarantee_arrived'],
      ['G4', 'docs_valid_on_T'],
    ]);
    for (const c of criteria.filter((c) => c.payload?.type !== 'auto')) expect(c.payload).toEqual({ gate_key: c.payload?.gate_key, type: 'manual' });
    expect(new Set(criteria.map((c) => c.key)).size).toBe(criteria.length);
  });

  it('handoffs with their offsets; watchlist with the guarantee at G4 − 10 calendar days and open-ended lead times', () => {
    const handoffs = TEMPLATE_L11_ITEMS.filter((i) => i.kind === 'handoff');
    expect(handoffs.map((h) => [h.payload?.from_role, h.payload?.to_role, h.anchor, h.offset_value, h.offset_unit])).toEqual([
      ['B', 'A', 'G0', 2, 'working'],
      ['A', 'B', 'G0', 3, 'working'],
      ['B', 'C', 'G1', 0, 'working'],
      ['C', 'B', 'T', -9, 'working'],
      ['A', 'C', 'G0', 3, 'working'],
    ]);
    const watch = TEMPLATE_L11_ITEMS.filter((i) => i.kind === 'watch_item');
    expect(watch[0]).toMatchObject({ key: 'guarantee', owner_role_key: 'A', payload: { lead_value: 10, lead_unit: 'calendar', needed_milestone_key: 'G4' } });
    for (const w of watch.slice(1)) expect(w.payload).toMatchObject({ lead_value: null });
    for (const w of watch) expect(typeof w.payload?.checks).toBe('string');
    expect(watch.filter((w) => w.condition && w.condition !== 'always').map((w) => [w.key, w.condition])).toEqual([
      ['partner_docs', 'partners'],
      ['demo_unit', 'demo'],
    ]);
  });
});
