// Pure part of the register import (R17): header → field mapping, value normalisation, per-row validation and the
// non-destructive merge plan. No database access here, so every rule is unit-testable.
// The file format is documented in docs/register-import-format.md — keep the two in sync.
import { REQUIREMENT_STATUSES, REQUIREMENT_TYPES, type RequirementStatus, type RequirementType } from '../../domain/register.js';
import { canonicalCode } from './codes.js';

export const REQUIREMENT_FOLDERS = ['participation', 'technical', 'financial'] as const;
export type RequirementFolder = (typeof REQUIREMENT_FOLDERS)[number];

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
/** field → 0-based column index in the file (null/absent = not imported). */
export type Mapping = Partial<Record<ImportField, number | null>>;

/** Lower-case, accent-free, punctuation-free form used to compare headers and enum values. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[^a-z0-9α-ω]+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------------------------------------------ headers

/** Canonical header first (it is the one the export and the template write), then accepted synonyms. */
export const HEADER_NAMES: Record<ImportField, { el: string; en: string; synonyms: string[] }> = {
  code: { el: 'Κωδικός', en: 'code', synonyms: ['Κωδ.', 'Κωδικός απαίτησης', 'ΥΠ', 'id', 'requirement code', 'req id'] },
  source_ref: { el: 'Πηγή', en: 'source_ref', synonyms: ['source', 'Παραπομπή', 'Άρθρο', 'Αναφορά', 'Πηγή διακήρυξης', 'reference'] },
  text: { el: 'Κείμενο', en: 'text', synonyms: ['Απαίτηση', 'Κείμενο απαίτησης', 'Περιγραφή', 'requirement', 'description'] },
  type: { el: 'Τύπος', en: 'type', synonyms: ['Είδος', 'Τύπος απαίτησης', 'category'] },
  folder: { el: 'Φάκελος', en: 'folder', synonyms: ['Υποφάκελος', 'Φάκελος προσφοράς'] },
  weight: { el: 'Συντελεστής', en: 'weight', synonyms: ['Βαρύτητα', 'Κριτήριο', 'Κριτήριο / συντελεστής', 'Συντελεστής βαρύτητας', 'criterion'] },
  owner: { el: 'Υπεύθυνος', en: 'owner', synonyms: ['Ρόλος', 'Υπεύθυνος ρόλος', 'role', 'assignee'] },
  response_ref: { el: 'Απάντηση', en: 'response_ref', synonyms: ['response', 'Κεφάλαιο', 'Απάντηση προσφοράς'] },
  evidence_ref: { el: 'Τεκμήριο', en: 'evidence_ref', synonyms: ['evidence', 'Τεκμηρίωση', 'Παραπομπή τεκμηρίου'] },
  status: { el: 'Κατάσταση', en: 'status', synonyms: ['state'] },
  deviation_note: { el: 'Αιτιολόγηση απόκλισης', en: 'deviation_note', synonyms: ['Σημείωση απόκλισης', 'Αιτιολόγηση', 'deviation', 'deviation note'] },
};

const HEADER_LOOKUP: Map<string, ImportField> = (() => {
  const map = new Map<string, ImportField>();
  for (const field of IMPORT_FIELDS) {
    const names = HEADER_NAMES[field];
    for (const name of [names.el, names.en, ...names.synonyms]) map.set(fold(name), field);
  }
  return map;
})();

/** Best-effort mapping of the file's header row; each column is used for at most one field (first match wins). */
export function suggestMapping(headers: readonly string[]): Record<ImportField, number | null> {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as Record<ImportField, number | null>;
  headers.forEach((header, index) => {
    const field = HEADER_LOOKUP.get(fold(header));
    if (field && mapping[field] === null) mapping[field] = index;
  });
  return mapping;
}

// -------------------------------------------------------------------------------------------------- enum values

type Matcher<V extends string> = { value: V; exact: string[]; stems: string[] };

