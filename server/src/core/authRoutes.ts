import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { scopedDb } from '../db/scoped.js';
import { assertCsrf, deleteSession, endSession, loadSession, startSession, toCtxUser, type ActiveSession } from './auth.js';
import { findInvitationByTokenHash, findPasswordResetByTokenHash, findUsersByEmail, type AuthUserRow } from './authStore.js';
import { sha256Hex } from './crypto.js';
import { conflict, HttpError, notFound, unauthorized } from './errors.js';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from './password.js';
import { authLimiter } from './rateLimit.js';
import { newTotpSecret, openTotpSecret, sealTotpSecret, totpEnrolment, verifyTotp } from './totp.js';

// Mounted at /api/auth. Login is two steps: password → partial session → TOTP (or first-time TOTP enrolment)
// → full session. There is no public sign-up: accounts are created by accepting an admin's invitation.

/**
 * Consecutive wrong passwords from one client address before THAT address is locked out of the account, and for
 * how long. The lock is per (account, address): a stranger hammering an e-mail address cannot lock its owner out.
 */
export const MAX_FAILED_LOGINS = 10;
export const LOCK_MINUTES = 15;
/** Wrong TOTP codes per user (across sessions) before the second factor is locked for LOCK_MINUTES. */
export const MAX_TOTP_FAILURES = 10;
/** Wrong TOTP codes allowed per partial session before it is destroyed (password needed again). */
export const MAX_TOTP_ATTEMPTS = 5;

const zEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
const loginBody = z.object({ email: zEmail, password: z.string().min(1).max(MAX_PASSWORD_LENGTH) });
const codeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Expected a 6-digit code') });
const tokenBody = z.object({ token: z.string().min(20).max(200) });
const acceptBody = tokenBody.extend({
  name: z.string().trim().min(1).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const changePasswordBody = z
  .object({ current_password: z.string().min(1).max(MAX_PASSWORD_LENGTH), new_password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH) })
  .strict();

const invalidCredentials = () => unauthorized('Invalid e-mail or password', 'invalid_credentials');
const invalidCode = () => unauthorized('Invalid code', 'invalid_code');
const invalidInvitation = () => notFound('Invitation is invalid or has expired', 'invitation_invalid');
const invalidReset = () => notFound('The password-reset link is invalid or has expired', 'reset_invalid');
const resetBody = tokenBody.extend({ password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH) });

async function requireSession(req: Request): Promise<ActiveSession> {
  const active = await loadSession(req);
  if (!active) throw unauthorized();
  return active;
}

async function meBody(active: { user: AuthUserRow }, csrfToken: string) {
  const user = toCtxUser(active.user);
  const org = await scopedDb(user.org_id, user.id).get('organization', user.org_id);
  return {
    stage: 'ready' as const,
    user: { id: user.id, email: user.email, name: user.name, org_role: user.org_role },
    org: { id: user.org_id, name: org?.name ?? '', timezone: org?.timezone ?? 'Europe/Athens' },
    csrfToken,
  };
}

/** The second factor is locked after too many wrong codes: the partial session ends, the user waits. */
async function assertTotpNotLocked(res: Response, active: ActiveSession): Promise<void> {
  const until = active.user.totp_locked_until;
  if (until && until.getTime() > Date.now()) {
    await endSession(res, active);
    throw new HttpError(429, 'totp_locked', 'Too many wrong codes. Try again later.', { retryAfterMinutes: Math.ceil((until.getTime() - Date.now()) / 60_000) });
  }
}

const clientOf = (req: Request): string => (req.ip ?? 'unknown').slice(0, 100);

const stageOf = (user: AuthUserRow) => (user.totp_enabled_at ? ('totp' as const) : ('totp_setup' as const));

/** TOTP passed: replace the partial session with a fresh full one (new token → no session fixation). */
async function promote(req: Request, res: Response, active: ActiveSession, timeStep: number, enrol: boolean) {
  const { user } = active;
  const db = scopedDb(user.org_id, user.id);
  await db.sql(
    `UPDATE "user"
        SET totp_last_step = :step, last_login_at = now(), failed_login_count = 0, locked_until = NULL,
            totp_failed_count = 0, totp_locked_until = NULL,
            totp_enabled_at = CASE WHEN :enrol THEN now() ELSE totp_enabled_at END
      WHERE org_id = :org_id AND id = :id`,
    { step: timeStep, enrol, id: user.id },
  );
  await deleteSession(active);
  const csrfToken = await startSession(req, res, user, true);
  if (enrol) await db.audit('user', user.id, 'totp_enabled');
  await db.audit('user', user.id, 'login');
  res.json({ ok: true, ...(await meBody(active, csrfToken)) });
}

