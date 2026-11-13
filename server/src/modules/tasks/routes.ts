// Mounted at /api/tenders/:tenderId/tasks — mergeParams; tender access already checked, tender row on req.tender.
// Tasks, checklists (section `checklist`, "Δ/Α" = status `na`) and handoffs (F6: deliver → receive).
import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest, conflict, forbidden, unprocessable } from '../../core/errors.js';
import { emit } from '../../core/events.js';
import { zUuid } from '../../core/http.js';
import type { Ctx } from '../../core/types.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { todayAthens } from '../../domain/time.js';
import {
  assertOwner,
  assertRoleKey,
  getInTender,
  isManager,
  loadRoles,
  nextSort,
  OPEN_TASK_STATUSES,
  readOnlyWhenClosed,
  roleKeysOf,
  zNullableDate,
  zNullableUuid,
  zRoleKey,
  zText,
} from './common.js';

export const router: Router = Router({ mergeParams: true });
router.use(readOnlyWhenClosed);

const SECTIONS = ['task', 'checklist', 'handoff'] as const;
const STATUSES = ['open', 'in_progress', 'done', 'na', 'cancelled'] as const;

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(z.enum(values)).min(1));
const zFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const listQuery = z.object({
  section: csv(SECTIONS).optional(),
  status: csv(STATUSES).optional(),
  owner_user_id: zUuid.optional(),
  owner_role_key: z.string().min(1).optional(),
  milestone_id: zUuid.optional(),
  overdue: zFlag.optional(),
  /** Only what the caller owns: directly, through a role, or as sender/recipient of a handoff. */
  mine: zFlag.optional(),
});

const createBody = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: zText(5000).optional(),
    section: z.enum(SECTIONS).default('task'),
    owner_user_id: zNullableUuid.optional(),
    owner_role_key: zRoleKey.optional(),
    due_date: zNullableDate.optional(),
    milestone_id: zNullableUuid.optional(),
    handoff_from_role: zRoleKey.optional(),
    handoff_to_role: zRoleKey.optional(),
  })
  .strict();

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: zText(5000).optional(),
    owner_user_id: zNullableUuid.optional(),
    owner_role_key: zRoleKey.optional(),
    due_date: zNullableDate.optional(),
    milestone_id: zNullableUuid.optional(),
    handoff_from_role: z.string().trim().min(1).max(60).optional(),
    handoff_to_role: z.string().trim().min(1).max(60).optional(),
    status: z.enum(STATUSES).optional(),
  })
  .strict();

const noteBody = z.object({ note: zText(2000).optional() }).strict();

interface Viewer {
  userId: string;
  roleKeys: string[];
  manager: boolean;
}

async function viewerOf(ctx: Ctx, tenderId: string): Promise<Viewer> {
  return { userId: ctx.user.id, roleKeys: await roleKeysOf(ctx.db, tenderId, ctx.user.id), manager: isManager(ctx) };
}

type HandoffState = 'pending' | 'delivered' | 'received';

function handoffState(task: Row): HandoffState | null {
  if (task.section !== 'handoff') return null;
  if (task.received_at) return 'received';
  return task.payload?.delivered_at ? 'delivered' : 'pending';
}

export function isOverdue(task: { due_date: string | null; status: string }, today: string): boolean {
  return !!task.due_date && task.due_date < today && (OPEN_TASK_STATUSES as readonly string[]).includes(task.status);
}

function view(task: Row, milestones: Map<string, Row>, viewer: Viewer, today: string, closed: boolean) {
  const m = task.milestone_id ? milestones.get(task.milestone_id) : undefined;
  const state = handoffState(task);
  const live = !closed && (task.status === 'open' || task.status === 'in_progress');
  const holdsFrom = !!task.handoff_from_role && viewer.roleKeys.includes(task.handoff_from_role);
  const holdsTo = !!task.handoff_to_role && viewer.roleKeys.includes(task.handoff_to_role);
  return {
    id: task.id,
    tender_id: task.tender_id,
    milestone_id: task.milestone_id,
    key: task.key,
    title: task.title,
    description: task.description,
    owner_user_id: task.owner_user_id,
    owner_role_key: task.owner_role_key,
    due_date: task.due_date,
    status: task.status,
    section: task.section,
    handoff_from_role: task.handoff_from_role,
    handoff_to_role: task.handoff_to_role,
    received_by: task.received_by,
    received_at: task.received_at,
    done_at: task.done_at,
    sort: task.sort,
    created_at: task.created_at,
    updated_at: task.updated_at,
    overdue: isOverdue(task as { due_date: string | null; status: string }, today),
    from_template: task.key != null,
    milestone: m ? { id: m.id, key: m.key, name: m.name, kind: m.kind, due_date: m.due_date, done_at: m.done_at } : null,
    handoff:
      state === null
        ? null
        : {
            state,
            delivered_at: task.payload?.delivered_at ?? null,
            delivered_by: task.payload?.delivered_by ?? null,
            delivery_note: task.payload?.delivery_note ?? null,
            receive_note: task.payload?.receive_note ?? null,
            received_by_override: task.payload?.received_by_override === true,
            can_deliver: live && state === 'pending' && (holdsFrom || viewer.manager),
            can_receive: live && state !== 'received' && (holdsTo || viewer.manager),
            /** bid_manager/admin confirming for a role they do not hold: a note is required */
            receive_needs_note: !holdsTo,
            can_undo_receive: !closed && state === 'received' && viewer.manager,
          },
  };
}

