// Mounted at /api/notifications — behind requireAuth (req.ctx = { orgId, user, db }).
import { Router } from 'express';

export const router: Router = Router();
