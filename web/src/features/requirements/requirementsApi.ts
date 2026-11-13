/**
 * Requirements register API (server/src/modules/requirements/routes.ts).
 *
 *   GET    /tenders/:id/requirements            → { items, total, coverage, nextCode, owners }   (whole register, no paging)
 *   GET    /tenders/:id/requirements/coverage   → RegisterCoverage
 *   POST   /tenders/:id/requirements            → RegisterRow            PATCH/DELETE …/:rowId
 *   POST   /tenders/:id/requirements/bulk       { ids, patch } → { updated }
 *   POST   …/import/preview | …/import/commit   multipart: file, sheet?, mapping? (JSON), overwrite?, skip_invalid?
 *   GET    …/export.xlsx (same filters as the list) · …/template.xlsx
 */
import { api } from '@/api/client';
import type { ChangeKind, ChangeSource, ID, Requirement, RequirementFolder, RequirementStatus, RequirementType } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export interface LinkedChange {
  id: ID;
  date: string;
  kind: ChangeKind;
  source: ChangeSource;
  description: string;
  reference: string | null;
}

export interface RegisterRow extends Omit<Requirement, 'folder'> {
  folder: RequirementFolder | null;
  owner_role_key: string | null;
  /** Change-log entries linked to the row (read-only here; the change log owns them) */
  changes: LinkedChange[];
}

export interface Coverage {
  total: number;
  covered: number;
  ratio: number | null;
}
export interface RegisterCoverage extends Record<RequirementType | 'all', Coverage> {
  /** Exclusion rows without evidence — they block G1 */
  exclusionWithoutEvidence: number;
  /** Rows still open / in progress — they block G3 */
  open: number;
  deviations: number;
}

export interface OwnerRole {
  key: string;
  name: string;
  user_ids: ID[];
}
export interface OwnerUser {
  id: ID;
  name: string;
  email: string;
}
export interface Owners {
  roles: OwnerRole[];
  users: OwnerUser[];
}

export interface RegisterResponse {
  items: RegisterRow[];
  total: number;
  coverage: RegisterCoverage;
  nextCode: string;
  owners: Owners;
}

export type RequirementBody = Partial<
  Pick<
    RegisterRow,
    'code' | 'source_ref' | 'text' | 'type' | 'folder' | 'weight' | 'owner_user_id' | 'owner_role_key' | 'response_ref' | 'evidence_ref' | 'status' | 'deviation_note'
  >
>;
export type BulkPatch = Partial<Pick<RegisterRow, 'status' | 'deviation_note' | 'owner_user_id' | 'owner_role_key' | 'folder'>>;

export const registerKeys = {
  all: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'requirements'] as const,
  list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'requirements', 'list'] as const,
};

const base = (tenderId: ID) => `/tenders/${tenderId}/requirements`;

const NO_COVERAGE: Coverage = { total: 0, covered: 0, ratio: null };
/** Fills in defaults, so a partial answer (e.g. the `{ items: [] }` of the screenshot mock) still renders. */
export const fetchRegister = (tenderId: ID): Promise<RegisterResponse> =>
  api.get<Partial<RegisterResponse>>(base(tenderId)).then((r) => ({
    items: r.items ?? [],
    total: r.total ?? r.items?.length ?? 0,
    coverage: r.coverage ?? { exclusion: NO_COVERAGE, scored: NO_COVERAGE, formal: NO_COVERAGE, all: NO_COVERAGE, exclusionWithoutEvidence: 0, open: 0, deviations: 0 },
    nextCode: r.nextCode ?? 'ΥΠ-001',
    owners: { roles: r.owners?.roles ?? [], users: r.owners?.users ?? [] },
  }));
export const fetchCoverage = (tenderId: ID) => api.get<RegisterCoverage>(`${base(tenderId)}/coverage`);
export const createRequirement = (tenderId: ID, body: RequirementBody) => api.post<RegisterRow>(base(tenderId), body);
export const updateRequirement = (tenderId: ID, id: ID, body: RequirementBody) => api.patch<RegisterRow>(`${base(tenderId)}/${id}`, body);
export const deleteRequirement = (tenderId: ID, id: ID) => api.del(`${base(tenderId)}/${id}`);
export const bulkUpdateRequirements = (tenderId: ID, ids: ID[], patch: BulkPatch) =>
  api.post<{ updated: number }>(`${base(tenderId)}/bulk`, { ids, patch });

export interface ExportFilters {
  type?: RequirementType | '';
  folder?: RequirementFolder | 'none' | '';
  status?: RequirementStatus | '';
  owner?: string;
  q?: string;
  missing_evidence?: boolean;
}
export const exportUrl = (tenderId: ID, filters?: ExportFilters) =>
  api.downloadUrl(`${base(tenderId)}/export.xlsx`, filters ? { ...filters, missing_evidence: filters.missing_evidence ? 'true' : undefined } : undefined);
export const templateUrl = (tenderId: ID) => api.downloadUrl(`${base(tenderId)}/template.xlsx`);

/* ------------------------------------------------------------------ import */

export const IMPORT_FIELDS = [
  'code',
  'source_ref',
  'text',
  'type',
  'folder',
  'weight',
  'owner',
  'response_ref',
  'evidence_ref',
  'status',
  'deviation_note',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Record<ImportField, number | null>;
export type ImportAction = 'create' | 'update' | 'unchanged' | 'error';

export interface ImportProblem {
  field: ImportField;
  code: string;
  value?: string;
  firstRow?: number;
}
export interface ImportRow {
  /** Row number in the file */
  row: number;
  code: string | null;
  action: ImportAction;
  errors: ImportProblem[];
  warnings: ImportProblem[];
  values: Partial<Record<ImportField, string>>;
  changed: string[];
  kept: string[];
}
export interface ImportSummary {
  total: number;
  create: number;
  update: number;
  unchanged: number;
  errors: number;
  warnings: number;
  kept: number;
}
export interface ImportPreview {
  file: { name: string; format: 'csv' | 'xlsx'; encoding?: string; delimiter?: string; sheets: string[]; sheet: string | null; rows: number };
  columns: { index: number; header: string; sample: string[] }[];
  suggestedMapping: ImportMapping;
  mapping: ImportMapping;
  overwrite: boolean;
  summary: ImportSummary;
  rows: ImportRow[];
}
export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  total: number;
  overwrite: boolean;
}
export interface ImportOptions {
  sheet?: string | null;
  mapping?: ImportMapping | null;
  overwrite?: boolean;
  skipInvalid?: boolean;
}

function importForm(file: File, opts: ImportOptions): FormData {
  const form = new FormData();
  form.append('file', file, file.name);
  if (opts.sheet) form.append('sheet', opts.sheet);
  if (opts.mapping) form.append('mapping', JSON.stringify(opts.mapping));
  if (opts.overwrite) form.append('overwrite', 'true');
  if (opts.skipInvalid) form.append('skip_invalid', 'true');
  return form;
}
export const previewImport = (tenderId: ID, file: File, opts: ImportOptions, signal?: AbortSignal) =>
  api.upload<ImportPreview>(`${base(tenderId)}/import/preview`, importForm(file, opts), { signal });
export const commitImport = (tenderId: ID, file: File, opts: ImportOptions) =>
  api.upload<ImportResult>(`${base(tenderId)}/import/commit`, importForm(file, opts));

/** Largest file the server accepts (MAX_IMPORT_BYTES). */
export const IMPORT_MAX_MB = 5;
