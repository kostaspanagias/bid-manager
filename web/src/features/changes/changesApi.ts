/**
 * Change log of a tender (server: server/src/modules/changes/routes.ts).
 *
 *   GET    /api/tenders/:id/changes             → { items: ChangeView[] } (newest first)
 *   POST   /api/tenders/:id/changes             { description, date?, source?, kind?, reference?, owner_user_id?,
 *                                                 requirement_ids?, reopen_requirements? } → ChangeView (+ reopened)
 *   PATCH  /api/tenders/:id/changes/:entryId    any of the above → ChangeView (+ reopened)
 *   DELETE /api/tenders/:id/changes/:entryId    → 204 (extension entries: bid manager / admin only)
 *
 * kind `extension` is written by the deadline flow only: `kind_locked` entries keep their kind.
 * `reopen_requirements: true` sets the linked covered/verified register rows back to in_progress.
 *
 * ASSUMPTION (slice 4, built concurrently) — the picker of affected rows reads
 *   GET /api/tenders/:id/requirements → { items: [{ id, code, text, … }] }
 * Only `fetchRequirementOptions` below changes if that shape differs.
 */
import { api, type ListResponse } from '@/api/client';
import type { ChangeKind, ChangeSource, DateString, ID, RequirementStatus } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export interface RequirementRef {
  id: ID;
  code: string;
  text: string;
  status?: RequirementStatus;
}

export interface ChangeView {
  id: ID;
  tender_id: ID;
  date: DateString;
  source: ChangeSource;
  kind: ChangeKind;
  description: string;
  reference: string | null;
  owner_user_id: ID | null;
  /** extensions: { oldT, newT } written by the deadline flow */
  payload: Record<string, unknown>;
  kind_locked: boolean;
  requirement_ids: ID[];
  requirements: RequirementRef[];
  /** only on create/update: how many register rows were set back to in_progress */
  reopened?: number;
}

export interface ChangeInput {
  date?: DateString;
  source?: ChangeSource;
  kind?: ChangeKind;
  description?: string;
  reference?: string | null;
  owner_user_id?: ID | null;
  requirement_ids?: ID[];
  reopen_requirements?: boolean;
}

export const changesKeys = {
  list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'changes'] as const,
  requirementOptions: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'changes', 'requirement-options'] as const,
};

export const listChanges = (tenderId: ID) => api.get<ListResponse<ChangeView>>(`/tenders/${tenderId}/changes`).then((r) => r.items);
export const createChange = (tenderId: ID, body: ChangeInput) => api.post<ChangeView>(`/tenders/${tenderId}/changes`, body);
export const updateChange = (tenderId: ID, entryId: ID, body: ChangeInput) => api.patch<ChangeView>(`/tenders/${tenderId}/changes/${entryId}`, body);
export const deleteChange = (tenderId: ID, entryId: ID) => api.del(`/tenders/${tenderId}/changes/${entryId}`);

/** Register rows for the picker; tolerant of a bare array and of extra fields. */
export async function fetchRequirementOptions(tenderId: ID): Promise<RequirementRef[]> {
  const raw = await api.get<ListResponse<RequirementRef> | RequirementRef[]>(`/tenders/${tenderId}/requirements`, { query: { limit: 1000 } });
  const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
  return items
    .filter((r) => r && typeof r.id === 'string' && typeof r.code === 'string')
    .map((r) => ({ id: r.id, code: r.code, text: r.text ?? '', status: r.status }))
    .sort((a, b) => a.code.localeCompare(b.code, 'el', { numeric: true }));
}
