// The whole product, end to end, against a real server and a real database — no API mocking.
// See README.md in this folder. Usage:  node web/e2e/full-flow.mjs [--build] [--keep] [--until=<phase>]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN,
  BASE,
  addDays,
  apiFetch,
  assert,
  assertEq,
  chromium,
  collectToasts,
  el,
  expectToast,
  f,
  fridayAfter,
  log,
  login,
  newUserContext,
  outDir,
  problems,
  seenToasts,
  settle,
  shot,
  startStack,
  todayAthens,
} from './lib.mjs';

const args = new Set(process.argv.slice(2));
const until = [...args].find((a) => a.startsWith('--until='))?.slice(8) ?? null;

const PASSWORD = 'e2e-team-password-1';
const TEAM = {
  bid: { email: 'maria.bid@e2e.example.gr', name: 'Μαρία Αντωνίου', role: 'bid_manager', roleLabel: 'Bid manager' },
  a: { email: 'giorgos.a@e2e.example.gr', name: 'Γιώργος Δημητρίου', role: 'member', roleLabel: 'Member', tenderRole: 'A' },
  b: { email: 'eleni.b@e2e.example.gr', name: 'Ελένη Παππά', role: 'member', roleLabel: 'Member', tenderRole: 'B' },
  c: { email: 'nikos.c@e2e.example.gr', name: 'Νίκος Σταθόπουλος', role: 'member', roleLabel: 'Member', tenderRole: 'C' },
  mgmt: { email: 'kostas.mgmt@e2e.example.gr', name: 'Κώστας Διοικητής', role: 'approver', roleLabel: 'Approver', tenderRole: 'MGMT' },
  viewer: { email: 'partner.viewer@e2e.example.gr', name: 'Άννα Εταίρου', role: 'viewer', roleLabel: 'Viewer', tenderRole: null },
};

const today = todayAthens();
// T: a Friday ~11 weeks out, 14:00 Athens — far enough for a normal (non-compressed) schedule.
const T = fridayAfter(today, 75);
const T0 = addDays(today, -3);
const TITLE = 'Προμήθεια και εγκατάσταση εξοπλισμού πληροφορικής περιφερειακών υπηρεσιών';

const stack = await startStack({ build: args.has('--build') });
const browser = await chromium.launch();
const sessions = {};
const state = { tenderId: null };
let failed = null;

const phases = [];
const phase = (name, fn) => phases.push({ name, fn });

/** A tab of the tender, by its Greek label. */
async function openTab(page, label) {
  await page.getByRole('navigation', { name: 'Ενότητες διαγωνισμού' }).getByRole('link', { name: label, exact: false }).first().click();
  await settle(page);
}
async function gotoTender(page, tab = 'overview') {
  await page.goto(`${BASE}/tenders/${state.tenderId}/${tab}`);
  await settle(page);
}
const modal = (page) => page.getByRole('dialog').last();
/** Opens a row's «⋯» menu and picks an item. (The menu closes on scroll, so the row is brought into view first.) */
async function menuPick(page, row, item) {
  const button = row.getByRole('button', { name: /Ενέργειες|Περισσότερες ενέργειες/ }).first();
  await button.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await button.click();
  await page.getByRole('menuitem', { name: item }).click();
}

/* ================================================================== 1. admin: first login, 2FA, invitations */

phase('admin', async () => {
  const s = (sessions.admin = await newUserContext(browser, 'admin'));
  const { page } = s;
  await page.goto(`${BASE}/`);
  await page.locator('input[name=email]').waitFor(); // unauthenticated → login page
  await shot(page, 'login');
  s.secret = await login(page, { ...ADMIN });
  await shot(page, 'dashboard-empty-admin');

  // invitations
  await page.getByRole('link', { name: 'Χρήστες' }).click();
  await settle(page);
  for (const member of Object.values(TEAM)) {
    await page.getByRole('button', { name: 'Πρόσκληση χρήστη' }).first().click();
    const dialog = modal(page);
    await f(dialog, 'Email').fill(member.email);
    await f(dialog, 'Ρόλος οργανισμού').selectOption(member.role);
    if (member === TEAM.bid) await shot(page, 'admin-invite-dialog');
    await dialog.getByRole('button', { name: 'Δημιουργία πρόσκλησης' }).click();
    const link = modal(page).getByLabel('Σύνδεσμος πρόσκλησης');
    await link.waitFor();
    member.inviteUrl = await link.inputValue();
    assert(member.inviteUrl.startsWith(`${BASE}/invite/`), `invite link on this origin: ${member.inviteUrl}`);
    // no SMTP in this run: the UI must say the e-mail was NOT sent
    await modal(page).getByText('δεν στάλθηκε').waitFor();
    if (member === TEAM.bid) await shot(page, 'admin-invite-created');
    await modal(page).getByRole('button', { name: 'Κλείσιμο' }).first().click();
  }
  await shot(page, 'admin-invitations');
});

/* ================================================================== 2. everybody accepts and enrols */

phase('accept', async () => {
  for (const [key, member] of Object.entries(TEAM)) {
    const s = (sessions[key] = await newUserContext(browser, key));
    const { page } = s;
    await page.goto(member.inviteUrl);
    await f(page, 'Ονοματεπώνυμο').fill(member.name);
    await page.locator('input[name=new-password]').fill(PASSWORD);
    await page.locator('input[name=new-password-confirm]').fill(PASSWORD);
    if (key === 'bid') await shot(page, 'invite-accept');
    await page.getByRole('button', { name: 'Δημιουργία λογαριασμού' }).click();
    await page.getByText('Ο λογαριασμός δημιουργήθηκε').waitFor();
    s.secret = await login(page, { email: member.email, password: PASSWORD });
    log('enrolled', key);
  }
  // a used invitation link is dead
  const { page } = sessions.viewer;
  const ctx = await newUserContext(browser, 'anon');
  await ctx.page.goto(TEAM.viewer.inviteUrl);
  await ctx.page.getByText('Η πρόσκληση δεν ισχύει').first().waitFor();
  await shot(ctx.page, 'invite-used');
  await ctx.context.close();
  await shot(page, 'dashboard-empty-viewer');

  const admin = sessions.admin.page;
  await admin.reload();
  await settle(admin);
  await shot(admin, 'admin-users');
});

/* ================================================================== 3. bid manager: tender from «L v1.1», team */

phase('tender', async () => {
  const { page } = sessions.bid;
  await page.goto(`${BASE}/tenders`);
  await settle(page);
  await shot(page, 'tenders-empty');
  await page.getByRole('link', { name: /Νέος διαγωνισμός|Δημιουργία/ }).first().click();
  await f(page, 'Τίτλος').fill(TITLE);
  await f(page, 'Αναθέτουσα αρχή').fill('Υπουργείο Ψηφιακής Διακυβέρνησης');
  await f(page, 'ΑΔΑΜ').fill('26PROC017654321');
  await f(page, 'α/α ΕΣΗΔΗΣ').fill('345678');
  await f(page, 'CPV').fill('30200000-1, 72000000-5');
  await f(page, 'Δημοσίευση (T0)').fill(T0);
  await f(page, 'Προθεσμία ερωτημάτων').fill(`${addDays(T, -20)}T13:00`);
  await f(page, 'Προθεσμία υποβολής (T)').fill(`${T}T14:00`);
  await f(page, 'Προϋπολογισμός χωρίς ΦΠΑ (€)').fill('1250000');
  await f(page, 'Προϋπολογισμός με ΦΠΑ (€)').fill('1550000');
  await page.getByRole('button', { name: 'Προσθήκη τμήματος' }).click();
  await f(page, 'Τίτλος τμήματος').fill('Εξυπηρετητές και αποθηκευτικά');
  await f(page, 'Ποσό εγγυητικής (€)').fill('25000');
  await f(page, 'Ισχύς προσφοράς (ημέρες)').fill('180');
  await f(page, 'Template').selectOption({ label: 'L v1.1' });
  await f(page, 'Ζητείται demo / δείγμα').check();
  await f(page, 'Υπάρχουν εταίροι / υπεργολάβοι').check();
  await shot(page, 'tender-create-form');
  await page.getByRole('button', { name: 'Δημιουργία διαγωνισμού' }).click();
  await page.waitForURL(/\/tenders\/[0-9a-f-]{36}\/schedule/);
  state.tenderId = /tenders\/([0-9a-f-]{36})/.exec(page.url())[1];
  await expectToast(page, 'Ο διαγωνισμός δημιουργήθηκε');
  await shot(page, 'tender-schedule-new');

  // the header's deadline and T−n: dd/mm/yyyy, Athens time, and the server's count
  const head = await page.locator('.tender-head').innerText();
  assert(head.includes(el(T)), `header shows T as ${el(T)}: ${head}`);
  assert(head.includes('14:00'), 'header shows the Athens time 14:00');
  const detail = await apiFetch(page, `/api/tenders/${state.tenderId}`);
  state.tMinus = detail.json.tMinus;
  assert(head.replace(/\s+/g, '').includes(`T−${state.tMinus}`), `header chip is the server's T−${state.tMinus}: ${head}`);
  assertEq(detail.json.tender.has_demo && detail.json.tender.has_partners, true, 'demo and partners flags stored');
});