async function totpFailed(res: Response, active: ActiveSession): Promise<never> {
  const db = scopedDb(active.user.org_id, active.user.id);
  const [row] = await db.sql<{ totp_attempts: number }>(
    'UPDATE session SET totp_attempts = totp_attempts + 1 WHERE org_id = :org_id AND id = :id RETURNING totp_attempts',
    { id: active.session.id },
  );
  // Per user, across sessions: whoever holds the password gets MAX_TOTP_FAILURES guesses, not 5 per login.
  const [counter] = await db.sql<{ totp_failed_count: number }>(
    `UPDATE "user"
        SET totp_failed_count = CASE WHEN totp_failed_count + 1 >= :max THEN 0 ELSE totp_failed_count + 1 END,
            totp_locked_until = CASE WHEN totp_failed_count + 1 >= :max THEN now() + make_interval(mins => :mins) ELSE totp_locked_until END
      WHERE org_id = :org_id AND id = :id
      RETURNING totp_failed_count`,
    { id: active.user.id, max: MAX_TOTP_FAILURES, mins: LOCK_MINUTES },
  );
  const lockedNow = counter?.totp_failed_count === 0;
  if (lockedNow) await db.audit('user', active.user.id, 'totp_locked', { after: { minutes: LOCK_MINUTES } });
  if (!row || row.totp_attempts >= MAX_TOTP_ATTEMPTS || lockedNow) {
    await endSession(res, active);
    await db.audit('user', active.user.id, 'totp_attempts_exceeded');
  }
  throw invalidCode();
}

