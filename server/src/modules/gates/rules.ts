// R13 — the automatic gate criteria. Each rule is a pure function over rows of the tender; `evaluateAutoRules`
// loads only the rows the requested rules need (through the scoped data layer) and runs them.
import type { Row, ScopedDb } from '../../db/scoped.js';
import { athensDate } from '../../domain/time.js';
import { expiredOnT } from '../../domain/validity.js';

export const AUTO_RULES = ['exclusion_evidence_100', 'register_no_open', 'handoffs_received', 'guarantee_arrived', 'docs_valid_on_T'] as const;
export type AutoRule = (typeof AUTO_RULES)[number];

/** Why a rule is (not) satisfied. `code` is what the web translates; `message` is the English fallback. */
export interface RuleDetail {
  code: string;
  message: string;
  /** Rows the rule looked at. */
  total: number;
  /** Rows that fail the rule (0 when satisfied). */
  missing: number;
  /** A few codes/names of the failing rows (at most `MAX_ITEMS`). */
  items: string[];
}
export interface RuleResult {
  satisfied: boolean;
  detail: RuleDetail;
}

export const MAX_ITEMS = 5;

const result = (satisfied: boolean, code: string, message: string, total: number, failing: readonly string[] = []): RuleResult => ({
  satisfied,
  detail: { code, message, total, missing: failing.length, items: failing.slice(0, MAX_ITEMS) },
});
const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';

export interface RequirementLike {
  code: string;
  type: string;
  status: string;
  evidence_ref: string | null;
}

/**
 * G1 — every requirement of type `exclusion` has a non-blank `evidence_ref`.
 * A register without any exclusion requirement is NOT satisfied: an empty register proves nothing.
 */
export function exclusionEvidence100(requirements: readonly RequirementLike[]): RuleResult {
  const exclusion = requirements.filter((r) => r.type === 'exclusion');
  if (exclusion.length === 0) {
    return result(false, 'exclusion_none', 'The register has no exclusion requirements yet — an empty register proves nothing', 0);
  }
  const failing = exclusion.filter((r) => blank(r.evidence_ref)).map((r) => r.code);
  return failing.length === 0
    ? result(true, 'exclusion_all_evidenced', `All ${exclusion.length} exclusion requirements have evidence`, exclusion.length)
    : result(false, 'exclusion_missing_evidence', `${failing.length} of ${exclusion.length} exclusion requirements have no evidence`, exclusion.length, failing);
}

/** G3 — no requirement is `open` or `in_progress`. An empty register satisfies the rule literally (flagged in the detail). */
export function registerNoOpen(requirements: readonly RequirementLike[]): RuleResult {
  if (requirements.length === 0) return result(true, 'register_empty', 'The register has no requirements', 0);
  const failing = requirements.filter((r) => r.status === 'open' || r.status === 'in_progress').map((r) => r.code);
  return failing.length === 0
    ? result(true, 'register_all_closed', `None of the ${requirements.length} requirements is open or in progress`, requirements.length)
    : result(false, 'register_open_rows', `${failing.length} of ${requirements.length} requirements are still open or in progress`, requirements.length, failing);
}

export interface HandoffLike {
  title: string;
  key?: string | null;
  section: string;
  status: string;
  due_date: string | null;
  received_at: Date | string | null;
}

/**
 * Every handoff task with `due_date` ≤ the gate's date and status not in (na, cancelled) has `received_at`.
 * Handoffs without a due date are not "before the gate" and are ignored; a gate without a date cannot be evaluated.
 */
export function handoffsReceived(tasks: readonly HandoffLike[], gateDate: string | null): RuleResult {
  if (!gateDate) return result(false, 'gate_no_date', 'The gate has no date, so the handoffs due before it cannot be determined', 0);
  const due = tasks.filter(
    (t) => t.section === 'handoff' && t.status !== 'na' && t.status !== 'cancelled' && t.due_date !== null && t.due_date <= gateDate,
  );
  if (due.length === 0) return result(true, 'handoffs_none_due', 'No handoff is due up to this gate', 0);
  const failing = due.filter((t) => t.received_at === null || t.received_at === undefined).map((t) => t.title);
  return failing.length === 0
    ? result(true, 'handoffs_all_received', `All ${due.length} handoffs due up to this gate have been received`, due.length)
    : result(false, 'handoffs_pending', `${failing.length} of ${due.length} handoffs due up to this gate have not been received`, due.length, failing);
}

