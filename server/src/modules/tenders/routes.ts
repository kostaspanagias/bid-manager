// Mounted at /api/tenders — behind requireAuth (req.ctx = { orgId, user, db }).
// F1 tenders, F2 template application, team, status, and the deadline-extension flow (R9/R10).
import { Router } from 'express';
import { z } from 'zod';
import { unprocessable } from '../../core/errors.js';
import { emit } from '../../core/events.js';
import { zDate, zUuid } from '../../core/http.js';
import { accessibleTenderIds, requireRole, requireTenderAccess } from '../../core/permissions.js';
import type { Row } from '../../db/scoped.js';
import { workingDaysBetween } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { athensDate, athensToUtc, formatDateTime, todayAthens } from '../../domain/time.js';
import { applyReschedule, planReschedule, snapshotOf, tenderDates, type ReschedulePlan } from './schedule.js';
import {
  assertOpen,
  createTender,
  isActive,
  listMembers,
  nextGates,
  replaceMembers,
  tenderDetail,
  tenderView,
  tenderWarnings,
  withTMinus,
} from './service.js';

export const router: Router = Router();

const manage = requireRole('admin', 'bid_manager');

/* ------------------------------------------------------------------ input */

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
/** An instant: ISO-8601 with time and zone ('2027-05-07T12:00:00Z'). */
const zTimestamp = z
  .string()
  .regex(ISO_TS, 'Expected an ISO-8601 timestamp with time zone')
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Invalid timestamp')
  .transform((s) => new Date(s));
/** An instant, or a pure date meaning 00:00 Athens time of that day (publication date T0). */
const zDateOrTimestamp = z.union([zDate.transform((d) => athensToUtc(d, '00:00')), zTimestamp]);

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .transform((v) => (v === '' ? null : v));
const money = z.number().finite().min(0).max(999_999_999_999.99);
const lot = z
  .object({
    no: z.union([z.string().trim().max(40), z.number()]).nullish(),
    title: text(500).min(1),
    budget_net: money.nullish(),
    budget_gross: money.nullish(),
  })
  .strict();

const basicFields = {
  title: text(500).min(1),
  authority: text(500).min(1),
  adam: optionalText(60),
  esidis_no: optionalText(60),
  cpv: z.array(text(20).min(1)).max(50),
  budget_net: money.nullable(),
  budget_gross: money.nullable(),
  lots: z.array(lot).max(200),
  t0_published_at: zDateOrTimestamp.nullable(),
  questions_deadline_at: zTimestamp.nullable(),
  guarantee_amount: money.nullable(),
  guarantee_valid_until: zDate.nullable(),
  guarantee_margin_days: z.number().int().min(0).max(3650),
  offer_validity_days: z.number().int().min(0).max(3650).nullable(),
  notes: optionalText(10_000),
};
const member = z.object({ user_id: zUuid, role_key: z.string().trim().min(1).max(60).nullable().default(null) }).strict();

const createBody = z
  .object({
    ...basicFields,
    adam: basicFields.adam.optional(),
    esidis_no: basicFields.esidis_no.optional(),
    cpv: basicFields.cpv.default([]),
    budget_net: basicFields.budget_net.optional(),
    budget_gross: basicFields.budget_gross.optional(),
    lots: basicFields.lots.default([]),
    t0_published_at: basicFields.t0_published_at.optional(),
    questions_deadline_at: basicFields.questions_deadline_at.optional(),
    guarantee_amount: basicFields.guarantee_amount.optional(),
    guarantee_valid_until: basicFields.guarantee_valid_until.optional(),
    guarantee_margin_days: basicFields.guarantee_margin_days.default(30),
    offer_validity_days: basicFields.offer_validity_days.optional(),
    notes: basicFields.notes.optional(),
    submission_deadline_at: zTimestamp,
    has_demo: z.boolean().default(false),
    has_partners: z.boolean().default(false),
    template_id: zUuid,
    members: z.array(member).max(200).default([]),
  })
  .strict();

const patchBody = z
  .object({
    ...basicFields,
    // accepted only to answer with a precise error (see the handler)
    submission_deadline_at: zTimestamp,
    has_demo: z.boolean(),
    has_partners: z.boolean(),
  })
  .partial()
  .strict();

