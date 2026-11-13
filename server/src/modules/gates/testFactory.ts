// Test-only factory: a tender with the G0–G4 milestones, gates and criteria the tenders slice would create from the
// «L v1.1» template (T = Fri 07/05/2027 → G0 21/04, G1 23/04, G2 29/04, G3 04/05, G4 05/05). Direct inserts only.
import type { Row } from '../../db/scoped.js';
import { addMember, createTender, createUser, dbFor, type TestTender, type TestUser } from '../../test/harness.js';

type CriterionSeed = { key: string; text: string; auto_rule?: string };
const GATES: { key: string; name: string; due: string; mode: 'approval' | 'go_no_go'; role: string; criteria: CriterionSeed[] }[] = [
  {
    key: 'G0', name: 'G0 Go/No-Go', due: '2027-04-21', mode: 'go_no_go', role: 'MGMT',
    criteria: [{ key: 'g0_analysis', text: 'Ανάλυση και cheat sheet έτοιμα' }, { key: 'g0_premortem', text: 'Pre-mortem έγινε' }],
  },
  {
    key: 'G1', name: 'G1 Solution freeze', due: '2027-04-23', mode: 'approval', role: 'B',
    criteria: [
      { key: 'g1_bom', text: 'BOM με ακριβείς κωδικούς' },
      { key: 'g1_exclusion', text: 'Κάθε απαίτηση αποκλεισμού έχει τεκμήριο', auto_rule: 'exclusion_evidence_100' },
      { key: 'g1_handoffs', text: 'Οι παραδόσεις πριν την πύλη παραλήφθηκαν', auto_rule: 'handoffs_received' },
    ],
  },
  { key: 'G2', name: 'G2 Pricing approval', due: '2027-04-29', mode: 'approval', role: 'MGMT', criteria: [{ key: 'g2_costing', text: 'Κοστολόγηση κλειδωμένη' }, { key: 'g2_budget', text: 'Εντός προϋπολογισμού' }] },
  {
    key: 'G3', name: 'G3 Red team', due: '2027-05-04', mode: 'approval', role: 'MGMT',
    criteria: [{ key: 'g3_register', text: 'Requirements register 100%', auto_rule: 'register_no_open' }, { key: 'g3_drafts', text: 'Πλήρη drafts και των τριών φακέλων' }],
  },
  {
    key: 'G4', name: 'G4 Final sign-off', due: '2027-05-05', mode: 'approval', role: 'MGMT',
    criteria: [
      { key: 'g4_guarantee', text: 'Εγγυητική στο χέρι', auto_rule: 'guarantee_arrived' },
      { key: 'g4_docs', text: 'Έγγραφα σε ισχύ την ημέρα υποβολής', auto_rule: 'docs_valid_on_T' },
      { key: 'g4_signed', text: 'Όλα τα αρχεία υπογεγραμμένα' },
    ],
  },
];

export interface GatedTender {
  tender: TestTender;
  /** the approver of every gate (org role `approver`, member of the tender) */
  approver: TestUser;
  gates: Record<string, Row>;
  milestones: Record<string, Row>;
  /** criteria per gate key, in order */
  criteria: Record<string, Row[]>;
  url: (suffix?: string) => string;
}

export async function createGatedTender(org: { id: string }, overrides: Row = {}): Promise<GatedTender> {
  const db = dbFor(org);
  const tender = await createTender(org, { submission_deadline_at: '2027-05-07T12:00:00Z', t0_published_at: '2027-04-05T08:00:00Z', ...overrides });
  const approver = await createUser(org, 'approver');
  await addMember(tender, approver, 'MGMT');
  const out: GatedTender = { tender, approver, gates: {}, milestones: {}, criteria: {}, url: (suffix = '') => `/api/tenders/${tender.id}/gates${suffix}` };
  for (const [i, g] of GATES.entries()) {
    const milestone = await db.insert('milestone', { tender_id: tender.id, key: g.key, name: g.name, kind: 'gate', due_date: g.due, sort: i });
    const gate = await db.insert('gate', {
      tender_id: tender.id, milestone_id: milestone.id, key: g.key, decision_mode: g.mode, approver_role_key: g.role, approver_user_id: approver.id,
    });
    out.milestones[g.key] = milestone;
    out.gates[g.key] = gate;
    out.criteria[g.key] = await db.insertMany(
      'gate_criterion',
      g.criteria.map((c, sort) => ({
        tender_id: tender.id, gate_id: gate.id, key: c.key, text: c.text, type: c.auto_rule ? 'auto' : 'manual', auto_rule: c.auto_rule ?? null, sort,
      })),
    );
  }
  return out;
}

export const addRequirement = (tender: TestTender, code: string, data: Row = {}): Promise<Row> =>
  dbFor({ id: tender.org_id }).insert('requirement', { tender_id: tender.id, code, text: code, type: 'exclusion', status: 'covered', ...data });

export const addHandoff = (tender: TestTender, title: string, data: Row = {}): Promise<Row> =>
  dbFor({ id: tender.org_id }).insert('task', { tender_id: tender.id, title, section: 'handoff', due_date: '2027-04-22', ...data });

export const addTask = (tender: TestTender, title: string, data: Row = {}): Promise<Row> =>
  dbFor({ id: tender.org_id }).insert('task', { tender_id: tender.id, title, ...data });

export const addWatchItem = (tender: TestTender, key: string | null, data: Row = {}): Promise<Row> =>
  dbFor({ id: tender.org_id }).insert('watch_item', { tender_id: tender.id, key, name: key === 'guarantee' ? 'Εγγυητική συμμετοχής' : 'MAF', ...data });

/** A company document linked to the tender. */
export async function linkDocument(tender: TestTender, title: string, expiresAt: string | null): Promise<Row> {
  const db = dbFor({ id: tender.org_id });
  const doc = await db.insert('company_document', { type: 'iso', title, expires_at: expiresAt });
  await db.insert('tender_document', { tender_id: tender.id, company_document_id: doc.id });
  return doc;
}
