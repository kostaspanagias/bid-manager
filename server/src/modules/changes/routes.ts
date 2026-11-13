// Mounted at /api/tenders/:tenderId/changes — mergeParams; tender access already checked, tender row on req.tender.
import { Router } from 'express';

export const router: Router = Router({ mergeParams: true });