const TYPE_VALUES: Matcher<RequirementType>[] = [
  { value: 'exclusion', exact: ['exclusion', 'mandatory', 'must'], stems: ['αποκλεισμ', 'υποχρε'] },
  { value: 'scored', exact: ['scored', 'score', 'scoring'], stems: ['βαθμολογ'] },
  { value: 'formal', exact: ['formal'], stems: ['τυπικ'] },
];
const FOLDER_VALUES: Matcher<RequirementFolder>[] = [
  { value: 'participation', exact: ['participation'], stems: ['συμμετοχ', 'δικαιολογητικ'] },
  { value: 'technical', exact: ['technical'], stems: ['τεχνικ'] },
  { value: 'financial', exact: ['financial'], stems: ['οικονομικ'] },
];
const STATUS_VALUES: Matcher<RequirementStatus>[] = [
  { value: 'open', exact: ['open'], stems: ['ανοιχτ', 'ανοικτ'] },
  { value: 'in_progress', exact: ['in progress', 'inprogress', 'wip'], stems: ['σε εξελιξη'] },
  { value: 'covered', exact: ['covered'], stems: ['καλυφθηκε', 'καλυμμεν'] },
  { value: 'verified', exact: ['verified', 'checked'], stems: ['ελεγχθηκε', 'ελεγμεν'] },
  { value: 'deviation', exact: ['deviation'], stems: ['αποκλιση'] },
];

function matchEnum<V extends string>(matchers: Matcher<V>[], raw: string): V | null {
  const folded = fold(raw);
  if (folded === '') return null;
  const exact = matchers.find((m) => m.exact.includes(folded));
  if (exact) return exact.value;
  // Greek values are matched by stem ("Αποκλεισμού (ΥΠΟΧΡΕΩΣΗ)", "Τεχνική προσφορά"), but only when unambiguous.
  const hits = matchers.filter((m) => m.stems.some((s) => folded.split(' ').some((w) => w.startsWith(s)) || folded.startsWith(s)));
  return hits.length === 1 ? (hits[0] as Matcher<V>).value : null;
}

export const parseType = (raw: string) => matchEnum(TYPE_VALUES, raw);
export const parseFolder = (raw: string) => matchEnum(FOLDER_VALUES, raw);
export const parseStatus = (raw: string) => matchEnum(STATUS_VALUES, raw);

// -------------------------------------------------------------------------------------------------------- owner

export interface OwnerRole {
  key: string;
  name: string;
}
export interface OwnerUser {
  id: string;
  name: string;
  email: string;
}
export interface OwnerDirectory {
  roles: OwnerRole[];
  users: OwnerUser[];
}
export interface Owner {
  owner_user_id: string | null;
  owner_role_key: string | null;
}

/** Greek capitals typed for the Latin role keys of the template (Α/Β/Γ = A/B/C). */
const ROLE_LETTERS: Record<string, string> = { Α: 'A', Β: 'B', Γ: 'C', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X' };
const roleKeyForm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[Α-Ω]/g, (c) => ROLE_LETTERS[c] ?? c)
    .replace(/\s+/g, '');

/**
 * "B", "Β" (Greek), a role name, a user's e-mail or full name, or a role and a user separated by `;` `/` `|` `·`.
 * Returns the owner, or an error code: `unknown_owner` / `ambiguous_owner`.
 */
