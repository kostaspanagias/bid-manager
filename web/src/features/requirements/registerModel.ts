/** Client-side view logic of the register: filters, sorting and owner labels (the whole register is in memory). */
import type { ID, RequirementFolder, RequirementStatus, RequirementType } from '@/api/types';
import { REQUIREMENT_FOLDERS, REQUIREMENT_STATUSES, REQUIREMENT_TYPES } from '@/api/types';
import type { Owners, RegisterRow } from './requirementsApi';

export interface Filters {
  q: string;
  type: RequirementType | '';
  folder: RequirementFolder | 'none' | '';
  status: RequirementStatus | '';
  /** '' | 'me' | 'none' | 'role:<key>' | user id */
  owner: string;
  missingEvidence: boolean;
}
export const NO_FILTERS: Filters = { q: '', type: '', folder: '', status: '', owner: '', missingEvidence: false };
export const hasFilters = (f: Filters) => Boolean(f.q.trim() || f.type || f.folder || f.status || f.owner || f.missingEvidence);

export type SortKey = 'code' | 'type' | 'text' | 'source_ref' | 'folder' | 'owner' | 'response_ref' | 'evidence_ref' | 'status';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_SORT: Sort = { key: 'code', dir: 'asc' };

/** Accent- and case-insensitive form for searching Greek text. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ');
}

export const isBlank = (v: string | null | undefined) => !v || v.trim() === '';
/** The G1 blocker: an exclusion requirement without evidence. */
export const lacksEvidence = (row: Pick<RegisterRow, 'type' | 'evidence_ref'>) => row.type === 'exclusion' && isBlank(row.evidence_ref);

export const codeNumber = (code: string): number => {
  const digits = code.replace(/\D/g, '');
  return digits ? Number(digits) : Number.MAX_SAFE_INTEGER;
};

/** Same normalisation as the server (codes.ts): ΥΠ-nnn with Greek letters and at least three digits, or null. */
export function canonicalCode(input: string): string | null {
  const raw = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/Y/g, 'Υ')
    .replace(/P/g, 'Π')
    .replace(/[\s ._\-‐-―−/#:]+/g, '');
  const m = /^(?:ΥΠ)?(\d{1,9})$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 999_999) return null;
  return `ΥΠ-${String(n).padStart(3, '0')}`;
}

export function ownerLabel(row: Pick<RegisterRow, 'owner_user_id' | 'owner_role_key'>, owners: Owners | undefined): { role: string | null; user: string | null } {
  const user = row.owner_user_id ? (owners?.users.find((u) => u.id === row.owner_user_id)?.name ?? '…') : null;
  return { role: row.owner_role_key, user };
}
export function ownerText(row: Pick<RegisterRow, 'owner_user_id' | 'owner_role_key'>, owners: Owners | undefined): string {
  const { role, user } = ownerLabel(row, owners);
  return [role, user].filter(Boolean).join(' · ');
}

/** A person owns the rows assigned to them and the rows assigned to a role they hold (same rule as the server). */
function ownerMatcher(owner: string, owners: Owners | undefined, me: ID | undefined): (row: RegisterRow) => boolean {
  if (owner === 'none') return (r) => !r.owner_user_id && !r.owner_role_key;
  if (owner.startsWith('role:')) {
    const key = owner.slice(5);
    return (r) => r.owner_role_key === key;
  }
  const userId = owner === 'me' ? me : owner;
  const roleKeys = new Set((owners?.roles ?? []).filter((r) => userId && r.user_ids.includes(userId)).map((r) => r.key));
  return (r) => r.owner_user_id === userId || (r.owner_role_key !== null && roleKeys.has(r.owner_role_key));
}

export function filterRows(rows: readonly RegisterRow[], f: Filters, owners: Owners | undefined, me: ID | undefined, haystack: ReadonlyMap<ID, string>): RegisterRow[] {
  const q = fold(f.q.trim());
  const qCode = q ? canonicalCode(f.q) : null;
  const byOwner = f.owner ? ownerMatcher(f.owner, owners, me) : null;
  return rows.filter((r) => {
    if (f.type && r.type !== f.type) return false;
    if (f.folder && (f.folder === 'none' ? r.folder !== null : r.folder !== f.folder)) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.missingEvidence && !lacksEvidence(r)) return false;
    if (byOwner && !byOwner(r)) return false;
    if (q && !(haystack.get(r.id) ?? '').includes(q) && r.code !== qCode) return false;
    return true;
  });
}

/** code + text + source, folded once per row so that typing in the search box stays instant at 1,000 rows. */
export function buildHaystack(rows: readonly RegisterRow[]): Map<ID, string> {
  return new Map(rows.map((r) => [r.id, fold(`${r.code}\n${r.text}\n${r.source_ref ?? ''}`)]));
}

const STATUS_ORDER: RequirementStatus[] = ['open', 'in_progress', 'deviation', 'covered', 'verified'];
const collator = new Intl.Collator('el', { numeric: true, sensitivity: 'base' });

export function sortRows(rows: readonly RegisterRow[], sort: Sort, owners: Owners | undefined): RegisterRow[] {
  const text = (v: string | null) => v ?? '';
  const rank = <T>(order: readonly T[], v: T | null) => (v === null ? order.length : order.indexOf(v));
  const key = (r: RegisterRow): number | string => {
    switch (sort.key) {
      case 'code':
        return codeNumber(r.code);
      case 'type':
        return rank(REQUIREMENT_TYPES, r.type);
      case 'folder':
        return rank(REQUIREMENT_FOLDERS, r.folder);
      case 'status':
        return rank(STATUS_ORDER, r.status);
      case 'owner':
        return ownerText(r, owners) || '￿';
      default:
        return text(r[sort.key]) || '￿';
    }
  };
  const sign = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row) => ({ row, k: key(row), n: codeNumber(row.code) }))
    .sort((a, b) => {
      const d = typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : collator.compare(String(a.k), String(b.k));
      return d !== 0 ? d * sign : a.n - b.n;
    })
    .map((x) => x.row);
}

export { REQUIREMENT_FOLDERS, REQUIREMENT_STATUSES, REQUIREMENT_TYPES };
