// Company documents (F8) — shared by /api/company-documents, /api/tenders/:id/documents and /api/gdpr.
//
// Visibility
//   non-CV documents: every user of the organization may list and download them.
//   CVs (personal data, spec "GDPR"): admin and bid_manager; anyone else only when the CV is linked to a tender
//   in which they have a tender_member row. For everybody else a CV does not exist (404, absent from lists).
//
// Audit and personal data
//   Rows of this module are written with raw statements + explicit audit entries instead of the automatic audit,
//   for one reason: the automatic audit copies full rows into the append-only audit_log, and a CV's person name,
//   title, notes and file name would then survive a GDPR erasure forever. For CVs those values are replaced by
//   '[personal data]' in the audit entry; other documents are audited in full, exactly like the automatic audit
//   (create/delete = full row, update = changed columns).
import type { Ctx } from '../../core/types.js';
import { hasRole } from '../../core/permissions.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { daysBetween } from '../../domain/calendar.js';
import type { StoredUpload } from '../files/service.js';

export const DOCUMENT_TYPES = ['iso', 'gemi', 'tax', 'insurance', 'cv', 'reference_project', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentStatus = 'valid' | 'expiring' | 'expired';

/** R15: a document "expires soon" when it expires within this many days (inclusive). */
export const EXPIRING_DAYS = 30;
export const PERSONAL_PLACEHOLDER = '[personal data]';
const PERSONAL_DOC_COLUMNS = ['title', 'person_name', 'notes'] as const;

type PermCtx = Pick<Ctx, 'user' | 'db'>;

export const isManager = (ctx: PermCtx): boolean => hasRole(ctx, 'admin', 'bid_manager');

/**
 * Status of a document on `today` (Athens date):
 *   expired  — expires_at < today
 *   expiring — today ≤ expires_at ≤ today + 30 days (a document expiring today is still valid today)
 *   valid    — later, or no expiry date
 */
export function documentStatus(expiresAt: string | null, today: string): { status: DocumentStatus; days_to_expiry: number | null } {
  if (!expiresAt) return { status: 'valid', days_to_expiry: null };
  const days = daysBetween(today, expiresAt);
  return { status: days < 0 ? 'expired' : days <= EXPIRING_DAYS ? 'expiring' : 'valid', days_to_expiry: days };
}

/** Which CVs the user may see: `null` = all of them (admin, bid_manager), otherwise the ids linked to their tenders. */
export async function visibleCvIds(ctx: PermCtx): Promise<Set<string> | null> {
  if (isManager(ctx)) return null;
  const rows = await ctx.db.sql<{ id: string }>(
    `SELECT DISTINCT td.company_document_id AS id
       FROM tender_document td
       JOIN tender_member tm ON tm.org_id = td.org_id AND tm.tender_id = td.tender_id
      WHERE td.org_id = :org_id AND tm.user_id = :user_id`,
    { user_id: ctx.user.id },
  );
  return new Set(rows.map((r) => r.id));
}

export function canSeeDocument(doc: Row, cvIds: Set<string> | null): boolean {
  return doc.type !== 'cv' || cvIds === null || cvIds.has(doc.id as string);
}

export interface DocumentView {
  id: string;
  type: DocumentType;
  title: string;
  issued_at: string | null;
  expires_at: string | null;
  person_name: string | null;
  notes: string | null;
  archived_at: Date | null;
  status: DocumentStatus;
  days_to_expiry: number | null;
  file: { id: string; filename: string; mime: string | null; size: number; uploaded_at: Date } | null;
  created_at: Date;
  updated_at: Date;
}

/** Live (not deleted) org-level file rows of the given documents, by file id. */
export async function filesOf(db: ScopedDb, docs: Row[]): Promise<Map<string, Row>> {
  const ids = docs.map((d) => d.file_id as string | null).filter((id): id is string => !!id);
  if (ids.length === 0) return new Map();
  const rows = await db.list('file', { id: ids, tender_id: null, deleted_at: null });
  return new Map(rows.map((r) => [r.id as string, r]));
}

export function documentView(doc: Row, files: Map<string, Row>, today: string): DocumentView {
  const file = doc.file_id ? files.get(doc.file_id as string) : undefined;
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    issued_at: doc.issued_at ?? null,
    expires_at: doc.expires_at ?? null,
    person_name: doc.person_name ?? null,
    notes: doc.notes ?? null,
    archived_at: doc.archived_at ?? null,
    ...documentStatus(doc.expires_at ?? null, today),
    file: file ? { id: file.id, filename: file.filename, mime: file.mime ?? null, size: Number(file.size), uploaded_at: file.created_at } : null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// writes (raw + explicit, personal-data-aware audit — see the header)
// ---------------------------------------------------------------------------------------------------------------

function auditDoc(row: Row, personal: boolean): Row {
  if (!personal) return row;
  const out: Row = { ...row };
  for (const col of PERSONAL_DOC_COLUMNS) if (col in out && out[col] != null) out[col] = PERSONAL_PLACEHOLDER;
  return out;
}

function auditFile(row: Row, personal: boolean): Row {
  return personal ? { ...row, filename: PERSONAL_PLACEHOLDER } : row;
}

export interface DocumentInput {
  type: DocumentType;
  title: string;
  issued_at: string | null;
  expires_at: string | null;
  person_name: string | null;
  notes: string | null;
}

export async function insertDocument(db: ScopedDb, data: DocumentInput): Promise<Row> {
  return db.tx(async (tx) => {
    const [row] = await tx.sql(
      `INSERT INTO company_document (org_id, type, title, issued_at, expires_at, person_name, notes, created_by)
       VALUES (:org_id, :type, :title, CAST(:issued_at AS date), CAST(:expires_at AS date), :person_name, :notes, :created_by)
       RETURNING *`,
      { ...data, created_by: tx.userId },
    );
    await tx.audit('company_document', (row as Row).id, 'create', { after: auditDoc(row as Row, data.type === 'cv') });
    return row as Row;
  });
}

const UPDATABLE = ['type', 'title', 'issued_at', 'expires_at', 'person_name', 'notes', 'archived_at', 'file_id'] as const;
type Updatable = (typeof UPDATABLE)[number];

/** Updates the given columns (names come from the constant list above, never from the request). */
export async function updateDocument(db: ScopedDb, before: Row, patch: Partial<Record<Updatable, unknown>>): Promise<Row> {
  const cols = UPDATABLE.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) return before;
  return db.tx(async (tx) => {
    const sets = cols.map((c) => (c === 'issued_at' || c === 'expires_at' ? `"${c}" = CAST(:${c} AS date)` : c === 'archived_at' ? `"${c}" = CAST(:${c} AS timestamptz)` : c === 'file_id' ? `"${c}" = CAST(:${c} AS uuid)` : `"${c}" = :${c}`));
    const params: Row = { id: before.id };
    for (const c of cols) params[c] = patch[c];
    const [after] = (await tx.sql(`UPDATE company_document SET ${sets.join(', ')} WHERE org_id = :org_id AND id = :id RETURNING *`, params)) as Row[];
    if (!after) return before;
    const personal = before.type === 'cv' || after.type === 'cv';
    const changedBefore: Row = {};
    const changedAfter: Row = {};
    for (const c of cols) {
      if (JSON.stringify(before[c]) !== JSON.stringify(after[c])) {
        changedBefore[c] = before[c];
        changedAfter[c] = after[c];
      }
    }
    if (Object.keys(changedAfter).length > 0) {
      await tx.audit('company_document', after.id, 'update', { before: auditDoc(changedBefore, personal), after: auditDoc(changedAfter, personal) });
    }
    return after;
  });
}

/** Registers an uploaded blob as an org-level file row (tender_id NULL). */
export async function insertOrgFile(db: ScopedDb, upload: StoredUpload, personal: boolean): Promise<Row> {
  const [row] = (await db.sql(
    `INSERT INTO file (id, org_id, tender_id, storage_key, filename, mime, size, sha256, folder, confidentiality, uploaded_by, enc, created_by)
     VALUES (:id, :org_id, NULL, :storage_key, :filename, :mime, :size, :sha256, 'other', 'normal', :user_id, CAST(:enc AS jsonb), :user_id)
     RETURNING *`,
    { id: upload.fileId, storage_key: upload.storageKey, filename: upload.filename, mime: upload.mime, size: upload.size, sha256: upload.sha256, enc: JSON.stringify(upload.enc), user_id: db.userId },
  )) as Row[];
  await db.audit('file', (row as Row).id, 'create', { after: auditFile(row as Row, personal) });
  return row as Row;
}

/** Hard-deletes an org-level file row (the blob is the caller's job). */
export async function deleteOrgFileRow(db: ScopedDb, file: Row, personal: boolean): Promise<void> {
  const rows = await db.sql('DELETE FROM file WHERE org_id = :org_id AND id = :id AND tender_id IS NULL RETURNING id', { id: file.id });
  if (rows.length > 0) await db.audit('file', file.id, 'delete', { before: auditFile(file, personal) });
}

/** Deletes a document, its tender links (FK cascade) and its file row. Returns the file row whose blob must go. */
export async function deleteDocument(db: ScopedDb, doc: Row): Promise<Row | null> {
  const personal = doc.type === 'cv';
  return db.tx(async (tx) => {
    const file = doc.file_id ? await tx.findOne('file', { id: doc.file_id, tender_id: null }) : null;
    const links = await tx.list<{ tender_id: string }>('tender_document', { company_document_id: doc.id });
    const gone = await tx.sql('DELETE FROM company_document WHERE org_id = :org_id AND id = :id RETURNING id', { id: doc.id });
    if (gone.length === 0) return null;
    await tx.audit('company_document', doc.id, 'delete', { before: { ...auditDoc(doc, personal), unlinked_tender_ids: links.map((l) => l.tender_id) } });
    if (file) await deleteOrgFileRow(tx, file, personal);
    return file;
  });
}
