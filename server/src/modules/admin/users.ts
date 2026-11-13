// Mounted at /api/admin/users — admin only.
import { Router } from 'express';
import { z } from 'zod';
import { endAllSessionsOf } from '../../core/auth.js';
import { notFound, unprocessable } from '../../core/errors.js';
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