const STATUSES = ['evaluation', 'in_progress', 'submitted', 'cancelled'] as const;
const statusBody = z.object({ status: z.enum(STATUSES) }).strict();
const membersBody = z.object({ members: z.array(member).max(200) }).strict();
const previewBody = z.object({ submission_deadline_at: zTimestamp }).strict();
const deadlineBody = z
  .object({
    submission_deadline_at: zTimestamp,
    source: z.enum(['adam', 'esidis', 'email', 'other']).default('other'),
    description: text(2000).optional(),
    reference: optionalText(500).optional(),
  })
  .strict();
const listQuery = z.object({
  /** one status, a comma-separated list, or `active` / `closed` */
  status: z.string().trim().max(120).optional(),
  q: z.string().trim().max(200).optional(),
});

/** Cross-field rules of F1 on the row as it would be stored. */
function assertConsistent(t: Row): void {
  const T = athensDate(t.submission_deadline_at);
  if (t.t0_published_at && athensDate(t.t0_published_at) > T) {
    throw unprocessable('The publication date (T0) is after the submission deadline', undefined, 't0_after_deadline');
  }
  if (t.questions_deadline_at && new Date(t.questions_deadline_at).getTime() > new Date(t.submission_deadline_at).getTime()) {
    throw unprocessable('The questions deadline is after the submission deadline', undefined, 'questions_after_deadline');
  }
  if (t.budget_net != null && t.budget_gross != null && Number(t.budget_gross) < Number(t.budget_net)) {
    throw unprocessable('The budget with VAT is lower than the budget without VAT', undefined, 'budget_gross_below_net');
  }
}

/* ------------------------------------------------------------------ list / create / read */

router.get('/', async (req, res) => {
  const query = listQuery.parse(req.query);
  const { db } = req.ctx;
  const ids = await accessibleTenderIds(req.ctx);
  let statuses: string[] | null = null;
  if (query.status === 'active') statuses = ['evaluation', 'in_progress'];
  else if (query.status === 'closed') statuses = ['submitted', 'no_go', 'cancelled'];
  else if (query.status) statuses = query.status.split(',').map((s) => s.trim()).filter(Boolean);

  const rows =
    ids !== null && ids.length === 0
      ? []
      : await db.sql(
          `SELECT * FROM tender
            WHERE org_id = :org_id
              AND (:all OR id = ANY(:ids))
              AND (:any_status OR status = ANY(:statuses))
              AND (:q = '' OR title ILIKE :like OR authority ILIKE :like OR adam ILIKE :like OR esidis_no ILIKE :like)
            ORDER BY submission_deadline_at, title`,
          {
            all: ids === null,
            ids: ids ?? [],
            any_status: statuses === null,
            statuses: statuses ?? [],
            q: query.q ?? '',
            like: `%${(query.q ?? '').replace(/[\\%_]/g, '\\$&')}%`,
          },
        );
  const holidays = await loadHolidays(db);
  const today = todayAthens();
  const gates = await nextGates(db, ids === null ? null : rows.map((r) => r.id));
  res.json({
    items: rows.map((row) => {
      const { T, T0 } = tenderDates(row);
      return {
        ...tenderView(row),
        T,
        T0,
        tMinus: workingDaysBetween(today, T, holidays),
        next_gate: isActive(row) ? withTMinus(gates.get(row.id), T, holidays) : null,
      };
    }),
  });
});

router.post('/', manage, async (req, res) => {
  const { template_id, members, ...fields } = createBody.parse(req.body);
  assertConsistent(fields);
  const tender = await createTender(req.ctx.db, { fields, template_id, members: members.map((m) => ({ user_id: m.user_id, role_key: m.role_key })) });
  emit(req.ctx, 'tender.created', { tenderId: tender.id });
  res.status(201).json(await tenderDetail(req.ctx, tender));
});

router.get('/:id', async (req, res) => {
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'read');
  res.json(await tenderDetail(req.ctx, tender));
});

