// Mounted at /api/company-documents — behind requireAuth (req.ctx = { orgId, user, db }). Register of F8.
//
//   read (list, get, download)   every user for non-CV documents; CVs per service.ts (admin, bid_manager, or a
//                                member of a tender the CV is linked to — otherwise 404 / absent)
//   create, update, file upload  admin, bid_manager
//   archive, unarchive, delete   admin
import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { zDate } from '../../core/http.js';
import { requireRole } from '../../core/permissions.js';
import type { Row } from '../../db/scoped.js';
import { todayAthens } from '../../domain/time.js';
import { expiringWithin } from '../../domain/validity.js';
import { discardUploads, receiveUploads, removeBlob, requireUploads, sendFile } from '../files/service.js';
import {
  canSeeDocument,
  deleteDocument,
  deleteOrgFileRow,
  DOCUMENT_TYPES,
  documentView,
  type DocumentInput,
  EXPIRING_DAYS,
  filesOf,
  insertDocument,
  insertOrgFile,
  isManager,
  updateDocument,
  visibleCvIds,
} from './service.js';

export const router: Router = Router();

const managers = requireRole('admin', 'bid_manager');
const zType = z.enum(DOCUMENT_TYPES);
const zText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s));
const flag = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');
const listQuery = z.object({ type: zType.optional(), status: z.enum(['valid', 'expiring', 'expired']).optional(), include_archived: flag.optional() });
const expiringQuery = z.object({ days: z.coerce.number().int().min(0).max(3650).default(EXPIRING_DAYS) });
const createBody = z
  .object({
    type: zType,
    title: z.string().trim().min(1).max(300),
    issued_at: zDate.nullable().optional(),
    expires_at: zDate.nullable().optional(),
    person_name: zText(200).nullable().optional(),
    notes: zText(4000).nullable().optional(),
  })
  .strict();
const patchBody = createBody.partial().strict();

/** Cross-field rules shared by create and update; returns the row values to store. */
function normalize(input: DocumentInput): DocumentInput {
  if (input.issued_at && input.expires_at && input.expires_at < input.issued_at) {
    throw unprocessable('The expiry date is before the issue date', undefined, 'expiry_before_issue');
  }
  if (input.type === 'cv' && !input.person_name) {
    throw unprocessable('A CV needs the name of the person it belongs to', undefined, 'person_name_required');
  }
  // A person's name is only kept on CVs: that is where the GDPR rules (visibility, erasure) apply.
  return { ...input, person_name: input.type === 'cv' ? input.person_name : null };
}

/** The document, if it exists in this org AND the caller may see it — otherwise 404 (a hidden CV does not exist). */
async function loadDocument(req: Request): Promise<Row> {
  const doc = await req.ctx.db.get('company_document', String(req.params.id));
  if (!doc || !canSeeDocument(doc, doc.type === 'cv' ? await visibleCvIds(req.ctx) : null)) {
    throw notFound('Document not found', 'document_not_found');
  }
  return doc;
}

async function one(req: Request, doc: Row) {
  return documentView(doc, await filesOf(req.ctx.db, [doc]), todayAthens());
}

router.get('/', async (req, res) => {
  const query = listQuery.parse(req.query);
  const { db } = req.ctx;
  const manager = isManager(req.ctx);
  const where: Row = {};
  if (query.type) where.type = query.type;
  // Archived documents are a management view.
  if (!(manager && query.include_archived)) where.archived_at = null;
  const cvIds = await visibleCvIds(req.ctx);
  const docs = (await db.list('company_document', where, { orderBy: 'type, expires_at nulls last, title, id' })).filter((d) => canSeeDocument(d, cvIds));
  const files = await filesOf(db, docs);
  const today = todayAthens();
  let items = docs.map((d) => documentView(d, files, today));
  if (query.status) items = items.filter((d) => d.status === query.status);
  res.json({ items });
});

/**
 * R15, admin digest: every non-archived document that expires within 30 days (already expired ones included),
 * soonest first. `status` tells expired from expiring. Same semantics as domain/validity.expiringWithin.
 */
router.get('/expiring', managers, async (req, res) => {
  const { days } = expiringQuery.parse(req.query);
  const { db } = req.ctx;
  const today = todayAthens();
  const docs = expiringWithin(await db.list<Row & { expires_at: string | null }>('company_document', { archived_at: null }, { orderBy: 'expires_at, title, id' }), today, days);
  const files = await filesOf(db, docs);
  res.json({ items: docs.map((d) => documentView(d, files, today)), today, days });
});

