// Shared file plumbing of slice 6 (tender files, company-document files): streaming multipart upload into the
// encrypted storage, safe downloads, blob removal. Access decisions are NOT made here — every route decides first
// and only then calls sendFile().
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { HttpError, badRequest } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { getStorage, storageKey, StorageError, verify, type EncMeta } from '../../core/storage.js';
import type { Row, ScopedDb } from '../../db/scoped.js';

/** Upload limits (spec: 200 MB per file). An object so tests can lower them. */
export const uploadLimits = { maxBytes: 200 * 1024 * 1024, maxFiles: 20 };

export const FILE_FOLDERS = ['tender_docs', 'clarifications', 'participation', 'technical', 'financial', 'other'] as const;
export type FileFolder = (typeof FILE_FOLDERS)[number];

/** A file received by `receiveUploads` — already encrypted on disk, not yet in the database. */
export interface StoredUpload {
  fileId: string;
  storageKey: string;
  filename: string;
  mime: string | null;
  size: number;
  sha256: string;
  enc: EncMeta;
}

const MAX_FILENAME = 200;
// C0/C1 controls, DEL, zero-width and bidirectional-override characters (used to disguise extensions).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The display name kept in `file.filename`. It is never used to build a path (tenant rule 4) — this only makes it
 * safe to show and to send back in Content-Disposition: no directories, no control or bidi characters, no leading
 * dots, bounded length (the extension survives truncation).
 */
export function sanitizeFilename(raw: unknown): string {
  let name = String(raw ?? '').normalize('NFC').replace(UNSAFE_CHARS, '');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/\s+/g, ' ').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name.length > MAX_FILENAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, MAX_FILENAME - ext.length).trimEnd() + ext;
  }
  return name || 'file';
}

/** RFC 6266 / RFC 5987 header value: an ASCII fallback plus the UTF-8 name, both free of quotes and separators. */
export function contentDisposition(filename: string, inline = false): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const utf8 = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Types a browser may render in place when asked with ?inline=1. Everything else (HTML, SVG, XML, …) downloads. */
const INLINE_SAFE: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);

export function normalizeMime(raw: unknown): string | null {
  const mime = String(raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9.+-]{0,80}\/[a-z0-9][a-z0-9.+-]{0,80}$/.test(mime) ? mime : null;
}

/** What a download response declares for a stored file. */
export function downloadHeaders(row: { filename: string; mime: string | null }, wantInline: boolean): { type: string; disposition: string } {
  const mime = normalizeMime(row.mime);
  const inline = wantInline && mime !== null && INLINE_SAFE.has(mime);
  const type = inline ? (mime === 'text/plain' ? 'text/plain; charset=utf-8' : (mime as string)) : 'application/octet-stream';
  return { type, disposition: contentDisposition(row.filename, inline) };
}

type UploadFile = Express.Multer.File & Partial<Omit<StoredUpload, 'filename'>>;

/**
 * Multipart upload straight into the encrypted storage (nothing is buffered in memory or written in clear).
 * Accepts one `file` part and/or repeated `files` parts. The storage key is made from the session's org, the
 * given scope (the guarded tender's id, or null = organization level) and a fresh uuid — never from the request.
 * The result is on `res.locals.uploads` (StoredUpload[]); text fields are on `req.body`.
 * Over the size limit → 413 `file_too_large` (the partial blob is removed).
 */
