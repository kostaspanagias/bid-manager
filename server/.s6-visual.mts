import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const { createServer } = await import('vite');
const { migrate } = await import('./src/db/migrate.ts');
await migrate(process.env.DATABASE_URL!);
const { createApp } = await import('./src/app.ts');
const { createOrganization, closeDatabase } = await import('./src/db/admin.ts');
const { scopedDb } = await import('./src/db/scoped.ts');
const { randomToken, sha256Hex } = await import('./src/core/crypto.ts');
const { shiftDays } = await import('./src/domain/calendar.ts');
const { todayAthens } = await import('./src/domain/time.ts');
const out = process.env.SHOTS!;
const only = process.argv[2];

const org = await createOrganization({ name: 'Active Computer Systems' });
const db = scopedDb(org.id, null);
const mkUser = (name: string, email: string, org_role: string) => db.insert('user', { name, email, org_role, totp_enabled_at: new Date() });
const admin = await mkUser('Κώστας Παναγιάς', 'kostas@example.gr', 'admin');
const fin = await mkUser('Ελένη Παπαδοπούλου', 'eleni@example.gr', 'member');
const tech = await mkUser('Γιώργος Δημητρίου', 'giorgos@example.gr', 'member');
const viewer = await mkUser('Νίκος Σταθόπουλος', 'nikos@partner.example.gr', 'viewer');
const users = [admin, fin, tech, viewer];
const today = todayAthens();
const tender = await db.insert('tender', { title: 'Προμήθεια και εγκατάσταση εξοπλισμού πληροφορικής και δικτύου για τις περιφερειακές υπηρεσίες', authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης', status: 'in_progress', t0_published_at: new Date(Date.now() - 6 * 864e5), submission_deadline_at: new Date(Date.now() + 20 * 864e5), offer_validity_days: 180 });
for (const [key, name, payload] of [['A', 'Δικαιολογητικά', { folder: 'participation' }], ['B', 'Τεχνική', { folder: 'technical' }], ['C', 'Οικονομική', { folder: 'financial', financial: true }]] as const) await db.insert('tender_role', { tender_id: tender.id, key, name, payload });
await db.insert('tender_member', { tender_id: tender.id, user_id: fin.id, tender_role_key: 'C' });
await db.insert('tender_member', { tender_id: tender.id, user_id: tech.id, tender_role_key: 'B' });
await db.insert('tender_member', { tender_id: tender.id, user_id: viewer.id, tender_role_key: null });

const app = createApp();
const http = app.listen(0, '127.0.0.1');
await new Promise((r) => http.once('listening', r));
const apiPort = (http.address() as AddressInfo).port;
const vite = await createServer({ root: '/home/user/bid-manager/web', logLevel: 'error', server: { port: 0, host: '127.0.0.1', proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } } });
await vite.listen();
const base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;

async function session(user: { id: string }) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  await scopedDb(org.id, user.id).insert('session', { id: sha256Hex(token), user_id: user.id, totp_verified: true, csrf_token: csrf, expires_at: new Date(Date.now() + 36e5) });
  return { token, csrf };
}
// seed through the real API
async function call(user: { id: string }, method: string, path: string, body?: unknown, file?: { name: string; type: string; content: string; fields?: Record<string, string> }) {
  const s = await session(user);
  const headers: Record<string, string> = { cookie: `bm_session=${s.token}`, 'x-csrf-token': s.csrf };
  let payload: BodyInit | undefined;
  if (file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(file.fields ?? {})) form.append(k, v);
    form.append('file', new Blob([file.content], { type: file.type }), file.name);
    payload = form;
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${apiPort}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const up = (user: { id: string }, name: string, folder: string, kb: number, label = '') => call(user, 'POST', `/tenders/${tender.id}/files`, undefined, { name, type: 'application/pdf', content: 'x'.repeat(kb * 1024), fields: { folder, ...(label ? { label } : {}) } });
await up(admin, 'Διακήρυξη 26PROC017654321.pdf', 'tender_docs', 2400);
await up(admin, 'Παράρτημα Α - Τεχνικές προδιαγραφές.pdf', 'tender_docs', 880);
await up(admin, 'Διευκρινίσεις 12-11-2026.pdf', 'clarifications', 140);
await up(tech, 'Τεχνική προσφορά v3.docx', 'technical', 5200, 'Προς έλεγχο');
await up(tech, 'Πίνακας συμμόρφωσης.xlsx', 'technical', 96);
await up(fin, 'Οικονομική προσφορά - τελική.xlsx', 'financial', 310, 'Τελικό');
await up(fin, 'Κοστολόγηση εξοπλισμού.xlsx', 'financial', 75);
const doc = async (body: Record<string, unknown>, file?: string) => {
  const d = await call(admin, 'POST', '/company-documents', body);
  if (file) await call(admin, 'PUT', `/company-documents/${d.id}/file`, undefined, { name: file, type: 'application/pdf', content: 'y'.repeat(180_000) });
  return d;
};
const iso = await doc({ type: 'iso', title: 'ISO 9001:2015 — Σύστημα διαχείρισης ποιότητας', issued_at: '2025-03-01', expires_at: shiftDays(today, 470), notes: 'TÜV Hellas' }, 'ISO9001.pdf');
await doc({ type: 'iso', title: 'ISO 27001:2022', issued_at: '2024-06-10', expires_at: shiftDays(today, 210) }, 'ISO27001.pdf');
const tax = await doc({ type: 'tax', title: 'Φορολογική ενημερότητα', issued_at: shiftDays(today, -48), expires_at: shiftDays(today, 12) }, 'forologiki.pdf');
const ins = await doc({ type: 'insurance', title: 'Ασφαλιστική ενημερότητα ΕΦΚΑ', issued_at: shiftDays(today, -190), expires_at: shiftDays(today, -4) }, 'efka.pdf');
const gemi = await doc({ type: 'gemi', title: 'Γενικό πιστοποιητικό ΓΕΜΗ', issued_at: shiftDays(today, -20), expires_at: shiftDays(today, 70) }, 'gemi.pdf');
const cv = await doc({ type: 'cv', title: 'CV Υπεύθυνου έργου', person_name: 'Γιώργος Δημητρίου', notes: 'PMP, 14 έτη εμπειρίας' }, 'CV_Dimitriou.pdf');
await doc({ type: 'cv', title: 'CV Μηχανικού δικτύων', person_name: 'Άννα Καραγιάννη' });
await doc({ type: 'reference_project', title: 'Έργο αναφοράς: Δίκτυο ΠΕ Αττικής (2023)', issued_at: '2023-11-30' }, 'bebaiosi.pdf');
for (const d of [iso, tax, ins, cv]) await call(admin, 'POST', `/tenders/${tender.id}/documents`, { company_document_id: d.id });
void gemi;

const browser = await chromium.launch();
const problems: string[] = [];
async function withPage(name: string, user: { id: string }, width: number, fn: (page: any, shot: (suffix: string) => Promise<void>) => Promise<void>) {
  if (only && !name.includes(only)) return;
  const s = await session(user);
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 740 : 850 }, locale: 'el-GR', timezoneId: 'Europe/Athens' });
  await context.addCookies([{ name: 'bm_session', value: s.token, url: base }]);
  const page = await context.newPage();
  page.on('pageerror', (e: Error) => problems.push(`${name}@${width}: pageerror ${e.message}`));
  page.on('console', (m: any) => { if (m.type() === 'error' && !/403|404|Failed to load resource/.test(m.text())) problems.push(`${name}@${width}: console ${m.text()}`); });
  // endpoints other slices have not filled in yet
  await page.route((url: URL) => url.pathname === '/api/users', (route: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: users.map((u) => ({ id: u.id, name: u.name, email: u.email, org_role: u.org_role })) }) }));
  const shot = async (suffix: string) => {
    await page.waitForTimeout(350);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) problems.push(`${name}-${suffix}@${width}: horizontal overflow ${overflow}px`);
    await page.screenshot({ path: `${out}/${name}-${suffix}-${width}.png`, fullPage: true });
  };
  try { await fn(page, shot); } catch (e) { problems.push(`${name}@${width}: ${(e as Error).message.split('\n')[0]}`); await page.screenshot({ path: `${out}/${name}-FAILED-${width}.png`, fullPage: true }).catch(() => {}); }
  await context.close();
}