export function parseOwner(raw: string, dir: OwnerDirectory): { owner: Owner } | { error: 'unknown_owner' | 'ambiguous_owner' } {
  const one = (token: string): { role?: string; user?: string; error?: 'unknown_owner' | 'ambiguous_owner' } => {
    const t = token.trim();
    if (t === '') return {};
    const keyForm = roleKeyForm(t);
    const byKey = dir.roles.find((r) => roleKeyForm(r.key) === keyForm);
    if (byKey) return { role: byKey.key };
    const email = /<([^<>\s]+@[^<>\s]+)>/.exec(t)?.[1] ?? t;
    if (email.includes('@')) {
      const byEmail = dir.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      return byEmail ? { user: byEmail.id } : { error: 'unknown_owner' };
    }
    const folded = fold(t);
    const byRoleName = dir.roles.filter((r) => fold(r.name) === folded);
    const byUserName = dir.users.filter((u) => fold(u.name) === folded);
    if (byRoleName.length + byUserName.length > 1) return { error: 'ambiguous_owner' };
    if (byRoleName[0]) return { role: byRoleName[0].key };
    if (byUserName[0]) return { user: byUserName[0].id };
    return { error: 'unknown_owner' };
  };

  const whole = one(raw);
  if (!whole.error) return { owner: { owner_user_id: whole.user ?? null, owner_role_key: whole.role ?? null } };
  const tokens = raw.split(/[;/|·]/).filter((t) => t.trim() !== '');
  if (tokens.length < 2) return { error: whole.error };
  const owner: Owner = { owner_user_id: null, owner_role_key: null };
  for (const token of tokens) {
    const r = one(token);
    if (r.error) return { error: r.error };
    if (r.role) {
      if (owner.owner_role_key && owner.owner_role_key !== r.role) return { error: 'ambiguous_owner' };
      owner.owner_role_key = r.role;
    }
    if (r.user) {
      if (owner.owner_user_id && owner.owner_user_id !== r.user) return { error: 'ambiguous_owner' };
      owner.owner_user_id = r.user;
    }
  }
  return { owner };
}

/** The text the export writes for an owner; `parseOwner` reads it back to the same owner. */
export function formatOwner(owner: Owner, dir: OwnerDirectory): string {
  const parts: string[] = [];
  if (owner.owner_role_key) parts.push(owner.owner_role_key);
  if (owner.owner_user_id) {
    const user = dir.users.find((u) => u.id === owner.owner_user_id);
    if (user) {
      const back = parseOwner(user.name, dir);
      const unambiguous = 'owner' in back && back.owner.owner_user_id === user.id && !/[;/|·@]/.test(user.name);
      parts.push(unambiguous ? user.name : user.email);
    }
  }
  return parts.join('; ');
}

// --------------------------------------------------------------------------------------------------------- plan

export interface ExistingRow extends Owner {
  id: string;
  code: string;
  source_ref: string | null;
  text: string;
  type: string;
  folder: string | null;
  weight: string | null;
  response_ref: string | null;
  evidence_ref: string | null;
  status: string;
  deviation_note: string | null;
}

export type ProblemCode =
  | 'missing_code'
  | 'invalid_code'
  | 'duplicate_code_in_file'
  | 'missing_text'
  | 'unknown_type'
  | 'unknown_folder'
  | 'unknown_status'
  | 'unknown_owner'
  | 'ambiguous_owner'
  | 'deviation_note_required'
  | 'value_too_long';

export interface Problem {
  field: ImportField;
  code: ProblemCode;
  /** The offending cell text (truncated). */
  value?: string;
  /** duplicate_code_in_file: the file row that already uses the code. */
  firstRow?: number;
}

export type RowAction = 'create' | 'update' | 'unchanged' | 'error';
type Columns = Omit<ExistingRow, 'id'>;
export type ColumnPatch = Partial<Columns>;

export interface PlanRow {
  /** Row number in the file (1-based, as a spreadsheet shows it). */
  row: number;
  /** Canonical code, or null when missing/invalid. */
  code: string | null;
  action: RowAction;
  /** Blocking problems: the row is not imported. */
  errors: Problem[];
  /** Non-blocking: the row is imported without that value. */
  warnings: Problem[];
  /** Normalised values read from the file (only mapped, non-empty cells; enums as English values). */
  values: Partial<Record<ImportField, string>>;
  /** Columns that will be written (update) — empty for create/unchanged/error. */
  changed: string[];
  /** Team-owned fields where the file differs but the existing value is kept (overwrite off). */
  kept: string[];
  /** Internal: id of the existing row and the column patch / new row. Stripped before the response. */
  id?: string;
  patch?: ColumnPatch;
  data?: Columns;
}

