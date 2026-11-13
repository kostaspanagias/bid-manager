// Mounted at /api/dashboard — behind requireAuth (req.ctx = { orgId, user, db }). Read-only for every role.
import { Router } from 'express';
import { loadDashboard } from './service.js';

export const router: Router = Router();

router.get('/', async (req, res) => {
  res.json(await loadDashboard(req.ctx));
});