export interface WatchLike {
  key: string | null;
  name: string;
  arrived_at: string | null;
}

/** G4 — the watch item with key `guarantee` has `arrived_at`. No such item → not satisfied. */
export function guaranteeArrived(watchItems: readonly WatchLike[]): RuleResult {
  const guarantees = watchItems.filter((w) => w.key === 'guarantee');
  if (guarantees.length === 0) return result(false, 'guarantee_missing', 'The watchlist has no item with key "guarantee"', 0);
  const failing = guarantees.filter((w) => !w.arrived_at).map((w) => w.name);
  return failing.length === 0
    ? result(true, 'guarantee_arrived', 'The participation guarantee has arrived', guarantees.length)
    : result(false, 'guarantee_not_arrived', 'The participation guarantee has not arrived yet', guarantees.length, failing);
}

export interface DocLike {
  title: string;
  expires_at: string | null;
}

/** G4 / R15 — no company document linked to the tender expires before T (expiring on T itself is still valid). */
export function docsValidOnT(linkedDocs: readonly DocLike[], T: string): RuleResult {
  if (linkedDocs.length === 0) return result(true, 'docs_none_linked', 'No company documents are linked to the tender', 0);
  const failing = expiredOnT(linkedDocs, T).map((d) => d.title);
  return failing.length === 0
    ? result(true, 'docs_all_valid', `All ${linkedDocs.length} linked documents are valid on the submission date`, linkedDocs.length)
    : result(false, 'docs_expired', `${failing.length} of ${linkedDocs.length} linked documents expire before the submission date`, linkedDocs.length, failing);
}

/** The rows of a tender the rules read. Each list is loaded only when a rule that needs it is requested. */
export interface RuleData {
  requirements: RequirementLike[];
  handoffs: HandoffLike[];
  watchItems: WatchLike[];
  linkedDocs: DocLike[];
  T: string;
}

export async function loadRuleData(db: ScopedDb, tender: Row, rules: ReadonlySet<string>): Promise<RuleData> {
  const tenderId = String(tender.id);
  const needsRegister = rules.has('exclusion_evidence_100') || rules.has('register_no_open');
  // Sequential on purpose: inside a transaction all queries share one connection.
  const requirements = needsRegister ? await db.list<RequirementLike>('requirement', { tender_id: tenderId }, { orderBy: 'sort, code' }) : [];
  const handoffs = rules.has('handoffs_received')
    ? await db.list<HandoffLike>('task', { tender_id: tenderId, section: 'handoff' }, { orderBy: 'due_date nulls last, sort' })
    : [];
  const watchItems = rules.has('guarantee_arrived') ? await db.list<WatchLike>('watch_item', { tender_id: tenderId, key: 'guarantee' }) : [];
  const linkedDocs = rules.has('docs_valid_on_T')
    ? await db.sql<DocLike>(
        `SELECT d.title, d.expires_at
           FROM tender_document td
           JOIN company_document d ON d.id = td.company_document_id AND d.org_id = td.org_id
          WHERE td.org_id = :org_id AND td.tender_id = :tender_id
          ORDER BY d.expires_at NULLS LAST, d.title`,
        { tender_id: tenderId },
      )
    : [];
  return { requirements, handoffs, watchItems, linkedDocs, T: athensDate(tender.submission_deadline_at) };
}

/** Runs one rule on already loaded data. `gateDate` is the due date of the gate's milestone. */
export function evaluateRule(rule: string, data: RuleData, gateDate: string | null): RuleResult {
  switch (rule as AutoRule) {
    case 'exclusion_evidence_100':
      return exclusionEvidence100(data.requirements);
    case 'register_no_open':
      return registerNoOpen(data.requirements);
    case 'handoffs_received':
      return handoffsReceived(data.handoffs, gateDate);
    case 'guarantee_arrived':
      return guaranteeArrived(data.watchItems);
    case 'docs_valid_on_T':
      return docsValidOnT(data.linkedDocs, data.T);
    default:
      return result(false, 'unknown_rule', `Unknown automatic rule "${rule}"`, 0);
  }
}
