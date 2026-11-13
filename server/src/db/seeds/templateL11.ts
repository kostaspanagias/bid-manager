// Template «L v1.1» — the content of docs/blueprint.md as data (spec F2, R7, R13). Roles, gates, exit criteria,
// offsets, handoffs, checklists and the watchlist live here and in the database, never in application code.
import type { Row, ScopedDb } from '../scoped.js';

export const TEMPLATE_L_NAME = 'L';
export const TEMPLATE_L_VERSION = 'v1.1';

type Unit = 'working' | 'calendar';
type Condition = 'always' | 'demo' | 'partners';
interface Offset {
  anchor: string;
  offset_value: number;
  offset_unit: Unit;
}
export interface SeedItem {
  kind: 'role' | 'gate' | 'gate_criterion' | 'milestone' | 'handoff' | 'task' | 'checklist_item' | 'watch_item';
  key: string;
  name: string;
  owner_role_key?: string | null;
  anchor?: string | null;
  offset_value?: number | null;
  offset_unit?: Unit | null;
  condition?: Condition;
  payload?: Record<string, unknown>;
}

const wd = (anchor: string, offset_value: number): Offset => ({ anchor, offset_value, offset_unit: 'working' });

const roles: SeedItem[] = [
  { kind: 'role', key: 'A', name: 'Α — Δικαιολογητικά συμμετοχής', payload: { folder: 'participation', deliverables: 'ΕΕΕΣ/ΤΕΥΔ, εγγυητική συμμετοχής, πιστοποιητικά, δηλώσεις, έγγραφα εταίρων' } },
  { kind: 'role', key: 'B', name: 'Β — Τεχνική προσφορά', payload: { folder: 'technical', deliverables: 'Λύση, BOM, φύλλο συμμόρφωσης, τεχνική περιγραφή, MAF, demo' } },
  { kind: 'role', key: 'C', name: 'Γ — Οικονομική προσφορά', payload: { folder: 'financial', financial: true, deliverables: 'Κοστολόγηση, τιμολόγιο, ηλεκτρονικό έντυπο οικονομικής στο ΕΣΗΔΗΣ' } },
  { kind: 'role', key: 'MGMT', name: 'Διοίκηση', payload: { management: true, deliverables: 'Αποφάσεις Go/No-Go και τιμής, ψηφιακές υπογραφές νόμιμου εκπροσώπου' } },
];

// R7: G0 target T0+3, latest T−10 (warn when the target is after T−12) · G1 T−8 · G2 T−4 · G3 T−3 · G4 T−2.
// R8: in compressed mode G1 and G2 merge at T−5.
const gates: SeedItem[] = [
  {
    kind: 'gate',
    key: 'G0',
    name: 'G0 Go/No-Go',
    owner_role_key: 'MGMT',
    ...wd('T', -10),
    payload: { decision_mode: 'go_no_go', target: wd('T0', 3), warn_if_target_after: wd('T', -12) },
  },
  { kind: 'gate', key: 'G1', name: 'G1 Solution freeze', owner_role_key: 'B', ...wd('T', -8), payload: { decision_mode: 'approval', compressed: wd('T', -5) } },
  { kind: 'gate', key: 'G2', name: 'G2 Pricing approval', owner_role_key: 'MGMT', ...wd('T', -4), payload: { decision_mode: 'approval', compressed: wd('T', -5) } },
  {
    kind: 'gate',
    key: 'G3',
    name: 'G3 Red team',
    owner_role_key: 'B',
    ...wd('T', -3),
    payload: { decision_mode: 'approval', note: 'Αποφασίζουν όλοι (ανεξάρτητος reviewer ή agent)· συντονίζει ο Β. Σε συμπιεσμένο mode ελέγχονται μόνο οι απαιτήσεις αποκλεισμού.' },
  },
  { kind: 'gate', key: 'G4', name: 'G4 Final sign-off', owner_role_key: 'MGMT', ...wd('T', -2), payload: { decision_mode: 'approval', note: 'Εισήγηση του bid manager.' } },
];

const manual = (gate_key: string, n: number, name: string, condition: Condition = 'always'): SeedItem => ({
  kind: 'gate_criterion',
  key: `${gate_key}-${n}`,
  name,
  condition,
  payload: { gate_key, type: 'manual' },
});
const auto = (gate_key: string, n: number, name: string, auto_rule: string): SeedItem => ({
  kind: 'gate_criterion',
  key: `${gate_key}-${n}`,
  name,
  payload: { gate_key, type: 'auto', auto_rule },
});

