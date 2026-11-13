// Mounted at /api/my — behind requireAuth (req.ctx = { orgId, user, db }).
// "Τα δικά μου" (F6): what waits for the current user across every active tender they can reach.
import { Router } from 'express';
import { accessibleTenderIds } from '../../core/permissions.js';
import type { Ctx } from '../../core/types.js';
import type { Row } from '../../db/scoped.js';
import { addWorkingDays } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { todayAthens } from '../../domain/time.js';
import { ACTIVE_TENDER_STATUSES, OPEN_TASK_STATUSES } from '../tasks/common.js';
import { watchView } from '../watch/service.js';

export const router: Router = Router();

export type MyBucket = 'overdue' | 'today' | 'soon' | 'later';
export type MyKind = 'task' | 'checklist' | 'handoff_deliver' | 'handoff_receive' | 'watch' | 'gate';

export interface MyItem {
  kind: MyKind;
  id: string;
  tender_id: string;
  tender_title: string;
  /** tab of the tender page that shows the item: /tenders/:id/<tab> */
  tab: 'tasks' | 'watch' | 'gates';
  title: string;
  /** the date the item is bucketed by; null = no date (→ later) */
  date: string | null;
  bucket: MyBucket;
  status: string;
  /** how the item reached the user: assigned by name, or through a tender role they hold */
  via: 'user' | 'role';
  role_key: string | null;
  /** display name of role_key in that tender */
  role_name: string | null;
  /** kind-specific extras (handoff roles, watch state, gate key…) */
  info: Record<string, unknown>;
}

/** overdue: before today · today · soon: within the next 3 working days · later: beyond, or undated. */
export function bucketOf(date: string | null, today: string, horizon: string): MyBucket {
  if (!date) return 'later';
  if (date < today) return 'overdue';
  if (date === today) return 'today';
  return date <= horizon ? 'soon' : 'later';
}

