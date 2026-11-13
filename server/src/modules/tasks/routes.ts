// Mounted at /api/tenders/:tenderId/tasks — mergeParams; tender access already checked, tender row on req.tender.
import { Router } from 'express';

export const router: Router = Router({ mergeParams: true });
