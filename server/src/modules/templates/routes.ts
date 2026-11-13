// Mounted at /api/templates — behind requireAuth (req.ctx = { orgId, user, db }).
// F2/F10: templates with versions. Every authenticated user reads published templates (the tender form needs
// them); everything else is admin only. A published template is immutable: changes go into a new version.
import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { zUuid } from '../../core/http.js';
import { hasRole, requireRole } from '../../core/permissions.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { LESSON_SELECT, lessonView } from '../lessons/service.js';
import { CONDITIONS, ITEM_KINDS, itemSchemas, OFFSET_UNITS, type ItemKind } from './shapes.js';
import { bumpVersion, diffItems, errorsOf, problemId, validateTemplate, type ItemLike, type Problem } from './validate.js';

export const router: Router = Router();

const admin = requireRole('admin');

const zName = z.string().trim().min(1).max(200);
const zVersion = z.string().trim().min(1).max(40);
const zDescription = z.string().trim().max(2000).nullable();
const listQuery = z.object({ status: z.enum(['draft', 'published']).optional() });
const createBody = z.object({ name: zName, version: zVersion.default('1.0'), description: zDescription.optional() }).strict();
const patchBody = z.object({ name: zName.optional(), version: zVersion.optional(), description: zDescription.optional() }).strict();
const newVersionBody = z.object({ version: zVersion.optional(), description: zDescription.optional() }).strict();
/** Loose on purpose: the per-kind schema of shapes.ts does the real validation after defaults are filled in. */
const itemCreateBody = z
  .object({
    kind: z.enum(ITEM_KINDS),
    key: z.string().trim().max(60).nullish(),
    name: z.string(),
    owner_role_key: z.string().nullish(),
    anchor: z.string().nullish(),
    offset_value: z.number().nullish(),
    offset_unit: z.enum(OFFSET_UNITS).nullish(),
    condition: z.enum(CONDITIONS).optional(),
    sort: z.number().int().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const itemPatchBody = itemCreateBody.omit({ kind: true }).partial().strict();
const reorderBody = z.object({ kind: z.enum(ITEM_KINDS), ids: z.array(zUuid).min(1).max(2000) }).strict();

const published = () => unprocessable('A published template cannot be changed; create a new version from it', undefined, 'template_published');
const versionExists = () => conflict('A template with this name and version already exists', undefined, 'template_version_exists');
const templateNotFound = () => notFound('Template not found', 'template_not_found');

function view(t: Row) {
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    status: t.status,
    description: t.description ?? null,
    parent_template_id: t.parent_template_id ?? null,
    published_at: t.published_at ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    created_by: t.created_by ?? null,
  };
}

function itemView(i: Row) {
  return {
    id: i.id,
    template_id: i.template_id,
    kind: i.kind,
    key: i.key,
    name: i.name,
    owner_role_key: i.owner_role_key ?? null,
    anchor: i.anchor ?? null,
    offset_value: i.offset_value ?? null,
    offset_unit: i.offset_unit ?? null,
    condition: i.condition,
    sort: i.sort,
    payload: i.payload ?? {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ItemRow = Omit<ItemLike, 'id' | 'payload'> & { id: string; payload: Record<string, unknown> | null; [column: string]: any };
const loadItems = (db: ScopedDb, templateId: string) => db.list<ItemRow>('template_item', { template_id: templateId }, { orderBy: 'sort, created_at, id' });

function grouped(items: Row[]) {
  const out = Object.fromEntries(ITEM_KINDS.map((k) => [k, [] as ReturnType<typeof itemView>[]])) as Record<ItemKind, ReturnType<typeof itemView>[]>;
  for (const i of items) out[i.kind as ItemKind]?.push(itemView(i));
  return out;
}

/** The template, or 404. Non-admins only ever see published templates. */
async function readable(req: { ctx: Express.Request['ctx']; params: Record<string, unknown> }): Promise<Row> {
  const t = await req.ctx.db.get('template', String(req.params.id));
  if (!t || (t.status !== 'published' && !hasRole(req.ctx, 'admin'))) throw templateNotFound();
  return t;
}

/** Runs fn on a locked draft inside a transaction (so a concurrent publish cannot interleave). */
async function onDraft<R>(db: ScopedDb, id: string, fn: (tx: ScopedDb, template: Row) => Promise<R>): Promise<R> {
  return db.tx(async (tx) => {
    const [template] = await tx.sql('SELECT * FROM template WHERE org_id = :org_id AND id::text = :id FOR UPDATE', { id });
    if (!template) throw templateNotFound();
    if (template.status !== 'draft') throw published();
    return fn(tx, template);
  });
}

/** Rejects a change that introduces validation errors the draft did not have before. */
function assertNoNewErrors(before: ItemLike[], after: ItemLike[], code: string, message: string): void {
  const known = new Set(errorsOf(validateTemplate(before)).map(problemId));
  const fresh = errorsOf(validateTemplate(after)).filter((p) => !known.has(problemId(p)));
  if (fresh.length > 0) throw unprocessable(`${message}: ${fresh[0]!.message}`, { problems: fresh }, code);
}

const PREFIX: Record<ItemKind, string> = {
  role: 'role_',
  gate: 'G',
  gate_criterion: 'crit_',
  milestone: 'ms_',
  handoff: 'ho_',
  task: 'task_',
  checklist_item: 'chk_',
  watch_item: 'watch_',
};

function nextKey(items: ItemRow[], kind: ItemKind): string {
  const used = new Set(items.map((i) => i.key));
  for (let n = items.filter((i) => i.kind === kind).length + 1; ; n += 1) {
    if (!used.has(`${PREFIX[kind]}${n}`)) return `${PREFIX[kind]}${n}`;
  }
}

/* ------------------------------------------------------------------------------------------------ templates */

router.get('/', async (req, res) => {
  const { status } = listQuery.parse(req.query);
  const isAdmin = hasRole(req.ctx, 'admin');
  if (!isAdmin && status === 'draft') {
    res.json({ items: [] });
    return;
  }
  const effective = isAdmin ? (status ?? null) : 'published';
  const rows = await req.ctx.db.sql(
    `SELECT t.*, p.name AS parent_name, p.version AS parent_version,
            (SELECT count(*) FROM template_item i WHERE i.org_id = t.org_id AND i.template_id = t.id) AS item_count,
            (SELECT count(*) FROM tender x WHERE x.org_id = t.org_id AND x.template_id = t.id) AS tender_count
       FROM template t
       LEFT JOIN template p ON p.id = t.parent_template_id AND p.org_id = t.org_id
      WHERE t.org_id = :org_id AND (:status::text IS NULL OR t.status = :status)
      ORDER BY lower(t.name), t.created_at, t.id`,
    { status: effective },
  );
  res.json({
    items: rows.map((r) => ({
      ...view(r),
      parent_name: r.parent_name ?? null,
      parent_version: r.parent_version ?? null,
      item_count: Number(r.item_count),
      tender_count: Number(r.tender_count),
    })),
  });
});

/** Lessons flagged "changes the template" and not yet applied to any version, across the org's tenders. */
router.get('/lessons/pending', admin, async (req, res) => {
  const rows = await req.ctx.db.sql(`${LESSON_SELECT} WHERE l.org_id = :org_id AND l.changes_template AND l.applied_in_version IS NULL ORDER BY l.created_at, l.id`);
  res.json({ items: rows.map(lessonView) });
});

router.post('/', admin, async (req, res) => {
  const body = createBody.parse(req.body);
  const { db } = req.ctx;
  if (await db.findOne('template', { name: body.name, version: body.version })) throw versionExists();
  const row = await db.insert('template', { name: body.name, version: body.version, description: body.description ?? null, status: 'draft' });
  res.status(201).json(view(row));
});

router.get('/:id', async (req, res) => {
  const t = await readable(req);
  const { db } = req.ctx;
  const parent = t.parent_template_id ? await db.get('template', t.parent_template_id) : null;
  res.json({
    template: { ...view(t), parent_name: parent?.name ?? null, parent_version: parent?.version ?? null },
    items: grouped(await loadItems(db, t.id)),
  });
});

router.patch('/:id', admin, async (req, res) => {
  const body = patchBody.parse(req.body);
  const row = await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    const name = body.name ?? t.name;
    const version = body.version ?? t.version;
    if (name !== t.name || version !== t.version) {
      const clash = await db.findOne('template', { name, version });
      if (clash && clash.id !== t.id) throw versionExists();
    }
    return (await db.update('template', t.id, body)) ?? t;
  });
  res.json(view(row));
});

/** Drafts can be discarded; a published template stays (tenders and lessons refer to it). */
router.delete('/:id', admin, async (req, res) => {
  await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    await db.remove('template', t.id);
  });
  res.status(204).end();
});

