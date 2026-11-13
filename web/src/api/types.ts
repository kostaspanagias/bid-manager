/**
 * Entity types mirroring the spec's data model (docs/spec.md) and ARCHITECTURE.md.
 * Field names are the DB column names (snake_case); enum values are the English snake_case values —
 * Greek labels come from i18n (`common:enums.*`, see src/lib/enums.ts).
 *
 * Pure dates travel as 'YYYY-MM-DD' strings, timestamps as ISO-8601 UTC strings.
 * Feature-specific response shapes (joined rows, computed fields) belong in the feature's own *Api.ts.
 */

export type ID = string;
/** 'YYYY-MM-DD' */
export type DateString = string;
/** ISO-8601 UTC timestamp */
export type Timestamp = string;
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/* ------------------------------------------------------------------ enums */

export const ORG_ROLES = ['admin', 'bid_manager', 'member', 'approver', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const TENDER_STATUSES = ['evaluation', 'in_progress', 'submitted', 'no_go', 'cancelled'] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

export const HOLIDAY_SOURCES = ['national', 'movable', 'manual'] as const;
export type HolidaySource = (typeof HOLIDAY_SOURCES)[number];

export const TEMPLATE_STATUSES = ['draft', 'published'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_ITEM_KINDS = [
  'role',
  'gate',
  'milestone',
  'task',
  'handoff',
  'checklist_item',
  'watch_item',
  'gate_criterion',
] as const;
export type TemplateItemKind = (typeof TEMPLATE_ITEM_KINDS)[number];

export const OFFSET_UNITS = ['working', 'calendar'] as const;
export type OffsetUnit = (typeof OFFSET_UNITS)[number];

export const TEMPLATE_CONDITIONS = ['always', 'demo', 'partners'] as const;
export type TemplateCondition = (typeof TEMPLATE_CONDITIONS)[number];

export const MILESTONE_KINDS = ['gate', 'milestone', 'handoff'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export const GATE_DECISIONS = ['pending', 'approved', 'approved_with_exception', 'rejected', 'go', 'no_go'] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

export const CRITERION_TYPES = ['manual', 'auto'] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];

export const AUTO_RULES = [
  'exclusion_evidence_100',
  'register_no_open',
  'handoffs_received',
  'guarantee_arrived',
  'docs_valid_on_T',
] as const;
export type AutoRule = (typeof AUTO_RULES)[number];

export const REQUIREMENT_TYPES = ['exclusion', 'scored', 'formal'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export const REQUIREMENT_FOLDERS = ['participation', 'technical', 'financial'] as const;
export type RequirementFolder = (typeof REQUIREMENT_FOLDERS)[number];

export const FILE_FOLDERS = ['participation', 'technical', 'financial', 'tender_docs', 'clarifications', 'other'] as const;
export type FileFolder = (typeof FILE_FOLDERS)[number];

export const REQUIREMENT_STATUSES = ['open', 'in_progress', 'covered', 'verified', 'deviation'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'na', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SECTIONS = ['task', 'checklist', 'handoff'] as const;
export type TaskSection = (typeof TASK_SECTIONS)[number];

export const RISK_STATUSES = ['open', 'mitigating', 'occurred', 'closed'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const CHANGE_SOURCES = ['adam', 'esidis', 'email', 'other'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const CHANGE_KINDS = ['clarification', 'amendment', 'extension'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const COMPANY_DOCUMENT_TYPES = ['iso', 'gemi', 'tax', 'insurance', 'cv', 'reference_project', 'other'] as const;
export type CompanyDocumentType = (typeof COMPANY_DOCUMENT_TYPES)[number];

export const FILE_CONFIDENTIALITIES = ['normal', 'financial'] as const;
export type FileConfidentiality = (typeof FILE_CONFIDENTIALITIES)[number];

/* --------------------------------------------------------------- entities */
//
// Only the entities that several features share, exactly as the server sends them. Everything else — templates and
// their items, gates and criteria, milestones, tasks, watch items, risks, files, company documents, lessons, team —
// is typed next to the endpoint that returns it, in the feature's own *Api.ts (the server returns joined/computed
// views there, not table rows).

/** Minimal user as returned by GET /api/users and embedded in other payloads. */
export interface UserRef {
  id: ID;
  name: string;
  email: string;
  org_role: OrgRole;
}

/** GET /api/admin/invitations item (the token is never returned after creation). */
export interface Invitation {
  id: ID;
  email: string;
  org_role: OrgRole;
  status: 'pending' | 'accepted' | 'expired';
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  created_at: Timestamp;
}

/** GET /api/holidays item. */
export interface Holiday {
  id: ID;
  date: DateString;
  name: string;
  source: HolidaySource;
}

export interface TenderLot {
  no?: string | number | null;
  title: string;
  budget_net?: number | null;
  budget_gross?: number | null;
}

/**
 * The tender record as sent by /api/tenders (server: tenders/service.ts `tenderView`): every column except the
 * template snapshot, plus `template_name`. Numeric columns arrive as JS numbers.
 */
export interface Tender {
  id: ID;
  org_id: ID;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: ID | null;
  title: string;
  authority: string;
  adam: string | null;
  esidis_no: string | null;
  cpv: string[];
  budget_net: number | null;
  budget_gross: number | null;
  lots: TenderLot[] | null;
  /** T0 */
  t0_published_at: Timestamp | null;
  questions_deadline_at: Timestamp | null;
  /** T (date + time) */
  submission_deadline_at: Timestamp;
  guarantee_amount: number | null;
  guarantee_valid_until: DateString | null;
  guarantee_margin_days: number;
  offer_validity_days: number | null;
  has_demo: boolean;
  has_partners: boolean;
  status: TenderStatus;
  compressed_mode: boolean;
  notes: string | null;
  template_id: ID | null;
  template_version: string | null;
  /** name of the template the tender was created from (from its snapshot) */
  template_name: string | null;
  closed_at: Timestamp | null;
}

/** A register row as stored (GET …/requirements adds owner role and linked changes — see requirementsApi.ts). */
export interface Requirement {
  id: ID;
  tender_id: ID;
  /** ΥΠ-nnn, unique per tender */
  code: string;
  source_ref: string | null;
  text: string;
  type: RequirementType;
  folder: RequirementFolder;
  weight: string | null;
  owner_user_id: ID | null;
  response_ref: string | null;
  evidence_ref: string | null;
  status: RequirementStatus;
  deviation_note: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A change-log entry as returned by the change log and by the deadline flow (kind `extension`). */
export interface ChangeEntry {
  id: ID;
  tender_id: ID;
  date: DateString;
  source: ChangeSource;
  kind: ChangeKind;
  description: string;
  reference?: string | null;
  owner_user_id?: ID | null;
}

export interface AuditLogEntry {
  id: ID;
  user_id: ID | null;
  entity: string;
  entity_id: ID | null;
  action: string;
  before: Record<string, Json> | null;
  after: Record<string, Json> | null;
  at: Timestamp;
}