const criteria: SeedItem[] = [
  manual('G0', 1, 'Ανάλυση διακήρυξης και cheat sheet έτοιμα'),
  manual('G0', 2, 'Τα κριτήρια επιλογής καλύπτονται (με ή χωρίς εταίρους)'),
  manual('G0', 3, 'Οι απαιτήσεις αποκλεισμού έχουν πιθανή λύση'),
  manual('G0', 4, 'Το pre-mortem έγινε'),
  manual('G0', 5, 'Υπάρχει εκτίμηση κόστους και περιθωρίου'),
  manual('G0', 6, 'Άμεση αίτηση εγγυητικής συμμετοχής από τον Α'),

  manual('G1', 1, 'BOM με ακριβείς κωδικούς'),
  auto('G1', 2, 'Κάθε απαίτηση αποκλεισμού έχει λύση και τεκμήριο', 'exclusion_evidence_100'),
  manual('G1', 3, 'Τα vendor quotes παραλήφθηκαν'),
  manual('G1', 4, 'Τα MAF παραλήφθηκαν ή έχουν επιβεβαιωμένη ημερομηνία'),
  auto('G1', 5, 'Το BOM παραδόθηκε στον Γ — όλες οι παραδόσεις έως την πύλη έχουν παραληφθεί', 'handoffs_received'),

  manual('G2', 1, 'Η κοστολόγηση είναι κλειδωμένη'),
  manual('G2', 2, 'Κάθε γραμμή του BOM έχει τιμή και αντίστροφα'),
  manual('G2', 3, 'Έγινε έλεγχος ασυνήθιστα χαμηλής τιμής και υπάρχουν τα αρχεία στήριξης'),
  manual('G2', 4, 'Η τιμή είναι εντός προϋπολογισμού και ανώτατης τιμής ανά τμήμα'),

  manual('G3', 1, 'Πλήρη drafts και των τριών φακέλων'),
  auto('G3', 2, 'Requirements register 100% — καμία γραμμή «Ανοιχτή» ή «Σε εξέλιξη»', 'register_no_open'),
  manual('G3', 3, 'Cross-check 1/6: κωδικοί, ποσότητες και περιγραφές του BOM της τεχνικής ταυτίζονται με τις γραμμές της οικονομικής'),
  manual('G3', 4, 'Cross-check 2/6: η ομάδα έργου της τεχνικής ταυτίζεται με ΕΕΕΣ, CVs και δηλώσεις διάθεσης'),
  manual('G3', 5, 'Cross-check 3/6: εμπειρία και έργα αναφοράς της τεχνικής ταυτίζονται με τα κριτήρια επιλογής του ΕΕΕΣ και με δημόσιες πηγές (ΓΕΜΗ, ημερομηνίες ίδρυσης)'),
  manual('G3', 6, 'Cross-check 4/6: εταίροι και υπεργολάβοι είναι ίδιοι σε ΕΕΕΣ, τεχνική και οικονομική'),
  manual('G3', 7, 'Cross-check 5/6: χρόνοι παράδοσης, εγγύηση και SLA της τεχνικής έχουν κοστολογηθεί στην οικονομική'),
  manual('G3', 8, 'Cross-check 6/6: καμία τιμή στον τεχνικό φάκελο ή στα συνημμένα του· τα συνημμένα της οικονομικής ταυτίζονται με το ηλεκτρονικό έντυπο του ΕΣΗΔΗΣ'),
  manual('G3', 9, 'Κανένα ανοιχτό εύρημα αποκλεισμού'),

  manual('G4', 1, 'Τα ευρήματα του G3 είναι κλεισμένα'),
  auto('G4', 2, 'Η εγγυητική συμμετοχής είναι στο χέρι και ελεγμένη', 'guarantee_arrived'),
  auto('G4', 3, 'Τα συνδεδεμένα πιστοποιητικά και έγγραφα ισχύουν την ημέρα υποβολής', 'docs_valid_on_T'),
  manual('G4', 4, 'Όλα τα αρχεία είναι υπογεγραμμένα και με σωστή ονοματολογία'),
  manual('G4', 5, 'Έγινε έλεγχος μεγέθους αρχείων για το ΕΣΗΔΗΣ'),
  manual('G4', 6, 'Το ανέβασμα είναι προγραμματισμένο για την T−1, ποτέ την τελευταία μέρα'),
];