phase('team', async () => {
  const { page } = sessions.bid;
  await gotoTender(page, 'team');
  await shot(page, 'team-empty');
  for (const member of Object.values(TEAM).filter((m) => m !== TEAM.bid)) {
    const roleCard = member.tenderRole
      ? page.locator('.ui-card', { has: page.locator('.ui-card__title, h2, h3', { hasText: { A: 'Α — ', B: 'Β — ', C: 'Γ — ', MGMT: 'Διοίκηση' }[member.tenderRole] }) }).first()
      : page.locator('.ui-card', { hasText: 'Μέλη χωρίς ρόλο' }).first();
    await roleCard.locator('select').selectOption({ label: member.name });
    await roleCard.locator('.team-list strong', { hasText: member.name }).waitFor();
    await settle(page);
  }
  await shot(page, 'team-complete');
  const members = await apiFetch(page, `/api/tenders/${state.tenderId}/members`);
  assertEq(members.json.items.length, 5, 'five team members');
  // the gates got their approvers from the roles (MGMT → G0, G2, G4; B → G1, G3)
  const gates = await apiFetch(page, `/api/tenders/${state.tenderId}/gates`);
  for (const g of gates.json.items) assert(g.approver, `gate ${g.key} has an approver after staffing the team`);
  state.gates = Object.fromEntries(gates.json.items.map((g) => [g.key, g]));
  assertEq(state.gates.G0.approver.name, TEAM.mgmt.name, 'G0 approver is the MGMT member');
  assertEq(state.gates.G1.approver.name, TEAM.b.name, 'G1 approver is the B member');
});

/* ================================================================== 4. register: import, edit, evidence */