async function milestoneMap(db: ScopedDb, tenderId: string): Promise<Map<string, Row>> {
  const rows = await db.list('milestone', { tender_id: tenderId });
  return new Map(rows.map((m) => [m.id as string, m]));
}

async function respond(ctx: Ctx, tender: Row, task: Row) {
  const [milestones, viewer] = await Promise.all([milestoneMap(ctx.db, tender.id), viewerOf(ctx, tender.id)]);
  return view(task, milestones, viewer, todayAthens(), false);
}

// ---------------------------------------------------------------------------------------------------------- list

router.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const where: Record<string, unknown> = { tender_id: tenderId };
  if (q.section) where.section = q.section;
  if (q.status) where.status = q.status;
  if (q.owner_user_id) where.owner_user_id = q.owner_user_id;
  if (q.owner_role_key) where.owner_role_key = q.owner_role_key;
  if (q.milestone_id) where.milestone_id = q.milestone_id;

  const [rows, milestones, roles, viewer] = await Promise.all([
    db.list('task', where, { orderBy: 'section, sort, due_date nulls last, created_at' }),
    milestoneMap(db, tenderId),
    loadRoles(db, tenderId),
    viewerOf(req.ctx, tenderId),
  ]);
  const today = todayAthens();
  const closed = req.tender.status !== 'evaluation' && req.tender.status !== 'in_progress';
  let items = rows.map((t) => view(t, milestones, viewer, today, closed));
  if (q.overdue !== undefined) items = items.filter((t) => t.overdue === q.overdue);
  if (q.mine) {
    items = items.filter(
      (t) =>
        t.owner_user_id === viewer.userId ||
        (t.owner_role_key != null && viewer.roleKeys.includes(t.owner_role_key)) ||
        (t.section === 'handoff' &&
          ((t.handoff_from_role != null && viewer.roleKeys.includes(t.handoff_from_role)) ||
            (t.handoff_to_role != null && viewer.roleKeys.includes(t.handoff_to_role)))),
    );
  }
  res.json({ items, roles, me: { role_keys: viewer.roleKeys, can_manage: viewer.manager }, today });
});

/** Checklists grouped by role, with progress. "Δ/Α" lines (status `na`) stay listed but do not count. */
router.get('/checklists', async (req, res) => {
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const [rows, milestones, roles, viewer] = await Promise.all([
    db.list('task', { tender_id: tenderId, section: 'checklist' }, { orderBy: 'sort, created_at' }),
    milestoneMap(db, tenderId),
    loadRoles(db, tenderId),
    viewerOf(req.ctx, tenderId),
  ]);
  const today = todayAthens();
  const closed = req.tender.status !== 'evaluation' && req.tender.status !== 'in_progress';
  const keys: Array<string | null> = roles.map((r) => r.key);
  for (const t of rows) {
    const k: string | null = t.owner_role_key ?? null;
    if (!keys.includes(k)) keys.push(k);
  }
  const groups = keys
    .map((key) => {
      const items = rows.filter((t) => (t.owner_role_key ?? null) === key).map((t) => view(t, milestones, viewer, today, closed));
      const na = items.filter((t) => t.status === 'na' || t.status === 'cancelled').length;
      const done = items.filter((t) => t.status === 'done').length;
      return {
        role_key: key,
        role_name: roles.find((r) => r.key === key)?.name ?? key,
        user_ids: roles.find((r) => r.key === key)?.user_ids ?? [],
        total: items.length,
        applicable: items.length - na,
        done,
        na,
        items,
      };
    })
    .filter((g) => g.items.length > 0);
  res.json({ groups, roles, me: { role_keys: viewer.roleKeys, can_manage: viewer.manager } });
});