router.get('/:id/validate', admin, async (req, res) => {
  const t = await readable(req);
  const problems = validateTemplate(await loadItems(req.ctx.db, t.id));
  res.json({ ok: errorsOf(problems).length === 0, problems });
});

router.post('/:id/publish', admin, async (req, res) => {
  const row = await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    const items = await loadItems(db, t.id);
    if (items.length === 0) throw unprocessable('An empty template cannot be published', undefined, 'template_empty');
    const problems: Problem[] = validateTemplate(items);
    if (errorsOf(problems).length > 0) throw unprocessable('The template has validation errors', { problems }, 'template_invalid');
    return (await db.update('template', t.id, { status: 'published', published_at: new Date() })) ?? t;
  });
  res.json(view(row));
});

/** New draft with a copy of every item of a published template (F10: lessons become a new version). */
router.post('/:id/new-version', admin, async (req, res) => {
  const body = newVersionBody.parse(req.body ?? {});
  const created = await req.ctx.db.tx(async (db) => {
    const source = await db.get('template', String(req.params.id));
    if (!source) throw templateNotFound();
    if (source.status !== 'published') throw unprocessable('Only a published template can get a new version', undefined, 'template_not_published');
    const taken = new Set((await db.list('template', { name: source.name })).map((t) => t.version));
    let version = body.version;
    if (version !== undefined) {
      if (taken.has(version)) throw versionExists();
    } else {
      version = bumpVersion(source.version);
      while (taken.has(version)) version = bumpVersion(version);
    }
    const draft = await db.insert('template', {
      name: source.name,
      version,
      status: 'draft',
      parent_template_id: source.id,
      description: body.description !== undefined ? body.description : (source.description ?? null),
    });
    const items = await loadItems(db, source.id);
    if (items.length > 0) {
      await db.insertMany(
        'template_item',
        items.map((i) => ({
          template_id: draft.id,
          kind: i.kind,
          key: i.key,
          name: i.name,
          owner_role_key: i.owner_role_key,
          offset_value: i.offset_value,
          offset_unit: i.offset_unit,
          anchor: i.anchor,
          condition: i.condition,
          sort: i.sort,
          payload: i.payload ?? {},
        })),
      );
    }
    return draft;
  });
  res.status(201).json(view(created));
});