export interface PlanSummary {
  total: number;
  create: number;
  update: number;
  unchanged: number;
  errors: number;
  /** Rows with at least one warning. */
  warnings: number;
  /** Rows where at least one team-owned field was kept instead of overwritten. */
  kept: number;
}

export interface PlanInput {
  rows: string[][];
  rowNumbers: number[];
  mapping: Mapping;
  existing: ExistingRow[];
  owners: OwnerDirectory;
  /** Also replace non-empty team-owned fields (response, evidence, status, deviation note, owner). */
  overwrite: boolean;
}

const MAX_LEN: Partial<Record<ImportField, number>> = { source_ref: 500, text: 20_000, weight: 500, response_ref: 1000, evidence_ref: 1000, deviation_note: 5000 };
const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';
const norm = (v: string | null | undefined) => (v ?? '').replace(/\r\n?/g, '\n').trim();
const same = (a: string | null | undefined, b: string | null | undefined) => norm(a) === norm(b);
const clip = (v: string) => (v.length > 80 ? `${v.slice(0, 77)}…` : v);

/**
 * Merge rules (R17 — upsert by canonical code, never delete):
 *  - file-owned fields (`source_ref`, `text`, `type`, `folder`, `weight`) follow the file whenever their column is
 *    mapped; an empty cell clears `source_ref`/`folder`/`weight`, keeps `type`, and is an error for `text`;
 *  - team-owned fields (`response_ref`, `evidence_ref`, `status`, `deviation_note`, owner) are filled from the file
 *    only where the row has nothing yet (blank text, status `open`, no owner) — unless `overwrite`;
 *    an empty cell never clears them;
 *  - a new row takes everything the file gives (type defaults to `formal`, status to `open`).
 */
