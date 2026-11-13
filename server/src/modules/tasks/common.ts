// Helpers shared by the slice-5 modules (tasks, my, watch, risks, changes). Reads other slices' tables only.
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { isMutating, zDate, zUuid } from '../../core/http.js';
import { hasRole } from '../../core/permissions.js';
import type { Ctx } from '../../core/types.js';
import type { Row, ScopedDb } from '../../db/scoped.js';

export const ACTIVE_TENDER_STATUSES = ['evaluation', 'in_progress'] as const;
export const OPEN_TASK_STATUSES = ['open', 'in_progress'] as const;

export const zNullableDate = zDate.nullable();
export const zNullableUuid = zUuid.nullable();
/** Trimmed text; '' becomes null. */
export const zText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));
export const zRoleKey = z.string().trim().min(1).max(60).nullable();

export function isTenderClosed(tender: Row): boolean {
  return !(ACTIVE_TENDER_STATUSES as readonly string[]).includes(String(tender.status));
}

/** Closed tenders (submitted, no_go, cancelled) are read-only for tasks, watchlist, risks and the change log. */
export const readOnlyWhenClosed: RequestHandler = (req, _res, next) => {
  if (isMutating(req.method) && isTenderClosed(req.tender)) {
    throw unprocessable('The tender is closed: this data is read-only', undefined, 'tender_closed');
  }
  next();
};

export const isManager = (ctx: Pick<Ctx, 'user' | 'db'>): boolean => hasRole(ctx, 'admin', 'bid_manager');

export interface TenderRoleView {
  key: string;
  name: string;
  user_ids: string[];
}

/** The tender's roles (template snapshot) with the users holding each one. */
export async function loadRoles(db: ScopedDb, tenderId: string): Promise<TenderRoleView[]> {
  const [roles, members] = await Promise.all([
    db.list<{ key: string; name: string }>('tender_role', { tender_id: tenderId }, { orderBy: 'sort, key' }),
    db.list<{ user_id: string; tender_role_key: string | null }>('tender_member', { tender_id: tenderId }),
  ]);
  return roles.map((r) => ({
    key: r.key,
    name: r.name,
    user_ids: members.filter((m) => m.tender_role_key === r.key).map((m) => m.user_id),
  }));
}

/** Keys of the tender roles the user holds in this tender. */
export async function roleKeysOf(db: ScopedDb, tenderId: string, userId: string): Promise<string[]> {
  const rows = await db.list<{ tender_role_key: string | null }>('tender_member', { tender_id: tenderId, user_id: userId });
  return rows.map((r) => r.tender_role_key).filter((k): k is string => typeof k === 'string');
}

/** A row of `table` that belongs to this tender, or 404 (also for rows of another tender or another org). */
export async function getInTender(db: ScopedDb, table: string, id: string, tenderId: string, what: string): Promise<Row> {
  const row = await db.get(table, id);
  if (!row || row.tender_id !== tenderId) throw notFound(`${what} not found`);
  return row;
}

/** Owner checks: the user must be an active user of the org, the role key a role of this tender. */
export async function assertOwner(db: ScopedDb, tenderId: string, owner: { owner_user_id?: string | null; owner_role_key?: string | null }): Promise<void> {
  if (owner.owner_user_id) {
    const user = await db.get('user', owner.owner_user_id);
    if (!user || user.active === false) throw badRequest('Unknown user', [{ path: 'owner_user_id', message: 'Unknown user' }], 'unknown_user');
  }
  if (owner.owner_role_key) await assertRoleKey(db, tenderId, owner.owner_role_key, 'owner_role_key');
}

export async function assertRoleKey(db: ScopedDb, tenderId: string, key: string, path: string): Promise<void> {
  if (!(await db.findOne('tender_role', { tender_id: tenderId, key }))) {
    throw badRequest('Unknown tender role', [{ path, message: 'Unknown tender role' }], 'unknown_role');
  }
}

/** Next free `sort` value (rows are appended). */
export async function nextSort(db: ScopedDb, table: string, tenderId: string): Promise<number> {
  const [row] = await db.sql<{ next: number }>(
    `SELECT COALESCE(MAX(sort), 0) + 10 AS next FROM ${table === 'task' ? 'task' : table === 'watch_item' ? 'watch_item' : 'risk'} WHERE org_id = :org_id AND tender_id = :tenderId`,
    { tenderId },
  );
  return Number(row?.next ?? 10);
}
