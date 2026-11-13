import type { ScopedDb, Row } from '../db/scoped.js';

export const ORG_ROLES = ['admin', 'bid_manager', 'member', 'approver', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** The authenticated user as exposed on req.ctx (never contains secrets). */
export interface CtxUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  org_role: OrgRole;
}

/** Request context set by the auth middleware. org_id comes from the session only. */
export interface Ctx {
  orgId: string;
  user: CtxUser;
  db: ScopedDb;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Request id (set first thing in app.ts; reused by the access log and error tracking). */
      id?: string | number | object;
      /** Set by requireAuth on every route behind it (everything except /api/health and /api/auth/*). */
      ctx: Ctx;
      /** Set by the tender guard on /api/tenders/:tenderId/<module> routes. */
      tender: Row;
    }
  }
}