const milestones: SeedItem[] = [{ kind: 'milestone', key: 'UPLOAD', name: 'Ανέβασμα στο ΕΣΗΔΗΣ', ...wd('T', -1) }];

const handoff = (key: string, from_role: string, to_role: string, name: string, at: Offset, note?: string): SeedItem => ({
  kind: 'handoff',
  key,
  name,
  ...at,
  payload: { from_role, to_role, ...(note ? { note } : {}) },
});

const handoffs: SeedItem[] = [
  handoff('H1', 'B', 'A', 'Λίστα απαιτούμενων πιστοποιητικών, MAF, CVs και δηλώσεων μελών ομάδας έργου', wd('G0', 2)),
  handoff('H2', 'A', 'B', 'Πιστοποιητικά εταιρείας (ISO κ.λπ.), έργα αναφοράς, στοιχεία εταίρων', wd('G0', 3)),
  handoff('H3', 'B', 'C', 'BOM κλειδωμένο (κωδικοί, ποσότητες, vendor quotes, υπηρεσίες)', wd('G1', 0)),
  handoff('H4', 'C', 'B', 'Εναλλακτικές που αλλάζουν το κόστος σημαντικά', wd('T', -9), 'Πριν το freeze (έως T−9).'),
  handoff('H5', 'A', 'C', 'Σχήμα συμμετοχής και ποσοστά εταίρων/υπεργολάβων', wd('G0', 3)),
];

const task = (key: string, owner: string, name: string, description: string, at: Offset | null, condition: Condition = 'always'): SeedItem => ({
  kind: 'task',
  key,
  name,
  owner_role_key: owner,
  ...(at ?? {}),
  condition,
  payload: { description },
});

// The work packages of the blueprint as dated tasks (WP0 is the schedule itself).
const tasks: SeedItem[] = [
  task('WP1', 'B', 'WP1 Ανάλυση & Go/No-Go', 'Αποδόμηση διακήρυξης, κριτήρια επιλογής/ανάθεσης, ανταγωνισμός, pre-mortem. Παραδοτέα: ανάλυση, cheat sheet, σημείωμα G0.', wd('G0', 0)),
  task('WP2', 'B', 'WP2 Ερωτήματα διευκρίνισης', 'Ασάφειες, φωτογραφικές απαιτήσεις, ενσωμάτωση απαντήσεων (Α/Β/Γ ανά θέμα). Αποστολή πριν την προθεσμία ερωτημάτων. Παραδοτέα: λίστα ερωτημάτων, change log.', null),
  task('WP3', 'B', 'WP3 Λύση & BOM', 'Αρχιτεκτονική, κωδικοί, vendor quotes, MAF. Παραδοτέο: BOM (freeze στο G1).', wd('G1', 0)),
  task('WP4', 'A', 'WP4 Εταίροι & due diligence', 'Ένωση ή στήριξη σε ικανότητα, συμφωνητικά, ΕΕΕΣ εταίρων, έλεγχος ισχυρισμών σε ΓΕΜΗ. Παραδοτέα: φάκελος εταίρων, due diligence.', wd('G1', 0), 'partners'),
  task('WP5', 'A', 'WP5 Δικαιολογητικά συμμετοχής', 'ΕΕΕΣ/ΤΕΥΔ, εγγυητική, πιστοποιητικά, δηλώσεις. Παραδοτέο: φάκελος συμμετοχής.', wd('G3', 0)),
  task('WP6', 'B', 'WP6 Τεχνική προσφορά', 'Φύλλο συμμόρφωσης, τεχνική περιγραφή, μεθοδολογία, ομάδα έργου, παραρτήματα. Παραδοτέο: φάκελος τεχνικής.', wd('G3', 0)),
  task('WP7', 'C', 'WP7 Οικονομική προσφορά', 'Κοστολόγηση, περιθώριο, έλεγχος ασυνήθιστα χαμηλής, τιμολόγιο. Παραδοτέο: φάκελος οικονομικής.', wd('G2', 0)),
  task('WP8', 'B', 'WP8 Demo / δείγματα', 'Προμήθεια, στήσιμο, δοκιμή λειτουργίας, αξεσουάρ, αποστολή. Παραδοτέο: δοκιμασμένη μονάδα + απόδειξη παράδοσης.', wd('G3', 0), 'demo'),
  task('WP9', 'B', 'WP9 Έλεγχος (cross-checks, red team)', 'Cross-checks φακέλων και red team από όλους. Παραδοτέο: review report.', wd('G3', 0)),
  task('WP10', 'A', 'WP10 Υποβολή', 'Υπογραφές, ονοματολογία, upload στο ΕΣΗΔΗΣ. Παραδοτέο: αποδεικτικό υποβολής.', wd('UPLOAD', 0)),
  task('WP11', 'B', 'WP11 Κλείσιμο', 'Μέσα σε 3 εργάσιμες μετά την κατάθεση: ανασκόπηση 30 λεπτών με Α, Β, Γ, αρχειοθέτηση, lessons learned, ενημέρωση βιβλιοθήκης.', wd('T', 3)),
];

