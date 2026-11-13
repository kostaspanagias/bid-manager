// Test-only: a realistic tender (roles, team, schedule, gates, tasks, handoffs, watchlist, register, documents)
// laid out around a given "today", built with the harness and direct inserts. Used by the notification and
// dashboard tests and by scripts that render a sample digest.
import { addWorkingDays, shiftDays } from '../../domain/calendar.js';
import { loadHolidays } from '../../domain/holidays.js';
import { athensToUtc } from '../../domain/time.js';
import { addMember, addRole, createTender, createUser, dbFor, type TestTender, type TestUser } from '../../test/harness.js';

/** Strings that must never show up in an e-mail or on the dashboard. */
export const SECRETS = {
  requirementText: 'SECRET-REQ-TEXT ο ανάδοχος οφείλει να διαθέτει ISO 27001',
  financialFile: 'ΑΠΟΡΡΗΤΟ-τιμοκατάλογος-προσφοράς.xlsx',
  guaranteeAmount: 48500.55,
  budget: 2425027.5,
};

export interface Team {
  admin: TestUser;
  manager: TestUser;
  /** member, role A (participation) */
  alice: TestUser;
  /** member, role B (technical) */
  bob: TestUser;
  /** member, role C (financial) */
  carol: TestUser;
  /** approver, role MGMT */
  boss: TestUser;
  /** viewer, plain member of the tender */
  victor: TestUser;
  /** member of the org, not on the tender */
  outsider: TestUser;
}

export interface Scenario {
  org: { id: string };
  today: string;
  T: string;
  tender: TestTender;
  team: Team;
  dates: Record<'overdue2' | 'overdue1' | 'today' | 'plus1' | 'plus2' | 'plus3' | 'plus4' | 'plus5' | 'far', string>;
  ids: Record<string, string>;
}

export async function createTeam(org: { id: string }): Promise<Team> {
  const mk = (role: Parameters<typeof createUser>[1], name: string) => createUser(org, role, { name });
  return {
    admin: await mk('admin', 'Άννα Διαχειρίστρια'),
    manager: await mk('bid_manager', 'Βασίλης Bid'),
    alice: await mk('member', 'Αλίκη Συμμετοχής'),
    bob: await mk('member', 'Μπάμπης Τεχνικός'),
    carol: await mk('member', 'Κάρολ Οικονομικής'),
    boss: await mk('approver', 'Δήμητρα Διοίκηση'),
    victor: await mk('viewer', 'Βίκτωρ Θεατής'),
    outsider: await mk('member', 'Ξένος Εκτός'),
  };
}

/**
 * T = today + 7 working days (15:00 Athens), T0 = today − 6 working days → 13 working days in total: compressed
 * mode, and fewer than 10 left, with the guarantee not requested yet.
 */
