/**
 * Lessons learned (F10) — contract of server/src/modules/lessons/routes.ts.
 *
 *   GET    /api/tenders/:tenderId/lessons            → { items: LessonRow[] }
 *   POST   /api/tenders/:tenderId/lessons            { text, category?, changes_template? } → LessonRow
 *   PATCH  /api/tenders/:tenderId/lessons/:id        { text?, category?, changes_template? } → LessonRow
 *   DELETE /api/tenders/:tenderId/lessons/:id        → 204
 *   POST   /api/tenders/:tenderId/lessons/:id/apply  { template_id } → LessonRow   (admin)
 *   DELETE /api/tenders/:tenderId/lessons/:id/apply  → LessonRow (pending again)   (admin)
 */
import { api, type ListResponse } from '@/api/client';
import type { ID, TenderStatus, Timestamp } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export const LESSON_CATEGORIES = ['delay', 'near_miss', 'went_well', 'other'] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

export interface LessonRow {
  id: ID;
  tender_id: ID;
  text: string;
  category: LessonCategory | null;
  changes_template: boolean;
  applied_in_version: string | null;
  applied_template_id: ID | null;
  created_by: ID | null;
  created_by_name: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  tender_title: string | null;
  tender_status: TenderStatus | null;
  tender_template_id: ID | null;
  tender_template_name: string | null;
  tender_template_version: string | null;
}

export interface LessonInput {
  text?: string;
  category?: LessonCategory | null;
  changes_template?: boolean;
}

export const lessonsKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'lessons'] as const };

export const listLessons = (tenderId: ID) => api.get<ListResponse<LessonRow>>(`/tenders/${tenderId}/lessons`).then((r) => r.items);
export const createLesson = (tenderId: ID, body: LessonInput) => api.post<LessonRow>(`/tenders/${tenderId}/lessons`, body);
export const updateLesson = (tenderId: ID, id: ID, body: LessonInput) => api.patch<LessonRow>(`/tenders/${tenderId}/lessons/${id}`, body);
export const deleteLesson = (tenderId: ID, id: ID) => api.del<void>(`/tenders/${tenderId}/lessons/${id}`);
export const applyLesson = (tenderId: ID, id: ID, templateId: ID) => api.post<LessonRow>(`/tenders/${tenderId}/lessons/${id}/apply`, { template_id: templateId });
export const unapplyLesson = (tenderId: ID, id: ID) => api.del<LessonRow>(`/tenders/${tenderId}/lessons/${id}/apply`);
