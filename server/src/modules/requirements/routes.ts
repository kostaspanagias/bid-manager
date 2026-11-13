// Mounted at /api/tenders/:tenderId/requirements — mergeParams; tender access already checked, tender row on req.tender.
// Requirements register (F5, R17). Everyone who can write to the tender edits rows and imports; only bid_manager and
// admin delete. Closed tenders are read-only. The import format is documented in docs/register-import-format.md.
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { badRequest, HttpError, unprocessable } from '../../core/errors.js';
import { isMutating, zUuid } from '../../core/http.js';
import { requireRole } from '../../core/permissions.js';
import { REQUIREMENT_STATUSES, REQUIREMENT_TYPES } from '../../domain/register.js';
import { MAX_IMPORT_BYTES } from './importFile.js';
import { IMPORT_FIELDS, REQUIREMENT_FOLDERS, type ExistingRow, type Mapping } from './importPlan.js';
import {
  SORT_KEYS,
  bulkUpdate,
  commitImport,
  createRequirement,
  getRequirement,
  listRequirements,
  loadOwners,
  previewImport,
  registerCoverage,
  removeRequirement,
  suggestNextCode,
  updateRequirement,
  type ListFilters,
} from './service.js';
import { buildComplianceSheet, buildTemplate } from './xlsx.js';

export const router: Router = Router({ mergeParams: true });

const CLOSED = new Set(['submitted', 'no_go', 'cancelled']);
router.use((req, _res, next) => {
  if (isMutating(req.method) && CLOSED.has(String(req.tender.status))) {
    throw unprocessable('The tender is closed: the register is read-only', undefined, 'tender_closed');
  }
  next();
});

// ------------------------------------------------------------------------------------------------------ schemas

/** Trimmed text; '' and null both mean "empty". */
const zText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((s) => (s && s.trim() !== '' ? s.trim() : null));
const zType = z.enum(REQUIREMENT_TYPES);
const zFolder = z.enum(REQUIREMENT_FOLDERS).nullable();
const zStatus = z.enum(REQUIREMENT_STATUSES);
const zRoleKey = z
  .string()
  .trim()
  .max(60)
  .nullable()
  .transform((s) => (s ? s : null));

const fields = {
  code: z.string().trim().min(1).max(40),
  source_ref: zText(500),
  text: z.string().trim().min(1).max(20_000),
  type: zType,
  folder: zFolder,
  weight: zText(500),
  owner_user_id: zUuid.nullable(),
  owner_role_key: zRoleKey,
  response_ref: zText(1000),
  evidence_ref: zText(1000),
  status: zStatus,
  deviation_note: zText(5000),
};
const createBody = z.object({ ...fields, text: fields.text }).partial().required({ text: true }).strict();
const patchBody = z.object(fields).partial().strict();
const bulkBody = z
  .object({
    ids: z.array(zUuid).min(1).max(5000),
    patch: z
      .object({ status: zStatus, deviation_note: zText(5000), owner_user_id: zUuid.nullable(), owner_role_key: zRoleKey, folder: zFolder })
      .partial()
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'Nothing to change'),
  })
  .strict();

