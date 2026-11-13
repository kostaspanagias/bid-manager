/**
 * Tender API used by the shell's TenderLayout. The tenders owner extends this file (list, create, update…).
 *
 * Assumed: GET /api/tenders/:id → { tender: Tender, permissions?: { canWrite, canSeeFinancial } }
 * The adapter below also accepts a bare Tender object and snake_case / top-level permission flags, and falls
 * back to the org role when the server sends no permissions — so only this function changes if the shape differs.
 */
import { api } from '@/api/client';
import type { ID, OrgRole, Tender } from '@/api/types';

export const tenderKeys = {
  all: ['tenders'] as const,
  list: (filters?: Record<string, unknown>) => ['tenders', 'list', filters ?? {}] as const,
  /** Everything of one tender — feature queries should use [...tenderKeys.detail(id), '<feature>'] */
  detail: (id: ID) => ['tenders', id] as const,
  /** The tender record itself (the query TenderLayout owns) */
  record: (id: ID) => ['tenders', id, 'record'] as const,
};

export interface TenderDetail {
  tender: Tender;
  /** null when the server did not say; TenderLayout then derives it from the org role and tender status */
  canWrite: boolean | null;
  canSeeFinancial: boolean | null;
  /** Working days to T if the server computes it (preferred over the client-side calculation) */
  tMinus: number | null;
}

function pickBool(...values: unknown[]): boolean | null {
  for (const v of values) if (typeof v === 'boolean') return v;
  return null;
}

export async function fetchTender(id: ID): Promise<TenderDetail> {
  const raw = await api.get<Record<string, unknown>>(`/tenders/${id}`);
  const tender = (raw.tender && typeof raw.tender === 'object' ? raw.tender : raw) as Tender & Record<string, unknown>;
  const perms = (raw.permissions ?? {}) as Record<string, unknown>;
  const tMinus = [raw.tMinus, raw.t_minus, tender.t_minus].find((v) => typeof v === 'number') as number | undefined;
  return {
    tender,
    canWrite: pickBool(perms.canWrite, perms.can_write, raw.canWrite, raw.can_write, tender.can_write),
    canSeeFinancial: pickBool(
      perms.canSeeFinancial,
      perms.can_see_financial,
      raw.canSeeFinancial,
      raw.can_see_financial,
      tender.can_see_financial,
    ),
    tMinus: tMinus ?? null,
  };
}

/** Fallback when the server sends no permission flags: everyone but viewers may write (server still enforces). */
export function defaultCanWrite(role: OrgRole | undefined): boolean {
  return Boolean(role && role !== 'viewer');
}