/** What this template added, removed or changed relative to the version it was created from. */
router.get('/:id/diff', admin, async (req, res) => {
  const t = await readable(req);
  const { db } = req.ctx;
  const parent = t.parent_template_id ? await db.get('template', t.parent_template_id) : null;
  if (!parent) {
    res.json({ template: view(t), parent: null, added: [], removed: [], changed: [], unchanged: 0 });
    return;
  }
  const diff = diffItems(await loadItems(db, parent.id), await loadItems(db, t.id));
  res.json({
    template: view(t),
    parent: view(parent),
    added: diff.added.map((i) => itemView(i as Row)),
    removed: diff.removed.map((i) => itemView(i as Row)),
    changed: diff.changed.map((c) => ({ kind: c.kind, key: c.key, fields: c.fields, before: itemView(c.before as Row), after: itemView(c.after as Row) })),
    unchanged: diff.unchanged,
  });
});

/** Lessons recorded as applied in this template version. */
router.get('/:id/lessons', admin, async (req, res) => {
  const t = await readable(req);
  const rows = await req.ctx.db.sql(`${LESSON_SELECT} WHERE l.org_id = :org_id AND l.applied_template_id = :id ORDER BY l.created_at, l.id`, { id: t.id });
  res.json({ items: rows.map(lessonView) });
});

