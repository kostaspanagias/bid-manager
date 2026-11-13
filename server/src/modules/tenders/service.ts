// Tenders (F1) and template application (F2). Everything goes through the scoped data layer.
import { notFound, unprocessable } from '../../core/errors.js';
import { canSeeFinancial, hasRole } from '../../core/permissions.js';
import type { Ctx } from '../../core/types.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { workingDaysBetween, type Holidays } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { computeSchedule, conditionApplies, scheduleMode, toScheduleItems, type ScheduleEntry } from '../../domain/scheduler.js';
import { todayAthens } from '../../domain/time.js';
import { expiredOnT, guaranteeWarning } from '../../domain/validity.js';
import { loadScheduleState, snapshotOf, tenderDates, type SnapshotItem, type TemplateSnapshot } from './schedule.js';

export const ACTIVE_STATUSES = ['evaluation', 'in_progress'] as const;
export const CLOSED_STATUSES = ['submitted', 'no_go', 'cancelled'] as const;

export function isActive(tender: Row): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(tender.status);
}

/** Closed tenders are read-only (cross-slice rule). */
export function assertOpen(tender: Row): void {
  if (!isActive(tender)) throw unprocessable('The tender is closed and can no longer be changed', undefined, 'tender_closed');
}

/** The tender as sent to clients: every column except the (large) template snapshot, plus the template's name. */
export function tenderView(tender: Row): Row {
  const { template_snapshot: snapshot, ...rest } = tender;
  return { ...rest, template_name: (snapshot as TemplateSnapshot | null)?.template?.name ?? null };
}

/* ------------------------------------------------------------------ members */

export interface MemberInput {
  user_id: string;
  role_key: string | null;
}