export function buildPlan(input: PlanInput): { rows: PlanRow[]; summary: PlanSummary } {
  const { mapping, overwrite, owners } = input;
  const byCode = new Map<string, ExistingRow>();
  for (const e of input.existing) byCode.set(canonicalCode(e.code) ?? e.code, e);
  const seen = new Map<string, number>();
  const col = (cells: string[], field: ImportField): string | undefined => {
    const index = mapping[field];
    return index === null || index === undefined ? undefined : (cells[index] ?? '');
  };

  const rows = input.rows.map((cells, i): PlanRow => {
    const out: PlanRow = { row: input.rowNumbers[i] ?? i + 2, code: null, action: 'error', errors: [], warnings: [], values: {}, changed: [], kept: [] };
    const err = (field: ImportField, code: ProblemCode, value?: string, extra?: Partial<Problem>) =>
      out.errors.push({ field, code, ...(value !== undefined ? { value: clip(value) } : {}), ...extra });

    // code
    const rawCode = col(cells, 'code') ?? '';
    if (rawCode === '') err('code', 'missing_code');
    else {
      out.code = canonicalCode(rawCode);
      if (!out.code) err('code', 'invalid_code', rawCode);
      else {
        out.values.code = out.code;
        const first = seen.get(out.code);
        if (first !== undefined) err('code', 'duplicate_code_in_file', rawCode, { firstRow: first });
        else seen.set(out.code, out.row);
      }
    }
    const existing = out.code ? byCode.get(out.code) : undefined;

    // plain text fields
    const texts: Partial<Record<ImportField, string>> = {};
    for (const field of ['source_ref', 'text', 'weight', 'response_ref', 'evidence_ref', 'deviation_note'] as const) {
      const v = col(cells, field);
      if (v === undefined) continue;
      texts[field] = v;
      if (v !== '') out.values[field] = v;
      const max = MAX_LEN[field];
      if (max && v.length > max) err(field, 'value_too_long', v);
    }
    if (texts.text === '' || (texts.text === undefined && !existing)) err('text', 'missing_text');

    // enums
    const enumCell = <V extends string>(field: 'type' | 'folder' | 'status', parse: (raw: string) => V | null, code: ProblemCode): V | null | undefined => {
      const v = col(cells, field);
      if (v === undefined) return undefined; // not mapped
      if (v === '') return null; // mapped, empty
      const parsed = parse(v);
      if (!parsed) {
        err(field, code, v);
        return undefined;
      }
      out.values[field] = parsed;
      return parsed;
    };
    const type = enumCell('type', parseType, 'unknown_type');
    const folder = enumCell('folder', parseFolder, 'unknown_folder');
    const status = enumCell('status', parseStatus, 'unknown_status');

    // owner — an unknown owner does not block the row; it is imported without (or keeping) its owner
    let owner: Owner | undefined;
    const rawOwner = col(cells, 'owner');
    if (rawOwner !== undefined && rawOwner !== '') {
      const parsed = parseOwner(rawOwner, owners);
      if ('error' in parsed) out.warnings.push({ field: 'owner', code: parsed.error, value: clip(rawOwner) });
      else {
        owner = parsed.owner;
        out.values.owner = formatOwner(owner, owners);
      }
    }

    if (!existing) {
      const data: Columns = {
        code: out.code ?? '',
        source_ref: texts.source_ref || null,
        text: texts.text ?? '',
        type: type ?? 'formal',
        folder: folder ?? null,
        weight: texts.weight || null,
        response_ref: texts.response_ref || null,
        evidence_ref: texts.evidence_ref || null,
        status: status ?? 'open',
        deviation_note: texts.deviation_note || null,
        owner_user_id: owner?.owner_user_id ?? null,
        owner_role_key: owner?.owner_role_key ?? null,
      };
      if (data.status === 'deviation' && blank(data.deviation_note)) err('status', 'deviation_note_required');
      if (out.errors.length === 0) {
        out.action = 'create';
        out.data = data;
      }
      return out;
    }

    out.id = existing.id;
    const patch: ColumnPatch = {};
    // file-owned
    if (out.code && existing.code !== out.code) patch.code = out.code; // legacy spelling → canonical
    if (texts.source_ref !== undefined && !same(texts.source_ref, existing.source_ref)) patch.source_ref = texts.source_ref || null;
    if (texts.text !== undefined && texts.text !== '' && !same(texts.text, existing.text)) patch.text = texts.text;
    if (texts.weight !== undefined && !same(texts.weight, existing.weight)) patch.weight = texts.weight || null;
    if (type && type !== existing.type) patch.type = type;
    if (folder !== undefined && folder !== existing.folder) patch.folder = folder;
    // team-owned
    for (const field of ['response_ref', 'evidence_ref', 'deviation_note'] as const) {
      const v = texts[field];
      if (v === undefined || v === '' || same(v, existing[field])) continue;
      if (blank(existing[field]) || overwrite) patch[field] = v;
      else out.kept.push(field);
    }
    if (status && status !== existing.status) {
      if (existing.status === 'open' || overwrite) patch.status = status;
      else out.kept.push('status');
    }
    if (owner && (owner.owner_user_id !== existing.owner_user_id || owner.owner_role_key !== existing.owner_role_key)) {
      if ((!existing.owner_user_id && !existing.owner_role_key) || overwrite) Object.assign(patch, owner);
      else out.kept.push('owner');
    }
    const result = { ...existing, ...patch };
    if (result.status === 'deviation' && blank(result.deviation_note)) err('status', 'deviation_note_required');
    if (out.errors.length > 0) return out;
    out.changed = Object.keys(patch);
    out.action = out.changed.length > 0 ? 'update' : 'unchanged';
    if (out.action === 'update') out.patch = patch;
    return out;
  });

  const summary: PlanSummary = { total: rows.length, create: 0, update: 0, unchanged: 0, errors: 0, warnings: 0, kept: 0 };
  for (const r of rows) {
    if (r.action === 'error') summary.errors++;
    else summary[r.action]++;
    if (r.warnings.length > 0) summary.warnings++;
    if (r.kept.length > 0 && r.action !== 'error') summary.kept++;
  }
  return { rows, summary };
}
