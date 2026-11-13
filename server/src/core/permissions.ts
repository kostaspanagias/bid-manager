import type { RequestHandler } from 'express';
import type { Row } from '../db/scoped.js';
import { forbidden, notFound } from './errors.js';
import { isMutating } from './http.js';
import type { Ctx, OrgRole } from './types.js';

export type AccessMode = 'read' | 'write';
type PermCtx = Pick<Ctx, 'user' | 'db'>;

const ALL_TENDERS: ReadonlySet<OrgRole> = new Set(['admin', 'bid_manager']);

/** Express middleware: the user's organization role must be one of `roles`, else 403. */
export function requireRole(...roles: OrgRole[]): RequestHandler {
  return (req, _res, next) => {
    assertRole(req.ctx, ...roles);
    next();
  };
}

/** Same check for use inside handlers/services. */
export function assertRole(ctx: PermCtx, ...roles: OrgRole[]): void {
  if (!roles.includes(ctx.user.org_role)) throw forbidden();
}

export function hasRole(ctx: PermCtx, ...roles: OrgRole[]): boolean {
  return roles.includes(ctx.user.org_role);
}

/** True when the user reaches every tender of the org (admin, bid_manager). */
export function seesAllTenders(ctx: PermCtx): boolean {
  return ALL_TENDERS.has(ctx.user.org_role);
}

/**
 * Returns the tender row or throws. Admin and bid_manager reach every tender of the org; member/approver/viewer
 * only tenders where they have a tender_member row; viewer is read-only everywhere.
 * 404 when the tender is missing or belongs to another org; 403 when it exists but the user may not do this.
 */
export async function requireTenderAccess(ctx: PermCtx, tenderId: string, mode: AccessMode = 'read'): Promise<Row> {
  const tender = await ctx.db.get('tender', tenderId);
  if (!tender) throw notFound('Tender not found');
  if (!seesAllTenders(ctx)) {
    const membership = await ctx.db.count('tender_member', { tender_id: tender.id, user_id: ctx.user.id });
    if (membership === 0) throw forbidden('You are not a member of this tender');
  }
  if (mode === 'write' && ctx.user.org_role === 'viewer') throw forbidden('Viewers have read-only access');
  return tender;
}

/** Ids of the tenders the user may read — `null` means "all tenders of the org" (admin, bid_manager). */
export async function accessibleTenderIds(ctx: PermCtx): Promise<string[] | null> {
  if (seesAllTenders(ctx)) return null;
  const rows = await ctx.db.list<{ tender_id: string }>('tender_member', { user_id: ctx.user.id });
  return [...new Set(rows.map((r) => r.tender_id))];
}

/**
 * R18 — who may see the financial-offer files of a tender: admin, bid_manager, approvers who are members of the
 * tender, and members holding a tender role whose payload.financial is true. A viewer never.
 * Check it on the backend for every list/download of `file.confidentiality = 'financial'`.
 */
export async function canSeeFinancial(ctx: PermCtx, tenderId: string): Promise<boolean> {
  const role = ctx.user.org_role;
  if (role === 'viewer') return false;
  if (role === 'admin' || role === 'bid_manager') return (await ctx.db.count('tender', { id: tenderId })) > 0;
  const memberships = await ctx.db.list<{ tender_role_key: string | null }>('tender_member', { tender_id: tenderId, user_id: ctx.user.id });
  if (memberships.length === 0) return false;
  if (role === 'approver') return true;
  const keys = memberships.map((m) => m.tender_role_key).filter((k): k is string => typeof k === 'string');
  if (keys.length === 0) return false;
  const roles = await ctx.db.list<{ payload: { financial?: unknown } | null }>('tender_role', { tender_id: tenderId, key: keys });
  return roles.some((r) => r.payload?.financial === true);
}

export async function requireFinancialAccess(ctx: PermCtx, tenderId: string): Promise<void> {
  if (!(await canSeeFinancial(ctx, tenderId))) throw forbidden('Financial files are restricted', 'financial_restricted');
}

/**
 * Guard mounted in app.ts in front of every /api/tenders/:tenderId/<module> router: enforces read access for
 * GET/HEAD and write access for everything else, and puts the tender row on req.tender.
 */
export const tenderGuard: RequestHandler = async (req, _res, next) => {
  const tenderId = String(req.params.tenderId ?? '');
  req.tender = await requireTenderAccess(req.ctx, tenderId, isMutating(req.method) ? 'write' : 'read');
  next();
};