/* ---------------------------------------------------------------------------------------------------- items */

router.post('/:id/items', admin, async (req, res) => {
  const body = itemCreateBody.parse(req.body);
  const row = await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    const items = await loadItems(db, t.id);
    const sameKind = items.filter((i) => i.kind === body.kind);
    const data = itemSchemas[body.kind].parse({
      ...body,
      key: body.key ? body.key : nextKey(items, body.kind),
      sort: body.sort ?? (sameKind.length ? Math.max(...sameKind.map((i) => i.sort as number)) + 10 : 10),
    });
    assertNoNewErrors(items, [...items, { ...data, id: null }], 'template_item_invalid', 'The item is not valid');
    return db.insert('template_item', { ...data, template_id: t.id });
  });
  res.status(201).json(itemView(row));
});

/** Sets the order of all items of one kind: `ids` must list every item of that kind exactly once. */
router.post('/:id/items/reorder', admin, async (req, res) => {
  const { kind, ids } = reorderBody.parse(req.body);
  const items = await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    const current = (await loadItems(db, t.id)).filter((i) => i.kind === kind);
    const wanted = new Set(ids);
    if (wanted.size !== ids.length || wanted.size !== current.length || current.some((i) => !wanted.has(i.id))) {
      throw unprocessable('ids must list every item of this kind exactly once', undefined, 'reorder_mismatch');
    }
    const byId = new Map(current.map((i) => [i.id as string, i]));
    for (const [index, id] of ids.entries()) {
      const sort = (index + 1) * 10;
      if (byId.get(id)!.sort !== sort) await db.update('template_item', id, { sort });
    }
    return (await loadItems(db, t.id)).filter((i) => i.kind === kind);
  });
  res.json({ items: items.map(itemView) });
});

router.patch('/:id/items/:itemId', admin, async (req, res) => {
  const body = itemPatchBody.parse(req.body);
  const row = await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    const items = await loadItems(db, t.id);
    const current = items.find((i) => i.id === String(req.params.itemId));
    if (!current) throw notFound('Template item not found', 'template_item_not_found');
    const merged = { ...itemView(current), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    const data = itemSchemas[current.kind as ItemKind].parse(merged);
    assertNoNewErrors(items, items.map((i) => (i === current ? { ...data, id: current.id } : i)), 'template_item_invalid', 'The item is not valid');
    return (await db.update('template_item', current.id, data)) ?? current;
  });
  res.json(itemView(row));
});

/** Removing a gate removes its exit criteria too; anything else that is still referenced cannot be removed. */
router.delete('/:id/items/:itemId', admin, async (req, res) => {
  await onDraft(req.ctx.db, String(req.params.id), async (db, t) => {
    const items = await loadItems(db, t.id);
    const current = items.find((i) => i.id === String(req.params.itemId));
    if (!current) throw notFound('Template item not found', 'template_item_not_found');
    const gone = new Set<ItemRow>([current]);
    if (current.kind === 'gate') for (const i of items) if (i.kind === 'gate_criterion' && i.payload?.gate_key === current.key) gone.add(i);
    assertNoNewErrors(items, items.filter((i) => !gone.has(i)), 'template_item_in_use', 'Other items still refer to this one');
    for (const i of gone) await db.remove('template_item', i.id);
  });
  res.status(204).end();
});
