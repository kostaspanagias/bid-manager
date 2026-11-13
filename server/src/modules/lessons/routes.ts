// Mounted at /api/tenders/:tenderId/lessons — mergeParams; tender access already checked, tender row on req.tender.
// F10: lessons learned per tender. Allowed on closed tenders too (the review happens after submission).
// Anyone with write access to the tender adds lessons and edits/deletes their own; bid_manager/admin any.
// Marking a lesson as applied in a template version is the admin's job (templates are admin-only).
import { Router, type Request } from 'express';
import { z } from 'zod';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { zUuid } from '../../core/http.js';
import { hasRole, requireRole } from '../../core/permissions.js';
import type { Row } from '../../db/scoped.js';
import { LESSON_CATEGORIES, LESSON_SELECT, lessonView } from './service.js';

export const router: Router = Router({ mergeParams: true });

const zText = z.string().trim().min(1).max(5000);
const zCategory = z.enum(LESSON_CATEGORIES).nullable();
const createBody = z.object({ text: zText, category: zCategory.optional(), changes_template: z.boolean().optional() }).strict();
const patchBody = z.object({ text: zText.optional(), category: zCategory.optional(), changes_template: z.boolean().optional() }).strict();
const applyBody = z.object({ template_id: zUuid }).strict();

const lessonNotFound = () => notFound('Lesson not found', 'lesson_not_found');

async function joined(req: Request, id: string) {
  const [row] = await req.ctx.db.sql(`${LESSON_SELECT} WHERE l.org_id = :org_id AND l.id = :id`, { id });
  return lessonView(row!);
}

/** The lesson of this tender, or 404. */
async function load(req: Request): Promise<Row> {
  const lesson = await req.ctx.db.findOne('lesson', { id: String(req.params.id), tender_id: req.tender.id });
  if (!lesson) throw lessonNotFound();
  return lesson;
}

function assertCanChange(req: Request, lesson: Row): void {
  if (hasRole(req.ctx, 'admin', 'bid_manager')) return;
  if (lesson.created_by !== req.ctx.user.id) throw forbidden('Only the author, a bid manager or an admin can change this lesson', 'lesson_not_yours');
}

router.get('/', async (req, res) => {
  const rows = await req.ctx.db.sql(`${LESSON_SELECT} WHERE l.org_id = :org_id AND l.tender_id = :tender_id ORDER BY l.created_at, l.id`, {
    tender_id: req.tender.id,
  });
  res.json({ items: rows.map(lessonView) });
});

router.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const row = await req.ctx.db.insert('lesson', {
    tender_id: req.tender.id,
    text: body.text,
    category: body.category ?? null,
    changes_template: body.changes_template ?? false,
  });
  res.status(201).json(await joined(req, row.id));
});

router.patch('/:id', async (req, res) => {
  const body = patchBody.parse(req.body);
  const lesson = await load(req);
  assertCanChange(req, lesson);
  if (body.changes_template === false && lesson.applied_in_version !== null) {
    throw unprocessable('The lesson is already applied in a template version', undefined, 'lesson_already_applied');
  }
  await req.ctx.db.update('lesson', lesson.id, body);
  res.json(await joined(req, lesson.id));
});

router.delete('/:id', async (req, res) => {
  const lesson = await load(req);
  assertCanChange(req, lesson);
  await req.ctx.db.remove('lesson', lesson.id);
  res.status(204).end();
});

/** Records that the lesson went into a template version (draft or published) of this organization. */
router.post('/:id/apply', requireRole('admin'), async (req, res) => {
  const { template_id } = applyBody.parse(req.body);
  const lesson = await load(req);
  if (!lesson.changes_template) throw unprocessable('The lesson is not flagged as changing the template', undefined, 'lesson_not_flagged');
  const template = await req.ctx.db.get('template', template_id);
  if (!template) throw notFound('Template not found', 'template_not_found');
  await req.ctx.db.update('lesson', lesson.id, { applied_in_version: template.version, applied_template_id: template.id });
  res.json(await joined(req, lesson.id));
});

/** Undo of apply: the lesson is pending again. */
router.delete('/:id/apply', requireRole('admin'), async (req, res) => {
  const lesson = await load(req);
  await req.ctx.db.update('lesson', lesson.id, { applied_in_version: null, applied_template_id: null });
  res.json(await joined(req, lesson.id));
});
