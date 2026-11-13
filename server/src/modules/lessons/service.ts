// Shared by the lessons router and the template routes (pending lessons): one joined view of a lesson.
import type { Row } from '../../db/scoped.js';

/** Categories follow the review questions of the blueprint ("Κλείσιμο και βελτίωση"). */
export const LESSON_CATEGORIES = ['delay', 'near_miss', 'went_well', 'other'] as const;

/** FROM clause with the tender (title, the template version it used) and the author; add WHERE … l.org_id = :org_id. */
export const LESSON_SELECT = `
  SELECT l.*, t.title AS tender_title, t.status AS tender_status, t.template_id AS tender_template_id,
         t.template_version AS tender_template_version, tp.name AS tender_template_name, u.name AS created_by_name
    FROM lesson l
    JOIN tender t ON t.id = l.tender_id AND t.org_id = l.org_id
    LEFT JOIN template tp ON tp.id = t.template_id AND tp.org_id = l.org_id
    LEFT JOIN "user" u ON u.id = l.created_by AND u.org_id = l.org_id`;

export function lessonView(l: Row) {
  return {
    id: l.id,
    tender_id: l.tender_id,
    text: l.text,
    category: l.category ?? null,
    changes_template: l.changes_template,
    applied_in_version: l.applied_in_version ?? null,
    applied_template_id: l.applied_template_id ?? null,
    created_by: l.created_by ?? null,
    created_by_name: l.created_by_name ?? null,
    created_at: l.created_at,
    updated_at: l.updated_at,
    tender_title: l.tender_title ?? null,
    tender_status: l.tender_status ?? null,
    tender_template_id: l.tender_template_id ?? null,
    tender_template_name: l.tender_template_name ?? null,
    tender_template_version: l.tender_template_version ?? null,
  };
}