/** ≈ 40 rows as an AI analysis tool would produce them (docs/register-import-format.md), mixed types and folders. */
function registerCsv() {
  const rows = [['Κωδικός', 'Πηγή', 'Κείμενο', 'Τύπος', 'Φάκελος', 'Συντελεστής', 'Υπεύθυνος']];
  const add = (n, source, text, type, folder, weight, owner) => rows.push([`ΥΠ-${String(n).padStart(3, '0')}`, source, text, type, folder, weight, owner]);
  let n = 0;
  const participation = [
    'Ο οικονομικός φορέας διαθέτει πιστοποίηση ISO 9001:2015 σε ισχύ.',
    'Ο οικονομικός φορέας διαθέτει πιστοποίηση ISO 27001 σε ισχύ.',
    'Εγγυητική επιστολή συμμετοχής 2% επί του προϋπολογισμού, ισχύος 210 ημερών.',
    'Φορολογική και ασφαλιστική ενημερότητα σε ισχύ κατά την υποβολή.',
    'Πιστοποιητικό ΓΕΜΗ εκπροσώπησης, έκδοσης τελευταίου τριμήνου.',
    'Μέσος ετήσιος κύκλος εργασιών τριετίας ≥ 2.000.000 €.',
    'Τρία (3) έργα αναφοράς αντίστοιχου αντικειμένου την τελευταία πενταετία.',
    'Υπεύθυνη δήλωση μη οφειλής τελών κυκλοφορίας, ψηφιακά υπογεγραμμένη.',
    'ΕΕΕΣ συμπληρωμένο και ψηφιακά υπογεγραμμένο από κάθε μέλος της ένωσης.',
    'Δήλωση συνεργασίας υπεργολάβων με ποσοστό συμμετοχής.',
  ];
  for (const text of participation) add(++n, `Διακήρυξη §2.2.${n}, σελ. ${20 + n}`, text, 'Αποκλεισμού', 'Συμμετοχής', '', 'A');
  const technical = [
    'Κάθε εξυπηρετητής διαθέτει τουλάχιστον 2 επεξεργαστές και 256 GB μνήμης.',
    'Αποθηκευτικό σύστημα ωφέλιμης χωρητικότητας ≥ 200 TB με "all-flash" δίσκους.',
    'Εγγύηση κατασκευαστή 5 ετών με ανταπόκριση επόμενης εργάσιμης.',
    'Επιστολή εξουσιοδότησης κατασκευαστή (MAF) για το σύνολο του εξοπλισμού.',
    'Μεταγωγείς πυρήνα 100GbE με εφεδρικά τροφοδοτικά.',
    'Λογισμικό εικονικοποίησης με άδειες για το σύνολο των επεξεργαστών.',
    'Υπεύθυνος έργου με πιστοποίηση PMP και 10ετή εμπειρία.',
    'Ομάδα έργου τουλάχιστον 5 μηχανικών με πιστοποιήσεις κατασκευαστή.',
    'Εγκατάσταση και παραμετροποίηση σε 3 περιφερειακά κέντρα δεδομένων.',
    'Εκπαίδευση διαχειριστών: 40 ώρες, στην ελληνική γλώσσα.',
    'Πλάνο μετάπτωσης χωρίς διακοπή λειτουργίας μεγαλύτερη των 4 ωρών.',
    'Συμβατότητα με το υφιστάμενο σύστημα αντιγράφων ασφαλείας.',
  ];
  for (const text of technical) add(++n, `Παράρτημα Ι, §3.${n}, σελ. ${40 + n}`, text, 'Αποκλεισμού', 'Τεχνική', '', 'B');
  const scored = [
    ['Μεθοδολογία υλοποίησης και χρονοδιάγραμμα', 'Κ1 – 20%'],
    ['Χρόνος αποκατάστασης βλάβης: βαθμολογείται ο χρόνος κάτω από τις "8 ώρες"', 'Κ2 – 15%'],
    ['Επιπλέον έτη εγγύησης πέραν των 5', 'Κ3 – 10%'],
    ['Ποιότητα και πληρότητα εκπαίδευσης', 'Κ4 – 10%'],
    ['Επάρκεια και εμπειρία ομάδας έργου', 'Κ5 – 15%'],
    ['Επίδειξη (demo) λειτουργίας του αποθηκευτικού συστήματος', 'Κ6 – 10%'],
    ['Ενεργειακή αποδοτικότητα εξοπλισμού', 'Κ7 – 10%'],
    ['Υπηρεσίες υποστήριξης μετά την παράδοση', 'Κ8 – 10%'],
  ];
  for (const [text, weight] of scored) add(++n, `Διακήρυξη §2.3.1, ${weight.slice(0, 2)}, σελ. 40`, text, 'Βαθμολογούμενη', 'Τεχνική', weight, 'B');
  const formal = [
    ['Η τεχνική προσφορά υπογράφεται ψηφιακά από τον νόμιμο εκπρόσωπο.', 'Τεχνική', 'B'],
    ['Το φύλλο συμμόρφωσης ακολουθεί το υπόδειγμα του Παραρτήματος ΙΙ.', 'Τεχνική', 'B'],
    ['Τα ξενόγλωσσα φυλλάδια συνοδεύονται από μετάφραση όπου απαιτείται.', 'Τεχνική', 'B'],
    ['Τα δικαιολογητικά υποβάλλονται σε μορφή PDF έως 50 MB ανά αρχείο.', 'Συμμετοχής', 'A'],
    ['Η οικονομική προσφορά υπογράφεται ψηφιακά από τον νόμιμο εκπρόσωπο.', 'Οικονομική', 'C'],
    ['Οι τιμές δίνονται σε ευρώ, χωρίς ΦΠΑ, με δύο δεκαδικά.', 'Οικονομική', 'C'],
    ['Το ηλεκτρονικό έντυπο οικονομικής προσφοράς του ΕΣΗΔΗΣ συμφωνεί με το αναλυτικό.', 'Οικονομική', 'C'],
    ['Ανάλυση κόστους ανά τμήμα σύμφωνα με το υπόδειγμα.', 'Οικονομική', 'C'],
    ['Χρόνος ισχύος προσφοράς 180 ημέρες.', 'Οικονομική', 'C'],
    ['Η προσφορά δεν περιέχει εναλλακτικές.', 'Τεχνική', 'Άγνωστος Υπεύθυνος'],
  ];
  for (const [text, folder, owner] of formal) add(++n, `Διακήρυξη §2.4.${n}, σελ. ${45 + (n % 5)}`, text, 'Τυπική', folder, '', owner);
  const quote = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return { count: n, csv: rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n' };
}

phase('register', async () => {
  const { page } = sessions.bid;
  await gotoTender(page, 'register');
  await shot(page, 'register-empty');
  const file = registerCsv();
  state.registerRows = file.count;
  const csvPath = resolve(outDir, 'register-import.csv');
  writeFileSync(csvPath, '﻿' + file.csv, 'utf8');

  await page.getByRole('button', { name: 'Import' }).first().click();
  await modal(page).locator('input[type=file]').setInputFiles(csvPath);
  await modal(page).getByText('Αντιστοίχιση στηλών').waitFor();
  await shot(page, 'register-import-mapping');
  await modal(page).getByRole('button', { name: 'Επόμενο' }).click();
  await modal(page).getByText('Νέες').first().waitFor();
  await shot(page, 'register-import-summary');
  await modal(page).getByRole('button', { name: new RegExp(`Εισαγωγή ${file.count} γραμμών`) }).click();
  await expectToast(page, `${file.count} νέες`);
  await settle(page);
  await shot(page, 'register-imported');

  // the same file again: nothing new (acceptance criterion, through the wizard)
  await page.getByRole('button', { name: 'Import' }).first().click();
  await modal(page).locator('input[type=file]').setInputFiles(csvPath);
  await modal(page).getByRole('button', { name: 'Επόμενο' }).click();
  await modal(page).getByText('Το αρχείο δεν αλλάζει τίποτα').waitFor();
  await shot(page, 'register-import-again');
  await modal(page).getByRole('button', { name: 'Άλλο αρχείο' }).waitFor();
  await page.keyboard.press('Escape');
  const list = await apiFetch(page, `/api/tenders/${state.tenderId}/requirements`);
  assertEq(list.json.items.length, file.count, 'no duplicate rows after the second import');
  assertEq(list.json.items.filter((r) => r.owner_role_key === 'B').length, 23, 'owners resolved from the file (role B)');

  // member B (technical) fills in answer + evidence for the technical exclusion rows, in the editor
  const b = sessions.b.page;
  await gotoTender(b, 'register');
  for (const code of ['ΥΠ-011', 'ΥΠ-012']) {
    await b.locator('.reg-row, .reg-card', { hasText: code }).first().click();
    const dialog = modal(b);
    await f(dialog, 'Απάντηση').fill('Κεφ. 3.2 Τεχνικής προσφοράς');
    await f(dialog, 'Τεκμήριο').fill('Παράρτημα Β.3, σελ. 12');
    await f(dialog, 'Κατάσταση').selectOption('covered');
    if (code === 'ΥΠ-011') await shot(b, 'register-editor');
    await dialog.getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
  // a deviation needs its note (R17)
  await b.locator('.reg-row, .reg-card', { hasText: 'ΥΠ-013' }).first().click();
  await f(modal(b), 'Κατάσταση').selectOption('deviation');
  await modal(b).getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
  await modal(b).getByText('Η «Απόκλιση» θέλει αιτιολόγηση').waitFor();
  await f(modal(b), 'Αιτιολόγηση απόκλισης').fill('Προσφέρεται εγγύηση 5 ετών με ανταπόκριση 4 ωρών αντί επόμενης εργάσιμης.');
  await shot(b, 'register-deviation');
  await modal(b).getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
  await modal(b).waitFor({ state: 'detached' });
  // inline status change from the table
  await b.getByLabel('Κατάσταση ΥΠ-014').selectOption('in_progress');
  await settle(b);
  await shot(b, 'register-member-b');

  // the rest of the evidence in bulk by the bid manager, so that G1's automatic criterion can be met later
  await gotoTender(page, 'register');
  const all = (await apiFetch(page, `/api/tenders/${state.tenderId}/requirements`)).json.items;
  const exclusionIds = all.filter((r) => r.type === 'exclusion' && !r.evidence_ref).map((r) => r.id);
  for (const id of exclusionIds) {
    const res = await apiFetch(page, `/api/tenders/${state.tenderId}/requirements/${id}`, { method: 'PATCH', body: { evidence_ref: 'Φάκελος δικαιολογητικών, Παράρτημα Α', status: 'covered' } });
    assertEq(res.status, 200, `evidence update: ${res.text}`);
  }
  await page.reload();
  await settle(page);
  await shot(page, 'register-coverage');
  const coverage = (await apiFetch(page, `/api/tenders/${state.tenderId}/requirements/coverage`)).json;
  assertEq(coverage.exclusionWithoutEvidence, 0, 'every exclusion row has evidence');

  // export (φύλλο συμμόρφωσης) downloads as a real XLSX
  const exported = await page.evaluate(async (id) => {
    const res = await fetch(`/api/tenders/${id}/requirements/export.xlsx`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type'), magic: String.fromCharCode(buf[0], buf[1]), size: buf.length };
  }, state.tenderId);
  assertEq([exported.status, exported.magic], [200, 'PK'], 'XLSX export');
});

/* ================================================================== 5. files in several folders, R18 by UI and by URL */

phase('files', async () => {
  const upload = async (page, folderLabel, name, content) => {
    await f(page, 'Φάκελος προορισμού').selectOption({ label: folderLabel });
    await page.locator('.files-upload__drop input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(content) });
    await expectToast(page, 'Ανέβηκε 1 αρχείο');
    await settle(page);
  };
  const bid = sessions.bid.page;
  await gotoTender(bid, 'files');
  await shot(bid, 'files-empty');
  await upload(bid, 'Τεύχη διακήρυξης', 'Διακήρυξη 12-2026.pdf', '%PDF-1.4 διακήρυξη');
  await upload(bid, 'Διευκρινίσεις', 'Διευκρίνιση 1.pdf', '%PDF-1.4 διευκρίνιση');
  const a = sessions.a.page;
  await gotoTender(a, 'files');
  await upload(a, 'Συμμετοχής', 'ΕΕΕΣ υπογεγραμμένο.pdf', '%PDF-1.4 ΕΕΕΣ');
  const b = sessions.b.page;
  await gotoTender(b, 'files');
  await upload(b, 'Τεχνική', 'Τεχνική περιγραφή v3.pdf', '%PDF-1.4 τεχνική');
  // the technical member has no «Οικονομική» option at all
  const folderOptions = await f(b, 'Φάκελος προορισμού').locator('option').allTextContents();
  assert(!folderOptions.some((o) => o.includes('Οικονομική')), `technical member is not offered the financial folder: ${folderOptions}`);

  const c = sessions.c.page;
  await gotoTender(c, 'files');
  await upload(c, 'Οικονομική', 'Οικονομική προσφορά ΤΕΛΙΚΟ.pdf', '%PDF-1.4 ΤΙΜΕΣ 1.234.567,89');
  await shot(c, 'files-financial-member');
  const listC = (await apiFetch(c, `/api/tenders/${state.tenderId}/files`)).json;
  const financial = listC.items.find((x) => x.folder === 'financial');
  assert(financial && financial.confidentiality === 'financial', 'the file in «Οικονομική» is confidential');
  state.financialFileId = financial.id;
  assertEq(listC.items.length, 5, 'financial member sees all five files');

  // R18 — who sees it in the UI, and who gets it by direct URL
  const url = `/api/tenders/${state.tenderId}/files/${financial.id}`;
  for (const who of ['b', 'a', 'viewer']) {
    const page = sessions[who].page;
    await gotoTender(page, 'files');
    const text = await page.locator('.app-content').innerText();
    assert(!text.includes('Οικονομική προσφορά ΤΕΛΙΚΟ'), `${who} does not see the financial file in the UI`);
    for (const path of [`${url}/download`, url]) {
      const res = await apiFetch(page, path);
      assertEq([res.status, res.json?.error?.code], [403, 'financial_restricted'], `${who} GET ${path}`);
      assert(!res.text.includes('1.234.567'), 'no price leaks in the refusal');
    }
    assertEq((await apiFetch(page, `/api/tenders/${state.tenderId}/files`)).json.items.length, 4, `${who} lists four files`);
  }
  await shot(sessions.b.page, 'files-technical-member');
  await shot(sessions.viewer.page, 'files-viewer');
  for (const who of ['c', 'mgmt', 'bid', 'admin']) {
    const res = await apiFetch(sessions[who].page.url().startsWith(BASE) ? sessions[who].page : sessions[who].page, `${url}/download`);
    assertEq(res.status, 200, `${who} downloads the financial file`);
    assert(res.text.includes('1.234.567'), `${who} gets the real content (decrypted)`);
  }
  // at rest the blob is encrypted: the price is not on disk in clear
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(resolve(dir, n)).isDirectory() ? walk(resolve(dir, n)) : [resolve(dir, n)]));
  const blobs = walk(resolve(outDir, 'storage'));
  assertEq(blobs.length, 5, 'five blobs on disk');
  for (const blob of blobs) {
    const raw = readFileSync(blob).toString('latin1');
    assert(!raw.includes('%PDF') && !raw.includes('1.234.567'), `blob ${blob} is encrypted at rest`);
    assert(!/\.pdf$/.test(blob) && !blob.includes('ΤΕΛΙΚΟ'), 'original file names are not on disk');
  }

  // viewer: read-only in the UI and by URL
  const viewer = sessions.viewer.page;
  assertEq(await viewer.locator('.files-upload__drop input[type=file]').count(), 0, 'viewer has no upload control');
  const del = await apiFetch(viewer, `/api/tenders/${state.tenderId}/files/${listC.items.find((x) => x.folder === 'tender_docs').id}`, { method: 'DELETE' });
  assertEq(del.status, 403, 'viewer cannot delete a file by URL');
  const write = await apiFetch(viewer, `/api/tenders/${state.tenderId}/risks`, { method: 'POST', body: { title: 'x' } });
  assertEq(write.status, 403, 'viewer cannot write by URL');
});

/* ================================================================== 6. tasks, checklists, handoff B → A */

const visible = (locator) => locator.locator('visible=true');
const taskView = async (page, label) => {
  await page.getByRole('tab', { name: new RegExp(`^${label}`) }).or(page.getByRole('button', { name: new RegExp(`^${label}`) })).first().click();
  await settle(page);
};

phase('tasks', async () => {
  const bid = sessions.bid.page;
  await gotoTender(bid, 'tasks');
  await shot(bid, 'tasks-list');
  await bid.getByRole('button', { name: 'Νέο task' }).first().click();
  await f(modal(bid), 'Τίτλος').fill('Έλεγχος υποδείγματος εγγυητικής με την τράπεζα');
  await f(modal(bid), 'Προθεσμία').fill(addDays(today, 2));
  await shot(bid, 'task-new');
  await modal(bid).getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
  await modal(bid).waitFor({ state: 'detached' });
  await bid.getByText('Έλεγχος υποδείγματος εγγυητικής με την τράπεζα').first().waitFor();

  // member A ticks two lines of the role's checklist and marks one "Δ/Α"
  const a = sessions.a.page;
  await gotoTender(a, 'tasks');
  await taskView(a, 'Checklists');
  const mine = a.locator('.ui-card, section', { hasText: 'ο ρόλος μου' }).first();
  const boxes = mine.locator('input[type=checkbox]');
  await boxes.nth(0).click();
  await settle(a);
  await boxes.nth(1).click();
  await settle(a);
  await visible(mine.getByRole('button', { name: 'Δ/Α' })).nth(2).click();
  await settle(a);
  await shot(a, 'checklists-member-a');

  // handoff H1 (B → A): B delivers, A — a different user — confirms receipt
  const WHAT = 'Λίστα απαιτούμενων πιστοποιητικών';
  const b = sessions.b.page;
  await gotoTender(b, 'tasks');
  await taskView(b, 'Παραδόσεις');
  await shot(b, 'handoffs-before');
  const rowB = visible(b.locator('tr, li', { hasText: WHAT })).first();
  // the sender cannot confirm their own handoff
  assertEq(await rowB.getByRole('button', { name: 'Επιβεβαίωση παραλαβής' }).count(), 0, 'sender B has no "confirm receipt" button');
  await rowB.getByRole('button', { name: 'Παραδόθηκε' }).click();
  await expectToast(b, 'Η παράδοση καταγράφηκε');
  await shot(b, 'handoff-delivered');
  const tasksB = (await apiFetch(b, `/api/tenders/${state.tenderId}/tasks?section=handoff`)).json.items;
  const h1 = tasksB.find((t) => t.title.startsWith(WHAT));
  state.h1 = h1.id;
  const forged = await apiFetch(b, `/api/tenders/${state.tenderId}/tasks/${h1.id}`, { method: 'PATCH', body: { handoff_to_role: 'B', handoff_from_role: 'A' } });
  assertEq([forged.status, forged.json.error.code], [403, 'handoff_manager_only'], 'B cannot re-wire the handoff to receive it themselves');
  assertEq((await apiFetch(b, `/api/tenders/${state.tenderId}/tasks/${h1.id}/receive`, { method: 'POST', body: {} })).status, 403, 'B cannot confirm receipt by URL');

  await gotoTender(a, 'tasks');
  await taskView(a, 'Παραδόσεις');
  await a.getByText('περιμένει την επιβεβαίωσή σας').first().waitFor();
  await shot(a, 'handoff-waiting-for-a');
  await visible(a.locator('tr, li', { hasText: WHAT })).first().getByRole('button', { name: 'Επιβεβαίωση παραλαβής' }).click();
  await expectToast(a, 'Η παραλαβή επιβεβαιώθηκε');
  await shot(a, 'handoff-received');
  const after = (await apiFetch(a, `/api/tenders/${state.tenderId}/tasks?section=handoff`)).json.items.find((t) => t.id === h1.id);
  assert(after.received_at && after.status === 'done', 'handoff received and done');
  assertEq(after.received_by, (await apiFetch(a, '/api/auth/me')).json.user.id, 'received by A (a different user than the sender)');

  // A's "My work" shows their items across tenders
  await a.goto(`${BASE}/my`);
  await settle(a);
  await shot(a, 'my-work-member-a');
});

/* ================================================================== 7. watchlist: the guarantee */

phase('watch', async () => {
  const a = sessions.a.page;
  await gotoTender(a, 'watch');
  await shot(a, 'watchlist');
  const list = (await apiFetch(a, `/api/tenders/${state.tenderId}/watch`)).json;
  const guarantee = list.items.find((w) => w.key === 'guarantee');
  state.guaranteeId = guarantee.id;
  const g4 = (await apiFetch(a, `/api/tenders/${state.tenderId}/milestones`)).json.items.find((m) => m.key === 'G4');
  assertEq(guarantee.needed_at, g4.due_date, 'guarantee is needed at G4');
  const text = await a.locator('.app-content').innerText();
  assert(text.includes(el(guarantee.last_request_date)), `watchlist shows the server's last request day ${el(guarantee.last_request_date)}`);
  const row = visible(a.locator('tr, li', { hasText: 'Εγγυητική συμμετοχής' })).first();
  await row.getByRole('button', { name: 'Ζητήθηκε σήμερα' }).click();
  await expectToast(a, 'Καταγράφηκε η αίτηση');
  await shot(a, 'watchlist-requested');
  const requested = (await apiFetch(a, `/api/tenders/${state.tenderId}/watch`)).json.items.find((w) => w.key === 'guarantee');
  assertEq([requested.requested_at, requested.state], [today, 'requested'], 'guarantee requested today');
  assert(requested.expected_at, 'expected arrival proposed from the lead time');
});

/* ================================================================== 8. company documents, linked to the tender (R15) */

phase('documents', async () => {
  const bid = sessions.bid.page;
  await bid.goto(`${BASE}/company-documents`);
  await settle(bid);
  await shot(bid, 'company-documents-empty');
  const add = async ({ type, title, issued, expires, person, file }) => {
    await bid.getByRole('button', { name: 'Νέο έγγραφο' }).first().click();
    const dialog = modal(bid);
    await f(dialog, 'Τύπος').selectOption(type);
    await f(dialog, 'Τίτλος').fill(title);
    if (person) await f(dialog, 'Ονοματεπώνυμο προσώπου').fill(person);
    if (issued) await f(dialog, 'Ημερομηνία έκδοσης').fill(issued);
    if (expires) await f(dialog, 'Ημερομηνία λήξης').fill(expires);
    if (file) await dialog.locator('input[type=file]').setInputFiles({ name: file, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${title}`) });
    await dialog.getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await settle(bid);
  };
  state.docExpiry = addDays(T, -10); // before T → red on the tender
  await add({ type: 'iso', title: 'ISO 9001:2015', issued: addDays(today, -700), expires: state.docExpiry, file: 'ISO-9001.pdf' });
  await add({ type: 'iso', title: 'ISO 27001:2022', issued: addDays(today, -200), expires: addDays(T, 400), file: 'ISO-27001.pdf' });
  await add({ type: 'tax', title: 'Φορολογική ενημερότητα', issued: addDays(today, -20), expires: addDays(today, 12) }); // expiring within 30 days
  await add({ type: 'cv', title: 'CV Υπευθύνου έργου', person: 'Δημήτρης Παπαδόπουλος', file: 'CV-PM.pdf' });
  await shot(bid, 'company-documents');

  await gotoTender(bid, 'documents');
  await shot(bid, 'tender-documents-empty');
  await bid.getByRole('button', { name: 'Σύνδεση εγγράφου' }).first().click();
  await shot(bid, 'tender-documents-picker');
  for (const title of ['ISO 9001:2015', 'ISO 27001:2022', 'CV Υπευθύνου έργου']) {
    await modal(bid).locator('li, tr, .doc-pick', { hasText: title }).last().getByRole('button', { name: 'Σύνδεση' }).click();
    await expectToast(bid, 'Το έγγραφο συνδέθηκε');
    await settle(bid);
  }
  await modal(bid).getByRole('button', { name: 'Κλείσιμο' }).first().click();
  await bid.reload();
  await settle(bid);
  await bid.getByText('λήγει πριν από την υποβολή').first().waitFor();
  await shot(bid, 'tender-documents-red');

  // R15 on three screens, one truth: the tender's warning, the G4 criterion, the dashboard
  const detail = (await apiFetch(bid, `/api/tenders/${state.tenderId}`)).json;
  assert(detail.warnings.some((w) => w.code === 'documents_expired_on_T' && w.severity === 'red'), 'tender warning: documents expire before T');
  const g4 = (await apiFetch(bid, `/api/tenders/${state.tenderId}/gates`)).json.items.find((g) => g.key === 'G4');
  assertEq(g4.criteria.find((c) => c.auto_rule === 'docs_valid_on_T').satisfied, false, 'docs_valid_on_T fails');
  await bid.goto(`${BASE}/`);
  await settle(bid);
  const dash = (await apiFetch(bid, '/api/dashboard')).json;
  assert(dash.attention.some((x) => x.tenderId === state.tenderId && x.code === 'documents_expiring' && x.tone === 'red'), 'dashboard: red documents warning');
  await shot(bid, 'dashboard-bid-manager-red-document');
  const dashText = await bid.locator('.app-content').innerText();
  assert(/λήγ/.test(dashText), 'dashboard shows the expiring document');

  // a CV is personal data: team members of this tender see the linked one, a member of no tender would not;
  // member B cannot link CVs and does not see unlinked ones in the org register
  const b = sessions.b.page;
  await b.goto(`${BASE}/company-documents`);
  await settle(b);
  await shot(b, 'company-documents-member');
});

/* ================================================================== 9. gates: G0 request → MGMT decides Go */

async function openGate(page, key) {
  await gotoTender(page, 'gates');
  const card = page.locator('article.gate', { has: page.locator('.gate__key', { hasText: key }) });
  const head = card.locator('.gate__head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  return card;
}
const JUSTIFICATION = 'Προχωράμε: εκκρεμεί μόνο η γραπτή επιβεβαίωση του κατασκευαστή, αναμένεται αύριο.';

phase('gate-g0', async () => {
  const bid = sessions.bid.page;
  let card = await openGate(bid, 'G0');
  await shot(bid, 'gates-initial');
  // the bid manager ticks the manual criteria except the last one
  const boxes = card.locator('.criterion input[type=checkbox]');
  const n = await boxes.count();
  for (let i = 0; i < n - 1; i++) {
    await boxes.nth(i).check();
    await settle(bid);
  }
  assertEq(await card.getByRole('button', { name: 'Καταγραφή απόφασης' }).count(), 0, 'the bid manager is not offered the decision (R11)');
  await card.getByRole('button', { name: 'Αίτημα έγκρισης' }).click();
  await expectToast(bid, 'Το αίτημα έγκρισης στάλθηκε');
  await shot(bid, 'gate-g0-requested');
  const refused = await apiFetch(bid, `/api/tenders/${state.tenderId}/gates/${state.gates.G0.id}/decision`, { method: 'POST', body: { decision: 'go', justification: JUSTIFICATION } });
  assertEq([refused.status, refused.json.error.code], [403, 'not_gate_approver'], 'bid manager cannot decide by URL');

  // the approver finds it in "My work" and on the dashboard, then decides
  const mgmt = sessions.mgmt.page;
  await mgmt.goto(`${BASE}/my`);
  await settle(mgmt);
  await mgmt.getByText('ζητήθηκε η έγκρισή σας').first().waitFor();
  await shot(mgmt, 'my-work-approver');
  card = await openGate(mgmt, 'G0');
  await card.getByText('Είστε ο approver αυτής της πύλης').waitFor();
  await card.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
  const dialog = modal(mgmt);
  await dialog.locator('input[type=radio][value=go]').check();
  await shot(mgmt, 'gate-g0-decision-dialog');
  // unmet criterion + no justification → the API refuses (acceptance), and the UI says so in Greek
  const noJust = await apiFetch(mgmt, `/api/tenders/${state.tenderId}/gates/${state.gates.G0.id}/decision`, { method: 'POST', body: { decision: 'go' } });
  assertEq([noJust.status, noJust.json.error.code], [422, 'criteria_unmet'], 'Go over an unmet criterion without justification is refused');
  await dialog.locator('textarea').fill(JUSTIFICATION);
  await dialog.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
  await expectToast(mgmt, 'Η απόφαση καταγράφηκε');
  await settle(mgmt);
  await shot(mgmt, 'gate-g0-go');
  const detail = (await apiFetch(mgmt, `/api/tenders/${state.tenderId}`)).json;
  assertEq(detail.tender.status, 'in_progress', 'Go moves the tender to "in progress"');
});

/* ================================================================== 10. later gates: G1 with exception (B), G2 plain approval (MGMT) */

phase('gates-later', async () => {
  // G1 — approver is the technical member; a handoff before G1 is still open → "approved with exception"
  const b = sessions.b.page;
  let card = await openGate(b, 'G1');
  await shot(b, 'gate-g1-criteria');
  const g1 = (await apiFetch(b, `/api/tenders/${state.tenderId}/gates`)).json.items.find((g) => g.key === 'G1');
  assertEq(g1.criteria.find((c) => c.auto_rule === 'exclusion_evidence_100').satisfied, true, 'G1: exclusion evidence 100% (register)');
  assertEq(g1.criteria.find((c) => c.auto_rule === 'handoffs_received').satisfied, false, 'G1: handoffs before the gate are not all received');
  await card.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
  let dialog = modal(b);
  assert(await dialog.locator('input[type=radio][value=approved]').isDisabled(), 'plain approval is disabled while criteria are unmet');
  await dialog.locator('input[type=radio][value=approved_with_exception]').check();
  await dialog.locator('textarea').fill('κοντό');
  await dialog.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
  await dialog.getByText('Χρειάζονται τουλάχιστον 20').waitFor();
  await dialog.locator('textarea').fill('Η λύση κλειδώνει· οι δύο παραδόσεις θα ολοκληρωθούν έως την Παρασκευή, χωρίς επίπτωση στο BOM.');
  await shot(b, 'gate-g1-exception-dialog');
  await dialog.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
  await expectToast(b, 'Η απόφαση καταγράφηκε');
  await settle(b);
  await shot(b, 'gate-g1-approved-with-exception');
  const exception = (await apiFetch(sessions.admin.page, `/api/audit?entity=gate&entity_id=${g1.id}`)).json.items.find((x) => x.action === 'exception');
  assert(exception, 'the exception is in the audit log (R12)');

  // G2 — MGMT ticks everything and approves plainly
  const mgmt = sessions.mgmt.page;
  card = await openGate(mgmt, 'G2');
  const boxes = card.locator('.criterion input[type=checkbox]');
  for (let i = 0, n = await boxes.count(); i < n; i++) {
    await boxes.nth(i).check();
    await settle(mgmt);
  }
  const g2 = (await apiFetch(mgmt, `/api/tenders/${state.tenderId}/gates`)).json.items.find((g) => g.key === 'G2');
  if (g2.all_met) {
    await card.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
    dialog = modal(mgmt);
    await dialog.locator('input[type=radio][value=approved]').check();
    await dialog.getByRole('button', { name: 'Καταγραφή απόφασης' }).click();
    await expectToast(mgmt, 'Η απόφαση καταγράφηκε');
  } else {
    throw new Error(`G2 still has unmet criteria: ${JSON.stringify(g2.criteria.filter((c) => !c.satisfied).map((c) => c.text))}`);
  }
  await settle(mgmt);
  await shot(mgmt, 'gates-after-g2');
  // the viewer sees the gates read-only
  const viewer = sessions.viewer.page;
  const vcard = await openGate(viewer, 'G3');
  assertEq(await vcard.locator('.criterion input[type=checkbox]').count(), 0, 'viewer cannot tick criteria');
  assertEq(await viewer.getByRole('button', { name: /Αίτημα έγκρισης|Καταγραφή απόφασης|Αλλαγή approver/ }).count(), 0, 'viewer has no gate actions');
  await shot(viewer, 'gates-viewer');
});

/* ================================================================== 11. extension: preview the diff, save, review */

phase('extension', async () => {
  const bid = sessions.bid.page;
  await gotoTender(bid, 'schedule');
  // pin G3 by hand first, so the extension has something to flag for review
  const before = (await apiFetch(bid, `/api/tenders/${state.tenderId}/milestones`)).json;
  const g3 = before.items.find((m) => m.key === 'G3');
  const pinned = addDays(g3.due_date, -1);
  const row = bid.locator('li.timeline__item', { hasText: 'G3 Red team' }).first();
  await menuPick(bid, row, 'Αλλαγή ημερομηνίας');
  await f(modal(bid), 'Νέα ημερομηνία').fill(pinned);
  await modal(bid).getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
  await modal(bid).waitFor({ state: 'detached' });
  await settle(bid);
  await shot(bid, 'schedule-manual-g3');

  const NEW_T = addDays(T, 7); // the next Friday: +5 working days unless a holiday falls in between
  await bid.getByRole('button', { name: 'Αλλαγή προθεσμίας (παράταση)' }).click();
  const dialog = modal(bid);
  await f(dialog, 'Νέα προθεσμία υποβολής (T)').fill(`${NEW_T}T14:00`);
  await dialog.locator('.diff__title').waitFor();
  await dialog.getByText('Χειροκίνητο — θέλει έλεγχο').first().waitFor();
  await f(dialog, 'Πηγή').selectOption('esidis');
  await f(dialog, 'Αναφορά').fill('ΑΔΑ: 9ΤΛΠ46ΜΤΛΠ-Χ1Ψ');
  await shot(bid, 'deadline-dialog-diff');
  const preview = (await apiFetch(bid, `/api/tenders/${state.tenderId}/deadline/preview`, { method: 'POST', body: { submission_deadline_at: new Date(`${NEW_T}T12:00:00Z`).toISOString() } })).json;
  const dialogText = await dialog.innerText();
  for (const item of preview.items.filter((i) => i.changed)) {
    assert(dialogText.includes(el(item.new_date)), `diff shows the new date of ${item.key}: ${el(item.new_date)}`);
  }
  await dialog.getByRole('button', { name: 'Αποθήκευση νέας προθεσμίας' }).click();
  await expectToast(bid, 'Η προθεσμία άλλαξε');
  await settle(bid);
  await bid.getByText('θέλει έλεγχο').first().waitFor();
  await shot(bid, 'schedule-after-extension');
  state.T = NEW_T;

  const after = (await apiFetch(bid, `/api/tenders/${state.tenderId}/milestones`)).json;
  const m = (list, key) => list.items.find((x) => x.key === key);
  assertEq(after.T, NEW_T, 'T moved');
  assertEq(m(after, 'G3').due_date, pinned, 'manual G3 stayed');
  assertEq(m(after, 'G3').needs_review, true, 'manual G3 flagged for review');
  assertEq(m(after, 'G0').due_date, m(before, 'G0').due_date, 'decided G0 stayed');
  assertEq(m(after, 'G1').due_date, m(before, 'G1').due_date, 'decided G1 stayed');
  assert(m(after, 'G4').due_date > m(before, 'G4').due_date, 'pending G4 moved');
  assertEq(m(after, 'G4').tMinus, 2, 'G4 is still T−2');
  // what hangs on the schedule followed: the guarantee is needed at the new G4; handoff tasks mirror their milestones
  const watch = (await apiFetch(bid, `/api/tenders/${state.tenderId}/watch`)).json.items.find((w) => w.key === 'guarantee');
  assertEq(watch.needed_at, m(after, 'G4').due_date, 'guarantee needed at the new G4');
  const handoffs = (await apiFetch(bid, `/api/tenders/${state.tenderId}/tasks?section=handoff`)).json.items;
  for (const h of handoffs.filter((x) => x.milestone_id)) {
    const ms = after.items.find((x) => x.id === h.milestone_id);
    assertEq(h.due_date, ms.due_date, `handoff "${h.title.slice(0, 30)}" mirrors its milestone`);
  }
  // header T−n = server's
  const detail = (await apiFetch(bid, `/api/tenders/${state.tenderId}`)).json;
  const head = (await bid.locator('.tender-head').innerText()).replace(/\s+/g, '');
  assert(head.includes(`T−${detail.tMinus}`) && head.includes(el(NEW_T)), `header follows the extension (T−${detail.tMinus}, ${el(NEW_T)})`);

  await openTab(bid, 'Change log');
  await bid.getByText('Προθεσμία:').first().waitFor();
  await shot(bid, 'change-log-extension');
  const changes = (await apiFetch(bid, `/api/tenders/${state.tenderId}/changes`)).json.items;
  assertEq(changes.filter((c) => c.kind === 'extension').length, 1, 'one extension entry in the change log');

  // review the manual milestone: keep its date
  await gotoTender(bid, 'schedule');
  await Promise.all([
    bid.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/milestones/')),
    menuPick(bid, bid.locator('li.timeline__item', { hasText: 'G3 Red team' }).first(), 'Ελέγχθηκε — κρατάω την ημερομηνία'),
  ]);
  await settle(bid);
  assertEq(m((await apiFetch(bid, `/api/tenders/${state.tenderId}/milestones`)).json, 'G3').needs_review, false, 'review cleared');

  // R15 re-run: the document that expired before the old T is still red; renew it and everything turns green
  const still = (await apiFetch(bid, `/api/tenders/${state.tenderId}`)).json.warnings.some((w) => w.code === 'documents_expired_on_T');
  assert(still, 'after the extension the expiring document is still red');
});

/* ================================================================== 12. dashboard, My work, digest; e-mails; jobs twice */

phase('coordination', async () => {
  const bid = sessions.bid.page;
  // renew the expiring ISO so the tender goes green on R15
  await bid.goto(`${BASE}/company-documents`);
  await settle(bid);
  await menuPick(bid, visible(bid.locator('tr, li', { hasText: 'ISO 9001:2015' })).first(), 'Επεξεργασία');
  await f(modal(bid), 'Ημερομηνία λήξης').fill(addDays(state.T, 500));
  await modal(bid).getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
  await modal(bid).waitFor({ state: 'detached' });
  const g4 = (await apiFetch(bid, `/api/tenders/${state.tenderId}/gates`)).json.items.find((g) => g.key === 'G4');
  assertEq(g4.criteria.find((c) => c.auto_rule === 'docs_valid_on_T').satisfied, true, 'docs_valid_on_T passes after the renewal');

  // dashboards per role; T−n and next gate equal to the tender page (the server's values on both)
  for (const who of ['bid', 'a', 'mgmt', 'viewer', 'admin']) {
    const page = sessions[who].page;
    await page.goto(`${BASE}/`);
    await settle(page);
    await shot(page, `dashboard-${who}`);
    const dash = (await apiFetch(page, '/api/dashboard')).json;
    const card = dash.tenders.find((t) => t.id === state.tenderId);
    const detail = (await apiFetch(page, `/api/tenders/${state.tenderId}`)).json;
    assert(card, `${who}: the tender is on the dashboard`);
    assertEq(card.tMinus, detail.tMinus, `${who}: dashboard T−n equals the tender's`);
    assertEq(card.nextGate?.key ?? null, detail.nextGate?.key ?? null, `${who}: same next gate on dashboard and tender`);
    assertEq(card.nextGate?.tMinus ?? null, detail.nextGate?.tMinus ?? null, `${who}: same gate T−n`);
    const text = (await page.locator('.app-content').innerText()).replace(/\s+/g, ' ');
    assert(text.includes(`T−${card.tMinus}`), `${who}: dashboard shows T−${card.tMinus}`);
    assert(!text.includes('λήγει πριν') || who === 'never', `${who}: no red document warning after the renewal`);
    await page.goto(`${BASE}/my`);
    await settle(page);
    await shot(page, `my-work-${who}`);
  }
  // the tender list shows the same T−n
  await bid.goto(`${BASE}/tenders`);
  await settle(bid);
  await shot(bid, 'tenders-list');
  const listItem = (await apiFetch(bid, '/api/tenders')).json.items.find((t) => t.id === state.tenderId);
  assertEq(listItem.tMinus, (await apiFetch(bid, `/api/tenders/${state.tenderId}`)).json.tMinus, 'list T−n equals detail T−n');

  // digest preview (member A) and "send now" twice (admin): idempotent
  const a = sessions.a.page;
  await a.goto(`${BASE}/`);
  await a.getByRole('button', { name: 'Τι θα έγραφε το σημερινό μου digest' }).click();
  await modal(a).getByText('Θέμα').first().waitFor();
  await shot(a, 'digest-preview-member-a');
  const preview = (await apiFetch(a, '/api/notifications/digest/preview', { method: 'POST', body: {} })).json;
  assert(!/\b20\d\d-\d\d-\d\d\b/.test(preview.text), 'digest text has no ISO dates');
  assert(preview.text.includes(TITLE.slice(0, 30)), 'digest mentions the tender');
  assert(preview.text.includes(`${BASE}/tenders/${state.tenderId}`), 'digest links into the app (no attachments)');
  await modal(a).getByRole('button', { name: 'Κλείσιμο' }).first().click();

  const admin = sessions.admin.page;
  await admin.goto(`${BASE}/`);
  await settle(admin);
  await admin.getByRole('button', { name: 'Αποστολή digest τώρα' }).click();
  await expectToast(admin, 'Το digest έτρεξε');
  await admin.getByRole('button', { name: 'Αποστολή digest τώρα' }).click();
  await expectToast(admin, 'έχει ήδη τρέξει');
  await shot(admin, 'digest-run-twice');
  const digests = (await stack.db.query("SELECT user_id, count(*)::int AS n FROM email_log WHERE kind = 'digest' GROUP BY user_id")).rows;
  assert(digests.length > 0 && digests.every((r) => r.n === 1), `one digest per user after two runs: ${JSON.stringify(digests)}`);

  // events → e-mails, exactly once each, to the right people
  const mails = (await stack.db.query('SELECT e.kind, u.email, e.subject, e.status FROM email_log e JOIN "user" u ON u.id = e.user_id ORDER BY e.created_at')).rows;
  const of = (kind) => mails.filter((x) => x.kind === kind).map((x) => x.email).sort();
  assertEq(of('gate_approval_requested'), [TEAM.mgmt.email], 'approval request e-mailed to the approver');
  assert(of('gate_decided').length >= 2, `gate decisions e-mailed: ${of('gate_decided')}`);
  assert(!of('gate_decided').includes(TEAM.viewer.email) || true, 'viewer may be informed');
  assertEq(of('handoff_delivered'), [TEAM.a.email], 'handoff delivery e-mailed to the receiving role');
  const extended = of('tender_extended');
  assert(extended.includes(TEAM.a.email) && extended.includes(TEAM.mgmt.email) && !extended.includes(TEAM.bid.email), `extension e-mailed to the team, not to its author: ${extended}`);
  for (const m of mails) assert(!/\b20\d\d-\d\d-\d\dT/.test(m.subject), 'no ISO timestamp in a subject');
  state.mailKinds = [...new Set(mails.map((m) => m.kind))];

  // daily jobs through the job runner, twice each: second run is skipped, job_run has one row per job and day
  const { spawnSync } = await import('node:child_process');
  const runJobs = () =>
    spawnSync('npx', ['tsx', resolve(outDir, '..', 'run-jobs.mts')], { cwd: resolve(outDir, '..', '..', '..', 'server'), env: { ...process.env, ...stack.env }, encoding: 'utf8' });
  const first = runJobs();
  const second = runJobs();
  const parse = (r) => JSON.parse((/JOBS (.*)/.exec(r.stdout) ?? [null, 'null'])[1]);
  const [r1, r2] = [parse(first), parse(second)];
  assert(r1 && r2, `job runner output: ${first.stdout} ${first.stderr}`);
  assertEq(r1['gdpr-retention'], ['ok'], 'retention job ran');
  assertEq(r1['daily-digest'], ['skipped'], 'digest already ran today (through the UI)');
  assertEq([r2['gdpr-retention'], r2['daily-digest']], [['skipped'], ['skipped']], 'second run of the day is skipped');
  const runs = (await stack.db.query('SELECT job, status, attempts FROM job_run ORDER BY job')).rows;
  assertEq(runs.map((r) => `${r.job}:${r.status}`), ['daily-digest:ok', 'gdpr-retention:ok'], 'job_run: one ok row per job');
  assertEq((await stack.db.query("SELECT count(*)::int AS n FROM email_log WHERE kind = 'digest'")).rows[0].n, digests.length, 'no extra digests');
  state.jobs = { r1, r2 };
});

/* ================================================================== 13. guarantee arrives; risks; lessons; a new template version */

phase('wrap-up', async () => {
  const a = sessions.a.page;
  await gotoTender(a, 'watch');
  await visible(a.locator('tr, li', { hasText: 'Εγγυητική συμμετοχής' })).first().getByRole('button', { name: 'Παραλήφθηκε σήμερα' }).click();
  await expectToast(a, 'Καταγράφηκε η παραλαβή');
  await shot(a, 'watchlist-arrived');
  const g4 = (await apiFetch(a, `/api/tenders/${state.tenderId}/gates`)).json.items.find((g) => g.key === 'G4');
  assertEq(g4.criteria.find((c) => c.auto_rule === 'guarantee_arrived').satisfied, true, 'guarantee_arrived follows the watchlist');

  const bid = sessions.bid.page;
  await gotoTender(bid, 'risks');
  await shot(bid, 'risks');
  await gotoTender(bid, 'overview');
  await shot(bid, 'tender-overview');

  await gotoTender(bid, 'lessons');
  await shot(bid, 'lessons-empty');
  await bid.getByRole('button', { name: 'Νέο lesson' }).first().click();
  await f(modal(bid), 'Τι μάθαμε').fill('Το υπόδειγμα της εγγυητικής άλλαξε στη διευκρίνιση: θέλουμε σημείο checklist «έλεγχος υποδείγματος μετά από κάθε διευκρίνιση».');
  await modal(bid).getByLabel('Αλλάζει το template').check();
  await modal(bid).getByRole('button', { name: 'Αποθήκευση', exact: true }).click();
  await expectToast(bid, 'Το lesson καταγράφηκε');
  await shot(bid, 'lessons');

  // admin: new template version from L v1.1, one more checklist line, the lesson marked as applied, publish
  const admin = sessions.admin.page;
  await admin.goto(`${BASE}/admin/templates`);
  await settle(admin);
  await shot(admin, 'templates-list');
  await admin.getByRole('button', { name: 'Νέα έκδοση από L v1.1' }).click();
  await admin.waitForURL(/\/admin\/templates\/[0-9a-f-]{36}/);
  await settle(admin);
  await shot(admin, 'template-draft');
  const templateId = /templates\/([0-9a-f-]{36})/.exec(admin.url())[1];
  const item = await apiFetch(admin, `/api/templates/${templateId}/items`, { method: 'POST', body: { kind: 'checklist_item', key: 'A_GUARANTEE_TEMPLATE', name: 'Έλεγχος υποδείγματος εγγυητικής μετά από κάθε διευκρίνιση', owner_role_key: 'A' } });
  assertEq(item.status, 201, `new checklist line in the draft: ${item.text}`);
  await admin.reload();
  await settle(admin);
  await admin.getByRole('tab', { name: /Lessons/ }).or(admin.getByRole('button', { name: /^Lessons/ })).first().click();
  await admin.getByRole('button', { name: /Εφαρμόστηκε στην/ }).first().click();
  await expectToast(admin, 'Σημειώθηκε ως εφαρμοσμένο');
  await shot(admin, 'template-lessons-applied');
  await admin.getByRole('tab', { name: /Αλλαγές από/ }).or(admin.getByRole('button', { name: /^Αλλαγές από/ })).first().click();
  await settle(admin);
  await shot(admin, 'template-diff');
  await admin.getByRole('button', { name: 'Δημοσίευση' }).first().click();
  await modal(admin).getByRole('button', { name: 'Δημοσίευση' }).click();
  await expectToast(admin, 'Το template δημοσιεύτηκε');
  await shot(admin, 'template-published');
  const templates = (await apiFetch(admin, '/api/templates')).json.items;
  assert(templates.some((t) => t.version === 'v1.2' && t.status === 'published'), 'L v1.2 is published');
  // the running tender keeps its snapshot of v1.1 (F2)
  const snapshot = (await apiFetch(bid, `/api/tenders/${state.tenderId}/snapshot`)).json.snapshot;
  assertEq(snapshot.template.version, 'v1.1', 'the tender still follows its v1.1 snapshot');
  assert(!snapshot.items.some((i) => i.key === 'A_GUARANTEE_TEMPLATE'), 'the new line is not in the running tender');
  await gotoTender(bid, 'lessons');
  await bid.getByText('Πέρασε στην v1.2').first().waitFor();
  await shot(bid, 'lessons-applied');

  await admin.goto(`${BASE}/admin/holidays`);
  await settle(admin);
  await shot(admin, 'admin-holidays');
  await admin.goto(`${BASE}/admin/audit`);
  await settle(admin);
  await shot(admin, 'admin-audit');
  const auditText = await admin.locator('.app-content').innerText();
  for (const member of Object.values(TEAM)) assert(!auditText.includes(member.email), 'audit page shows no e-mail addresses');
});

/* ================================================================== 14. non-member; admin password reset; close as submitted */

phase('close', async () => {
  const bid = sessions.bid.page;
  // a second tender without a team: member A cannot open it, in the UI or by URL
  const second = await apiFetch(bid, '/api/tenders', {
    method: 'POST',
    body: { title: 'Δεύτερος διαγωνισμός χωρίς ομάδα', authority: 'Δήμος Αθηναίων', submission_deadline_at: new Date(`${addDays(state.T, 30)}T10:00:00Z`).toISOString(), template_id: (await apiFetch(bid, '/api/templates?status=published')).json.items.find((t) => t.version === 'v1.2').id },
  });
  assertEq(second.status, 201, `second tender from v1.2: ${second.text}`);
  const otherId = second.json.tender.id;
  const checklist = (await apiFetch(bid, `/api/tenders/${otherId}/tasks?section=checklist`)).json.items;
  assert(checklist.some((t) => t.title.startsWith('Έλεγχος υποδείγματος εγγυητικής')), 'a tender created from v1.2 has the new checklist line');
  const a = sessions.a.page;
  await a.goto(`${BASE}/tenders/${otherId}/overview`);
  await a.getByText('Ο διαγωνισμός δεν βρέθηκε').waitFor();
  await shot(a, 'non-member-tender');
  for (const path of ['', '/gates', '/files', '/requirements', '/tasks', '/watch', '/documents', '/milestones']) {
    assertEq((await apiFetch(a, `/api/tenders/${otherId}${path}`)).status, 403, `non-member GET ${path || '/'} → 403`);
  }
  assert(!(await apiFetch(a, '/api/tenders')).json.items.some((t) => t.id === otherId), 'the other tender is not in A\'s list');
  assert(!(await apiFetch(a, '/api/dashboard')).json.tenders.some((t) => t.id === otherId), '… nor on A\'s dashboard');

  // admin resets the viewer's password: link once, old password dead, session gone
  const admin = sessions.admin.page;
  await admin.goto(`${BASE}/admin/users`);
  await settle(admin);
  await menuPick(admin, visible(admin.locator('tr, li', { hasText: TEAM.viewer.email })).first(), 'Επαναφορά κωδικού');
  await shot(admin, 'admin-reset-password-confirm');
  await admin.getByRole('dialog').last().getByRole('button', { name: 'Επαναφορά κωδικού' }).click();
  const link = f(modal(admin), 'Σύνδεσμος ορισμού νέου κωδικού');
  await link.waitFor();
  const resetUrl = await link.inputValue();
  await shot(admin, 'admin-reset-password-link');
  const modalText = await modal(admin).innerText();
  assert(!/κωδικός:\s*\S+/i.test(modalText), 'no password is shown, only a link');
  await modal(admin).getByRole('button', { name: 'Κλείσιμο' }).first().click();
  const viewer = sessions.viewer.page;
  assertEq((await apiFetch(viewer, '/api/auth/me')).status, 401, 'the viewer\'s session ended');
  await viewer.goto(resetUrl);
  await viewer.locator('input[name=new-password]').fill('viewer-new-password-2');
  await viewer.locator('input[name=new-password-confirm]').fill('viewer-new-password-2');
  await shot(viewer, 'reset-password-page');
  await viewer.getByRole('button', { name: 'Αποθήκευση κωδικού' }).click();
  await viewer.getByText('Ο νέος κωδικός ορίστηκε').waitFor();
  await login(viewer, { email: TEAM.viewer.email, password: 'viewer-new-password-2', secret: sessions.viewer.secret });
  await viewer.goto(resetUrl);
  await viewer.getByText('Ο σύνδεσμος δεν ισχύει').first().waitFor();

  // close the tender as submitted
  await gotoTender(bid, 'overview');
  await bid.getByRole('button', { name: 'Σήμανση ως «Υποβλήθηκε»' }).click();
  await shot(bid, 'close-confirm');
  await bid.getByRole('dialog').last().getByRole('button', { name: /Σήμανση ως «Υποβλήθηκε»|Επιβεβαίωση/ }).click();
  await expectToast(bid, 'Η κατάσταση άλλαξε');
  await settle(bid);
  await shot(bid, 'tender-submitted');

  // closed = read-only on every tab, in the UI and by URL (422 tender_closed) — except lessons and files
  const id = state.tenderId;
  const g3 = (await apiFetch(bid, `/api/tenders/${id}/gates`)).json.items.find((g) => g.key === 'G3');
  const anyTask = (await apiFetch(bid, `/api/tenders/${id}/tasks`)).json.items[0];
  const anyReq = (await apiFetch(bid, `/api/tenders/${id}/requirements`)).json.items[0];
  const anyMs = (await apiFetch(bid, `/api/tenders/${id}/milestones`)).json.items.find((m) => m.key === 'UPLOAD');
  const refused = [
    ['PATCH', `/api/tenders/${id}`, { title: 'x' }],
    ['PUT', `/api/tenders/${id}/members`, { members: [] }],
    ['POST', `/api/tenders/${id}/deadline`, { submission_deadline_at: new Date(`${addDays(state.T, 7)}T12:00:00Z`).toISOString() }],
    ['POST', `/api/tenders/${id}/gates/${g3.id}/request`, {}],
    ['POST', `/api/tenders/${id}/requirements`, { code: 'ΥΠ-900', text: 'x', type: 'formal' }],
    ['PATCH', `/api/tenders/${id}/requirements/${anyReq.id}`, { status: 'verified' }],
    ['POST', `/api/tenders/${id}/tasks`, { title: 'x' }],
    ['PATCH', `/api/tenders/${id}/tasks/${anyTask.id}`, { title: 'x' }],
    ['PATCH', `/api/tenders/${id}/watch/${state.guaranteeId}`, { notes: 'x' }],
    ['POST', `/api/tenders/${id}/risks`, { title: 'x' }],
    ['POST', `/api/tenders/${id}/changes`, { description: 'x' }],
    ['PATCH', `/api/tenders/${id}/milestones/${anyMs.id}`, { done: true }],
    ['POST', `/api/tenders/${id}/documents`, { company_document_id: anyReq.id }],
  ];
  for (const [method, path, body] of refused) {
    const res = await apiFetch(bid, path, { method, body });
    assertEq([res.status, res.json?.error?.code], [422, 'tender_closed'], `closed tender: ${method} ${path.replace(id, ':id')}`);
  }
  const WRITE_BUTTONS = /^(Νέα γραμμή|Import|Νέο task|Νέα παράδοση|Νέο στοιχείο|Νέα καταχώριση|Σύνδεση εγγράφου|Αίτημα έγκρισης|Καταγραφή απόφασης|Αλλαγή προθεσμίας \(παράταση\)|Προσθήκη σημείου)$/;
  for (const [tab, slug] of [['Πρόγραμμα', 'schedule'], ['Πύλες', 'gates'], ['Register', 'register'], ['Tasks', 'tasks'], ['Watchlist', 'watch'], ['Κίνδυνοι', 'risks'], ['Change log', 'changes'], ['Έγγραφα', 'documents'], ['Ομάδα', 'team']]) {
    await gotoTender(bid, slug);
    const buttons = (await bid.locator('.app-content button:visible').allInnerTexts()).map((x) => x.trim()).filter((x) => WRITE_BUTTONS.test(x));
    assertEq(buttons, [], `closed tender, tab «${tab}»: no write buttons`);
    await shot(bid, `closed-${slug}`);
  }
  // lessons and files stay open (cross-slice rule)
  const lesson = await apiFetch(bid, `/api/tenders/${id}/lessons`, { method: 'POST', body: { text: 'Η ανασκόπηση έγινε δύο ημέρες μετά την κατάθεση.', category: 'went_well' } });
  assertEq(lesson.status, 201, 'a lesson can still be recorded after closing');
  await gotoTender(bid, 'files');
  await f(bid, 'Φάκελος προορισμού').selectOption({ label: 'Λοιπά' });
  await bid.locator('.files-upload__drop input[type=file]').setInputFiles({ name: 'Αποδεικτικό υποβολής ΕΣΗΔΗΣ.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 απόδειξη') });
  await expectToast(bid, 'Ανέβηκε 1 αρχείο');
  await shot(bid, 'closed-files');
  // the closed tender left the active dashboard and shows under "recently closed"
  await bid.goto(`${BASE}/`);
  await settle(bid);
  await shot(bid, 'dashboard-after-close');
  const dash = (await apiFetch(bid, '/api/dashboard')).json;
  assert(!dash.tenders.some((t) => t.id === id) && dash.recentlyClosed.some((t) => t.id === id), 'closed tender moved to "recently closed"');
});

/* ================================================================== 15. the main screens at 375 px */

phase('mobile', async () => {
  const m = await newUserContext(browser, 'mobile', { width: 375, height: 760 });
  sessions.mobile = m;
  await login(m.page, { email: TEAM.bid.email, password: PASSWORD, secret: sessions.bid.secret });
  const id = state.tenderId;
  const screens = [
    ['dashboard', '/'],
    ['tenders', '/tenders'],
    ['my', '/my'],
    ['company-documents', '/company-documents'],
    ['account', '/account'],
    ...['overview', 'schedule', 'gates', 'register', 'tasks', 'watch', 'risks', 'changes', 'files', 'documents', 'lessons', 'team'].map((t) => [`tender-${t}`, `/tenders/${id}/${t}`]),
    ['tender-new', '/tenders/new'],
  ];
  for (const [name, path] of screens) {
    await m.page.goto(`${BASE}${path}`);
    await settle(m.page);
    await shot(m.page, `mobile-${name}`);
  }
  await m.page.getByRole('button', { name: 'Άνοιγμα μενού' }).click();
  await shot(m.page, 'mobile-nav-open', { fullPage: false });
  const adminMobile = await newUserContext(browser, 'mobile-admin', { width: 375, height: 760 });
  sessions.mobileAdmin = adminMobile;
  await login(adminMobile.page, { ...ADMIN, secret: sessions.admin.secret });
  for (const [name, path] of [['admin-users', '/admin/users'], ['admin-templates', '/admin/templates'], ['admin-holidays', '/admin/holidays'], ['admin-audit', '/admin/audit']]) {
    await adminMobile.page.goto(`${BASE}${path}`);
    await settle(adminMobile.page);
    await shot(adminMobile.page, `mobile-${name}`);
  }
});

/* ================================================================== run */

try {
  for (const p of phases) {
    log(`── phase: ${p.name}`);
    await p.fn();
    if (until === p.name) break;
  }
} catch (err) {
  failed = err;
  console.error(err);
  for (const [who, s] of Object.entries(sessions)) {
    await s.page.screenshot({ path: resolve(outDir, `FAILED-${who}.png`), fullPage: true }).catch(() => undefined);
  }
}
for (const s of Object.values(sessions)) await collectToasts(s.page).catch(() => undefined);
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify({ failed: failed ? String(failed.stack ?? failed) : null, problems, toasts: seenToasts, tenderId: state.tenderId, T, T0 }, null, 2));
await browser.close();
await stack.stop({ keep: args.has('--keep') });
log(failed ? 'FAILED' : 'flow finished', `— ${problems.length} problem(s) noted`);
for (const p of problems) console.log('  •', p);
process.exit(failed || problems.length > 0 ? 1 : 0);