const check = (owner: string, n: number, name: string, condition: Condition = 'always'): SeedItem => ({
  kind: 'checklist_item',
  key: `CL-${owner}-${n}`,
  name,
  owner_role_key: owner,
  condition,
});

const checklists: SeedItem[] = [
  check('A', 1, 'Αίτηση εγγυητικής την ίδια μέρα με το G0 και έλεγχος κειμένου πριν την έκδοση'),
  check('A', 2, 'ΕΕΕΣ/ΤΕΥΔ σε συμφωνία με τα κριτήρια επιλογής της διακήρυξης'),
  check('A', 3, 'ΕΕΕΣ εταίρων/υπεργολάβων και δεσμεύσεις στήριξης σε ικανότητα', 'partners'),
  check('A', 4, 'Διασταύρωση ισχυρισμών εταίρων σε ΓΕΜΗ και άλλες δημόσιες πηγές (έτος ίδρυσης, δραστηριότητα, εκπροσώπηση)', 'partners'),
  check('A', 5, 'Πιστοποιητικά σε ισχύ την ημέρα υποβολής'),
  check('A', 6, 'Υπεύθυνες δηλώσεις με το ακριβές κείμενο που ζητά η διακήρυξη'),
  check('A', 7, 'Ψηφιακές υπογραφές σε όλα τα αρχεία, ονοματολογία, μέγεθος'),

  check('B', 1, 'Requirements register πλήρες πριν το G0'),
  check('B', 2, 'Ερωτήματα διευκρίνισης σταλμένα πριν την προθεσμία ερωτημάτων'),
  check('B', 3, 'BOM με ακριβείς κωδικούς και τεκμήριο ανά προδιαγραφή'),
  check('B', 4, 'MAF και vendor quotes παραλήφθηκαν'),
  check('B', 5, 'Φύλλο συμμόρφωσης με παραπομπή σε σελίδα τεκμηρίου'),
  check('B', 6, 'Καμία τιμή στον τεχνικό φάκελο ή στα συνημμένα'),
  check('B', 7, 'Demo: hardware, software και κωδικοί BOM ταυτίζονται με την προσφορά', 'demo'),
  check('B', 8, 'Demo: καλώδια, adapters, συμβατές θύρες (π.χ. DisplayPort/HDMI), τροφοδοτικά, άδειες, δοκιμή εν λειτουργία πριν την αποστολή', 'demo'),

  check('C', 1, 'Κάθε γραμμή του BOM έχει τιμή και αντίστροφα'),
  check('C', 2, 'Συντήρηση, εγγύηση, SLA και υπηρεσίες κοστολογημένα'),
  check('C', 3, 'Τιμή εντός προϋπολογισμού και ανώτατης τιμής ανά τμήμα/είδος'),
  check('C', 4, 'Αρχείο αιτιολόγησης αν η τιμή είναι πολύ χαμηλή'),
  check('C', 5, 'Συνημμένα ταυτίζονται με το ηλεκτρονικό έντυπο ΕΣΗΔΗΣ (ποσά, ΦΠΑ, στρογγυλοποιήσεις)'),
  check('C', 6, 'Έγκριση Διοίκησης (G2) καταγεγραμμένη'),
];

const watch = (
  key: string,
  owner: string,
  name: string,
  checks: string,
  lead: { lead_value: number | null; lead_unit: Unit },
  needed_milestone_key: string,
  condition: Condition = 'always',
  lead_note?: string,
): SeedItem => ({
  kind: 'watch_item',
  key,
  name,
  owner_role_key: owner,
  condition,
  payload: { ...lead, needed_milestone_key, checks, ...(lead_note ? { lead_note } : {}) },
});
const OPEN = { lead_value: null, lead_unit: 'working' as Unit };

