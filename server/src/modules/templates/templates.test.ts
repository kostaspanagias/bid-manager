import { describe, expect, it } from 'vitest';
import { as, createOrg, createTender, createUser, dbFor, missingId, type Agent } from '../../test/harness.js';
import { itemSchemas, parseItem } from './shapes.js';
import { bumpVersion, diffItems, errorsOf, validateTemplate, type ItemLike } from './validate.js';

const off = (anchor: string, offset_value: number, offset_unit = 'working') => ({ anchor, offset_value, offset_unit });

/** A small but complete, valid template (shapes of ARCHITECTURE.md). */
const ITEMS: ItemLike[] = [
  { kind: 'role', key: 'A', name: 'Δικαιολογητικά', payload: { folder: 'participation' } },
  { kind: 'role', key: 'B', name: 'Τεχνική', payload: { folder: 'technical' } },
  { kind: 'role', key: 'C', name: 'Οικονομική', payload: { folder: 'financial', financial: true } },
  { kind: 'role', key: 'MGMT', name: 'Διοίκηση', payload: { management: true } },
  { kind: 'gate', key: 'G0', name: 'Go / No-Go', owner_role_key: 'MGMT', ...off('T0', 3), payload: { decision_mode: 'go_no_go' } },
  { kind: 'gate', key: 'G3', name: 'Red team', owner_role_key: 'MGMT', ...off('T', -5), payload: { decision_mode: 'approval', target: off('T', -8), compressed: off('T', -3) } },
  { kind: 'gate_criterion', key: 'g0_fit', name: 'Καλύπτονται τα κριτήρια επιλογής', payload: { gate_key: 'G0', type: 'manual' } },
  { kind: 'gate_criterion', key: 'g3_excl', name: 'Αποκλεισμού 100%', payload: { gate_key: 'G3', type: 'auto', auto_rule: 'exclusion_evidence_100' } },
  { kind: 'milestone', key: 'UPLOAD', name: 'Ανέβασμα στο ΕΣΗΔΗΣ', ...off('T', -1) },
  { kind: 'milestone', key: 'KICKOFF', name: 'Kick-off', ...off('G0', 2) },
  { kind: 'handoff', key: 'tech_to_a', name: 'Τεχνική προσφορά προς συσκευασία', ...off('T', -3), payload: { from_role: 'B', to_role: 'A' } },
  { kind: 'task', key: 'demo_prep', name: 'Προετοιμασία demo', owner_role_key: 'B', ...off('T', -6), condition: 'demo', payload: { description: 'Στήσιμο' } },
  { kind: 'task', key: 'notes', name: 'Σημειώσεις', owner_role_key: null, payload: {} },
  { kind: 'checklist_item', key: 'chk_gemi', name: 'Πιστοποιητικό ΓΕΜΗ', owner_role_key: 'A' },
  { kind: 'watch_item', key: 'guarantee', name: 'Εγγυητική συμμετοχής', owner_role_key: 'C', payload: { lead_value: 5, lead_unit: 'working', needed_milestone_key: 'UPLOAD' } },
];

const codes = (items: ItemLike[]) => errorsOf(validateTemplate(items)).map((p) => `${p.code}:${p.key}:${p.field}`);
const without = (key: string) => ITEMS.filter((i) => i.key !== key);
const patched = (key: string, patch: Partial<ItemLike>) => ITEMS.map((i) => (i.key === key ? { ...i, ...patch } : i));

async function setup() {
  const org = await createOrg();
  const admin = await createUser(org, 'admin');
  return { org, admin, api: await as(admin) };
}

async function createTemplate(api: Agent, name = 'L', version = '1.1', items: ItemLike[] = ITEMS) {
  const res = await api.post('/api/templates').send({ name, version });
  expect(res.status).toBe(201);
  for (const item of items) {
    const r = await api.post(`/api/templates/${res.body.id}/items`).send(item);
    expect([r.status, r.body.error]).toEqual([201, undefined]);
  }
  return res.body as { id: string; name: string; version: string; status: string };
}

async function publishedTemplate(api: Agent, name = 'L', version = '1.1') {
  const t = await createTemplate(api, name, version);
  expect((await api.post(`/api/templates/${t.id}/publish`)).status).toBe(200);
  return t;
}

