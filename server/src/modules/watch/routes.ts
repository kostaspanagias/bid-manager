// Mounted at /api/tenders/:tenderId/watch — mergeParams; tender access already checked, tender row on req.tender.
import { Router } from 'express';

export const router: Router = Router({ mergeParams: true });