/** `?type=exclusion&type=scored` or `?type=exclusion,scored`. */
const zMulti = <T extends string>(values: readonly T[]) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : [v].flat().flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(z.enum(values as readonly [T, ...T[]])).optional());
const zFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');
const filterQuery = {
  type: zMulti(REQUIREMENT_TYPES),
  folder: zMulti([...REQUIREMENT_FOLDERS, 'none'] as const),
  status: zMulti(REQUIREMENT_STATUSES),
  owner: z
    .string()
    .trim()
    .max(80)
    .optional()
    .refine((v) => v === undefined || v === '' || v === 'me' || v === 'none' || /^role:.{1,60}$/.test(v) || zUuid.safeParse(v).success, 'Invalid owner filter'),
  q: z.string().max(200).optional(),
  missing_evidence: zFlag,
  sort: z.enum(SORT_KEYS as [string, ...string[]]).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
};
const listQuery = z.object({
  ...filterQuery,
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function filtersOf(q: z.infer<typeof listQuery>): ListFilters {
  return {
    type: q.type,
    folder: q.folder,
    status: q.status,
    owner: q.owner || undefined,
    q: q.q,
    missingEvidence: q.missing_evidence,
    sort: q.sort,
    dir: q.dir,
    limit: q.limit,
    offset: q.offset,
  };
}

// --------------------------------------------------------------------------------------------------------- read

/**
 * The whole register in one response (no page limit unless `limit` is given — the spec's size is 1,000 rows):
 * `{ items, total, coverage, nextCode, owners }`. Coverage is always that of the whole tender, not of the filter.
 */
router.get('/', async (req, res) => {
  const { db } = req.ctx;
  const tenderId = req.tender.id as string;
  const filters = filtersOf(listQuery.parse(req.query));
  const [items, coverage, owners, nextCode] = await Promise.all([
    listRequirements(db, tenderId, filters),
    registerCoverage(db, tenderId),
    loadOwners(db, tenderId),
    suggestNextCode(db, tenderId),
  ]);
  res.json({ items, total: coverage.all.total, coverage, nextCode, owners });
});

router.get('/coverage', async (req, res) => {
  res.json(await registerCoverage(req.ctx.db, req.tender.id));
});

router.get('/next-code', async (req, res) => {
  res.json({ code: await suggestNextCode(req.ctx.db, req.tender.id) });
});

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function sendXlsx(res: Parameters<RequestHandler>[1], buffer: Buffer, filename: string): void {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

/** Compliance sheet (φύλλο συμμόρφωσης). Takes the same filters as the list; without any, the whole register. */
router.get('/export.xlsx', async (req, res) => {
  const { db } = req.ctx;
  const filters = filtersOf(z.object(filterQuery).parse(req.query));
  const [rows, owners] = await Promise.all([listRequirements(db, req.tender.id, filters), loadOwners(db, req.tender.id)]);
  const buffer = await buildComplianceSheet(rows as ExistingRow[], owners, { title: String(req.tender.title ?? '') });
  const ref = String(req.tender.esidis_no || req.tender.adam || '').replace(/[^\p{L}\p{N}_-]+/gu, '');
  sendXlsx(res, buffer, `Φύλλο συμμόρφωσης${ref ? ` ${ref}` : ''}.xlsx`);
});

router.get('/template.xlsx', async (req, res) => {
  sendXlsx(res, await buildTemplate(await loadOwners(req.ctx.db, req.tender.id)), 'Υπόδειγμα register απαιτήσεων.xlsx');
});

// ------------------------------------------------------------------------------------------------------- import

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 10, fieldSize: 20_000 } });
/** Multipart with one `file` part, kept in memory only. */
const importUpload: RequestHandler = (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      return next(
        code === 'LIMIT_FILE_SIZE'
          ? new HttpError(413, 'import_file_too_large', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`, { limitBytes: MAX_IMPORT_BYTES })
          : badRequest('Invalid upload', undefined, 'invalid_upload'),
      );
    }
    next();
  });
};

const zMapping = z.record(z.enum(IMPORT_FIELDS), z.number().int().min(0).nullable());
const importFields = z.object({
  sheet: z.string().max(200).optional(),
  /** JSON object: field → 0-based column index or null. Absent = use the suggested mapping. */
  mapping: z.string().optional(),
  overwrite: zFlag,
  skip_invalid: zFlag,
});

function importInput(req: Parameters<RequestHandler>[0]) {
  if (!req.file) throw badRequest('Send the file in a multipart part named "file"', undefined, 'import_file_required');
  const body = importFields.parse(req.body ?? {});
  let mapping: Mapping | null = null;
  if (body.mapping !== undefined && body.mapping !== '') {
    let raw: unknown;
    try {
      raw = JSON.parse(body.mapping);
    } catch {
      throw badRequest('mapping must be a JSON object', undefined, 'import_bad_mapping');
    }
    const parsed = zMapping.safeParse(raw);
    if (!parsed.success) throw badRequest('mapping must map field names to column indexes', undefined, 'import_bad_mapping');
    mapping = parsed.data as Mapping;
  }
  // multer hands the filename over as latin1.
  const name = Buffer.from(req.file.originalname ?? 'import', 'latin1').toString('utf8').slice(0, 200);
  return {
    file: { buffer: req.file.buffer, name },
    opts: { sheet: body.sheet || null, mapping, overwrite: body.overwrite, skipInvalid: body.skip_invalid },
  };
}

/** Step 1: nothing is written. Returns the columns, the suggested/applied mapping and the per-row plan. */
router.post('/import/preview', importUpload, async (req, res) => {
  const { file, opts } = importInput(req);
  res.json(await previewImport(req.ctx.db, req.tender.id, file, opts));
});

/** Step 2: the same file and options again; applies the upsert in one transaction. */
router.post('/import/commit', importUpload, async (req, res) => {
  const { file, opts } = importInput(req);
  res.json(await commitImport(req.ctx.db, req.tender.id, file, opts));
});

// ------------------------------------------------------------------------------------------------------- writes

router.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  res.status(201).json(await createRequirement(req.ctx.db, req.tender.id, body));
});

router.post('/bulk', async (req, res) => {
  const { ids, patch } = bulkBody.parse(req.body);
  res.json(await bulkUpdate(req.ctx.db, req.tender.id, ids, patch));
});

router.get('/:id', async (req, res) => {
  res.json(await getRequirement(req.ctx.db, req.tender.id, String(req.params.id)));
});

router.patch('/:id', async (req, res) => {
  const body = patchBody.parse(req.body);
  res.json(await updateRequirement(req.ctx.db, req.tender.id, String(req.params.id), body));
});

router.delete('/:id', requireRole('admin', 'bid_manager'), async (req, res) => {
  await removeRequirement(req.ctx.db, req.tender.id, String(req.params.id));
  res.status(204).end();
});