// -------------------------------------------------------------------------------------------------- create / edit

async function assertMilestone(db: ScopedDb, tenderId: string, milestoneId: string): Promise<Row> {
  const m = await db.get('milestone', milestoneId);
  if (!m || m.tender_id !== tenderId) {
    throw badRequest('Unknown milestone', [{ path: 'milestone_id', message: 'Unknown milestone' }], 'unknown_milestone');
  }
  return m;
}

router.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  if (body.owner_user_id && body.owner_role_key) {
    throw badRequest('A task is owned by a user or by a role, not both', undefined, 'owner_conflict');
  }
  await assertOwner(db, tenderId, body);
  const data: Row = {
    tender_id: tenderId,
    title: body.title,
    description: body.description ?? null,
    section: body.section,
    owner_user_id: body.owner_user_id ?? null,
    owner_role_key: body.owner_role_key ?? null,
    due_date: body.due_date ?? null,
    milestone_id: body.milestone_id ?? null,
  };
  if (body.section === 'handoff') {
    if (!body.handoff_from_role || !body.handoff_to_role) {
      throw badRequest('A handoff needs a "from" and a "to" role', undefined, 'handoff_roles_required');
    }
    if (body.handoff_from_role === body.handoff_to_role) {
      throw badRequest('The "from" and "to" roles of a handoff must differ', undefined, 'handoff_same_role');
    }
    await assertRoleKey(db, tenderId, body.handoff_from_role, 'handoff_from_role');
    await assertRoleKey(db, tenderId, body.handoff_to_role, 'handoff_to_role');
    data.handoff_from_role = body.handoff_from_role;
    data.handoff_to_role = body.handoff_to_role;
  } else if (body.handoff_from_role || body.handoff_to_role) {
    throw badRequest('Only handoffs have "from"/"to" roles', undefined, 'not_a_handoff');
  }
  if (body.milestone_id) {
    const m = await assertMilestone(db, tenderId, body.milestone_id);
    if (data.due_date == null && m.due_date) data.due_date = m.due_date;
  }
  data.sort = await nextSort(db, 'task', tenderId);
  const row = await db.insert('task', data);
  res.status(201).json(await respond(req.ctx, req.tender, row));
});

router.patch('/:id', async (req, res) => {
  const body = patchBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const task = await getInTender(db, 'task', String(req.params.id), tenderId, 'Task');
  const patch: Row = {};

  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;

  // Owner: a user OR a role — choosing one clears the other unless both are given explicitly.
  if (body.owner_user_id && body.owner_role_key) {
    throw badRequest('A task is owned by a user or by a role, not both', undefined, 'owner_conflict');
  }
  if (body.owner_user_id !== undefined || body.owner_role_key !== undefined) {
    await assertOwner(db, tenderId, body);
    if (body.owner_user_id !== undefined) patch.owner_user_id = body.owner_user_id;
    if (body.owner_role_key !== undefined) patch.owner_role_key = body.owner_role_key;
    if (body.owner_user_id && body.owner_role_key === undefined) patch.owner_role_key = null;
    if (body.owner_role_key && body.owner_user_id === undefined) patch.owner_user_id = null;
  }

  // A handoff's roles, milestone and date decide who may deliver / receive it and whether a gate waits for it
  // (`handoffs_received`): only the bid manager or an admin re-wires them.
  if (task.section === 'handoff' && !isManager(req.ctx)) {
    const rewires =
      (body.handoff_from_role !== undefined && body.handoff_from_role !== task.handoff_from_role) ||
      (body.handoff_to_role !== undefined && body.handoff_to_role !== task.handoff_to_role) ||
      (body.milestone_id !== undefined && body.milestone_id !== (task.milestone_id ?? null));
    if (rewires) throw forbidden('Only the bid manager can change the roles, milestone or date of a handoff', 'handoff_manager_only');
  }

  if (body.milestone_id !== undefined) {
    if (body.milestone_id) await assertMilestone(db, tenderId, body.milestone_id);
    patch.milestone_id = body.milestone_id;
  }
  if (body.due_date !== undefined && body.due_date !== task.due_date) {
    // A template handoff mirrors its handoff milestone: the date is changed in the schedule, not here.
    const linked = task.milestone_id ? await db.get('milestone', task.milestone_id) : null;
    if (task.section === 'handoff' && linked?.kind === 'handoff') {
      throw unprocessable('The date of this handoff follows the schedule: change the milestone instead', undefined, 'handoff_date_from_schedule');
    }
    if (task.section === 'handoff' && !isManager(req.ctx)) {
      throw forbidden('Only the bid manager can change the roles, milestone or date of a handoff', 'handoff_manager_only');
    }
    patch.due_date = body.due_date;
  }

  if (body.handoff_from_role !== undefined || body.handoff_to_role !== undefined) {
    if (task.section !== 'handoff') throw badRequest('Only handoffs have "from"/"to" roles', undefined, 'not_a_handoff');
    if (task.received_at) throw unprocessable('The handoff has been received', undefined, 'handoff_already_received');
    const from = body.handoff_from_role ?? task.handoff_from_role;
    const to = body.handoff_to_role ?? task.handoff_to_role;
    if (from === to) throw badRequest('The "from" and "to" roles of a handoff must differ', undefined, 'handoff_same_role');
    if (body.handoff_from_role) await assertRoleKey(db, tenderId, body.handoff_from_role, 'handoff_from_role');
    if (body.handoff_to_role) await assertRoleKey(db, tenderId, body.handoff_to_role, 'handoff_to_role');
    patch.handoff_from_role = from;
    patch.handoff_to_role = to;
  }

  if (body.status !== undefined && body.status !== task.status) Object.assign(patch, statusPatch(req.ctx, task, body.status));

  const row = Object.keys(patch).length > 0 ? ((await db.update('task', task.id, patch)) ?? task) : task;
  res.json(await respond(req.ctx, req.tender, row));
});

