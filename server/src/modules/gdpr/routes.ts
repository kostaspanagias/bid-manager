// Mounted at /api/gdpr — behind requireAuth (req.ctx = { orgId, user, db }). Admin only, every route.
import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { zUuid } from '../../core/http.js';
import { requireRole } from '../../core/permissions.js';
import { todayAthens } from '../../domain/time.js';
import { executeErasure, planErasure, retentionCandidates } from './service.js';

export const router: Router = Router();
router.use(requireRole('admin'));

const eraseBody = z
  .object({
    user_id: zUuid.optional(),
    person_name: z.string().trim().min(2).max(200).optional(),
    /** Defaults to TRUE: nothing is removed unless the request says `dry_run: false`. */
    dry_run: z.boolean().default(true),
  })
  .strict();
const retentionBody = z.object({ retention_days: z.number().int().min(0).max(36500).nullable() }).strict();

/**
 * Erases the data of one person in a single action: their CV documents (rows, files, tender links) — matched by
 * `person_name` and, for a user, by the user's own name — and the user account (anonymised and deactivated; the
 * row stays so that references and the audit trail keep working).
 * `dry_run` (the default) returns the same plan without changing anything.
 */
router.post('/erase-person', async (req, res) => {
  const body = eraseBody.parse(req.body);
  if (!body.user_id && !body.person_name) throw badRequest('Give a user_id and/or a person_name', undefined, 'erase_target_required');
  if (body.user_id === req.ctx.user.id) throw unprocessable('You cannot erase your own account', undefined, 'cannot_erase_self');
  const { db } = req.ctx;
  const { plan, target } = await planErasure(db, body.user_id, body.person_name);
  if (body.user_id && !target.user) throw notFound('User not found', 'user_not_found');
  if (body.dry_run) {
    res.json({ dry_run: true, erased: false, ...plan });
    return;
  }
  await executeErasure(db, target, plan);
  res.json({ dry_run: false, erased: true, ...plan });
});

async function retentionView(req: Request) {
  const { db, orgId } = req.ctx;
  const org = await db.get<{ retention_days: number | null }>('organization', orgId);
  const days = org?.retention_days ?? null;
  const pending = days === null ? [] : await retentionCandidates(db, days, todayAthens());
  return {
    retention_days: days,
    /** What the next run of the retention job would remove. */
    pending: { tenders: pending.length, files: pending.reduce((n, t) => n + t.files, 0) },
  };
}

router.get('/retention', async (req, res) => {
  res.json(await retentionView(req));
});

/** `retention_days: null` = keep files of closed tenders indefinitely. */
router.put('/retention', async (req, res) => {
  const { retention_days } = retentionBody.parse(req.body);
  await req.ctx.db.update('organization', req.ctx.orgId, { retention_days });
  res.json(await retentionView(req));
});