describe('validateTemplate (pure)', () => {
  it('accepts a complete template', () => {
    expect(validateTemplate(ITEMS)).toEqual([]);
  });

  it('every kind has a schema; payload extras are kept; defaults are filled', () => {
    for (const item of ITEMS) expect(parseItem(item).success).toBe(true);
    const role = itemSchemas.role.parse({ kind: 'role', key: 'X', name: 'x', payload: { folder: 'technical', colour: 'blue' } });
    expect(role).toMatchObject({ condition: 'always', sort: 0, anchor: null, owner_role_key: null, payload: { folder: 'technical', colour: 'blue' } });
    expect(parseItem({ kind: 'nope', key: 'X', name: 'x' }).success).toBe(false);
  });

  it('shape rules per kind', () => {
    expect(codes(patched('G0', { payload: {} }))).toContain('invalid_shape:G0:payload.decision_mode');
    expect(codes(patched('G0', { anchor: null, offset_value: null, offset_unit: null }))).toContain('invalid_shape:G0:anchor');
    expect(codes(patched('UPLOAD', { offset_unit: 'weeks' }))).toContain('invalid_shape:UPLOAD:offset_unit');
    expect(codes(patched('A', { payload: { folder: 'legal' } }))).toContain('invalid_shape:A:payload.folder');
    expect(codes(patched('A', { anchor: 'T', offset_value: 1, offset_unit: 'working' }))).toContain('invalid_shape:A:anchor');
    expect(codes(patched('notes', { anchor: 'T' }))).toContain('invalid_shape:notes:anchor'); // all three or none
    expect(codes(patched('chk_gemi', { owner_role_key: null }))).toContain('invalid_shape:chk_gemi:owner_role_key');
    expect(codes(patched('guarantee', { payload: { lead_value: 'soon', lead_unit: 'working' } }))).toContain('invalid_shape:guarantee:payload.lead_value');
    expect(codes(patched('demo_prep', { condition: 'sometimes' }))).toContain('invalid_shape:demo_prep:condition');
    expect(codes(patched('tech_to_a', { payload: { from_role: 'B' } }))).toContain('invalid_shape:tech_to_a:payload.to_role');
  });

  it('auto_rule: only for auto criteria and only from the allowed list', () => {
    expect(codes(patched('g3_excl', { payload: { gate_key: 'G3', type: 'auto', auto_rule: 'made_up' } }))).toContain('invalid_shape:g3_excl:payload.auto_rule');
    expect(codes(patched('g3_excl', { payload: { gate_key: 'G3', type: 'auto' } }))).toContain('invalid_shape:g3_excl:payload.auto_rule');
    expect(codes(patched('g0_fit', { payload: { gate_key: 'G0', type: 'manual', auto_rule: 'register_no_open' } }))).toContain('invalid_shape:g0_fit:payload.auto_rule');
    for (const rule of ['exclusion_evidence_100', 'register_no_open', 'handoffs_received', 'guarantee_arrived', 'docs_valid_on_T']) {
      expect(codes(patched('g3_excl', { payload: { gate_key: 'G3', type: 'auto', auto_rule: rule } }))).toEqual([]);
    }
  });

  it('keys: unique per kind, unique across gate/milestone/handoff, T and T0 reserved', () => {
    expect(codes([...ITEMS, { kind: 'role', key: 'A', name: 'Ξανά' }])).toEqual(['duplicate_key:A:key']);
    // the same key in different kinds is fine (a role A and a task A)…
    expect(codes([...ITEMS, { kind: 'task', key: 'A', name: 'Task A', payload: {} }])).toEqual([]);
    // …but not among the kinds that share the anchor namespace
    expect(codes([...ITEMS, { kind: 'milestone', key: 'G0', name: 'x', ...off('T', -2) }])).toEqual(['duplicate_key:G0:key']);
    expect(codes([...ITEMS, { kind: 'milestone', key: 'T0', name: 'x', ...off('T', -2) }])).toEqual(['reserved_key:T0:key']);
  });

  it('anchors must be T, T0 or a gate/milestone/handoff key', () => {
    expect(codes(patched('UPLOAD', { anchor: 'NOPE' }))).toContain('unknown_anchor:UPLOAD:anchor');
    expect(codes(patched('demo_prep', { anchor: 'chk_gemi' }))).toEqual(['unknown_anchor:demo_prep:anchor']); // a checklist item has no date
    expect(codes(patched('demo_prep', { anchor: 'tech_to_a' }))).toEqual([]);
    expect(codes(patched('G3', { payload: { decision_mode: 'approval', target: off('GX', -1) } }))).toEqual(['unknown_anchor:G3:payload.target.anchor']);
    // a gate's own target may be relative to the gate itself
    expect(codes(patched('G3', { payload: { decision_mode: 'approval', target: off('G3', -2) } }))).toEqual([]);
  });

  it('detects dependency cycles, direct and indirect', () => {
    expect(codes(patched('UPLOAD', { anchor: 'UPLOAD' }))).toEqual(['anchor_cycle:UPLOAD:anchor']);
    const loop = patched('G0', { anchor: 'KICKOFF' }); // KICKOFF → G0 → KICKOFF
    expect(codes(loop).sort()).toEqual(['anchor_cycle:G0:anchor', 'anchor_cycle:KICKOFF:anchor']);
    const viaPayload = patched('G0', { payload: { decision_mode: 'go_no_go', target: off('KICKOFF', -1) } });
    expect(codes(viaPayload).sort()).toEqual(['anchor_cycle:G0:anchor', 'anchor_cycle:KICKOFF:anchor']);
    const three = [...ITEMS, { kind: 'milestone', key: 'M1', name: 'm1', ...off('M3', 1) }, { kind: 'milestone', key: 'M2', name: 'm2', ...off('M1', 1) }, { kind: 'milestone', key: 'M3', name: 'm3', ...off('M2', 1) }];
    expect(codes(three).sort()).toEqual(['anchor_cycle:M1:anchor', 'anchor_cycle:M2:anchor', 'anchor_cycle:M3:anchor']);
  });

  it('references: gate of a criterion, role keys, needed milestone', () => {
    expect(codes(without('G0').filter((i) => i.key !== 'KICKOFF'))).toEqual(['unknown_gate:g0_fit:payload.gate_key']);
    expect(codes(without('MGMT')).sort()).toEqual(['unknown_role:G0:owner_role_key', 'unknown_role:G3:owner_role_key']);
    expect(codes(without('B')).sort()).toEqual(['unknown_role:demo_prep:owner_role_key', 'unknown_role:tech_to_a:payload.from_role']);
    expect(codes(patched('tech_to_a', { payload: { from_role: 'B', to_role: 'Z' } }))).toEqual(['unknown_role:tech_to_a:payload.to_role']);
    expect(codes(patched('guarantee', { payload: { lead_value: null, lead_unit: 'calendar', needed_milestone_key: 'NOPE' } }))).toEqual(['unknown_milestone:guarantee:payload.needed_milestone_key']);
  });

  it('warnings do not block: conditional anchor, gate without criteria or approver', () => {
    const items = [
      ...patched('G0', { owner_role_key: null }).filter((i) => i.key !== 'g0_fit'),
      { kind: 'milestone', key: 'DEMO', name: 'Demo', ...off('T', -4), condition: 'demo' },
      { kind: 'task', key: 'after_demo', name: 'x', ...off('DEMO', 1), payload: {} },
      { kind: 'task', key: 'demo_dry', name: 'x', ...off('DEMO', -1), condition: 'demo', payload: {} },
    ];
    const problems = validateTemplate(items);
    expect(errorsOf(problems)).toEqual([]);
    expect(problems.map((p) => `${p.code}:${p.key}`).sort()).toEqual(['condition_mismatch:after_demo', 'gate_without_approver:G0', 'gate_without_criteria:G0']);
  });

  it('bumpVersion and diffItems', () => {
    expect(['1.1', '1.9', 'v1.0', 'L v2', '2', 'beta', '1.1-rc'].map(bumpVersion)).toEqual(['1.2', '1.10', 'v1.1', 'L v3', '3', 'beta.1', '1.2-rc']);
    const next = [
      ...patched('UPLOAD', { offset_value: -2 }).filter((i) => i.key !== 'notes'),
      { kind: 'checklist_item', key: 'chk_new', name: 'Νέο', owner_role_key: 'A' },
    ];
    const d = diffItems(ITEMS, next);
    expect(d.added.map((i) => i.key)).toEqual(['chk_new']);
    expect(d.removed.map((i) => i.key)).toEqual(['notes']);
    expect(d.changed.map((c) => [c.kind, c.key, c.fields])).toEqual([['milestone', 'UPLOAD', ['offset_value']]]);
    expect(d.unchanged).toBe(ITEMS.length - 2);
    // key order inside payload does not count as a change
    expect(diffItems([{ kind: 'role', key: 'A', name: 'a', payload: { a: 1, b: 2 } }], [{ kind: 'role', key: 'A', name: 'a', payload: { b: 2, a: 1 } }]).changed).toEqual([]);
  });
});