/** Status rules. `done` stamps done_at; a handoff is completed only through /receive. */
function statusPatch(ctx: Ctx, task: Row, status: (typeof STATUSES)[number]): Row {
  if (status === 'na' && task.section === 'task') {
    throw unprocessable('"N/A" is for checklist lines and handoffs; cancel a task instead', undefined, 'na_only_checklist');
  }
  if (task.section === 'handoff') {
    if (task.received_at) throw unprocessable('The handoff has been received: undo the receipt first', undefined, 'handoff_already_received');
    if (status === 'done') throw unprocessable('A handoff is completed when the recipient confirms receipt', undefined, 'handoff_use_receive');
    if (status === 'in_progress') throw unprocessable('Use "deliver" to mark a handoff as delivered', undefined, 'handoff_use_deliver');
    // na / cancelled take the handoff out of the `handoffs_received` gate criterion: bid manager only.
    if (!isManager(ctx)) throw forbidden('Only the bid manager can cancel, exclude or reopen a handoff', 'handoff_manager_only');
    if (status === 'open') return { status, done_at: null, payload: { ...stripDelivery(task.payload) } };
    return { status, done_at: null };
  }
  return { status, done_at: status === 'done' ? new Date() : null };
}

function stripDelivery(payload: Row | null): Row {
  const { delivered_at: _a, delivered_by: _b, delivery_note: _c, ...rest } = payload ?? {};
  return rest;
}

router.delete('/:id', async (req, res) => {
  const { db } = req.ctx;
  const task = await getInTender(db, 'task', String(req.params.id), req.tender.id, 'Task');
  // Blueprint: a checklist line that does not apply is marked "Δ/Α", never deleted. Same for template handoffs.
  if (task.key != null && task.section !== 'task') {
    throw unprocessable(
      'Lines that come from the template are never deleted: mark them N/A instead',
      undefined,
      task.section === 'checklist' ? 'checklist_use_na' : 'handoff_use_na',
    );
  }
  if (task.section === 'handoff' && task.received_at) {
    throw unprocessable('The handoff has been received', undefined, 'handoff_already_received');
  }
  await db.remove('task', task.id);
  res.status(204).end();
});

// ------------------------------------------------------------------------------------------------- handoffs (F6)

async function handoffOr404(req: Request): Promise<Row> {
  const task = await getInTender(req.ctx.db, 'task', String(req.params.id), req.tender.id, 'Task');
  if (task.section !== 'handoff') throw unprocessable('This task is not a handoff', undefined, 'not_a_handoff');
  return task;
}

