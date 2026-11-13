/**
 * Admin → audit log (read-only; reconciled with server/src/modules/audit/routes.ts).
 *
 *   GET /api/audit?entity=&entity_id=&user_id=&limit=&offset= → { items, total, limit, offset }  (newest first)
 *   item: { id, at, user_id, user_name, entity, entity_id, tender_id, action, before, after }
 *   The server also accepts tender_id= and action= (not used by the UI yet).
 */
import { api, type PagedResponse } from '@/api/client';
import type { AuditLogEntry, ID, Json } from '@/api/types';

export interface AuditItem extends AuditLogEntry {
  user_name?: string | null;
  tender_id?: ID | null;
}

export interface AuditFilters {
  entity?: string;
  entity_id?: string;
  user_id?: ID;
  limit: number;
  offset: number;
}

export const auditKeys = {
  list: (filters: AuditFilters) => ['admin', 'audit', filters] as const,
};

export async function listAudit(filters: AuditFilters): Promise<PagedResponse<AuditItem>> {
  const res = await api.get<Partial<PagedResponse<AuditItem>>>('/audit', { query: { ...filters } });
  const items = res.items ?? [];
  return { items, total: typeof res.total === 'number' ? res.total : filters.offset + items.length };
}

/** Entities offered in the filter (table names that write audit rows). */
export const AUDIT_ENTITIES = [
  'tender',
  'tender_member',
  'tender_role',
  'milestone',
  'gate',
  'gate_criterion',
  'requirement',
  'task',
  'watch_item',
  'risk',
  'change_entry',
  'company_document',
  'tender_document',
  'file',
  'lesson',
  'template',
  'template_item',
  'holiday',
  'user',
  'invitation',
  'organization',
] as const;

export interface DiffRow {
  field: string;
  before: Json | undefined;
  after: Json | undefined;
  changed: boolean;
}

const NOISE = new Set(['updated_at']);

/** Field-by-field comparison of the before/after snapshots of an audit entry. */
export function diffAudit(entry: Pick<AuditLogEntry, 'before' | 'after'>): DiffRow[] {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  return keys.map((field) => {
    const b = before[field];
    const a = after[field];
    return { field, before: b, after: a, changed: JSON.stringify(b ?? null) !== JSON.stringify(a ?? null) };
  });
}

/** Names of the fields that changed, ignoring bookkeeping columns. */
export function changedFields(entry: Pick<AuditLogEntry, 'before' | 'after'>): string[] {
  return diffAudit(entry)
    .filter((r) => r.changed && !NOISE.has(r.field))
    .map((r) => r.field);
}