for (const width of [1280, 375]) {
  await withPage('files-admin', admin, width, async (page, shot) => {
    await page.goto(`${base}/tenders/${tender.id}/files`);
    await page.getByText('Οικονομική προσφορά - τελική.xlsx').first().waitFor();
    await shot('list');
    // real upload through the UI into the financial folder
    await page.getByLabel('Φάκελος προορισμού').selectOption('financial');
    await page.locator('.ui-filedrop__input').setInputFiles([{ name: 'Ανάλυση τιμών.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.alloc(400_000, 1) }, { name: 'κενό.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
    await page.getByText('Ανέβηκε', { exact: true }).first().waitFor();
    await page.locator('.files-sections').getByText('Ανάλυση τιμών.xlsx').first().waitFor();
    await shot('uploaded');
    const trigger = page.getByRole('button', { name: 'Ενέργειες για «Τεχνική προσφορά v3.docx»' });
    await trigger.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await trigger.click();
    await page.waitForTimeout(400);
    console.log(width, 'menuitems after click:', await page.getByRole('menuitem').count(), 'toasts:', await page.locator('[class*=toast]').count());
    await page.screenshot({ path: `${out}/files-admin-menu-${width}.png` });
    console.log(width, 'menuitems after screenshot:', await page.getByRole('menuitem').count());
    if (!(await page.getByRole('menuitem').count())) await trigger.click();
    await page.getByRole('menuitem', { name: 'Μετονομασία / μετακίνηση' }).click();
    await page.getByRole('dialog').waitFor();
    await shot('edit');
  });
  await withPage('files-technical', tech, width, async (page, shot) => {
    await page.goto(`${base}/tenders/${tender.id}/files`);
    await page.getByText('Τεχνική προσφορά v3.docx').first().waitFor();
    if (await page.getByText('Οικονομική προσφορά').count()) problems.push('technical member sees a financial file name');
    if (await page.locator('.files-sections').getByText('Οικονομική').count()) problems.push('technical member sees the financial section');
    await shot('list');
  });
  await withPage('files-viewer', viewer, width, async (page, shot) => {
    await page.goto(`${base}/tenders/${tender.id}/files`);
    await page.getByText('Τεχνική προσφορά v3.docx').first().waitFor();
    await shot('list');
  });
  await withPage('tenderdocs', admin, width, async (page, shot) => {
    await page.goto(`${base}/tenders/${tender.id}/documents`);
    await page.locator('table').getByText('Φορολογική ενημερότητα').first().waitFor();
    await shot('list');
    await page.getByRole('button', { name: 'Σύνδεση εγγράφου' }).click();
    await page.getByText('ISO 27001:2022').first().waitFor();
    await shot('picker');
  });
  await withPage('companydocs', admin, width, async (page, shot) => {
    await page.goto(`${base}/company-documents`);
    await page.locator('table').getByText('Φορολογική ενημερότητα').first().waitFor();
    await shot('list');
    await page.getByRole('button', { name: 'Νέο έγγραφο' }).click();
    await page.getByRole('dialog').getByLabel('Τύπος').selectOption('cv');
    await shot('add');
    await page.getByRole('button', { name: 'Άκυρο' }).click();
    await page.getByRole('button', { name: 'Ενέργειες για «Φορολογική ενημερότητα»' }).click();
    await page.getByRole('menuitem').first().waitFor();
    await page.screenshot({ path: `${out}/companydocs-menu-${width}.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'GDPR' }).click();
    await page.getByRole('dialog').getByLabel('Λογαριασμός χρήστη').selectOption(tech.id);
    await page.getByRole('button', { name: 'Προεπισκόπηση' }).click();
    await page.getByText('Θα διαγραφούν').first().waitFor();
    await page.getByLabel(/Για επιβεβαίωση/).fill('ΔΙΑΓΡΑΦΗ');
    await shot('gdpr-erase');
    await page.getByRole('tab', { name: 'Διατήρηση αρχείων' }).click();
    await page.getByText('Χωρίς αυτόματη διαγραφή').first().waitFor();
    await page.getByLabel('Χωρίς αυτόματη διαγραφή').uncheck();
    await shot('gdpr-retention');
  });
  await withPage('companydocs-member', tech, width, async (page, shot) => {
    await page.goto(`${base}/company-documents`);
    await page.locator('table').getByText('Φορολογική ενημερότητα').first().waitFor();
    if (await page.getByText('Άννα Καραγιάννη').count()) problems.push('member sees an unlinked CV');
    await shot('list');
  });
}
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no problems');
await browser.close();
await vite.close();
await new Promise((r) => http.close(r));
await closeDatabase();
process.exit(0);