router.get('/:id', async (req, res) => {
  res.json(await one(req, await loadDocument(req)));
});

router.get('/:id/download', async (req, res) => {
  const doc = await loadDocument(req);
  const file = doc.file_id ? await req.ctx.db.findOne('file', { id: doc.file_id, tender_id: null, deleted_at: null }) : null;
  if (!file) throw notFound('This document has no file', 'document_has_no_file');
  await sendFile(req, res, req.ctx.db, file, { audit: doc.type === 'cv' });
});

router.post('/', managers, async (req, res) => {
  const body = createBody.parse(req.body);
  const data = normalize({
    type: body.type,
    title: body.title,
    issued_at: body.issued_at ?? null,
    expires_at: body.expires_at ?? null,
    person_name: body.person_name ?? null,
    notes: body.notes ?? null,
  });
  const doc = await insertDocument(req.ctx.db, data);
  res.status(201).json(await one(req, doc));
});

router.patch('/:id', managers, async (req, res) => {
  const body = patchBody.parse(req.body);
  const doc = await loadDocument(req);
  const next = normalize({
    type: body.type ?? doc.type,
    title: body.title ?? doc.title,
    issued_at: body.issued_at !== undefined ? body.issued_at : (doc.issued_at ?? null),
    expires_at: body.expires_at !== undefined ? body.expires_at : (doc.expires_at ?? null),
    person_name: body.person_name !== undefined ? body.person_name : (doc.person_name ?? null),
    notes: body.notes !== undefined ? body.notes : (doc.notes ?? null),
  });
  res.json(await one(req, await updateDocument(req.ctx.db, doc, next)));
});

/** Upload or replace the file: a new file row + blob; the previous row and blob are removed (no version history). */
router.put(
  '/:id/file',
  managers,
  receiveUploads(() => null, { maxFiles: 1 }),
  async (req, res) => {
    const uploads = await requireUploads(res);
    const upload = uploads[0];
    if (!upload || uploads.length !== 1) {
      await discardUploads(uploads);
      throw badRequest('Exactly one file is expected', undefined, 'invalid_upload');
    }
    let previous: Row | null = null;
    let updated: Row;
    try {
      const doc = await loadDocument(req);
      const personal = doc.type === 'cv';
      updated = await req.ctx.db.tx(async (tx) => {
        previous = doc.file_id ? await tx.findOne('file', { id: doc.file_id, tender_id: null }) : null;
        const file = await insertOrgFile(tx, upload, personal);
        const after = await updateDocument(tx, doc, { file_id: file.id });
        if (previous) await deleteOrgFileRow(tx, previous, personal);
        return after;
      });
    } catch (err) {
      await discardUploads(uploads);
      throw err;
    }
    if (previous) await discardUploads([{ storageKey: (previous as Row).storage_key as string }]);
    res.json(await one(req, updated));
  },
);

router.delete('/:id/file', managers, async (req, res) => {
  const doc = await loadDocument(req);
  const file = doc.file_id ? await req.ctx.db.findOne('file', { id: doc.file_id, tender_id: null }) : null;
  if (!file) throw notFound('This document has no file', 'document_has_no_file');
  await removeBlob(file as { storage_key: string });
  const updated = await req.ctx.db.tx(async (tx) => {
    const after = await updateDocument(tx, doc, { file_id: null });
    await deleteOrgFileRow(tx, file, doc.type === 'cv');
    return after;
  });
  res.json(await one(req, updated));
});

router.post('/:id/archive', requireRole('admin'), async (req, res) => {
  const doc = await loadDocument(req);
  res.json(await one(req, doc.archived_at ? doc : await updateDocument(req.ctx.db, doc, { archived_at: new Date() })));
});

router.post('/:id/unarchive', requireRole('admin'), async (req, res) => {
  const doc = await loadDocument(req);
  res.json(await one(req, doc.archived_at ? await updateDocument(req.ctx.db, doc, { archived_at: null }) : doc));
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const doc = await loadDocument(req);
  const file = doc.file_id ? await req.ctx.db.findOne('file', { id: doc.file_id, tender_id: null }) : null;
  // Blob first: if anything fails afterwards the row still points at a missing blob (loud), never the reverse.
  if (file) await removeBlob(file as { storage_key: string });
  await deleteDocument(req.ctx.db, doc);
  res.status(204).end();
});