export function authRouter(): Router {
  const router = Router();
  // Warm the dummy hash so the very first unknown-e-mail login is not slower than the rest.
  void verifyPassword(null, 'warm-up');
  const loginLimiter = authLimiter(20);
  const totpLimiter = authLimiter(30);
  const inviteLimiter = authLimiter(30);
  const passwordLimiter = authLimiter(10);

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const candidates = await findUsersByEmail(email);
    let matched: AuthUserRow | null = null;
    // Unknown e-mail, inactive, locked-out or password-less accounts all cost one Argon2 verification and all get
    // the same 401, so neither the response nor its timing reveals whether an account exists.
    if (candidates.length === 0) await verifyPassword(null, password);
    const ip = clientOf(req);
    for (const user of candidates) {
      const db = scopedDb(user.org_id, null);
      const [throttle] = await db.sql<{ locked_until: Date | null }>(
        'SELECT locked_until FROM login_throttle WHERE org_id = :org_id AND user_id = :id AND ip = :ip',
        { id: user.id, ip },
      );
      const locked = !!throttle?.locked_until && throttle.locked_until.getTime() > Date.now();
      const usable = user.active && !!user.password_hash && !locked;
      const ok = await verifyPassword(usable ? user.password_hash : null, password);
      if (ok && !matched) {
        matched = user;
        await db.sql('DELETE FROM login_throttle WHERE org_id = :org_id AND user_id = :id AND ip = :ip', { id: user.id, ip });
      } else if (!ok && usable) {
        // Lock this client address out of this account after MAX_FAILED_LOGINS misses; other addresses (the real
        // owner) are not affected. failed_login_count stays as an account-wide counter for the admin to look at.
        await db.sql(
          `INSERT INTO login_throttle (org_id, user_id, ip, failures) VALUES (:org_id, :id, :ip, 1)
           ON CONFLICT (org_id, user_id, ip) DO UPDATE
              SET failures = CASE WHEN login_throttle.failures + 1 >= :max THEN 0 ELSE login_throttle.failures + 1 END,
                  locked_until = CASE WHEN login_throttle.failures + 1 >= :max THEN now() + make_interval(mins => :mins) ELSE login_throttle.locked_until END`,
          { id: user.id, ip, max: MAX_FAILED_LOGINS, mins: LOCK_MINUTES },
        );
        await db.sql('UPDATE "user" SET failed_login_count = failed_login_count + 1 WHERE org_id = :org_id AND id = :id', { id: user.id });
      }
    }
    if (!matched) throw invalidCredentials();

    await deleteSession(await loadSession(req)); // never reuse a pre-login session id
    const csrfToken = await startSession(req, res, matched, false);
    const stage = stageOf(matched);
    res.json({ stage, next: stage, csrfToken }); // `next` is an alias of `stage`
  });

  router.post('/totp', totpLimiter, async (req, res) => {
    const active = await requireSession(req);
    const { code } = codeBody.parse(req.body);
    if (active.session.totp_verified) {
      res.json({ ok: true, ...(await meBody(active, active.session.csrf_token)) });
      return;
    }
    const { user } = active;
    if (!user.totp_enabled_at || !user.totp_secret) throw new HttpError(409, 'totp_setup_required', 'Two-factor authentication is not set up yet');
    await assertTotpNotLocked(res, active);
    const step = await verifyTotp(openTotpSecret(user.totp_secret), code, user.totp_last_step);
    if (step === null) return totpFailed(res, active);
    await promote(req, res, active, step, false);
  });

  router.get('/totp/setup', async (req, res) => {
    const active = await requireSession(req);
    const { user } = active;
    if (user.totp_enabled_at) throw conflict('Two-factor authentication is already enabled', undefined, 'totp_already_enabled');
    // The secret is shown only during enrolment; once enabled it is never returned by any endpoint.
    let secret = user.totp_secret ? openTotpSecret(user.totp_secret) : null;
    if (!secret) {
      secret = newTotpSecret();
      await scopedDb(user.org_id, user.id).sql(
        'UPDATE "user" SET totp_secret = :secret WHERE org_id = :org_id AND id = :id AND totp_enabled_at IS NULL',
        { secret: sealTotpSecret(secret), id: user.id },
      );
    }
    res.set('Cache-Control', 'no-store');
    res.json(await totpEnrolment(user.email, secret));
  });

  router.post('/totp/enable', totpLimiter, async (req, res) => {
    const active = await requireSession(req);
    const { code } = codeBody.parse(req.body);
    const { user } = active;
    if (user.totp_enabled_at) throw conflict('Two-factor authentication is already enabled', undefined, 'totp_already_enabled');
    if (!user.totp_secret) throw new HttpError(409, 'totp_setup_required', 'Start enrolment with GET /api/auth/totp/setup');
    await assertTotpNotLocked(res, active);
    const step = await verifyTotp(openTotpSecret(user.totp_secret), code, null);
    if (step === null) return totpFailed(res, active);
    await promote(req, res, active, step, true);
  });

  router.post('/logout', async (req, res) => {
    const active = await loadSession(req);
    if (active) {
      assertCsrf(req, active);
      if (active.session.totp_verified) await scopedDb(active.user.org_id, active.user.id).audit('user', active.user.id, 'logout');
    }
    await endSession(res, active);
    res.status(204).end();
  });

  // Change of the logged-in user's own password. Needs a full session + CSRF token (this router is mounted in
  // front of requireAuth, so both are checked here). A wrong current password is a 422, not a 401: the session
  // itself is fine. Every other session of the user ends; the audit entry carries no secrets.
  router.post('/change-password', passwordLimiter, async (req, res) => {
    const active = await requireSession(req);
    if (!active.session.totp_verified) throw new HttpError(401, 'totp_required', 'Two-factor verification required');
    assertCsrf(req, active);
    const body = changePasswordBody.parse(req.body);
    const { user } = active;
    if (!(await verifyPassword(user.password_hash, body.current_password))) {
      throw new HttpError(422, 'wrong_current_password', 'The current password is not correct');
    }
    if (body.new_password === body.current_password) {
      throw new HttpError(422, 'password_unchanged', 'The new password must differ from the current one');
    }
    const passwordHash = await hashPassword(body.new_password);
    await scopedDb(user.org_id, user.id).tx(async (db) => {
      await db.sql('UPDATE "user" SET password_hash = :hash, failed_login_count = 0, locked_until = NULL WHERE org_id = :org_id AND id = :id', {
        hash: passwordHash,
        id: user.id,
      });
      const ended = await db.sql('DELETE FROM session WHERE org_id = :org_id AND user_id = :id AND id <> :current RETURNING id', {
        id: user.id,
        current: active.session.id,
      });
      await db.audit('user', user.id, 'password_changed', { after: { other_sessions_ended: ended.length } });
    });
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    const active = await requireSession(req);
    res.set('Cache-Control', 'no-store');
    if (!active.session.totp_verified) {
      // Not logged in yet. details.stage lets a client that reloaded mid-login resume at the right step.
      throw new HttpError(401, 'totp_required', 'Two-factor verification required', { stage: stageOf(active.user) });
    }
    res.json(await meBody(active, active.session.csrf_token));
  });

  async function openInvitation(token: string) {
    const invitation = await findInvitationByTokenHash(sha256Hex(token));
    if (!invitation || invitation.accepted_at || invitation.expires_at.getTime() <= Date.now()) throw invalidInvitation();
    return invitation;
  }

  router.post('/invite-info', inviteLimiter, async (req, res) => {
    const invitation = await openInvitation(tokenBody.parse(req.body).token);
    const org = await scopedDb(invitation.org_id, null).get('organization', invitation.org_id);
    res.json({ email: invitation.email, org_role: invitation.org_role, org_name: org?.name ?? '' });
  });

  router.post('/accept-invite', inviteLimiter, async (req, res) => {
    const body = acceptBody.parse(req.body);
    const invitation = await openInvitation(body.token);
    const passwordHash = await hashPassword(body.password);
    await scopedDb(invitation.org_id, null).tx(async (db) => {
      // Re-check under lock so two concurrent accepts cannot both create a user.
      const [locked] = await db.sql('SELECT id FROM invitation WHERE org_id = :org_id AND id = :id AND accepted_at IS NULL FOR UPDATE', {
        id: invitation.id,
      });
      if (!locked) throw invalidInvitation();
      if (await db.findOne('user', { email: invitation.email })) throw invalidInvitation();
      const user = await db.insert('user', {
        email: invitation.email,
        name: body.name,
        org_role: invitation.org_role,
        password_hash: passwordHash,
      });
      await db.update('invitation', invitation.id, { accepted_at: new Date(), accepted_user_id: user.id });
    });
    res.status(201).json({ ok: true, email: invitation.email });
  });

  // ---- admin-triggered password reset (POST /api/admin/users/:id/reset-password issues the link) ----
  async function openReset(token: string) {
    const reset = await findPasswordResetByTokenHash(sha256Hex(token));
    if (!reset || reset.used_at || reset.expires_at.getTime() <= Date.now()) throw invalidReset();
    const user = await scopedDb(reset.org_id, null).get('user', reset.user_id);
    if (!user || user.active !== true || user.anonymized_at) throw invalidReset();
    return { reset, user };
  }

  router.post('/reset-info', inviteLimiter, async (req, res) => {
    const { reset, user } = await openReset(tokenBody.parse(req.body).token);
    const org = await scopedDb(reset.org_id, null).get('organization', reset.org_id);
    res.json({ email: user.email, name: user.name, org_name: org?.name ?? '' });
  });

  // Sets the new password. The link is single-use; every session of the user ends and a lockout is cleared.
  // The second factor is untouched: the user still needs their authenticator to log in.
  router.post('/reset-password', inviteLimiter, async (req, res) => {
    const body = resetBody.parse(req.body);
    const { reset, user } = await openReset(body.token);
    const passwordHash = await hashPassword(body.password);
    await scopedDb(reset.org_id, user.id).tx(async (db) => {
      const [locked] = await db.sql('SELECT id FROM password_reset WHERE org_id = :org_id AND id = :id AND used_at IS NULL FOR UPDATE', { id: reset.id });
      if (!locked) throw invalidReset();
      await db.sql('UPDATE "user" SET password_hash = :hash, failed_login_count = 0, locked_until = NULL WHERE org_id = :org_id AND id = :id', {
        hash: passwordHash,
        id: user.id,
      });
      await db.sql('UPDATE password_reset SET used_at = now() WHERE org_id = :org_id AND id = :id', { id: reset.id });
      await db.sql('DELETE FROM session WHERE org_id = :org_id AND user_id = :id', { id: user.id });
      await db.audit('user', user.id, 'password_reset_completed');
    });
    res.json({ ok: true, email: user.email });
  });

  return router;
}
