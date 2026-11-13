// Mounted at /api/tenders — behind requireAuth (req.ctx = { orgId, user, db }).
import { Router } from 'express';

export const router: Router = Router();
