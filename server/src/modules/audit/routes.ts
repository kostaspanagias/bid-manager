// Mounted at /api/audit — admin only, read-only, newest first.
import { Router } from 'express';
import { z } from 'zod';
import { zPage, zUuid } from '../../core/http.js';
import { requireRole } from '../../core/permissions.js';

export const router: Router = Router();
router.use(requireRole('admin'));

const query = zPage.extend({
  entity: z.string().trim().min(1).max(100).optional(),
  entity_id: z.string().trim().min(1).max(100).optional(),
  user: zUuid.optional(),
  user_id: zUuid.optional(),
  tender_id: zUuid.optional(),
  action: z.string().trim().min(1).max(100).optional(),
});

router.get('/', async (req, res) => {
  const q = query.parse(req.query);
  const filters: Record<string, unknown> = {
    entity: q.entity,
    entity_id: q.entity_id,
    user_id: q.user ?? q.user_id,
    tender_id: q.tender_id,
    action: q.action,
  };
  const where = ['a.org_id = :org_id'];
  const params: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    where.push(`a.${column} = :${column}`);
    params[column] = value;
  }
  const { db } = req.ctx;
  const [count] = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log a WHERE ${where.join(' AND ')}`, params);
  const items = await db.sql(
    `SELECT a.id, a.at, a.user_id, u.name AS user_name, a.entity, a.entity_id, a.tender_id, a.action, a.before, a.after
       FROM audit_log a LEFT JOIN "user" u ON u.id = a.user_id AND u.org_id = a.org_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.at DESC, a.id DESC
      LIMIT :limit OFFSET :offset`,
    { ...params, limit: q.limit, offset: q.offset },
  );
  res.json({ items, total: count?.n ?? 0, limit: q.limit, offset: q.offset });
});