/** The sender (a holder of the "from" role, or bid_manager/admin) declares the handoff delivered. */
router.post('/:id/deliver', async (req, res) => {
  const body = noteBody.parse(req.body ?? {});
  const { db, user } = req.ctx;
  const task = await handoffOr404(req);
  const viewer = await viewerOf(req.ctx, req.tender.id);
  if (!viewer.manager && !(task.handoff_from_role && viewer.roleKeys.includes(task.handoff_from_role))) {
    throw forbidden('Only the sending role (or the bid manager) can deliver this handoff', 'handoff_not_sender');
  }
  if (task.received_at) throw conflict('The handoff has been received', undefined, 'handoff_already_received');
  if (task.status === 'na' || task.status === 'cancelled') throw unprocessable('The handoff is not active', undefined, 'handoff_not_active');
  if (task.payload?.delivered_at) throw conflict('The handoff is already delivered', undefined, 'handoff_already_delivered');
  const row = await db.update('task', task.id, {
    status: 'in_progress',
    payload: { ...(task.payload ?? {}), delivered_at: new Date().toISOString(), delivered_by: user.id, delivery_note: body.note ?? null },
  });
  emit(req.ctx, 'handoff.delivered', { tenderId: req.tender.id, taskId: task.id });
  res.json(await respond(req.ctx, req.tender, row ?? task));
});

/** Sender or bid manager takes a delivery back (before it is received). */
router.post('/:id/undo-deliver', async (req, res) => {
  const { db } = req.ctx;
  const task = await handoffOr404(req);
  const viewer = await viewerOf(req.ctx, req.tender.id);
  if (!viewer.manager && !(task.handoff_from_role && viewer.roleKeys.includes(task.handoff_from_role))) {
    throw forbidden('Only the sending role (or the bid manager) can take a delivery back', 'handoff_not_sender');
  }
  if (task.received_at) throw conflict('The handoff has been received', undefined, 'handoff_already_received');
  if (!task.payload?.delivered_at) throw conflict('The handoff has not been delivered', undefined, 'handoff_not_delivered');
  const row = await db.update('task', task.id, { status: 'open', payload: stripDelivery(task.payload) });
  res.json(await respond(req.ctx, req.tender, row ?? task));
});

/**
 * The recipient confirms receipt: only a holder of the "to" role (a sender qualifies only when they hold both roles).
 * bid_manager/admin may confirm on the recipient's behalf with a note. Receipt completes the task and its handoff
 * milestone (`handoffs_received`, R13).
 */
router.post('/:id/receive', async (req, res) => {
  const body = noteBody.parse(req.body ?? {});
  const { user } = req.ctx;
  const task = await handoffOr404(req);
  const viewer = await viewerOf(req.ctx, req.tender.id);
  const holdsTo = !!task.handoff_to_role && viewer.roleKeys.includes(task.handoff_to_role);
  if (!holdsTo && !viewer.manager) {
    throw forbidden('Only the receiving role can confirm receipt', 'handoff_not_recipient');
  }
  if (!holdsTo && !body.note) {
    throw unprocessable('Confirming receipt on behalf of the recipient needs a note', undefined, 'handoff_override_note_required');
  }
  if (task.received_at) throw conflict('The handoff is already received', undefined, 'handoff_already_received');
  if (task.status === 'na' || task.status === 'cancelled') throw unprocessable('The handoff is not active', undefined, 'handoff_not_active');

  const now = new Date();
  const row = await req.ctx.db.tx(async (tx) => {
    const milestone = task.milestone_id ? await tx.get('milestone', task.milestone_id) : null;
    const completesMilestone = !!milestone && milestone.kind === 'handoff' && milestone.done_at == null;
    if (completesMilestone) await tx.update('milestone', milestone.id, { done_at: now });
    return tx.update('task', task.id, {
      status: 'done',
      done_at: now,
      received_by: user.id,
      received_at: now,
      payload: {
        ...(task.payload ?? {}),
        receive_note: body.note ?? null,
        received_by_override: !holdsTo,
        milestone_completed: completesMilestone,
      },
    });
  });
  res.json(await respond(req.ctx, req.tender, row ?? task));
});

/** bid_manager/admin reopens a received handoff (and the milestone the receipt had completed). */
router.post('/:id/undo-receive', async (req, res) => {
  if (!isManager(req.ctx)) throw forbidden('Only the bid manager can undo a receipt', 'handoff_manager_only');
  const task = await handoffOr404(req);
  if (!task.received_at) throw conflict('The handoff has not been received', undefined, 'handoff_not_received');
  const row = await req.ctx.db.tx(async (tx) => {
    if (task.payload?.milestone_completed && task.milestone_id) await tx.update('milestone', task.milestone_id, { done_at: null });
    const { receive_note: _n, received_by_override: _o, milestone_completed: _m, ...payload } = task.payload ?? {};
    return tx.update('task', task.id, {
      status: payload.delivered_at ? 'in_progress' : 'open',
      done_at: null,
      received_by: null,
      received_at: null,
      payload,
    });
  });
  res.json(await respond(req.ctx, req.tender, row ?? task));
});