export async function createScenario(org: { id: string }, today: string, opts: { team?: Team; title?: string } = {}): Promise<Scenario> {
  const db = dbFor(org);
  const holidays = await loadHolidays(db);
  const wd = (n: number) => addWorkingDays(today, n, holidays);
  const team = opts.team ?? (await createTeam(org));
  const T = wd(7);
  const dates = { overdue2: wd(-2), overdue1: wd(-1), today, plus1: wd(1), plus2: wd(2), plus3: wd(3), plus4: wd(4), plus5: wd(5), far: wd(10) };

  const tender = await createTender(org, {
    title: opts.title ?? 'Προμήθεια εξοπλισμού πληροφορικής',
    authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης',
    status: 'in_progress',
    t0_published_at: athensToUtc(wd(-6), '10:00'),
    submission_deadline_at: athensToUtc(T, '15:00'),
    compressed_mode: true,
    budget_net: SECRETS.budget,
    guarantee_amount: SECRETS.guaranteeAmount,
    guarantee_valid_until: shiftDays(T, 150), // R16: needs T + 180 + 30
    offer_validity_days: 180,
  });
  await addRole(tender, 'A', { folder: 'participation' }, 'Α Δικαιολογητικά');
  await addRole(tender, 'B', { folder: 'technical' }, 'Β Τεχνική');
  await addRole(tender, 'C', { folder: 'financial', financial: true }, 'Γ Οικονομική');
  await addRole(tender, 'MGMT', { management: true }, 'Διοίκηση');
  await addMember(tender, team.alice, 'A');
  await addMember(tender, team.bob, 'B');
  await addMember(tender, team.carol, 'C');
  await addMember(tender, team.boss, 'MGMT');
  await addMember(tender, team.victor, null);

  const ids: Record<string, string> = {};
  const base = { tender_id: tender.id };

  // Schedule + gates
  const gate = async (key: string, name: string, due: string, sort: number, g: Record<string, unknown>) => {
    const m = await db.insert('milestone', { ...base, key, name, kind: 'gate', due_date: due, sort });
    const row = await db.insert('gate', { ...base, milestone_id: m.id, key, ...g });
    ids[key] = row.id;
  };
  await gate('G0', 'Go/No-Go', wd(-5), 10, { decision_mode: 'go_no_go', approver_user_id: team.boss.id, approver_role_key: 'MGMT', decision: 'go', decided_by: team.boss.id, decided_at: new Date() });
  await gate('G1', 'Solution freeze', dates.plus2, 20, { approver_user_id: team.bob.id, approver_role_key: 'B' });
  await gate('G2', 'Pricing approval', dates.plus3, 30, { approver_user_id: team.boss.id, approver_role_key: 'MGMT', requested_at: new Date(), requested_by: team.manager.id });
  await gate('G3', 'Red team', dates.plus4, 40, { approver_user_id: team.manager.id });
  await gate('G4', 'Final sign-off', dates.plus5, 50, { approver_user_id: team.boss.id, approver_role_key: 'MGMT' });

  // Tasks
  const task = async (name: string, title: string, data: Record<string, unknown>) => {
    ids[name] = (await db.insert('task', { ...base, title, ...data })).id;
  };
  await task('tGuaranteeRequest', 'Αίτηση εγγυητικής και έλεγχος κειμένου', { owner_role_key: 'A', due_date: dates.overdue2, section: 'checklist' });
  await task('tEspd', 'ΕΕΕΣ σε συμφωνία με τα κριτήρια επιλογής', { owner_user_id: team.alice.id, due_date: dates.today });
  await task('tAliceDone', 'Υπεύθυνες δηλώσεις', { owner_user_id: team.alice.id, due_date: dates.overdue1, status: 'done', done_at: new Date() });
  await task('tBom', 'BOM με ακριβείς κωδικούς', { owner_role_key: 'B', due_date: dates.plus2 });
  // direct owner wins over the role: Bob's, not Alice's although the role says A
  await task('tBobDirect', 'Συλλογή datasheets κατασκευαστών', { owner_user_id: team.bob.id, owner_role_key: 'A', due_date: dates.overdue1, status: 'in_progress' });
  await task('tCosting', 'Κοστολόγηση υπηρεσιών και SLA', { owner_role_key: 'C', due_date: dates.far });
  await task('tNoDate', 'Έλεγχος ονοματολογίας αρχείων', { owner_role_key: 'A', section: 'checklist' });
  // Handoffs
  await task('hCertList', 'Λίστα απαιτούμενων πιστοποιητικών, MAF και CVs', {
    section: 'handoff', handoff_from_role: 'B', handoff_to_role: 'A', due_date: dates.overdue1,
  });
  await task('hBom', 'BOM κλειδωμένο (κωδικοί, ποσότητες, vendor quotes)', {
    section: 'handoff', handoff_from_role: 'B', handoff_to_role: 'C', due_date: dates.plus1, status: 'in_progress',
    payload: { delivered_at: new Date().toISOString(), delivered_by: team.bob.id },
  });

  // Watchlist
  const watch = async (name: string, data: Record<string, unknown>) => {
    ids[name] = (await db.insert('watch_item', { ...base, ...data })).id;
  };
  await watch('wGuarantee', { key: 'guarantee', name: 'Εγγυητική συμμετοχής', owner_role_key: 'A', lead_value: 10, lead_unit: 'calendar', needed_at: dates.plus5, needed_milestone_key: 'G4' });
  await watch('wMaf', { key: 'maf', name: 'MAF κατασκευαστή', owner_role_key: 'B', lead_value: 2, lead_unit: 'working', needed_at: dates.plus2 });
  await watch('wQuotes', { key: 'quotes', name: 'Vendor quotes', owner_user_id: team.bob.id, requested_at: dates.overdue2, expected_at: dates.plus1, needed_at: dates.plus2 });
  await watch('wSignatures', { key: 'signatures', name: 'Ψηφιακές υπογραφές νόμιμου εκπροσώπου', owner_role_key: 'A', needed_at: dates.far });

  // Register (text is confidential business content: must never leave the app)
  const req = (code: string, type: string, status: string, extra: Record<string, unknown> = {}) =>
    db.insert('requirement', { ...base, code, type, status, text: `${SECRETS.requirementText} (${code})`, folder: 'technical', ...extra });
  await req('ΥΠ-001', 'exclusion', 'covered', { evidence_ref: 'Παράρτημα Β.3, σελ. 12' });
  await req('ΥΠ-002', 'exclusion', 'open');
  await req('ΥΠ-003', 'scored', 'verified');
  await req('ΥΠ-004', 'formal', 'deviation', { deviation_note: 'Αποφασίζεται στο G3' });
  await req('ΥΠ-005', 'formal', 'in_progress', { folder: 'financial' });

  // Company documents (org level) and the ones this tender uses
  const doc = async (name: string, data: Record<string, unknown>, linked: boolean) => {
    const row = await db.insert('company_document', data);
    ids[name] = row.id;
    if (linked) await db.insert('tender_document', { ...base, company_document_id: row.id });
  };
  await doc('dIso9001', { type: 'iso', title: 'ISO 9001:2015', expires_at: shiftDays(T, -1) }, true); // R15: before T
  await doc('dTax', { type: 'tax', title: 'Φορολογική ενημερότητα', expires_at: shiftDays(T, 5) }, true); // valid on T
  await doc('dIso27001', { type: 'iso', title: 'ISO 27001:2022', expires_at: shiftDays(today, 400) }, true);
  await doc('dInsurance', { type: 'insurance', title: 'Ασφαλιστική ενημερότητα', expires_at: shiftDays(today, -3) }, false); // expired
  await doc('dArchived', { type: 'gemi', title: 'ΓΕΜΗ (παλιό)', expires_at: shiftDays(today, 2), archived_at: new Date() }, false);

  // A financial-offer file: its name is confidential (R18)
  ids.fFinancial = (
    await db.insert('file', { ...base, storage_key: `${org.id}/${tender.id}/financial-1`, filename: SECRETS.financialFile, folder: 'financial', confidentiality: 'financial', size: 1024 })
  ).id;

  return { org, today, T, tender, team, dates, ids };
}

/** Everything a test may grep for a leak: every confidential string of the fixture, in the forms it could appear. */
export function secretStrings(): string[] {
  return [
    'SECRET-REQ-TEXT',
    SECRETS.financialFile,
    'ΑΠΟΡΡΗΤΟ',
    String(SECRETS.guaranteeAmount),
    '48500',
    '48.500',
    String(SECRETS.budget),
    '2425027',
    '2.425.027',
  ];
}
