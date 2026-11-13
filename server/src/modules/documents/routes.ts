// Mounted at /api/tenders/:tenderId/documents — mergeParams; tender access already checked, tender row on req.tender.
// The company documents a tender uses (F8) and their validity on submission day (R15).
//
//   list         every member of the tender — including linked CVs (they are participants of this tender)
//   suggestions  the caller's own view of the register: unlinked CVs only for admin / bid_manager
//   link         members with write access; a CV only by admin / bid_manager (linking is what exposes a CV to a team)
//   unlink       members with write access
// Links are part of the bid: a closed tender (submitted / no_go / cancelled) is read-only here.
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { isMutating, zUuid } from '../../core/http.js';
import type { Row } from '../../db/scoped.js';
import { athensDate, todayAthens } from '../../domain/time.js';
import { expiredOnT } from '../../domain/validity.js';
import { canSeeDocument, DOCUMENT_TYPES, documentView, filesOf, isManager, visibleCvIds } from '../company-documents/service.js';

export const router: Router = Router({ mergeParams: true });

const CLOSED = ['submitted', 'no_go', 'cancelled'];
const readOnlyWhenClosed: RequestHandler = (req, _res, next) => {
  if (isMutating(req.method) && CLOSED.includes(String(req.tender.status))) {
    throw unprocessable('The tender is closed: its documents are read-only', undefined, 'tender_closed');
  }
  next();
};
router.use(readOnlyWhenClosed);

const linkBody = z.object({ company_document_id: zUuid }).strict();

/** T = Athens date of the submission deadline. */
const tOf = (tender: Row): string => athensDate(tender.submission_deadline_at);

/** R15: ids of the documents whose expires_at is strictly before T (domain/validity.expiredOnT). */
function expiredIds(docs: Row[], T: string): Set<string> {
  return new Set(expiredOnT(docs as (Row & { expires_at: string | null })[], T).map((d) => d.id as string));
}

router.get('/', async (req, res) => {
  const { db } = req.ctx;
  const T = tOf(req.tender);
  const links = await db.list('tender_document', { tender_id: req.tender.id });
  const docs = links.length ? await db.list('company_document', { id: links.map((l) => l.company_document_id) }, { orderBy: 'type, title, id' }) : [];
  const linkOf = new Map(links.map((l) => [l.company_document_id as string, l]));
  const files = await filesOf(db, docs);
  const red = expiredIds(docs, T);
  const today = todayAthens();
  res.json({
    T,
    items: docs.map((d) => ({
      ...documentView(d, files, today),
      link_id: linkOf.get(d.id)?.id as string,
      linked_at: linkOf.get(d.id)?.created_at as Date,
      linked_by: (linkOf.get(d.id)?.created_by as string | null) ?? null,
      expires_before_T: red.has(d.id),
    })),
    expired_count: red.size,
  });
});

/** Documents of the register not yet linked to this tender, grouped by type (types without candidates are omitted). */
router.get('/suggestions', async (req, res) => {
  const { db } = req.ctx;
  const T = tOf(req.tender);
  const linked = new Set((await db.list('tender_document', { tender_id: req.tender.id })).map((l) => l.company_document_id as string));
  const cvIds = await visibleCvIds(req.ctx);
  const docs = (await db.list('company_document', { archived_at: null }, { orderBy: 'type, title, id' })).filter((d) => !linked.has(d.id) && canSeeDocument(d, cvIds));
  const files = await filesOf(db, docs);
  const red = expiredIds(docs, T);
  const today = todayAthens();
  const groups = DOCUMENT_TYPES.map((type) => ({
    type,
    documents: docs.filter((d) => d.type === type).map((d) => ({ ...documentView(d, files, today), expires_before_T: red.has(d.id) })),
  })).filter((g) => g.documents.length > 0);
  res.json({ T, items: groups });
});

router.post('/', async (req, res) => {
  const { company_document_id } = linkBody.parse(req.body);
  const { db } = req.ctx;
  const doc = await db.get('company_document', company_document_id);
  const manager = isManager(req.ctx);
  // A CV the caller cannot see does not exist for them; one they can see they still may not hand to another team.
  if (!doc || !canSeeDocument(doc, doc.type === 'cv' ? await visibleCvIds(req.ctx) : null)) throw notFound('Document not found', 'document_not_found');
  if (doc.type === 'cv' && !manager) throw forbidden('Only a bid manager or an admin can link a CV to a tender', 'cv_link_restricted');
  if (doc.archived_at) throw unprocessable('An archived document cannot be linked', undefined, 'document_archived');
  if (await db.findOne('tender_document', { tender_id: req.tender.id, company_document_id: doc.id })) {
    throw conflict('The document is already linked to this tender', undefined, 'document_already_linked');
  }
  const link = await db.insert('tender_document', { tender_id: req.tender.id, company_document_id: doc.id });
  const T = tOf(req.tender);
  res.status(201).json({
    ...documentView(doc, await filesOf(db, [doc]), todayAthens()),
    link_id: link.id,
    linked_at: link.created_at,
    linked_by: link.created_by ?? null,
    expires_before_T: expiredIds([doc], T).has(doc.id),
  });
});

/** Unlink by company document id. */
router.delete('/:documentId', async (req, res) => {
  const link = await req.ctx.db.findOne('tender_document', { tender_id: req.tender.id, company_document_id: String(req.params.documentId) });
  if (!link) throw notFound('The document is not linked to this tender', 'document_not_linked');
  await req.ctx.db.remove('tender_document', link.id);
  res.status(204).end();
});
