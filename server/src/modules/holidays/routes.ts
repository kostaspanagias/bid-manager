// Mounted at /api/holidays — read for every authenticated user; changes admin only (R2).
import { Router } from 'express';
import { z } from 'zod';
import { conflict, notFound } from '../../core/errors.js';
import { zDate } from '../../core/http.js';
import { requireRole } from '../../core/permissions.js';
import { seedHolidaysForYear } from '../../domain/holidays.js';
import type { Row } from '../../db/scoped.js';

export const router: Router = Router();

const zYear = z.coerce.number().int().min(1900).max(2099);
const listQuery = z.object({ year: zYear.optional() });
const createBody = z.object({ date: zDate, name: z.string().trim().min(1).max(200) }).strict();
const patchBody = z.object({ date: zDate.optional(), name: z.string().trim().min(1).max(200).optional() }).strict();
const seedBody = z.object({ year: zYear }).strict();

const view = (h: Row) => ({ id: h.id, date: h.date, name: h.name, source: h.source });

router.get('/', async (req, res) => {
  const { year } = listQuery.parse(req.query);
  const rows =
    year === undefined
      ? await req.ctx.db.list('holiday', {}, { orderBy: 'date' })
      : await req.ctx.db.sql('SELECT * FROM holiday WHERE org_id = :org_id AND date >= :from AND date <= :to ORDER BY date', {
          from: `${year}-01-01`,
          to: `${year}-12-31`,
        });
  res.json({ items: rows.map(view) });
});

router.post('/seed', requireRole('admin'), async (req, res) => {
  const { year } = seedBody.parse(req.body);
  const added = await seedHolidaysForYear(req.ctx.db, year);
  res.json({ year, added: added.length, items: added.map(view) });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const body = createBody.parse(req.body);
  if (await req.ctx.db.findOne('holiday', { date: body.date })) throw conflict('There is already a holiday on this date', undefined, 'holiday_exists');
  const row = await req.ctx.db.insert('holiday', { ...body, source: 'manual' });
  res.status(201).json(view(row));
});

/** Rename or move (e.g. the 1 May transfer). A moved holiday becomes source = manual. */
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const body = patchBody.parse(req.body);
  const { db } = req.ctx;
  const current = await db.get('holiday', String(req.params.id));
  if (!current) throw notFound('Holiday not found');
  const moved = body.date !== undefined && body.date !== current.date;
  if (moved && (await db.findOne('holiday', { date: body.date }))) throw conflict('There is already a holiday on this date', undefined, 'holiday_exists');
  const row = await db.update('holiday', current.id, { ...body, ...(moved ? { source: 'manual' } : {}) });
  if (!row) throw notFound('Holiday not found');
  res.json(view(row));
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  if (!(await req.ctx.db.remove('holiday', String(req.params.id)))) throw notFound('Holiday not found');
  res.status(204).end();
});