/** The template copy this tender was created from (F2) — the tender keeps following it whatever happens to the template. */
router.get('/:id/snapshot', async (req, res) => {
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'read');
  res.json({ snapshot: snapshotOf(tender) });
});

/* ------------------------------------------------------------------ basic fields */

router.patch('/:id', manage, async (req, res) => {
  const { db } = req.ctx;
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'write');
  const { submission_deadline_at, has_demo, has_partners, ...patch } = patchBody.parse(req.body);
  assertOpen(tender);
  // Changing the flags after creation is out of scope: conditional items were created (or not) with the template.
  if ((has_demo !== undefined && has_demo !== tender.has_demo) || (has_partners !== undefined && has_partners !== tender.has_partners)) {
    throw unprocessable('The demo / partners flags cannot be changed after the tender is created', undefined, 'flags_immutable');
  }
  if (submission_deadline_at !== undefined && submission_deadline_at.getTime() !== new Date(tender.submission_deadline_at).getTime()) {
    throw unprocessable('Change the submission deadline through the deadline flow (preview, then confirm)', undefined, 'use_deadline_flow');
  }
  assertConsistent({ ...tender, ...patch });

  const updated = await db.tx(async (tx) => {
    let row = (await tx.update('tender', tender.id, patch)) ?? tender;
    // A new publication date moves T0-anchored milestones (G0 target) and can switch compressed mode (R8).
    // R8 is judged as on the day the tender was created, so days that passed since do not count against it.
    if (tenderDates(row).T0 !== tenderDates(tender).T0) {
      const created = athensDate(row.created_at);
      const today = todayAthens();
      const plan = await planReschedule(tx, row, { flagManual: false, today: created < today ? created : today });
      await applyReschedule(tx, row, plan);
      if (plan.result.mode.compressed !== row.compressed_mode) {
        row = (await tx.update('tender', row.id, { compressed_mode: plan.result.mode.compressed })) ?? row;
      }
    }
    return row;
  });
  res.json(await tenderDetail(req.ctx, updated));
});

/* ------------------------------------------------------------------ status */

// evaluation → in_progress → submitted / cancelled. Re-opening a submitted or cancelled tender is allowed (a wrong
// click must be reversible); No-Go is decided at G0 (gates module, R14) and is final here.
const TRANSITIONS: Record<string, readonly string[]> = {
  evaluation: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'cancelled'],
  submitted: ['in_progress'],
  cancelled: ['evaluation', 'in_progress'],
  no_go: [],
};

router.post('/:id/status', manage, async (req, res) => {
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'write');
  const { status } = statusBody.parse(req.body);
  if (!(TRANSITIONS[tender.status] ?? []).includes(status)) {
    throw unprocessable(`A tender cannot go from "${tender.status}" to "${status}"`, { from: tender.status, to: status, allowed: TRANSITIONS[tender.status] ?? [] }, 'invalid_status_transition');
  }
  const closing = status === 'submitted' || status === 'cancelled';
  const updated = await req.ctx.db.update('tender', tender.id, { status, closed_at: closing ? new Date() : null });
  res.json(await tenderDetail(req.ctx, updated ?? tender));
});

/* ------------------------------------------------------------------ team */

router.get('/:id/members', async (req, res) => {
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'read');
  res.json(await listMembers(req.ctx.db, tender.id));
});

router.put('/:id/members', manage, async (req, res) => {
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'write');
  const { members } = membersBody.parse(req.body);
  assertOpen(tender);
  await replaceMembers(req.ctx.db, tender, members.map((m) => ({ user_id: m.user_id, role_key: m.role_key })));
  res.json(await listMembers(req.ctx.db, tender.id));
});

/* ------------------------------------------------------------------ deadline change (R9, R10) */

function diffView(plan: ReschedulePlan) {
  const byKey = new Map(plan.state.milestones.map((m) => [m.key, m]));
  return plan.result.diff.map((row) => ({
    milestone_id: byKey.get(row.key)?.id ?? null,
    key: row.key,
    kind: row.kind,
    name: row.name,
    old_date: row.old_date,
    new_date: row.new_date,
    changed: row.changed,
    /** moved | unchanged | manual | done | no_rule */
    status: row.status,
    /** where the rules would put a manual / done milestone */
    computed_date: row.computed_date,
    is_manual: row.is_manual,
    done: row.done,
    needs_review: row.needs_review,
    tMinus: row.new_date ? workingDaysBetween(row.new_date, plan.T, plan.state.holidays) : null,
  }));
}

