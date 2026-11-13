import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { scopedDb } from '../db/scoped.js';
import { findSessionWithUser, type AuthUserRow, type SessionRow } from './authStore.js';
import { randomToken, safeEqual, sha256Hex } from './crypto.js';
import { forbidden, HttpError, unauthorized } from './errors.js';
import { isMutating } from './http.js';
import type { CtxUser } from './types.js';

// Sessions live in the `session` table. The cookie carries an opaque random token; the table stores only its
// SHA-256 (session.id), so a database leak does not yield usable sessions.

export const SESSION_COOKIE = 'bm_session';
export const CSRF_HEADER = 'x-csrf-token';
/** A password-only (pre-TOTP) session is short-lived and never extended. */
const PARTIAL_SESSION_MINUTES = 10;
/** Even an active session ends after this long; the user logs in again. */
const ABSOLUTE_SESSION_HOURS = 12;
/** last_seen_at/expires_at are pushed forward at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

export interface ActiveSession {
  session: SessionRow;
  user: AuthUserRow;
}

function cookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' };
}

export function toCtxUser(user: AuthUserRow): CtxUser {
  return { id: user.id, org_id: user.org_id, email: user.email, name: user.name, org_role: user.org_role };
}

/** Creates a session row and sets the cookie. Returns the CSRF token of the new session. */
export async function startSession(req: Request, res: Response, user: Pick<AuthUserRow, 'id' | 'org_id'>, totpVerified: boolean): Promise<string> {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const minutes = totpVerified ? config.sessionIdleMinutes : PARTIAL_SESSION_MINUTES;
  await scopedDb(user.org_id, user.id).insert('session', {
    id: sha256Hex(token),
    user_id: user.id,
    totp_verified: totpVerified,
    csrf_token: csrfToken,
    expires_at: new Date(Date.now() + minutes * 60_000),
    ip: req.ip ?? null,
    user_agent: (req.get('user-agent') ?? '').slice(0, 300) || null,
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  return csrfToken;
}

export async function endSession(res: Response, active: ActiveSession | null): Promise<void> {
  if (active) await scopedDb(active.session.org_id, active.user.id).remove('session', active.session.id);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Deletes every session of a user (deactivation, role change, 2FA reset). */
export async function endAllSessionsOf(orgId: string, userId: string): Promise<void> {
  await scopedDb(orgId, null).sql('DELETE FROM session WHERE org_id = :org_id AND user_id = :user_id', { user_id: userId });
}

/**
 * Resolves the request's session cookie. Returns null (and removes the row) when the session is unknown, idle-
 * expired, past its absolute lifetime, or its user was deactivated. Cached per request.
 */
export async function loadSession(req: Request): Promise<ActiveSession | null> {
  const cache = req as Request & { _session?: ActiveSession | null };
  if (cache._session !== undefined) return cache._session;
  cache._session = await resolve(req);
  return cache._session;
}

async function resolve(req: Request): Promise<ActiveSession | null> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const found = await findSessionWithUser(sha256Hex(token));
  if (!found) return null;
  const { session, user } = found;
  const db = scopedDb(session.org_id, user.id);
  const now = Date.now();
  const tooOld = now - session.created_at.getTime() > ABSOLUTE_SESSION_HOURS * 3_600_000;
  if (session.expires_at.getTime() <= now || tooOld || !user.active) {
    await db.remove('session', session.id);
    return null;
  }
  if (session.totp_verified && now - session.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db.sql('UPDATE session SET last_seen_at = now(), expires_at = :expires_at WHERE org_id = :org_id AND id = :id', {
      id: session.id,
      expires_at: new Date(now + config.sessionIdleMinutes * 60_000),
    });
  }
  return found;
}

/** Mutating requests must echo the session's CSRF token in X-CSRF-Token. */
export function assertCsrf(req: Request, active: ActiveSession): void {
  if (!isMutating(req.method)) return;
  const header = req.get(CSRF_HEADER);
  if (!header || !safeEqual(header, active.session.csrf_token)) {
    throw forbidden('Missing or invalid CSRF token', 'csrf_invalid');
  }
}

/**
 * Gate for everything except /api/health and /api/auth/*: requires a fully authenticated (password + TOTP)
 * session, checks CSRF on mutating requests and sets req.ctx = { orgId, user, db }.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const active = await loadSession(req);
  if (!active) throw unauthorized();
  if (!active.session.totp_verified) throw new HttpError(401, 'totp_required', 'Two-factor verification required');
  assertCsrf(req, active);
  const user = toCtxUser(active.user);
  req.ctx = { orgId: user.org_id, user, db: scopedDb(user.org_id, user.id) };
  next();
};
