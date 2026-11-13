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

/** Columns every table has. */
export interface BaseEntity {
  id: ID;
  org_id: ID;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: ID | null;
}

export interface Organization {
  id: ID;
  name: string;
  timezone: string;
  settings?: Json;
  retention_days?: number | null;
}

/** Minimal user as returned by GET /api/users and embedded in other payloads. */
export interface UserRef {
  id: ID;
  name: string;
  email: string;
  org_role: OrgRole;
}

export interface User extends BaseEntity, UserRef {
  active: boolean;
  totp_enabled_at: Timestamp | null;
  last_login_at: Timestamp | null;
}

export interface Invitation extends BaseEntity {
  email: string;
  org_role: OrgRole;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
}

export interface Holiday extends BaseEntity {
  date: DateString;
  name: string;
  source: HolidaySource;
}

export interface Template extends BaseEntity {
  name: string;
  version: string;
  status: TemplateStatus;
  parent_template_id: ID | null;
}

export interface TemplateItem extends BaseEntity {
  template_id: ID;
  kind: TemplateItemKind;
  key: string;
  name: string;
  owner_role_key: string | null;
  /** Signed: anchor 'T' + −8 = T−8; anchor 'T0' + 3 = T0+3; anchor 'G0' + 2 = G0+2. */
  offset_value: number | null;
  offset_unit: OffsetUnit | null;
  /** 'T' | 'T0' | key of another item */
  anchor: string | null;
  condition: TemplateCondition;
  sort: number;
  payload: Json;
}

export interface TenderLot {
  no?: string | number;
  title?: string;
  budget_net?: number | string | null;
  [key: string]: Json | undefined;
}

export interface Tender extends BaseEntity {
  title: string;
  authority: string;
  adam: string | null;
  esidis_no: string | null;
  cpv: string[];
  /** numeric columns arrive as strings from pg unless the server converts them */
  budget_net: number | string | null;
  budget_gross: number | string | null;
  lots: TenderLot[] | null;
  /** T0 */
  t0_published_at: Timestamp | null;
  questions_deadline_at: Timestamp | null;
  /** T (date + time) */
  submission_deadline_at: Timestamp;
  guarantee_amount: number | string | null;
  guarantee_valid_until: DateString | null;
  guarantee_margin_days: number;
  offer_validity_days: number | null;
  has_demo: boolean;
  has_partners: boolean;
  status: TenderStatus;
  compressed_mode: boolean;
  template_id: ID | null;
  template_version: string | null;
  closed_at: Timestamp | null;
}

/** Per-tender snapshot of a template role (e.g. «Δικαιολογητικά», «Τεχνική», «Οικονομική»). */
export interface TenderRole extends BaseEntity {
  tender_id: ID;
  key: string;
  name: string;
  payload: { folder?: RequirementFolder; financial?: boolean; [key: string]: Json | undefined };
}

export interface TenderMember extends BaseEntity {
  tender_id: ID;
  user_id: ID;
  tender_role_key: string | null;
}

export interface Milestone extends BaseEntity {
  tender_id: ID;
  key: string;
  name: string;
  kind: MilestoneKind;
  due_date: DateString;
  computed_from: Json;
  is_manual: boolean;
  needs_review: boolean;
  done_at: Timestamp | null;
  sort: number;
}

export interface Gate extends BaseEntity {
  tender_id: ID;
  milestone_id: ID;
  approver_user_id: ID | null;
  decision: GateDecision;
  justification: string | null;
  decided_by: ID | null;
  decided_at: Timestamp | null;
  requested_at: Timestamp | null;
}

export interface GateCriterion extends BaseEntity {
  gate_id: ID;
  key: string | null;
  text: string;
  type: CriterionType;
  auto_rule: AutoRule | null;
  checked_by: ID | null;
  checked_at: Timestamp | null;
  sort: number;
}

export interface Requirement extends BaseEntity {
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
}

export interface Task extends BaseEntity {
  tender_id: ID;
  milestone_id: ID | null;
  title: string;
  owner_user_id: ID | null;
  owner_role_key: string | null;
  due_date: DateString | null;
  status: TaskStatus;
  section: TaskSection;
  handoff_from_role: string | null;
  handoff_to_role: string | null;
  received_by: ID | null;
  received_at: Timestamp | null;
  done_at: Timestamp | null;
  sort: number;
}

export interface WatchItem extends BaseEntity {
  tender_id: ID;
  name: string;
  owner_user_id: ID | null;
  lead_value: number | null;
  lead_unit: OffsetUnit | null;
  needed_at: DateString | null;
  needed_milestone_key: string | null;
  checks: string | null;
  requested_at: DateString | null;
  expected_at: DateString | null;
  arrived_at: DateString | null;
  notes: string | null;
}

export interface Risk extends BaseEntity {
  tender_id: ID;
  title: string;
  trigger: string | null;
  mitigation: string | null;
  owner_user_id: ID | null;
  status: RiskStatus;
}

export interface ChangeEntry extends BaseEntity {
  tender_id: ID;
  date: DateString;
  source: ChangeSource;
  kind: ChangeKind;
  description: string;
  owner_user_id?: ID | null;
  /** ids of affected register rows (m2m change_entry_requirement), when the endpoint includes them */
  requirement_ids?: ID[];
}

export interface CompanyDocument extends BaseEntity {
  type: CompanyDocumentType;
  title: string;
  file_id: ID | null;
  issued_at: DateString | null;
  expires_at: DateString | null;
  /** for CVs */
  person_name: string | null;
}

export interface TenderDocument extends BaseEntity {
  tender_id: ID;
  company_document_id: ID;
}

export interface FileRecord extends BaseEntity {
  tender_id: ID | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  folder: FileFolder;
  confidentiality: FileConfidentiality;
  uploaded_by: ID | null;
  deleted_at: Timestamp | null;
}

export interface Lesson extends BaseEntity {
  tender_id: ID;
  text: string;
  category: string | null;
  changes_template: boolean;
  applied_in_version: string | null;
}

export interface AuditLogEntry {
  id: ID;
  org_id?: ID;
  user_id: ID | null;
  entity: string;
  entity_id: ID | null;
  action: string;
  before: Record<string, Json> | null;
  after: Record<string, Json> | null;
  at: Timestamp;
}