// R6: the guarantee is needed at G4 with a lead time of 10 calendar days. "Ανοιχτό" lead times are null.
const watchlist: SeedItem[] = [
  watch('guarantee', 'A', 'Εγγυητική συμμετοχής', 'Ποσό, δικαιούχος, αρ. διακήρυξης, ισχύς ≥ ισχύς προσφοράς + περιθώριο διακήρυξης, κείμενο βάσει υποδείγματος', { lead_value: 10, lead_unit: 'calendar' }, 'G4', 'always', 'Έως 10 ημερολογιακές (≈ 8 εργάσιμες)'),
  watch('maf', 'B', 'MAF / εξουσιοδοτήσεις κατασκευαστή', 'Αναφορά στον διαγωνισμό, σωστοί κωδικοί, υπογραφή', OPEN, 'G1', 'always', 'Ανοιχτό'),
  watch('vendor_quotes', 'B', 'Vendor quotes', 'Ισχύς τιμών μέχρι την υλοποίηση, συναλλαγματικός κίνδυνος', OPEN, 'G1', 'always', 'Ανοιχτό'),
  watch('cvs', 'A', 'CVs & δηλώσεις μελών ομάδας', 'Διαθεσιμότητα προσώπων, υπογραφές, αντιστοίχιση με απαιτούμενα προσόντα (Α με Β)', OPEN, 'G3', 'always', 'Ανοιχτό'),
  watch('certificates', 'A', 'Πιστοποιητικά με λήξη (ISO, ΓΕΜΗ, ενημερότητες)', 'Ισχύς στην ημέρα υποβολής', OPEN, 'G4', 'always', 'Ανά έγγραφο'),
  watch('signatures', 'A', 'Ψηφιακές υπογραφές νόμιμου εκπροσώπου', 'Διαθεσιμότητα T−2 έως T−1, ενεργό πιστοποιητικό υπογραφής', OPEN, 'G4'),
  watch('partner_docs', 'A', 'Έγγραφα εταίρων', 'ΕΕΕΣ, δεσμεύσεις, ισχυρισμοί εμπειρίας διασταυρωμένοι σε ΓΕΜΗ', OPEN, 'G1', 'partners', 'Ανοιχτό'),
  watch('demo_unit', 'B', 'Demo μονάδα', 'Δοκιμή εν λειτουργία, καλώδια/θύρες/τροφοδοτικά, προθεσμία φυσικής παράδοσης', OPEN, 'G3', 'demo', 'Ανοιχτό'),
];

/** Every item of «L v1.1», in display order (`sort` = position × 10 when seeded). */
export const TEMPLATE_L11_ITEMS: readonly SeedItem[] = [...roles, ...gates, ...criteria, ...milestones, ...handoffs, ...tasks, ...checklists, ...watchlist];

export const TEMPLATE_L11_DESCRIPTION =
  'Blueprint κατάθεσης μεγάλων δημόσιων διαγωνισμών (L), έκδοση v1.1: ρόλοι Α/Β/Γ/Διοίκηση, πύλες G0–G4 με κριτήρια εξόδου, ' +
  'ανάστροφο πρόγραμμα σε εργάσιμες, παραδόσεις, checklists ανά μέλος και watchlist.';

export interface SeedTemplateResult {
  template: Row;
  created: boolean;
  items: number;
}

/**
 * Creates the published template «L v1.1» with its items for the organization of `db`. Idempotent: when a template
 * with that name and version already exists (whatever its state — the admin may have edited it) nothing is touched.
 */
export async function seedTemplateL11(db: ScopedDb): Promise<SeedTemplateResult> {
  return db.tx(async (tx) => {
    const existing = await tx.findOne('template', { name: TEMPLATE_L_NAME, version: TEMPLATE_L_VERSION });
    if (existing) return { template: existing, created: false, items: await tx.count('template_item', { template_id: existing.id }) };
    const template = await tx.insert('template', {
      name: TEMPLATE_L_NAME,
      version: TEMPLATE_L_VERSION,
      status: 'published',
      description: TEMPLATE_L11_DESCRIPTION,
      published_at: new Date(),
    });
    const rows = TEMPLATE_L11_ITEMS.map((item, index) => ({
      template_id: template.id,
      kind: item.kind,
      key: item.key,
      name: item.name,
      owner_role_key: item.owner_role_key ?? null,
      anchor: item.anchor ?? null,
      offset_value: item.offset_value ?? null,
      offset_unit: item.offset_unit ?? null,
      condition: item.condition ?? 'always',
      sort: (index + 1) * 10,
      payload: item.payload ?? {},
    }));
    await tx.insertMany('template_item', rows);
    return { template, created: true, items: rows.length };
  });
}
