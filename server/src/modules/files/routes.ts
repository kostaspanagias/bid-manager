// Mounted at /api/tenders/:tenderId/files — mergeParams; tender access already checked (read for GET/HEAD, write
// otherwise — so viewers are read-only and non-members never get here), tender row on req.tender.
//
// R18 (financial files): admin, bid_manager, approvers who are members of the tender and members whose tender role
// has payload.financial = true — decided by core/permissions.canSeeFinancial on EVERY request:
//   list      → financial files are simply absent for everybody else (no names, no counts)
//   metadata, download, rename/move, delete → 403 `financial_restricted`
//   upload / move into the financial folder, or marking a file financial → 403 as well
// Only files of this tender are addressable here (org-level files of company documents are not).
import { Router, type Request } from 'express';
import { z } from 'zod';
import { forbidden, notFound, unprocessable } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { canSeeFinancial, hasRole, requireFinancialAccess } from '../../core/permissions.js';
import type { Row } from '../../db/scoped.js';
import { discardUploads, FILE_FOLDERS, receiveUploads, removeBlob, requireUploads, sanitizeFilename, sendFile, type FileFolder } from './service.js';

export const router: Router = Router({ mergeParams: true });

const zFolder = z.enum(FILE_FOLDERS);
const zConfidentiality = z.enum(['normal', 'financial']);
const zLabel = z
  .string()
  .trim()
  .max(200)
  .transform((s) => (s === '' ? null : s));
const listQuery = z.object({ folder: zFolder.optional() });
const uploadFields = z.object({ folder: zFolder.default('other'), label: zLabel.optional(), confidentiality: zConfidentiality.optional() });
const patchBody = z
  .object({
    filename: z.string().trim().min(1).max(255).optional(),
    label: zLabel.nullable().optional(),
    folder: zFolder.optional(),
    confidentiality: zConfidentiality.optional(),
  })
  .strict();