async function previewOf(req: { ctx: Express.Request['ctx'] }, tender: Row, deadline: Date) {
  const { db } = req.ctx;
  if (deadline.getTime() === new Date(tender.submission_deadline_at).getTime()) {
    throw unprocessable('The submission deadline is the same as the current one', undefined, 'deadline_unchanged');
  }
  const prospective = { ...tender, submission_deadline_at: deadline };
  assertConsistent(prospective);
  const plan = await planReschedule(db, tender, { T: athensDate(deadline), flagManual: true });
  const oldT = tenderDates(tender).T;
  return {
    plan,
    body: {
      old_deadline_at: tender.submission_deadline_at as Date,
      new_deadline_at: deadline,
      oldT,
      newT: plan.T,
      /** working days the deadline moves by (negative = earlier) */
      shiftWorkingDays: workingDaysBetween(oldT, plan.T, plan.state.holidays),
      compressed: { old: Boolean(tender.compressed_mode), new: plan.result.mode.compressed },
      workingDays: plan.result.mode.workingDays,
      items: diffView(plan),
      /** the warnings the tender would have with the new deadline (R15/R16 re-run) */
      warnings: await tenderWarnings(db, prospective, { holidays: plan.state.holidays, today: plan.today, compressed: plan.result.mode.compressed }),
    },
  };
}

router.post('/:id/deadline/preview', manage, async (req, res) => {
  const tender = await requireTenderAccess(req.ctx, String(req.params.id), 'write');
  const body = previewBody.parse(req.body);
  assertOpen(tender);
  res.json((await previewOf(req, tender, body.submission_deadline_at)).body);
});

router.post('/:id/deadline', manage, async (req, res) => {
  const { db } = req.ctx;
  const seen = await requireTenderAccess(req.ctx, String(req.params.id), 'write');
  const body = deadlineBody.parse(req.body);
  assertOpen(seen);

  const result = await db.tx(async (tx) => {
    // Two confirmations of the same extension (double click, two bid managers) must not both reschedule and both
    // write a change entry: take the tender row lock, then judge everything on the row as it is NOW.
    await tx.sql('SELECT id FROM tender WHERE org_id = :org_id AND id = :id FOR UPDATE', { id: seen.id });
    const tender = (await tx.get('tender', seen.id)) ?? seen;
    assertOpen(tender);
    const { plan, body: preview } = await previewOf({ ctx: { ...req.ctx, db: tx } }, tender, body.submission_deadline_at);
    const updated = await tx.update('tender', tender.id, {
      submission_deadline_at: body.submission_deadline_at,
      compressed_mode: plan.result.mode.compressed,
    });
    const { moved } = await applyReschedule(tx, updated ?? tender, plan);
    const change = await tx.insert('change_entry', {
      tender_id: tender.id,
      date: plan.today,
      source: body.source,
      kind: 'extension',
      description:
        body.description && body.description !== ''
          ? body.description
          : `Νέα προθεσμία υποβολής: ${formatDateTime(body.submission_deadline_at)} (από ${formatDateTime(tender.submission_deadline_at)}).`,
      reference: body.reference ?? null,
      owner_user_id: req.ctx.user.id,
      payload: {
        oldT: preview.oldT,
        newT: preview.newT,
        old_deadline_at: new Date(tender.submission_deadline_at).toISOString(),
        new_deadline_at: body.submission_deadline_at.toISOString(),
        moved,
        needs_review: preview.items.filter((i) => i.status === 'manual').map((i) => i.key),
      },
    });
    return { tender: updated ?? tender, preview, change, moved };
  });

  emit(req.ctx, 'tender.extended', { tenderId: seen.id, oldT: result.preview.oldT, newT: result.preview.newT });
  res.json({
    ...(await tenderDetail(req.ctx, result.tender)),
    change_entry: result.change,
    diff: { ...result.preview, moved: result.moved },
  });
});