export function receiveUploads(scope: (req: Request) => string | null, opts: { maxFiles?: number } = {}): RequestHandler {
  return (req, res, next) => {
    const maxFiles = Math.min(opts.maxFiles ?? uploadLimits.maxFiles, uploadLimits.maxFiles);
    const engine: multer.StorageEngine = {
      _handleFile(request, file, cb) {
        let key: string;
        const fileId = randomUUID();
        try {
          key = storageKey(request.ctx.orgId, scope(request), fileId);
        } catch (err) {
          cb(err);
          return;
        }
        getStorage()
          .put(key, file.stream)
          .then(
            (stored) => cb(null, { fileId, storageKey: key, size: stored.size, sha256: stored.sha256, enc: stored.enc } as Partial<Express.Multer.File>),
            (err: unknown) => {
              void getStorage().delete(key).catch(() => undefined);
              cb(err);
            },
          );
      },
      _removeFile(_request, file, cb) {
        const key = (file as UploadFile).storageKey;
        if (!key) return cb(null);
        getStorage()
          .delete(key)
          .then(
            () => cb(null),
            (err: unknown) => cb(err as Error),
          );
      },
    };
    const parse = multer({
      storage: engine,
      defParamCharset: 'utf8',
      limits: { fileSize: uploadLimits.maxBytes, files: maxFiles, fields: 20, fieldSize: 16 * 1024, parts: maxFiles + 20 },
    }).fields([
      { name: 'file', maxCount: 1 },
      { name: 'files', maxCount: maxFiles },
    ]);
    parse(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { name?: string; code?: string }).name === 'MulterError' ? (err as { code?: string }).code : undefined;
        if (code === 'LIMIT_FILE_SIZE') {
          next(new HttpError(413, 'file_too_large', `The file exceeds the ${Math.floor(uploadLimits.maxBytes / 1024 / 1024)} MB limit`, { max_bytes: uploadLimits.maxBytes }));
        } else if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE' || code === 'LIMIT_PART_COUNT') {
          next(badRequest('Too many files in one upload, or an unexpected file field', { max_files: maxFiles }, 'invalid_upload'));
        } else {
          next(err);
        }
        return;
      }
      const grouped = (req.files ?? {}) as Record<string, UploadFile[]>;
      const uploads: StoredUpload[] = [...(grouped.file ?? []), ...(grouped.files ?? [])].map((f) => ({
        fileId: f.fileId as string,
        storageKey: f.storageKey as string,
        filename: sanitizeFilename(f.originalname),
        mime: normalizeMime(f.mimetype),
        size: f.size as number,
        sha256: f.sha256 as string,
        enc: f.enc as EncMeta,
      }));
      res.locals.uploads = uploads;
      if (req.body === undefined || req.body === null) req.body = {};
      next();
    });
  };
}

export function uploadsOf(res: Response): StoredUpload[] {
  return (res.locals.uploads as StoredUpload[] | undefined) ?? [];
}

/** Removes blobs that will not get (or lost) their database row. Never throws. */
export async function discardUploads(uploads: readonly { storageKey: string }[]): Promise<void> {
  for (const u of uploads) {
    await getStorage()
      .delete(u.storageKey)
      .catch((err: unknown) => logger.error({ err, storageKey: u.storageKey }, 'could not remove an orphaned upload'));
  }
}

/** Requires at least one non-empty file; discards everything and throws otherwise. */
export async function requireUploads(res: Response): Promise<StoredUpload[]> {
  const uploads = uploadsOf(res);
  if (uploads.length === 0) throw badRequest('A file is required (multipart field "file")', undefined, 'file_required');
  if (uploads.some((u) => u.size === 0)) {
    await discardUploads(uploads);
    throw badRequest('The file is empty', undefined, 'file_empty');
  }
  return uploads;
}

/** Removes the blob of a file row (idempotent). */
export async function removeBlob(row: { storage_key: string }): Promise<void> {
  await getStorage().delete(row.storage_key);
}

/**
 * Sends a stored file. The caller has ALREADY decided the user may have it.
 * The blob is first read to the end and checked (GCM tag, size, sha256 of the plaintext against the database);
 * only then are the headers written and the content streamed — so a corrupted or tampered file is a loud
 * 500 `file_integrity_error` (logged and audited), never a silently truncated download.
 */
export async function sendFile(req: Request, res: Response, db: ScopedDb, row: Row, opts: { audit?: boolean } = {}): Promise<void> {
  const storage = getStorage();
  const fail = async (reason: string, err?: unknown): Promise<never> => {
    logger.error({ err, fileId: row.id, reason }, 'file integrity check failed');
    await db.audit('file', row.id, 'integrity_failure', { after: { reason }, tenderId: row.tender_id }).catch(() => undefined);
    throw new HttpError(500, 'file_integrity_error', 'The stored file failed its integrity check and was not sent');
  };
  try {
    const actual = await verify(storage, row.storage_key, row.enc);
    if (actual.size !== Number(row.size)) await fail('size_mismatch');
    if (!row.sha256 || actual.sha256 !== row.sha256) await fail('sha256_mismatch');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    await fail(err instanceof StorageError ? err.code : 'read_error', err);
  }

  if (opts.audit) await db.audit('file', row.id, 'download', { tenderId: row.tender_id });

  const headers = downloadHeaders(row as { filename: string; mime: string | null }, req.query.inline === '1');
  res.status(200);
  res.set({
    'Content-Type': headers.type,
    'Content-Disposition': headers.disposition,
    'Content-Length': String(row.size),
    'X-Content-Type-Options': 'nosniff',
    // Even if a browser were tricked into rendering the response, it runs without scripts, plugins or an origin.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'no-store',
    ETag: `"${row.sha256}"`,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(await storage.get(row.storage_key, row.enc), res);
  } catch (err) {
    // Headers are gone already: the only honest signal left is to break the connection.
    logger.error({ err, fileId: row.id }, 'file download aborted');
    res.destroy();
  }
}