/** Public shape of a file row: never the storage key or the encryption metadata. */
function view(row: Row, names: Map<string, string>) {
  return {
    id: row.id as string,
    tender_id: row.tender_id as string,
    filename: row.filename as string,
    mime: (row.mime as string | null) ?? null,
    size: Number(row.size),
    sha256: (row.sha256 as string | null) ?? null,
    folder: row.folder as FileFolder,
    confidentiality: row.confidentiality as 'normal' | 'financial',
    label: (row.label as string | null) ?? null,
    uploaded_by: (row.uploaded_by as string | null) ?? null,
    uploaded_by_name: row.uploaded_by ? (names.get(row.uploaded_by as string) ?? null) : null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

async function uploaderNames(req: Request, rows: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.uploaded_by as string | null).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const users = await req.ctx.db.list<{ id: string; name: string }>('user', { id: ids });
  return new Map(users.map((u) => [u.id, u.name]));
}

/**
 * The file addressed by the URL — of THIS tender, not deleted — or 404. A financial file additionally needs R18
 * (403 `financial_restricted`), whatever the caller is about to do with it.
 */
async function loadFile(req: Request): Promise<Row> {
  const row = await req.ctx.db.findOne('file', { id: String(req.params.fileId), tender_id: req.tender.id, deleted_at: null });
  if (!row) throw notFound('File not found', 'file_not_found');
  if (row.confidentiality === 'financial') await requireFinancialAccess(req.ctx, req.tender.id);
  return row;
}

/** Rename, move and delete: the uploader, a bid manager or an admin. */
function assertCanManage(req: Request, row: Row): void {
  if (hasRole(req.ctx, 'admin', 'bid_manager') || row.uploaded_by === req.ctx.user.id) return;
  throw forbidden('Only the uploader, a bid manager or an admin can change or delete this file', 'file_not_owner');
}

/** `folder = financial` always means `confidentiality = financial`; asking for anything else is an error. */
function resolveConfidentiality(folder: FileFolder, requested: 'normal' | 'financial' | undefined, current: 'normal' | 'financial'): 'normal' | 'financial' {
  if (folder === 'financial') {
    if (requested === 'normal') {
      throw unprocessable('Files in the financial folder are always confidential', undefined, 'financial_folder_confidential');
    }
    return 'financial';
  }
  return requested ?? current;
}

router.get('/', async (req, res) => {
  const { folder } = listQuery.parse(req.query);
  const financial = await canSeeFinancial(req.ctx, req.tender.id);
  const where: Row = { tender_id: req.tender.id, deleted_at: null };
  if (folder) where.folder = folder;
  // Filtered in the query itself: rows the caller may not see are never loaded.
  if (!financial) where.confidentiality = 'normal';
  const rows = await req.ctx.db.list('file', where, { orderBy: 'folder, created_at desc, id' });
  const names = await uploaderNames(req, rows);
  res.json({ items: rows.map((r) => view(r, names)), can_see_financial: financial });
});

router.post(
  '/',
  receiveUploads((req) => req.tender.id),
  async (req, res) => {
    const uploads = await requireUploads(res);
    try {
      const fields = uploadFields.parse(req.body ?? {});
      const confidentiality = resolveConfidentiality(fields.folder, fields.confidentiality, 'normal');
      if (confidentiality === 'financial') await requireFinancialAccess(req.ctx, req.tender.id);
      const rows = await req.ctx.db.tx((tx) =>
        tx.insertMany(
          'file',
          uploads.map((u) => ({
            id: u.fileId,
            tender_id: req.tender.id,
            storage_key: u.storageKey,
            filename: u.filename,
            mime: u.mime,
            size: u.size,
            sha256: u.sha256,
            enc: u.enc,
            folder: fields.folder,
            confidentiality,
            label: fields.label ?? null,
            uploaded_by: req.ctx.user.id,
          })),
        ),
      );
      const names = new Map([[req.ctx.user.id, req.ctx.user.name]]);
      res.status(201).json({ items: rows.map((r) => view(r, names)) });
    } catch (err) {
      await discardUploads(uploads); // refused or failed: nothing stays on disk
      throw err;
    }
  },
);

router.get('/:fileId', async (req, res) => {
  const row = await loadFile(req);
  res.json(view(row, await uploaderNames(req, [row])));
});

router.get('/:fileId/download', async (req, res) => {
  const row = await loadFile(req);
  await sendFile(req, res, req.ctx.db, row, { audit: row.confidentiality === 'financial' });
});

router.patch('/:fileId', async (req, res) => {
  const body = patchBody.parse(req.body);
  const row = await loadFile(req);
  assertCanManage(req, row);
  const folder = body.folder ?? (row.folder as FileFolder);
  const confidentiality = resolveConfidentiality(folder, body.confidentiality, row.confidentiality);
  // Into the financial folder / marked financial: R18 (a financial file already passed it in loadFile, which also
  // covers the reverse — only someone with financial access can ever declassify).
  if (confidentiality === 'financial') await requireFinancialAccess(req.ctx, req.tender.id);
  const patch: Row = { folder, confidentiality };
  if (body.filename !== undefined) patch.filename = sanitizeFilename(body.filename);
  if (body.label !== undefined) patch.label = body.label;
  const updated = await req.ctx.db.update('file', row.id, patch);
  if (!updated) throw notFound('File not found', 'file_not_found');
  res.json(view(updated, await uploaderNames(req, [updated])));
});

router.delete('/:fileId', async (req, res) => {
  const row = await loadFile(req);
  assertCanManage(req, row);
  const { db } = req.ctx;
  await db.update('file', row.id, { deleted_at: new Date() });
  try {
    await removeBlob(row as { storage_key: string });
    // enc = NULL marks "blob gone"; the retention job retries rows where that did not happen.
    await db.sql('UPDATE file SET enc = NULL WHERE org_id = :org_id AND id = :id', { id: row.id });
  } catch (err) {
    logger.error({ err, fileId: row.id }, 'blob of a deleted file could not be removed; the retention job will retry');
  }
  res.status(204).end();
});
