// Mounted at /api/users — the directory for pickers and for showing names next to ids.
// admin / bid_manager see every active user. Everyone else sees only the people they share a tender with (see
// core/permissions.visibleUserIds); a viewer never gets e-mail addresses (`email` is null for them).
import { Router } from 'express';
import { seesUserEmails, visibleUserIds } from '../../core/permissions.js';

export const router: Router = Router();

router.get('/', async (req, res) => {
  const visible = await visibleUserIds(req.ctx);
  const emails = seesUserEmails(req.ctx);
  const users = await req.ctx.db.list('user', { active: true }, { orderBy: 'name, email' });
  res.json({
    items: users
      .filter((u) => visible === null || visible.has(u.id))
      .map((u) => ({ id: u.id, name: u.name, email: emails || u.id === req.ctx.user.id ? u.email : null, org_role: u.org_role })),
  });
});
