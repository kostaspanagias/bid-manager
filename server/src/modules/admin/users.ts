// Mounted at /api/admin/users — admin only.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { endAllSessionsOf } from '../../core/auth.js';
import { randomToken, sha256Hex } from '../../core/crypto.js';
import { notFound, unprocessable } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sendMail } from '../../core/mailer.js';
import { requireRole } from '../../core/permissions.js';
import { ORG_ROLES, type Ctx } from '../../core/types.js';
import type { Row } from '../../db/scoped.js';

export const router: Router = Router();
router.use(requireRole('admin'));

/** Admin view of a user: never includes password_hash or totp_secret. */
function view(u: Row) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    org_role: u.org_role,
    active: u.active,
    totp_enabled: u.totp_enabled_at !== null,
    totp_enabled_at: u.totp_enabled_at,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  };
}

const patchBody = z
  .object({
    org_role: z.enum(ORG_ROLES).optional(),
    active: z.boolean().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

async function assertAnotherAdminRemains(ctx: Ctx, userId: string): Promise<void> {
  const admins = await ctx.db.list('user', { org_role: 'admin', active: true });
  if (!admins.some((a) => a.id !== userId)) throw unprocessable('The organization needs at least one active admin', undefined, 'last_admin');
}

router.get('/', async (req, res) => {
  const users = await req.ctx.db.list('user', {}, { orderBy: 'name, email' });
  res.json({ items: users.map(view) });
});

router.patch('/:id', async (req, res) => {
  const patch = patchBody.parse(req.body);
  const { ctx } = req;
  const updated = await ctx.db.tx(async (db) => {
    const user = await db.get('user', String(req.params.id));
    if (!user) throw notFound('User not found');
    const demoting = patch.org_role !== undefined && patch.org_role !== 'admin' && user.org_role === 'admin';
    const deactivating = patch.active === false && user.active;
    if (user.id === ctx.user.id && (demoting || deactivating)) {
      throw unprocessable('You cannot deactivate yourself or remove your own admin role', undefined, 'self_change');
    }
    if ((demoting || deactivating) && user.active) await assertAnotherAdminRemains({ ...ctx, db }, user.id);
    return db.update('user', user.id, patch);
  });
  if (!updated) throw notFound('User not found');
  if (patch.active === false) await endAllSessionsOf(ctx.orgId, updated.id);
  res.json(view(updated));
});

/** Lost authenticator: clears the user's TOTP so they enrol again at next login. Ends their sessions. */
router.post('/:id/reset-totp', async (req, res) => {
  const { ctx } = req;
  const updated = await ctx.db.update('user', String(req.params.id), { totp_secret: null, totp_enabled_at: null, totp_last_step: null });
  if (!updated) throw notFound('User not found');
  if (updated.id !== ctx.user.id) await endAllSessionsOf(ctx.orgId, updated.id);
  res.json(view(updated));
});

export const PASSWORD_RESET_HOURS = 24;

/**
 * Forgotten password: the admin issues a single-use set-password link (valid 24 h), exactly like an invitation.
 * No password is ever generated, shown or e-mailed. The current password stops working at once, every session of
 * the user ends, and earlier unused links are revoked. 2FA is untouched (use reset-totp for a lost authenticator).
 */
router.post('/:id/reset-password', async (req, res) => {
  const { ctx } = req;
  const token = randomToken(32);
  const user = await ctx.db.tx(async (db) => {
    const u = await db.get('user', String(req.params.id));
    if (!u) throw notFound('User not found');
    if (u.active !== true || u.anonymized_at) throw unprocessable('Only an active user can get a password-reset link', undefined, 'user_inactive');
    await db.sql('DELETE FROM password_reset WHERE org_id = :org_id AND user_id = :id AND used_at IS NULL', { id: u.id });
    await db.sql('UPDATE "user" SET password_hash = NULL, failed_login_count = 0, locked_until = NULL WHERE org_id = :org_id AND id = :id', { id: u.id });
    await db.sql(
      `INSERT INTO password_reset (org_id, user_id, token_hash, expires_at, created_by)
       VALUES (:org_id, :id, :token_hash, :expires_at, :created_by)`,
      { id: u.id, token_hash: sha256Hex(token), expires_at: new Date(Date.now() + PASSWORD_RESET_HOURS * 3_600_000), created_by: ctx.user.id },
    );
    await db.sql('DELETE FROM session WHERE org_id = :org_id AND user_id = :id', { id: u.id });
    await db.audit('user', u.id, 'password_reset_requested', { after: { expires_in_hours: PASSWORD_RESET_HOURS } });
    return u;
  });
  // The web app's route for setting the new password is /reset/:token.
  const resetUrl = `${config.appUrl}/reset/${encodeURIComponent(token)}`;
  let emailSent = true;
  try {
    await sendMail({
      to: user.email,
      subject: 'Επαναφορά κωδικού στο Bid Manager',
      text: [
        `Ο/Η ${ctx.user.name} ζήτησε επαναφορά του κωδικού σας στο Bid Manager.`,
        '',
        `Ορίστε νέο κωδικό εδώ (ο σύνδεσμος ισχύει ${PASSWORD_RESET_HOURS} ώρες και χρησιμοποιείται μία φορά):`,
        resetUrl,
        '',
        'Ο προηγούμενος κωδικός δεν ισχύει πλέον. Ο έλεγχος δύο παραγόντων δεν αλλάζει.',
      ].join('\n'),
    });
  } catch (err) {
    emailSent = false;
    logger.error({ err }, 'password-reset e-mail failed');
  }
  // The token is returned exactly once (only its hash is stored) so the admin can also pass the link on by hand.
  res.status(201).json({ user: view(user), resetUrl, expiresInHours: PASSWORD_RESET_HOURS, emailSent });
});
