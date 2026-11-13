/**
 * Templates (F2, F10) — contract of server/src/modules/templates/routes.ts.
 *
 *   GET    /api/templates?status=            → { items: TemplateSummary[] }   (non-admins: published only)
 *   POST   /api/templates                    { name, version?, description? } → Template (draft)
 *   GET    /api/templates/:id                → { template, items: Record<kind, TplItem[]> }
 *   PATCH  /api/templates/:id                { name?, version?, description? } (draft only)
 *   DELETE /api/templates/:id                (draft only) → 204
 *   GET    /api/templates/:id/validate       → { ok, problems: Problem[] }
 *   POST   /api/templates/:id/publish        → Template | 422 template_invalid { details.problems }
 *   POST   /api/templates/:id/new-version    { version? } → Template (draft, parent_template_id set)
 *   GET    /api/templates/:id/diff           → TemplateDiff
 *   GET    /api/templates/:id/lessons        → { items: LessonRow[] } applied in this version
 *   GET    /api/templates/lessons/pending    → { items: LessonRow[] }
 *   POST   /api/templates/:id/items          { kind, key?, name, … } → TplItem
 *   PATCH  /api/templates/:id/items/:itemId  → TplItem
 *   DELETE /api/templates/:id/items/:itemId  → 204
 *   POST   /api/templates/:id/items/reorder  { kind, ids } → { items }
 */
import { api, type ListResponse } from '@/api/client';
import type { ID, OffsetUnit, TemplateCondition, TemplateItemKind, TemplateStatus, Timestamp } from '@/api/types';
import type { LessonRow } from '@/features/lessons/lessonsApi';

export interface TemplateRecord {
  id: ID;
  name: string;
  version: string;
  status: TemplateStatus;
  description: string | null;
  parent_template_id: ID | null;
  published_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  parent_name?: string | null;
  parent_version?: string | null;
}

export interface TemplateSummary extends TemplateRecord {
  item_count: number;
  tender_count: number;
}

export interface OffsetValue {
  anchor: string;
  offset_value: number;
  offset_unit: OffsetUnit;
}

export interface TplItem {
  id: ID;
  template_id: ID;
  kind: TemplateItemKind;
  key: string;
  name: string;
  owner_role_key: string | null;
  anchor: string | null;
  offset_value: number | null;
  offset_unit: OffsetUnit | null;
  condition: TemplateCondition;
  sort: number;
  payload: Record<string, unknown>;
}

export type ItemInput = Partial<Omit<TplItem, 'id' | 'template_id'>> & { kind?: TemplateItemKind };
export type GroupedItems = Record<TemplateItemKind, TplItem[]>;

export interface TemplateDetail {
  template: TemplateRecord;
  items: GroupedItems;
}

export interface Problem {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  item_id: ID | null;
  kind: TemplateItemKind | null;
  key: string | null;
  field: string | null;
}

export interface TemplateDiff {
  template: TemplateRecord;
  parent: TemplateRecord | null;
  added: TplItem[];
  removed: TplItem[];
  changed: { kind: TemplateItemKind; key: string; fields: string[]; before: TplItem; after: TplItem }[];
  unchanged: number;
}

export const templateKeys = {
  all: ['templates'] as const,
  list: (status?: TemplateStatus) => ['templates', 'list', status ?? 'all'] as const,
  detail: (id: ID) => ['templates', id] as const,
  record: (id: ID) => ['templates', id, 'record'] as const,
  validate: (id: ID) => ['templates', id, 'validate'] as const,
  diff: (id: ID) => ['templates', id, 'diff'] as const,
  lessons: (id: ID) => ['templates', id, 'lessons'] as const,
  pendingLessons: ['templates', 'lessons', 'pending'] as const,
};

export const listTemplates = (status?: TemplateStatus) =>
  api.get<ListResponse<TemplateSummary>>('/templates', { query: { status } }).then((r) => r.items);
export const getTemplate = (id: ID) => api.get<TemplateDetail>(`/templates/${id}`);
export const createTemplate = (body: { name: string; version?: string; description?: string | null }) => api.post<TemplateRecord>('/templates', body);
export const updateTemplate = (id: ID, body: { name?: string; version?: string; description?: string | null }) =>
  api.patch<TemplateRecord>(`/templates/${id}`, body);
export const deleteTemplate = (id: ID) => api.del<void>(`/templates/${id}`);
export const validateTemplate = (id: ID) => api.get<{ ok: boolean; problems: Problem[] }>(`/templates/${id}/validate`);
export const publishTemplate = (id: ID) => api.post<TemplateRecord>(`/templates/${id}/publish`);
export const newVersion = (id: ID) => api.post<TemplateRecord>(`/templates/${id}/new-version`, {});
export const getDiff = (id: ID) => api.get<TemplateDiff>(`/templates/${id}/diff`);
export const listAppliedLessons = (id: ID) => api.get<ListResponse<LessonRow>>(`/templates/${id}/lessons`).then((r) => r.items);
export const listPendingLessons = () => api.get<ListResponse<LessonRow>>('/templates/lessons/pending').then((r) => r.items);

export const createItem = (templateId: ID, body: ItemInput) => api.post<TplItem>(`/templates/${templateId}/items`, body);
export const updateItem = (templateId: ID, itemId: ID, body: ItemInput) => api.patch<TplItem>(`/templates/${templateId}/items/${itemId}`, body);
export const deleteItem = (templateId: ID, itemId: ID) => api.del<void>(`/templates/${templateId}/items/${itemId}`);
export const reorderItems = (templateId: ID, kind: TemplateItemKind, ids: ID[]) =>
  api.post<ListResponse<TplItem>>(`/templates/${templateId}/items/reorder`, { kind, ids });

/** Kinds that have a date of their own and can be anchors of other items. */
export const ANCHOR_KINDS: TemplateItemKind[] = ['gate', 'milestone', 'handoff'];