/** Users must be active users of this org; role keys must be roles of the tender. Returns the de-duplicated list. */
async function validateMembers(db: ScopedDb, members: MemberInput[], roleKeys: ReadonlySet<string>): Promise<MemberInput[]> {
  const seen = new Set<string>();
  const out: MemberInput[] = [];
  for (const m of members) {
    const id = `${m.user_id}|${m.role_key ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  const unknownRole = out.find((m) => m.role_key !== null && !roleKeys.has(m.role_key));
  if (unknownRole) throw unprocessable(`Unknown tender role "${unknownRole.role_key}"`, { role_key: unknownRole.role_key }, 'unknown_tender_role');
  const ids = [...new Set(out.map((m) => m.user_id))];
  if (ids.length > 0) {
    const users = await db.list<{ id: string; active: boolean }>('user', { id: ids });
    const ok = new Set(users.filter((u) => u.active).map((u) => u.id));
    const bad = ids.find((id) => !ok.has(id));
    if (bad) throw unprocessable('A selected user does not exist or is inactive', { user_id: bad }, 'unknown_user');
  }
  return out;
}

export async function listMembers(db: ScopedDb, tenderId: string) {
  const roles = await db.list('tender_role', { tender_id: tenderId }, { orderBy: 'sort, key' });
  const items = await db.sql(
    `SELECT tm.id, tm.user_id, tm.tender_role_key, u.name, u.email, u.org_role, u.active
       FROM tender_member tm JOIN "user" u ON u.org_id = tm.org_id AND u.id = tm.user_id
      WHERE tm.org_id = :org_id AND tm.tender_id = :tender_id
      ORDER BY u.name, u.email, tm.tender_role_key NULLS FIRST`,
    { tender_id: tenderId },
  );
  return {
    roles: roles.map((r) => ({ key: r.key, name: r.name, sort: r.sort, payload: r.payload ?? {} })),
    items: items.map((m) => ({
      id: m.id,
      user_id: m.user_id,
      tender_role_key: m.tender_role_key,
      user: { id: m.user_id, name: m.name, email: m.email, org_role: m.org_role, active: m.active },
    })),
  };
}

/**
 * Replaces the tender's team. Pending gates follow the role: a gate without approver gets the first holder of its
 * approver role, and a gate whose approver just lost that role is handed to the role's first current holder.
 */
export async function replaceMembers(db: ScopedDb, tender: Row, input: MemberInput[]): Promise<void> {
  await db.tx(async (tx) => {
    const roles = await tx.list<{ key: string }>('tender_role', { tender_id: tender.id });
    const members = await validateMembers(tx, input, new Set(roles.map((r) => r.key)));
    const existing = await tx.list<{ id: string; user_id: string; tender_role_key: string | null }>('tender_member', { tender_id: tender.id });
    const idOf = (userId: string, role: string | null) => `${userId}|${role ?? ''}`;
    const wanted = new Set(members.map((m) => idOf(m.user_id, m.role_key)));
    const have = new Set(existing.map((m) => idOf(m.user_id, m.tender_role_key)));
    for (const m of existing) if (!wanted.has(idOf(m.user_id, m.tender_role_key))) await tx.remove('tender_member', m.id);
    const added = members.filter((m) => !have.has(idOf(m.user_id, m.role_key)));
    await tx.insertMany('tender_member', added.map((m) => ({ tender_id: tender.id, user_id: m.user_id, tender_role_key: m.role_key })));

    const holders = new Map<string, string[]>();
    for (const m of members) if (m.role_key !== null) holders.set(m.role_key, [...(holders.get(m.role_key) ?? []), m.user_id]);
    const gates = await tx.list('gate', { tender_id: tender.id, decision: 'pending' });
    for (const g of gates) {
      if (!g.approver_role_key) continue;
      const now = holders.get(g.approver_role_key) ?? [];
      const heldBefore = g.approver_user_id != null && have.has(idOf(g.approver_user_id, g.approver_role_key));
      const lostRole = heldBefore && !now.includes(g.approver_user_id);
      if (g.approver_user_id == null || lostRole) {
        const next = now[0] ?? null;
        if (next !== g.approver_user_id) await tx.update('gate', g.id, { approver_user_id: next });
      }
    }
  });
}

/* ------------------------------------------------------------------ create + apply template (F1, F2) */

export interface CreateInput {
  fields: Row;
  template_id: string;
  members: MemberInput[];
}

const SNAPSHOT_COLUMNS = ['kind', 'key', 'name', 'owner_role_key', 'offset_value', 'offset_unit', 'anchor', 'condition', 'sort', 'payload'] as const;

function payloadOf(item: SnapshotItem): Record<string, unknown> {
  return item.payload && typeof item.payload === 'object' ? item.payload : {};
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Creates the tender and applies the template in one transaction, as ARCHITECTURE.md "How template items become
 * tender rows" prescribes. Conditional items (demo / partners) are created only when the flag is set (F2); the
 * snapshot keeps every item of the template.
 */
export async function createTender(db: ScopedDb, input: CreateInput, today = todayAthens()): Promise<Row> {
  return db.tx(async (tx) => {
    const template = await tx.get('template', input.template_id);
    if (!template) throw unprocessable('The selected template does not exist', undefined, 'template_not_found');
    if (template.status !== 'published') throw unprocessable('Only a published template can be applied', undefined, 'template_not_published');
    const templateItems = await tx.list('template_item', { template_id: template.id }, { orderBy: 'sort, created_at, id' });
    const snapshotItems: SnapshotItem[] = templateItems.map((row) => {
      const item: Row = {};
      for (const c of SNAPSHOT_COLUMNS) item[c] = row[c] ?? null;
      return item as SnapshotItem;
    });
    const snapshot: TemplateSnapshot = {
      template: { id: template.id, name: template.name, version: template.version, description: template.description ?? null },
      applied_at: new Date().toISOString(),
      items: snapshotItems,
    };

    const flags = { has_demo: Boolean(input.fields.has_demo), has_partners: Boolean(input.fields.has_partners) };
    const applied = snapshotItems.filter((i) => conditionApplies(i.condition, flags));
    const of = (kind: string) => applied.filter((i) => i.kind === kind);

    let tender = await tx.insert('tender', {
      ...input.fields,
      status: 'evaluation',
      template_id: template.id,
      template_version: template.version,
      template_snapshot: snapshot,
    });
    const { T, T0 } = tenderDates(tender);
    const holidays = await loadHolidays(tx);
    const schedule = computeSchedule({ items: toScheduleItems(snapshotItems, flags), T, T0, today, holidays });
    const entry = new Map<string, ScheduleEntry>(schedule.entries.map((e) => [e.key, e]));
    if (schedule.mode.compressed) tender = (await tx.update('tender', tender.id, { compressed_mode: true })) ?? tender;

    // roles and team
    const roles = of('role').filter((r) => r.key);
    await tx.insertMany('tender_role', roles.map((r, i) => ({ tender_id: tender.id, key: r.key, name: r.name, sort: r.sort ?? i, payload: payloadOf(r) })));
    const members = await validateMembers(tx, input.members, new Set(roles.map((r) => r.key as string)));
    await tx.insertMany('tender_member', members.map((m) => ({ tender_id: tender.id, user_id: m.user_id, tender_role_key: m.role_key })));
    const firstHolder = (role: string | null) => (role ? (members.find((m) => m.role_key === role)?.user_id ?? null) : null);

    // gate / milestone / handoff → milestone rows
    const dated = applied.filter((i) => (i.kind === 'gate' || i.kind === 'milestone' || i.kind === 'handoff') && i.key && entry.has(i.key));
    const milestones = await tx.insertMany(
      'milestone',
      dated.map((i, index) => {
        const e = entry.get(i.key as string) as ScheduleEntry;
        return { tender_id: tender.id, key: i.key, name: i.name, kind: i.kind, due_date: e.due_date, computed_from: e.computed_from, sort: i.sort ?? index };
      }),
    );
    const milestoneByKey = new Map(milestones.map((m) => [m.key as string, m]));

    // gates and their exit criteria
    const gateItems = of('gate').filter((g) => g.key && milestoneByKey.has(g.key));
    const gates = await tx.insertMany(
      'gate',
      gateItems.map((g) => {
        const p = payloadOf(g);
        return {
          tender_id: tender.id,
          milestone_id: milestoneByKey.get(g.key as string)?.id,
          key: g.key,
          decision_mode: p.decision_mode === 'go_no_go' ? 'go_no_go' : 'approval',
          approver_role_key: g.owner_role_key ?? null,
          approver_user_id: firstHolder(g.owner_role_key ?? null),
          payload: typeof p.note === 'string' ? { note: p.note } : {},
        };
      }),
    );
    const gateByKey = new Map(gates.map((g) => [g.key as string, g]));
    await tx.insertMany(
      'gate_criterion',
      of('gate_criterion').flatMap((c, index) => {
        const p = payloadOf(c);
        const gate = gateByKey.get(String(p.gate_key ?? ''));
        if (!gate) return [];
        const isAuto = p.type === 'auto' && typeof p.auto_rule === 'string';
        return [{ tender_id: tender.id, gate_id: gate.id, key: c.key ?? null, text: c.name, type: isAuto ? 'auto' : 'manual', auto_rule: isAuto ? p.auto_rule : null, sort: c.sort ?? index }];
      }),
    );

    // handoffs, tasks and checklists → task rows
    const taskRows: Row[] = [];
    for (const h of of('handoff')) {
      const m = h.key ? milestoneByKey.get(h.key) : undefined;
      if (!m) continue;
      const p = payloadOf(h);
      taskRows.push({
        tender_id: tender.id,
        milestone_id: m.id,
        key: h.key,
        title: h.name,
        description: str(p.note),
        section: 'handoff',
        owner_role_key: str(p.from_role),
        handoff_from_role: str(p.from_role),
        handoff_to_role: str(p.to_role),
        due_date: m.due_date,
        sort: h.sort ?? 0,
      });
    }
    for (const t of of('task')) {
      const e = t.key ? entry.get(t.key) : undefined;
      const anchorMilestone = t.anchor && (t.offset_value ?? 0) === 0 ? milestoneByKey.get(t.anchor) : undefined;
      taskRows.push({
        tender_id: tender.id,
        milestone_id: anchorMilestone?.id ?? null,
        key: t.key ?? null,
        title: t.name,
        description: str(payloadOf(t).description),
        section: 'task',
        owner_role_key: t.owner_role_key ?? null,
        due_date: e?.due_date ?? null,
        sort: t.sort ?? 0,
        payload: e ? { computed_from: { anchor: e.computed_from.anchor, offset_value: e.computed_from.offset_value, offset_unit: e.computed_from.offset_unit }, computed_due: e.due_date } : {},
      });
    }
    for (const c of of('checklist_item')) {
      taskRows.push({ tender_id: tender.id, key: c.key ?? null, title: c.name, section: 'checklist', owner_role_key: c.owner_role_key ?? null, sort: c.sort ?? 0 });
    }
    await tx.insertMany('task', taskRows);

    // watchlist
    await tx.insertMany(
      'watch_item',
      of('watch_item').map((w, index) => {
        const p = payloadOf(w);
        const neededKey = str(p.needed_milestone_key);
        const lead = typeof p.lead_value === 'number' && Number.isInteger(p.lead_value) && p.lead_value >= 0 ? p.lead_value : null;
        return {
          tender_id: tender.id,
          key: w.key ?? null,
          name: w.name,
          owner_role_key: w.owner_role_key ?? null,
          lead_value: lead,
          lead_unit: p.lead_unit === 'calendar' ? 'calendar' : 'working',
          needed_milestone_key: neededKey,
          needed_at: neededKey ? (milestoneByKey.get(neededKey)?.due_date ?? null) : null,
          checks: str(p.checks),
          sort: w.sort ?? index,
          payload: typeof p.lead_note === 'string' ? { lead_note: p.lead_note } : {},
        };
      }),
    );
    return tender;
  });
}

/* ------------------------------------------------------------------ detail: permissions, T−n, warnings */

export type WarningCode = 'compressed_mode' | 'guarantee_at_risk' | 'gate_target_late' | 'guarantee_validity_short' | 'documents_expired_on_T';
export interface TenderWarning {
  code: WarningCode;
  /** red = blocking, orange = warning */
  severity: 'red' | 'orange';
  /** English, for logs — the web translates by code */
  message: string;
  data: Record<string, unknown>;
}

export interface NextGate {
  milestone_id: string;
  gate_id: string;
  key: string;
  name: string;
  due_date: string | null;
  /** working days from the gate to T (the n of T−n) */
  tMinus: number | null;
}

/**
 * Warnings of an active tender, computed now (never stored):
 *  R8 orange — compressed mode (the stored flag) · R8 red — fewer than 10 working days and the guarantee is not
 *  requested yet · R7 — a pending gate whose target date (G0: T0+3) is after the recommended limit (T−12) ·
 *  R16 — guarantee validity too short · R15 — linked company documents that expire before T.
 * Pass `overrides` to evaluate a prospective deadline (extension preview).
 */
export async function tenderWarnings(
  db: ScopedDb,
  tender: Row,
  opts: { holidays?: Holidays; today?: string; compressed?: boolean } = {},
): Promise<TenderWarning[]> {
  if (!isActive(tender)) return [];
  const holidays = opts.holidays ?? (await loadHolidays(db));
  const today = opts.today ?? todayAthens();
  const { T, T0 } = tenderDates(tender);
  const mode = scheduleMode(T, T0, today, holidays);
  const warnings: TenderWarning[] = [];

  if (opts.compressed ?? tender.compressed_mode) {
    warnings.push({
      code: 'compressed_mode',
      severity: 'orange',
      message: 'Compressed mode: fewer than 15 working days — G1 and G2 are merged',
      data: { workingDays: mode.workingDays, from: mode.from },
    });
  }
  if (mode.guaranteeAtRisk) {
    const guarantee = await db.findOne('watch_item', { tender_id: tender.id, key: 'guarantee' });
    if (!guarantee || (guarantee.requested_at == null && guarantee.arrived_at == null)) {
      warnings.push({
        code: 'guarantee_at_risk',
        severity: 'red',
        message: 'Fewer than 10 working days to the deadline: the guarantee will not make it without an immediate request',
        data: { workingDays: mode.workingDays, from: mode.from },
      });
    }
  }

  const state = await loadScheduleState(db, tender, holidays);
  const pending = new Map(state.milestones.filter((m) => m.kind === 'gate' && m.gate_decision === 'pending' && !m.is_manual && m.done_at == null).map((m) => [m.key, m]));
  if (pending.size > 0) {
    const schedule = computeSchedule({ items: state.items, T, T0, today, holidays, compressed: Boolean(opts.compressed ?? tender.compressed_mode) });
    for (const w of schedule.warnings) {
      const gate = w.code === 'target_after_limit' ? pending.get(w.key) : undefined;
      if (!gate || w.code !== 'target_after_limit') continue;
      warnings.push({
        code: 'gate_target_late',
        severity: 'orange',
        message: `${gate.key}: the target date is later than recommended — little margin for the guarantee`,
        data: { key: gate.key, name: gate.name, target: w.target, recommended: w.limit, latest: w.latest, due_date: gate.due_date },
      });
    }
  }

  const guarantee = guaranteeWarning({
    submission_deadline_at: tender.submission_deadline_at,
    guarantee_valid_until: tender.guarantee_valid_until ?? null,
    offer_validity_days: tender.offer_validity_days ?? null,
    guarantee_margin_days: tender.guarantee_margin_days ?? null,
  });
  if (guarantee) {
    warnings.push({
      code: 'guarantee_validity_short',
      severity: 'orange',
      message: 'The participation guarantee expires before T + offer validity + margin',
      data: { ...guarantee },
    });
  }

  const docs = await db.sql<{ id: string; title: string; type: string; expires_at: string | null }>(
    `SELECT d.id, d.title, d.type, d.expires_at
       FROM tender_document td JOIN company_document d ON d.org_id = td.org_id AND d.id = td.company_document_id
      WHERE td.org_id = :org_id AND td.tender_id = :tender_id AND d.expires_at IS NOT NULL
      ORDER BY d.expires_at, d.title`,
    { tender_id: tender.id },
  );
  const expired = expiredOnT(docs, T);
  if (expired.length > 0) {
    warnings.push({
      code: 'documents_expired_on_T',
      severity: 'red',
      message: 'Linked company documents expire before the submission deadline',
      data: { count: expired.length, T, documents: expired.slice(0, 10).map((d) => ({ id: d.id, title: d.title, type: d.type, expires_at: d.expires_at })) },
    });
  }
  return warnings;
}

/** The next gate still waiting for a decision, by date. */
export async function nextGates(db: ScopedDb, tenderIds: string[] | null): Promise<Map<string, Omit<NextGate, 'tMinus'>>> {
  if (tenderIds !== null && tenderIds.length === 0) return new Map();
  const rows = await db.sql<Omit<NextGate, 'tMinus'> & { tender_id: string }>(
    `SELECT DISTINCT ON (m.tender_id) m.tender_id, m.id AS milestone_id, g.id AS gate_id, m.key, m.name, m.due_date
       FROM milestone m JOIN gate g ON g.org_id = m.org_id AND g.milestone_id = m.id
      WHERE m.org_id = :org_id AND g.decision = 'pending' AND m.done_at IS NULL
        AND (:all OR m.tender_id = ANY(:ids))
      ORDER BY m.tender_id, m.due_date NULLS LAST, m.sort, m.key`,
    { all: tenderIds === null, ids: tenderIds ?? [] },
  );
  return new Map(rows.map(({ tender_id, ...gate }) => [tender_id, gate]));
}

export function withTMinus(gate: Omit<NextGate, 'tMinus'> | undefined, T: string, holidays: Holidays): NextGate | null {
  if (!gate) return null;
  return { ...gate, tMinus: gate.due_date ? workingDaysBetween(gate.due_date, T, holidays) : null };
}

/** `GET /api/tenders/:id` — the cross-slice contract `{ tender, permissions, tMinus, warnings }` plus conveniences. */
export async function tenderDetail(ctx: Pick<Ctx, 'user' | 'db'>, tender: Row) {
  const { db } = ctx;
  const holidays = await loadHolidays(db);
  const today = todayAthens();
  const { T, T0 } = tenderDates(tender);
  const active = isActive(tender);
  const canManage = hasRole(ctx, 'admin', 'bid_manager');
  const gates = await nextGates(db, [tender.id]);
  return {
    tender: tenderView(tender),
    permissions: {
      /** may change tender data: not a viewer and the tender is not closed */
      canWrite: active && ctx.user.org_role !== 'viewer',
      canSeeFinancial: await canSeeFinancial(ctx, tender.id),
      /** admin / bid manager: basic fields, team, deadline, status, milestone dates */
      canManage,
    },
    T,
    T0,
    /** working days from today to T (negative after the deadline) */
    tMinus: workingDaysBetween(today, T, holidays),
    nextGate: withTMinus(gates.get(tender.id), T, holidays),
    warnings: await tenderWarnings(db, tender, { holidays, today }),
  };
}

export async function getTenderOr404(db: ScopedDb, id: string): Promise<Row> {
  const tender = await db.get('tender', id);
  if (!tender) throw notFound('Tender not found');
  return tender;
}

export { snapshotOf };