export async function collectMyWork(ctx: Pick<Ctx, 'user' | 'db'>, today = todayAthens()) {
  const { db, user } = ctx;
  const holidays = await loadHolidays(db);
  const horizon = addWorkingDays(today, 3, holidays);
  const empty = { today, horizon, counts: { overdue: 0, today: 0, soon: 0, later: 0, total: 0 }, groups: { overdue: [], today: [], soon: [], later: [] } as Record<MyBucket, MyItem[]> };

  const accessible = await accessibleTenderIds(ctx);
  const tenderWhere: Row = { status: [...ACTIVE_TENDER_STATUSES] };
  if (accessible !== null) tenderWhere.id = accessible;
  const tenders = accessible !== null && accessible.length === 0 ? [] : await db.list('tender', tenderWhere);
  if (tenders.length === 0) return empty;
  const tenderIds = tenders.map((t) => t.id as string);
  const titleOf = new Map(tenders.map((t) => [t.id as string, String(t.title)]));

  const [memberships, tasks, watchItems, gates, milestones, tenderRoles] = await Promise.all([
    db.list<{ tender_id: string; tender_role_key: string | null }>('tender_member', { user_id: user.id, tender_id: tenderIds }),
    db.list('task', { tender_id: tenderIds, status: [...OPEN_TASK_STATUSES] }, { orderBy: 'due_date nulls last, sort' }),
    db.list('watch_item', { tender_id: tenderIds, arrived_at: null }, { orderBy: 'sort' }),
    db.list('gate', { tender_id: tenderIds, approver_user_id: user.id, decision: 'pending' }),
    db.list('milestone', { tender_id: tenderIds }),
    db.list<{ tender_id: string; key: string; name: string }>('tender_role', { tender_id: tenderIds }),
  ]);
  const roleNames = new Map(tenderRoles.map((r) => [`${r.tender_id}:${r.key}`, r.name]));
  const roleNameOf = (tenderId: string, key: unknown): string | null => (typeof key === 'string' ? (roleNames.get(`${tenderId}:${key}`) ?? key) : null);
  const rolesIn = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!m.tender_role_key) continue;
    const set = rolesIn.get(m.tender_id) ?? new Set<string>();
    set.add(m.tender_role_key);
    rolesIn.set(m.tender_id, set);
  }
  const holds = (tenderId: string, key: unknown): key is string => typeof key === 'string' && (rolesIn.get(tenderId)?.has(key) ?? false);
  const milestoneById = new Map(milestones.map((m) => [m.id as string, m]));
  const milestonesByKeyIn = new Map<string, Map<string, Row>>();
  for (const m of milestones) {
    const map = milestonesByKeyIn.get(m.tender_id) ?? new Map<string, Row>();
    map.set(m.key, m);
    milestonesByKeyIn.set(m.tender_id, map);
  }

  const items: MyItem[] = [];
  const push = (item: Omit<MyItem, 'bucket' | 'tender_title' | 'role_name'> & { bucket?: MyBucket }) =>
    items.push({
      ...item,
      role_name: roleNameOf(item.tender_id, item.role_key),
      tender_title: titleOf.get(item.tender_id) ?? '',
      bucket: item.bucket ?? bucketOf(item.date, today, horizon),
    });

  for (const t of tasks) {
    const base = { id: t.id as string, tender_id: t.tender_id as string, tab: 'tasks' as const, title: String(t.title), date: (t.due_date as string | null) ?? null, status: String(t.status) };
    if (t.section === 'handoff') {
      const info = { from_role: t.handoff_from_role, to_role: t.handoff_to_role, from_role_name: roleNameOf(t.tender_id, t.handoff_from_role), to_role_name: roleNameOf(t.tender_id, t.handoff_to_role), delivered: !!t.payload?.delivered_at, delivered_at: t.payload?.delivered_at ?? null };
      // Waiting for my receipt (I hold the "to" role) …
      if (holds(t.tender_id, t.handoff_to_role)) {
        push({ ...base, kind: 'handoff_receive', via: 'role', role_key: t.handoff_to_role, info });
      }
      // … or mine to deliver (I hold the "from" role and it is not delivered yet).
      if (holds(t.tender_id, t.handoff_from_role) && !info.delivered) {
        push({ ...base, kind: 'handoff_deliver', via: 'role', role_key: t.handoff_from_role, info });
      }
      continue;
    }
    const direct = t.owner_user_id === user.id;
    if (!direct && !holds(t.tender_id, t.owner_role_key)) continue;
    push({ ...base, kind: t.section === 'checklist' ? 'checklist' : 'task', via: direct ? 'user' : 'role', role_key: direct ? null : t.owner_role_key, info: {} });
  }

  for (const w of watchItems) {
    const direct = w.owner_user_id === user.id;
    if (!direct && !holds(w.tender_id, w.owner_role_key)) continue;
    const v = watchView(w, milestonesByKeyIn.get(w.tender_id) ?? new Map(), holidays, today);
    // Not requested yet → act by the last request day (R6); requested → watch the expected arrival.
    const date = v.requested_at ? (v.expected_at ?? v.needed_at) : (v.last_request_date ?? v.needed_at);
    push({
      kind: 'watch',
      id: v.id,
      tender_id: v.tender_id,
      tab: 'watch',
      title: v.name,
      date,
      status: v.state,
      via: direct ? 'user' : 'role',
      role_key: direct ? null : v.owner_role_key,
      info: { state: v.state, request_overdue: v.request_overdue, last_request_date: v.last_request_date, needed_at: v.needed_at, requested_at: v.requested_at, expected_at: v.expected_at },
    });
  }

  for (const g of gates) {
    const m = milestoneById.get(g.milestone_id);
    const date = (m?.due_date as string | null | undefined) ?? null;
    const requested = g.requested_at != null;
    // An approval that has been requested needs me now, whatever the gate's date.
    const bucket = requested && !(date && date < today) ? ('today' as const) : undefined;
    push({
      kind: 'gate',
      id: g.id,
      tender_id: g.tender_id,
      tab: 'gates',
      title: m ? String(m.name) : String(g.key ?? ''),
      date,
      bucket,
      status: requested ? 'requested' : 'pending',
      via: 'user',
      role_key: g.approver_role_key ?? null,
      info: { gate_key: g.key ?? m?.key ?? null, requested, requested_at: g.requested_at ?? null, decision_mode: g.decision_mode },
    });
  }

  const groups: Record<MyBucket, MyItem[]> = { overdue: [], today: [], soon: [], later: [] };
  for (const item of items) groups[item.bucket].push(item);
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.tender_title.localeCompare(b.tender_title) || a.title.localeCompare(b.title));
  }
  return {
    today,
    horizon,
    counts: { overdue: groups.overdue.length, today: groups.today.length, soon: groups.soon.length, later: groups.later.length, total: items.length },
    groups,
  };
}

router.get('/', async (req, res) => {
  res.json(await collectMyWork(req.ctx));
});
