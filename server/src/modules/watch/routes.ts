// Mounted at /api/tenders/:tenderId/watch — mergeParams; tender access already checked, tender row on req.tender.
// Watchlist (F7): items that depend on third parties, with lead time and the last day to request them (R6).
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, forbidden } from '../../core/errors.js';
import type { Ctx } from '../../core/types.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { loadHolidays } from '../../domain/holidays.js';
import { todayAthens } from '../../domain/time.js';
import {
  assertOwner,
  getInTender,
  isManager,
  loadRoles,
  nextSort,
  readOnlyWhenClosed,
  zNullableDate,
  zNullableUuid,
  zRoleKey,
  zText,
} from '../tasks/common.js';
import { proposeExpected, watchView } from './service.js';

export const router: Router = Router({ mergeParams: true });
router.use(readOnlyWhenClosed);

const fields = {
  name: z.string().trim().min(1).max(300),
  owner_user_id: zNullableUuid,
  owner_role_key: zRoleKey,
  /** null = open-ended lead time ("ανοιχτό") */
  lead_value: z.number().int().min(0).max(3650).nullable(),
  lead_unit: z.enum(['working', 'calendar']).nullable(),
  needed_at: zNullableDate,
  needed_milestone_key: z.string().trim().min(1).max(60).nullable(),
  requested_at: zNullableDate,
  expected_at: zNullableDate,
  arrived_at: zNullableDate,
  checks: zText(2000),
  notes: zText(5000),
};
const createBody = z.object({ ...fields, name: fields.name }).partial().required({ name: true }).strict();
const patchBody = z.object(fields).partial().strict();

async function milestonesByKey(db: ScopedDb, tenderId: string): Promise<Map<string, Row>> {
  const rows = await db.list('milestone', { tender_id: tenderId });
  return new Map(rows.map((m) => [m.key as string, m]));
}

async function respond(ctx: Ctx, tenderId: string, item: Row, extra: Record<string, unknown> = {}) {
  const [milestones, holidays] = await Promise.all([milestonesByKey(ctx.db, tenderId), loadHolidays(ctx.db)]);
  return { ...watchView(item, milestones, holidays, todayAthens()), ...extra };
}

router.get('/', async (req, res) => {
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const [rows, milestones, holidays, roles] = await Promise.all([
    db.list('watch_item', { tender_id: tenderId }, { orderBy: 'sort, created_at' }),
    milestonesByKey(db, tenderId),
    loadHolidays(db),
    loadRoles(db, tenderId),
  ]);
  const today = todayAthens();
  const items = rows.map((w) => watchView(w, milestones, holidays, today));
  res.json({
    items,
    roles,
    milestones: [...milestones.values()]
      .sort((a, b) => Number(a.sort) - Number(b.sort) || String(a.due_date ?? '').localeCompare(String(b.due_date ?? '')))
      .map((m) => ({ key: m.key, name: m.name, kind: m.kind, due_date: m.due_date })),
    today,
    can_manage: isManager(req.ctx),
  });
});

/** Shared write rules. Returns the column patch and whether expected_at was proposed from the lead time. */
async function buildPatch(db: ScopedDb, tenderId: string, body: z.infer<typeof patchBody>, current: Row | null) {
  const patch: Row = { ...body };
  if (body.owner_user_id && body.owner_role_key) {
    throw badRequest('An item is owned by a user or by a role, not both', undefined, 'owner_conflict');
  }
  if (body.owner_user_id !== undefined || body.owner_role_key !== undefined) {
    await assertOwner(db, tenderId, body);
    if (body.owner_user_id && body.owner_role_key === undefined) patch.owner_role_key = null;
    if (body.owner_role_key && body.owner_user_id === undefined) patch.owner_user_id = null;
  }

  const leadValue = body.lead_value !== undefined ? body.lead_value : ((current?.lead_value as number | null | undefined) ?? null);
  let leadUnit = body.lead_unit !== undefined ? body.lead_unit : ((current?.lead_unit as 'working' | 'calendar' | null | undefined) ?? null);
  if (leadValue != null && leadUnit == null) leadUnit = patch.lead_unit = 'working';

  // Needed at a milestone: keep the stored date in step with it (slice 1 refreshes it on every reschedule).
  if (body.needed_milestone_key) {
    const m = await db.findOne('milestone', { tender_id: tenderId, key: body.needed_milestone_key });
    if (!m) throw badRequest('Unknown milestone', [{ path: 'needed_milestone_key', message: 'Unknown milestone' }], 'unknown_milestone');
    patch.needed_at = m.due_date ?? null;
  } else if (body.needed_at !== undefined && body.needed_milestone_key === undefined && current?.needed_milestone_key) {
    patch.needed_milestone_key = null; // an explicit date replaces the milestone link
  }

  // Requested (again) with a known lead time and no explicit expected date → propose requested + lead.
  let expectedProposed = false;
  const requestedChanged = body.requested_at !== undefined && body.requested_at !== (current?.requested_at ?? null);
  if (requestedChanged && body.expected_at === undefined) {
    if (body.requested_at) {
      const proposed = proposeExpected(body.requested_at, leadValue, leadUnit, await loadHolidays(db));
      if (proposed) {
        patch.expected_at = proposed;
        expectedProposed = true;
      }
    } else {
      patch.expected_at = null;
    }
  }

  const requested = patch.requested_at !== undefined ? patch.requested_at : (current?.requested_at ?? null);
  const expected = patch.expected_at !== undefined ? patch.expected_at : (current?.expected_at ?? null);
  if (requested && expected && expected < requested) {
    throw badRequest('The expected date is before the request date', [{ path: 'expected_at', message: 'Before the request date' }], 'expected_before_requested');
  }
  return { patch, expectedProposed };
}

router.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const { patch, expectedProposed } = await buildPatch(db, tenderId, body, null);
  const row = await db.insert('watch_item', { ...patch, tender_id: tenderId, sort: await nextSort(db, 'watch_item', tenderId) });
  res.status(201).json(await respond(req.ctx, tenderId, row, { expected_proposed: expectedProposed }));
});

router.patch('/:id', async (req, res) => {
  const body = patchBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const current = await getInTender(db, 'watch_item', String(req.params.id), tenderId, 'Watch item');
  const { patch, expectedProposed } = await buildPatch(db, tenderId, body, current);
  const row = Object.keys(patch).length > 0 ? ((await db.update('watch_item', current.id, patch)) ?? current) : current;
  res.json(await respond(req.ctx, tenderId, row, { expected_proposed: expectedProposed }));
});

/** Items that came from the template (e.g. the guarantee, which a G4 criterion reads) are removed by the bid manager only. */
router.delete('/:id', async (req, res) => {
  const { db } = req.ctx;
  const current = await getInTender(db, 'watch_item', String(req.params.id), req.tender.id, 'Watch item');
  if (current.key != null && !isManager(req.ctx)) {
    throw forbidden('Only the bid manager can remove a watchlist item that comes from the template', 'watch_template_item');
  }
  await db.remove('watch_item', current.id);
  res.status(204).end();
});
