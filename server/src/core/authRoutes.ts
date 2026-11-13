import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { scopedDb } from '../db/scoped.js';
import { assertCsrf, deleteSession, endSession, loadSession, startSession, toCtxUser, type ActiveSession } from './auth.js';
import { findInvitationByTokenHash, findUsersByEmail, type AuthUserRow } from './authStore.js';
import { sha256Hex } from './crypto.js';
import { conflict, HttpError, notFound, unauthorized } from './errors.js';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from './password.js';
import { authLimiter } from './rateLimit.js';
import { newTotpSecret, openTotpSecret, sealTotpSecret, totpEnrolment, verifyTotp } from './totp.js';

// Mounted at /api/auth. Login is two steps: password → partial session → TOTP (or first-time TOTP enrolment)
// → full session. There is no public sign-up: accounts are created by accepting an admin's invitation.

/** Consecutive wrong passwords before the account is locked, and for how long. */
export const MAX_FAILED_LOGINS = 10;
export const LOCK_MINUTES = 15;
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

const invalidCredentials = () => unauthorized('Invalid e-mail or password', 'invalid_credentials');
const invalidCode = () => unauthorized('Invalid code', 'invalid_code');
const invalidInvitation = () => notFound('Invitation is invalid or has expired', 'invitation_invalid');

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

const stageOf = (user: AuthUserRow) => (user.totp_enabled_at ? ('totp' as const) : ('totp_setup' as const));

/** TOTP passed: replace the partial session with a fresh full one (new token → no session fixation). */
async function promote(req: Request, res: Response, active: ActiveSession, timeStep: number, enrol: boolean) {
  const { user } = active;
  const db = scopedDb(user.org_id, user.id);
  await db.sql(
    `UPDATE "user"
        SET totp_last_step = :step, last_login_at = now(), failed_login_count = 0, locked_until = NULL,
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
  if (!row || row.totp_attempts >= MAX_TOTP_ATTEMPTS) {
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

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const candidates = await findUsersByEmail(email);
    let matched: AuthUserRow | null = null;
    // Unknown e-mail, inactive, locked or password-less accounts all cost one Argon2 verification and all get
    // the same 401, so neither the response nor its timing reveals whether an account exists.
    if (candidates.length === 0) await verifyPassword(null, password);
    for (const user of candidates) {
      const locked = user.locked_until !== null && user.locked_until.getTime() > Date.now();
      const usable = user.active && !!user.password_hash && !locked;
      const ok = await verifyPassword(usable ? user.password_hash : null, password);
      if (ok && !matched) {
        matched = user;
      } else if (!ok && usable) {
        await scopedDb(user.org_id, null).sql(
          `UPDATE "user"
              SET failed_login_count = failed_login_count + 1,
                  locked_until = CASE WHEN failed_login_count + 1 >= :max THEN now() + make_interval(mins => :mins) ELSE locked_until END
            WHERE org_id = :org_id AND id = :id`,
          { id: user.id, max: MAX_FAILED_LOGINS, mins: LOCK_MINUTES },
        );
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

  return router;
}