describe('/api/templates', () => {
  it('admin creates a draft, edits it, and reads it grouped by kind', async () => {
    const { org, admin, api } = await setup();
    const t = await createTemplate(api);
    expect(t).toMatchObject({ name: 'L', version: '1.1', status: 'draft' });

    const got = await api.get(`/api/templates/${t.id}`);
    expect(got.status).toBe(200);
    expect(got.body.template).toMatchObject({ id: t.id, status: 'draft', parent_template_id: null, published_at: null });
    expect(Object.keys(got.body.items).sort()).toEqual(['checklist_item', 'gate', 'gate_criterion', 'handoff', 'milestone', 'role', 'task', 'watch_item']);
    expect(got.body.items.role.map((r: { key: string }) => r.key)).toEqual(['A', 'B', 'C', 'MGMT']);
    expect(got.body.items.gate[1]).toMatchObject({ key: 'G3', owner_role_key: 'MGMT', anchor: 'T', offset_value: -5, offset_unit: 'working', condition: 'always', payload: { decision_mode: 'approval', target: { anchor: 'T', offset_value: -8 } } });
    expect(got.body.items.role.map((r: { sort: number }) => r.sort)).toEqual([10, 20, 30, 40]);

    const patch = await api.patch(`/api/templates/${t.id}`).send({ name: 'Large', description: 'Μεγάλοι διαγωνισμοί' });
    expect(patch.body).toMatchObject({ name: 'Large', version: '1.1', description: 'Μεγάλοι διαγωνισμοί' });
    expect((await api.patch(`/api/templates/${t.id}`).send({ status: 'published' })).status).toBe(400);
    expect(await dbFor(org).findOne('audit_log', { entity: 'template', entity_id: t.id, action: 'create' })).toMatchObject({ user_id: admin.id });

    const list = await api.get('/api/templates');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: t.id, name: 'Large', status: 'draft', item_count: ITEMS.length, tender_count: 0, parent_version: null });
    expect((await api.get('/api/templates?status=published')).body.items).toEqual([]);
    expect((await api.get('/api/templates?status=archived')).status).toBe(400);
  });

  it('name + version is unique per organization', async () => {
    const { api } = await setup();
    const a = await createTemplate(api, 'L', '1.0', []);
    const dup = await api.post('/api/templates').send({ name: 'L', version: '1.0' });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'template_version_exists']);
    const b = await createTemplate(api, 'L', '1.1', []);
    const clash = await api.patch(`/api/templates/${b.id}`).send({ version: '1.0' });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'template_version_exists']);
    expect((await api.patch(`/api/templates/${a.id}`).send({ version: '1.0' })).status).toBe(200); // itself
    // another organization may use the same name and version
    const other = await setup();
    expect((await other.api.post('/api/templates').send({ name: 'L', version: '1.0' })).status).toBe(201);
  });

  it('item writes are validated against the rest of the draft', async () => {
    const { api } = await setup();
    const t = await createTemplate(api);
    const base = `/api/templates/${t.id}/items`;
    const bad = async (body: Record<string, unknown>, code: string, problem?: string) => {
      const res = await api.post(base).send(body);
      expect([res.status, res.body.error?.code]).toEqual([code === 'validation_error' ? 400 : 422, code]);
      if (problem) expect(res.body.error.details.problems.map((p: { code: string }) => p.code)).toContain(problem);
    };
    await bad({ kind: 'role', key: 'A', name: 'Διπλός' }, 'template_item_invalid', 'duplicate_key');
    await bad({ kind: 'milestone', key: 'G0', name: 'x', ...off('T', -1) }, 'template_item_invalid', 'duplicate_key');
    await bad({ kind: 'milestone', key: 'M', name: 'x', ...off('NOPE', -1) }, 'template_item_invalid', 'unknown_anchor');
    await bad({ kind: 'milestone', key: 'M', name: 'x', ...off('M', 1) }, 'template_item_invalid', 'anchor_cycle');
    await bad({ kind: 'gate_criterion', name: 'x', payload: { gate_key: 'G9', type: 'manual' } }, 'template_item_invalid', 'unknown_gate');
    await bad({ kind: 'task', name: 'x', owner_role_key: 'Z' }, 'template_item_invalid', 'unknown_role');
    await bad({ kind: 'handoff', key: 'h', name: 'x', ...off('T', -2), payload: { from_role: 'A', to_role: 'Z' } }, 'template_item_invalid', 'unknown_role');
    await bad({ kind: 'watch_item', name: 'x', payload: { lead_value: 3, lead_unit: 'working', needed_milestone_key: 'NOPE' } }, 'template_item_invalid', 'unknown_milestone');
    await bad({ kind: 'gate_criterion', name: 'x', payload: { gate_key: 'G0', type: 'auto', auto_rule: 'made_up' } }, 'validation_error');
    await bad({ kind: 'gate', key: 'G5', name: 'x', payload: { decision_mode: 'approval' } }, 'validation_error'); // a gate needs its date
    await bad({ kind: 'milestone', key: 'bad key!', name: 'x', ...off('T', -1) }, 'validation_error');
    await bad({ kind: 'role', key: 'X', name: 'x', template_id: missingId() }, 'validation_error');
    await bad({ kind: 'widget', key: 'X', name: 'x' }, 'validation_error');
    expect((await api.get(`/api/templates/${t.id}`)).body.items.role).toHaveLength(4);

    // a key is generated when none is given
    const auto = await api.post(base).send({ kind: 'checklist_item', name: 'Φορολογική ενημερότητα', owner_role_key: 'A' });
    expect(auto.status).toBe(201);
    expect(auto.body).toMatchObject({ key: 'chk_2', sort: 20, condition: 'always', payload: {} });

    // update: merged with the stored item, validated the same way
    const upload = (await api.get(`/api/templates/${t.id}`)).body.items.milestone.find((m: { key: string }) => m.key === 'UPLOAD');
    const moved = await api.patch(`${base}/${upload.id}`).send({ offset_value: -2, offset_unit: 'calendar' });
    expect(moved.body).toMatchObject({ key: 'UPLOAD', anchor: 'T', offset_value: -2, offset_unit: 'calendar', name: 'Ανέβασμα στο ΕΣΗΔΗΣ' });
    const cyc = await api.patch(`${base}/${upload.id}`).send({ anchor: 'UPLOAD' });
    expect([cyc.status, cyc.body.error.code]).toEqual([422, 'template_item_invalid']);
    // renaming a key that others refer to would break them
    const ren = await api.patch(`${base}/${upload.id}`).send({ key: 'SUBMIT' });
    expect([ren.status, ren.body.error.details.problems[0].code]).toEqual([422, 'unknown_milestone']);
    expect((await api.patch(`${base}/${upload.id}`).send({ kind: 'task' })).status).toBe(400);
    expect((await api.patch(`${base}/${missingId()}`).send({ name: 'x' })).status).toBe(404);
    expect((await api.patch(`${base}/not-a-uuid`).send({ name: 'x' })).status).toBe(404);
  });

  it('delete: referenced items are protected; a gate takes its criteria with it', async () => {
    const { api } = await setup();
    const t = await createTemplate(api);
    const base = `/api/templates/${t.id}/items`;
    const items = (await api.get(`/api/templates/${t.id}`)).body.items;
    const find = (kind: string, key: string) => items[kind].find((i: { key: string }) => i.key === key);

    const role = await api.delete(`${base}/${find('role', 'B').id}`);
    expect([role.status, role.body.error.code]).toEqual([422, 'template_item_in_use']);
    expect(role.body.error.details.problems.map((p: { key: string }) => p.key).sort()).toEqual(['demo_prep', 'tech_to_a']);
    expect((await api.delete(`${base}/${find('milestone', 'UPLOAD').id}`)).status).toBe(422); // the guarantee needs it
    expect((await api.delete(`${base}/${find('gate', 'G0').id}`)).status).toBe(422); // KICKOFF is anchored to it

    expect((await api.delete(`${base}/${find('gate', 'G3').id}`)).status).toBe(204);
    const after = (await api.get(`/api/templates/${t.id}`)).body.items;
    expect(after.gate.map((g: { key: string }) => g.key)).toEqual(['G0']);
    expect(after.gate_criterion.map((c: { key: string }) => c.key)).toEqual(['g0_fit']);
    expect((await api.delete(`${base}/${find('task', 'notes').id}`)).status).toBe(204);
    expect((await api.delete(`${base}/${find('task', 'notes').id}`)).status).toBe(404);
  });

  it('reorder sets the order of one kind', async () => {
    const { api } = await setup();
    const t = await createTemplate(api);
    const roles = (await api.get(`/api/templates/${t.id}`)).body.items.role as { id: string; key: string }[];
    const ids = [roles[3]!.id, roles[0]!.id, roles[2]!.id, roles[1]!.id];
    const res = await api.post(`/api/templates/${t.id}/items/reorder`).send({ kind: 'role', ids });
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { key: string }) => r.key)).toEqual(['MGMT', 'A', 'C', 'B']);
    expect((await api.get(`/api/templates/${t.id}`)).body.items.role.map((r: { key: string }) => r.key)).toEqual(['MGMT', 'A', 'C', 'B']);
    for (const bad of [ids.slice(1), [...ids, ids[0]], [...ids.slice(1), missingId()]]) {
      const r = await api.post(`/api/templates/${t.id}/items/reorder`).send({ kind: 'role', ids: bad });
      expect([r.status, r.body.error.code]).toEqual([422, 'reorder_mismatch']);
    }
    expect((await api.post(`/api/templates/${t.id}/items/reorder`).send({ kind: 'gate', ids })).status).toBe(422);
  });

  it('validate reports problems of rows that did not come through the API; publish refuses them', async () => {
    const { org, api } = await setup();
    const t = await createTemplate(api);
    expect((await api.get(`/api/templates/${t.id}/validate`)).body).toEqual({ ok: true, problems: [] });
    // e.g. a seed or an import wrote something inconsistent
    const stray = await dbFor(org).insert('template_item', { template_id: t.id, kind: 'task', key: 'stray', name: 'x', owner_role_key: 'Z', anchor: 'NOPE', offset_value: 1, offset_unit: 'working' });
    const v = await api.get(`/api/templates/${t.id}/validate`);
    expect(v.body.ok).toBe(false);
    expect(v.body.problems.map((p: { code: string; item_id: string; severity: string }) => [p.code, p.item_id, p.severity]).sort()).toEqual([
      ['unknown_anchor', stray.id, 'error'],
      ['unknown_role', stray.id, 'error'],
    ]);
    const pub = await api.post(`/api/templates/${t.id}/publish`);
    expect([pub.status, pub.body.error.code]).toEqual([422, 'template_invalid']);
    expect(pub.body.error.details.problems).toHaveLength(2);
    // pre-existing problems elsewhere do not block unrelated edits, and can be fixed
    expect((await api.post(`/api/templates/${t.id}/items`).send({ kind: 'role', key: 'D', name: 'Νομικός' })).status).toBe(201);
    expect((await api.patch(`/api/templates/${t.id}/items/${stray.id}`).send({ owner_role_key: 'D', anchor: 'T' })).status).toBe(200);
    expect((await api.post(`/api/templates/${t.id}/publish`)).status).toBe(200);

    const empty = await createTemplate(api, 'Empty', '1.0', []);
    const e = await api.post(`/api/templates/${empty.id}/publish`);
    expect([e.status, e.body.error.code]).toEqual([422, 'template_empty']);
  });

  it('a published template is immutable', async () => {
    const { api } = await setup();
    const t = await publishedTemplate(api);
    const got = (await api.get(`/api/templates/${t.id}`)).body;
    expect(got.template).toMatchObject({ status: 'published', published_at: expect.any(String) });
    const item = got.items.role[0];
    const attempts = [
      api.patch(`/api/templates/${t.id}`).send({ name: 'x' }),
      api.delete(`/api/templates/${t.id}`),
      api.post(`/api/templates/${t.id}/publish`),
      api.post(`/api/templates/${t.id}/items`).send({ kind: 'role', key: 'Z', name: 'z' }),
      api.patch(`/api/templates/${t.id}/items/${item.id}`).send({ name: 'z' }),
      api.delete(`/api/templates/${t.id}/items/${item.id}`),
      api.post(`/api/templates/${t.id}/items/reorder`).send({ kind: 'role', ids: got.items.role.map((r: { id: string }) => r.id) }),
    ];
    for (const attempt of attempts) {
      const res = await attempt;
      expect([res.status, res.body.error.code]).toEqual([422, 'template_published']);
    }
    expect((await api.get(`/api/templates/${t.id}`)).body).toEqual(got);
  });

  it('new version: copies every item into a draft with a bumped version and a parent', async () => {
    const { api } = await setup();
    const draft = await createTemplate(api, 'S', '0.1', []);
    const no = await api.post(`/api/templates/${draft.id}/new-version`).send({});
    expect([no.status, no.body.error.code]).toEqual([422, 'template_not_published']);

    const v11 = await publishedTemplate(api);
    const res = await api.post(`/api/templates/${v11.id}/new-version`).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'L', version: '1.2', status: 'draft', parent_template_id: v11.id, published_at: null });
    const v12 = res.body;

    const strip = (g: Record<string, Record<string, unknown>[]>) =>
      Object.fromEntries(Object.entries(g).map(([k, rows]) => [k, rows.map(({ id: _id, template_id: _t, ...rest }) => rest)]));
    const [a, b] = [(await api.get(`/api/templates/${v11.id}`)).body, (await api.get(`/api/templates/${v12.id}`)).body];
    expect(strip(b.items)).toEqual(strip(a.items));
    expect(b.template).toMatchObject({ parent_name: 'L', parent_version: '1.1' });
    const idsA = new Set(Object.values(a.items as Record<string, { id: string }[]>).flat().map((i) => i.id));
    expect(Object.values(b.items as Record<string, { id: string }[]>).flat().some((i) => idsA.has(i.id))).toBe(false);

    // the next free version is used; an explicit one must be free; the draft's version stays editable
    expect((await api.post(`/api/templates/${v11.id}/new-version`).send({})).body.version).toBe('1.3');
    const taken = await api.post(`/api/templates/${v11.id}/new-version`).send({ version: '1.2' });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'template_version_exists']);
    expect((await api.post(`/api/templates/${v11.id}/new-version`).send({ version: '2.0' })).body.version).toBe('2.0');
    expect((await api.patch(`/api/templates/${v12.id}`).send({ version: '1.2-beta' })).body.version).toBe('1.2-beta');

    // the draft is editable and publishable; the parent is untouched
    const upload = b.items.milestone.find((m: { key: string }) => m.key === 'UPLOAD');
    expect((await api.patch(`/api/templates/${v12.id}/items/${upload.id}`).send({ offset_value: -2 })).status).toBe(200);
    expect((await api.post(`/api/templates/${v12.id}/publish`)).status).toBe(200);
    expect((await api.get(`/api/templates/${v11.id}`)).body).toEqual(a);
    const list = (await api.get('/api/templates?status=published')).body.items;
    expect(list.map((t: { version: string; parent_version: string | null }) => [t.version, t.parent_version])).toEqual([
      ['1.1', null],
      ['1.2-beta', '1.1'],
    ]);
  });

  it('diff against the parent: added, removed, changed', async () => {
    const { api } = await setup();
    const v11 = await publishedTemplate(api);
    const none = (await api.get(`/api/templates/${v11.id}/diff`)).body;
    expect(none).toMatchObject({ parent: null, added: [], removed: [], changed: [] });

    const v12 = (await api.post(`/api/templates/${v11.id}/new-version`).send({})).body;
    const same = (await api.get(`/api/templates/${v12.id}/diff`)).body;
    expect(same).toMatchObject({ parent: { id: v11.id, version: '1.1' }, added: [], removed: [], changed: [], unchanged: ITEMS.length });

    const items = (await api.get(`/api/templates/${v12.id}`)).body.items;
    const base = `/api/templates/${v12.id}/items`;
    await api.patch(`${base}/${items.gate[1].id}`).send({ offset_value: -6, name: 'Red team review' }).expect(200);
    await api.delete(`${base}/${items.task.find((x: { key: string }) => x.key === 'notes').id}`).expect(204);
    await api.post(base).send({ kind: 'watch_item', key: 'samples', name: 'Δείγματα', owner_role_key: 'B', payload: { lead_value: 10, lead_unit: 'calendar' } }).expect(201);
    await api.patch(`${base}/${items.watch_item[0].id}`).send({ payload: { lead_value: 7, lead_unit: 'working', needed_milestone_key: 'UPLOAD' } }).expect(200);

    const diff = (await api.get(`/api/templates/${v12.id}/diff`)).body;
    expect(diff.added.map((i: { kind: string; key: string }) => [i.kind, i.key])).toEqual([['watch_item', 'samples']]);
    expect(diff.removed.map((i: { kind: string; key: string }) => [i.kind, i.key])).toEqual([['task', 'notes']]);
    expect(diff.changed.map((c: { key: string; fields: string[] }) => [c.key, c.fields]).sort()).toEqual([
      ['G3', ['name', 'offset_value']],
      ['guarantee', ['payload']],
    ]);
    const g3 = diff.changed.find((c: { key: string }) => c.key === 'G3');
    expect([g3.before.offset_value, g3.after.offset_value]).toEqual([-5, -6]);
    expect(diff.unchanged).toBe(ITEMS.length - 3);
  });

  it('drafts can be deleted with their items', async () => {
    const { org, api } = await setup();
    const t = await createTemplate(api);
    expect((await api.delete(`/api/templates/${t.id}`)).status).toBe(204);
    expect(await dbFor(org).count('template_item', { template_id: t.id })).toBe(0);
    expect((await api.get(`/api/templates/${t.id}`)).status).toBe(404);
    expect((await api.delete(`/api/templates/${missingId()}`)).status).toBe(404);
  });

  it('non-admins read published templates only and cannot change anything', async () => {
    const { org, api } = await setup();
    const pub = await publishedTemplate(api);
    const draft = (await api.post(`/api/templates/${pub.id}/new-version`).send({})).body;
    const item = (await api.get(`/api/templates/${draft.id}`)).body.items.role[0];
    const lessonTender = await createTender(org);
    for (const role of ['bid_manager', 'member', 'approver', 'viewer'] as const) {
      const u = await as(await createUser(org, role));
      const list = await u.get('/api/templates');
      expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([pub.id]);
      expect(list.body.items[0]).toMatchObject({ id: pub.id, name: 'L', version: '1.1', status: 'published' });
      expect((await u.get('/api/templates?status=draft')).body.items).toEqual([]);
      expect((await u.get(`/api/templates/${pub.id}`)).body.items.role).toHaveLength(4);
      expect((await u.get(`/api/templates/${draft.id}`)).status).toBe(404);

      const denied = [
        u.post('/api/templates').send({ name: 'X' }),
        u.patch(`/api/templates/${draft.id}`).send({ name: 'X' }),
        u.delete(`/api/templates/${draft.id}`),
        u.post(`/api/templates/${draft.id}/publish`),
        u.post(`/api/templates/${pub.id}/new-version`).send({}),
        u.post(`/api/templates/${draft.id}/items`).send({ kind: 'role', key: 'Z', name: 'z' }),
        u.patch(`/api/templates/${draft.id}/items/${item.id}`).send({ name: 'z' }),
        u.delete(`/api/templates/${draft.id}/items/${item.id}`),
        u.post(`/api/templates/${draft.id}/items/reorder`).send({ kind: 'role', ids: [item.id] }),
        u.get(`/api/templates/${draft.id}/validate`),
        u.get(`/api/templates/${draft.id}/diff`),
        u.get(`/api/templates/${pub.id}/lessons`),
        u.get('/api/templates/lessons/pending'),
      ];
      for (const d of denied) expect((await d).status).toBe(403);
    }
    expect(await dbFor(org).count('template')).toBe(2);
    expect(await dbFor(org).count('template_item', { template_id: draft.id })).toBe(ITEMS.length);
    expect(lessonTender.id).toBeTruthy();
  });

  it('another organization never sees or touches a template', async () => {
    const { org, api } = await setup();
    const pub = await publishedTemplate(api);
    const draft = (await api.post(`/api/templates/${pub.id}/new-version`).send({})).body;
    const item = (await api.get(`/api/templates/${draft.id}`)).body.items.role[0];
    const tender = await createTender(org);
    await dbFor(org).insert('lesson', { tender_id: tender.id, text: 'x', changes_template: true });

    const foreign = await setup();
    const f = foreign.api;
    expect((await f.get('/api/templates')).body.items).toEqual([]);
    expect((await f.get('/api/templates/lessons/pending')).body.items).toEqual([]);
    const own = await createTemplate(f, 'Own', '1.0', []);
    const attempts = [
      f.get(`/api/templates/${pub.id}`),
      f.get(`/api/templates/${draft.id}`),
      f.get(`/api/templates/${draft.id}/validate`),
      f.get(`/api/templates/${draft.id}/diff`),
      f.get(`/api/templates/${pub.id}/lessons`),
      f.patch(`/api/templates/${draft.id}`).send({ name: 'x' }),
      f.delete(`/api/templates/${draft.id}`),
      f.post(`/api/templates/${draft.id}/publish`),
      f.post(`/api/templates/${pub.id}/new-version`).send({}),
      f.post(`/api/templates/${draft.id}/items`).send({ kind: 'role', key: 'Z', name: 'z' }),
      f.patch(`/api/templates/${draft.id}/items/${item.id}`).send({ name: 'z' }),
      f.delete(`/api/templates/${draft.id}/items/${item.id}`),
      f.post(`/api/templates/${draft.id}/items/reorder`).send({ kind: 'role', ids: [item.id] }),
      // an item of another org's template addressed through an own template
      f.patch(`/api/templates/${own.id}/items/${item.id}`).send({ name: 'z' }),
      f.delete(`/api/templates/${own.id}/items/${item.id}`),
    ];
    for (const a of attempts) expect((await a).status).toBe(404);
    expect((await api.get(`/api/templates/${draft.id}`)).body.items.role[0]).toEqual(item);
    expect(await dbFor(org).count('template')).toBe(2);
  });
});
