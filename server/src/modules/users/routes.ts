// Mounted at /api/users — minimal directory (id, name, email, org_role) for pickers; any authenticated user.
import { Router } from 'express';

export const router: Router = Router();

router.get('/', async (req, res) => {
  const users = await req.ctx.db.list('user', { active: true }, { orderBy: 'name, email' });
  res.json({ items: users.map((u) => ({ id: u.id, name: u.name, email: u.email, org_role: u.org_role })) });
});
