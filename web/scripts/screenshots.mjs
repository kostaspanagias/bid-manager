/**
 * Visual smoke test: starts Vite, mocks /api/* with Playwright and writes screenshots of the main screens
 * (desktop 1280px and mobile 375px) to web/scripts/screenshots/.
 *
 *   node web/scripts/screenshots.mjs            # all shots
 *   node web/scripts/screenshots.mjs users      # only shots whose name contains "users"
 *
 * Needs no server and no database. Playwright + Chromium are expected to be preinstalled (not a dependency).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(here, 'screenshots');
const only = process.argv[2];
mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------- mock data */
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = [
  { id: uid(1), name: 'Κώστας Παναγιάς', email: 'kostas@example.gr', org_role: 'admin', active: true, totp_enabled: true, last_login_at: '2026-11-13T07:42:00Z' },
  { id: uid(2), name: 'Μαρία Αντωνίου', email: 'maria@example.gr', org_role: 'bid_manager', active: true, totp_enabled: true, last_login_at: '2026-11-12T16:05:00Z' },
  { id: uid(3), name: 'Γιώργος Δημητρίου', email: 'giorgos@example.gr', org_role: 'member', active: true, totp_enabled: true, last_login_at: '2026-11-13T06:58:00Z' },
  { id: uid(4), name: 'Ελένη Παπαδοπούλου', email: 'eleni@example.gr', org_role: 'approver', active: true, totp_enabled: false, last_login_at: null },
  { id: uid(5), name: 'Νίκος Σταθόπουλος', email: 'nikos@partner.example.gr', org_role: 'viewer', active: false, totp_enabled: true, last_login_at: '2026-07-20T10:11:00Z' },
];
const { id, email, name, org_role } = users[0];
const me = { stage: 'ready', user: { id, email, name, org_role }, org: { id: uid(100), name: 'Active Computer Systems', timezone: 'Europe/Athens' }, csrfToken: 'csrf-mock' };
const tender = {
  id: uid(200),
  org_id: uid(100),
  title: 'Προμήθεια και εγκατάσταση εξοπλισμού πληροφορικής και δικτύου για τις ανάγκες των περιφερειακών υπηρεσιών',
  authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης',
  adam: '26PROC017654321',
  esidis_no: '345678',
  cpv: ['30200000-1'],
  budget_net: '1250000.00',
  budget_gross: '1550000.00',
  lots: null,
  t0_published_at: '2026-11-02T08:00:00Z',
  questions_deadline_at: '2026-11-16T13:00:00Z',
  submission_deadline_at: '2026-11-27T13:00:00Z',
  guarantee_amount: '25000.00',
  guarantee_valid_until: '2027-12-31',
  guarantee_margin_days: 30,
  offer_validity_days: 365,
  has_demo: true,
  has_partners: false,
  status: 'in_progress',
  compressed_mode: true,
  template_id: uid(300),
  template_version: 'L v1.1',
  closed_at: null,
  created_at: '2026-11-02T09:00:00Z',
  updated_at: '2026-11-12T09:00:00Z',
  created_by: uid(2),
};
const invitations = [
  { id: uid(401), email: 'sofia@example.gr', org_role: 'member', created_at: '2026-11-12T09:30:00Z', expires_at: '2026-11-19T09:30:00Z', accepted_at: null },
  { id: uid(402), email: 'dimitris@example.gr', org_role: 'approver', created_at: '2026-10-20T09:30:00Z', expires_at: '2026-10-27T09:30:00Z', accepted_at: '2026-10-21T11:00:00Z' },
  { id: uid(403), email: 'partner@example.gr', org_role: 'viewer', created_at: '2026-10-01T09:30:00Z', expires_at: '2026-10-08T09:30:00Z', accepted_at: null },
];
const holidays = (year) =>
  [
    ['01-01', 'Πρωτοχρονιά', 'national'],
    ['01-06', 'Θεοφάνια', 'national'],
    ['02-23', 'Καθαρά Δευτέρα', 'movable'],
    ['03-25', 'Ευαγγελισμός / Εθνική εορτή', 'national'],
    ['04-10', 'Μεγάλη Παρασκευή', 'movable'],
    ['04-13', 'Δευτέρα του Πάσχα', 'movable'],
    ['05-04', 'Πρωτομαγιά (μετάθεση)', 'manual'],
    ['06-01', 'Αγίου Πνεύματος', 'movable'],
    ['08-15', 'Κοίμηση της Θεοτόκου', 'national'],
    ['10-28', 'Επέτειος του Όχι', 'national'],
    ['12-25', 'Χριστούγεννα', 'national'],
    ['12-26', 'Σύναξη της Θεοτόκου', 'national'],
  ].map(([md, name, source], i) => ({ id: uid(500 + i), date: `${year}-${md}`, name, source }));
const audit = [
  { id: uid(601), user_id: uid(2), entity: 'tender', entity_id: tender.id, action: 'update', at: '2026-11-12T09:00:12Z',
    before: { ...tender, submission_deadline_at: '2026-11-20T13:00:00Z', compressed_mode: false, updated_at: '2026-11-05T09:00:00Z' }, after: tender },
  { id: uid(602), user_id: uid(3), entity: 'requirement', entity_id: uid(701), action: 'update', at: '2026-11-12T08:41:03Z',
    before: { code: 'ΥΠ-014', status: 'in_progress', evidence_ref: null, response_ref: 'Κεφ. 3.2' }, after: { code: 'ΥΠ-014', status: 'covered', evidence_ref: 'Παράρτημα Β.3, σελ. 12', response_ref: 'Κεφ. 3.2' } },
  { id: uid(603), user_id: uid(1), entity: 'holiday', entity_id: uid(506), action: 'insert', at: '2026-11-11T15:20:44Z', before: null, after: { date: '2026-05-04', name: 'Πρωτομαγιά (μετάθεση)', source: 'manual' } },
  { id: uid(604), user_id: uid(4), entity: 'gate', entity_id: uid(801), action: 'update', at: '2026-11-10T12:02:10Z',
    before: { decision: 'pending', justification: null, decided_at: null }, after: { decision: 'go', justification: null, decided_at: '2026-11-10T12:02:10Z' } },
  { id: uid(605), user_id: null, entity: 'task', entity_id: uid(901), action: 'delete', at: '2026-11-09T07:00:01Z', before: { title: 'Δοκιμή demo μονάδας', status: 'open' }, after: null },
];
const qrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/>${Array.from({ length: 21 * 21 }, (_, i) => ((i * 7919) % 5 < 2 || [0, 6, 14, 20].includes(i % 21) ? `<rect x="${i % 21}" y="${Math.floor(i / 21)}" width="1" height="1"/>` : '')).join('')}</svg>`;

/* ------------------------------------------------------------ mock server */
function mockApi(page, state) {
  // A predicate, not the glob '**/api/**' — that would also swallow Vite's /src/api/*.ts modules.
  return page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const error = (status, code, message) => json({ error: { code, message } }, status);

    // Shapes mirror server/src/core/authRoutes.ts
    if (path === '/auth/me') {
      if (state.loggedIn) return json(me);
      if (state.pending) return json({ stage: state.loginNext, csrfToken: 'csrf-partial' });
      return error(401, 'unauthorized', 'Authentication required');
    }
    if (path === '/auth/login') { state.pending = true; return json({ stage: state.loginNext, csrfToken: 'csrf-partial' }); }
    if (path === '/auth/totp' || path === '/auth/totp/enable') { state.loggedIn = true; return json(me); }
    if (path === '/auth/invite-info') return json({ email: 'sofia@example.gr', org_role: 'member', org_name: 'Active Computer Systems' });
    if (path === '/auth/totp/setup')
      return json({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/BidManager:x?secret=JBSWY3DPEHPK3PXP', qrDataUrl: `data:image/svg+xml,${encodeURIComponent(qrSvg)}` });
    if (path === '/auth/logout') { state.loggedIn = false; state.pending = false; return route.fulfill({ status: 204 }); }
    if (path === '/auth/accept-invite') return json({ ok: true, email: 'sofia@example.gr' }, 201);
    if (!state.loggedIn) return error(401, 'unauthorized', 'Authentication required');

    if (path === '/users') return json({ items: users.filter((u) => u.active).map(({ id, name, email, org_role }) => ({ id, name, email, org_role })) });
    if (path === '/admin/users') return json({ items: users });
    if (path.startsWith('/admin/users/') && method === 'PATCH') return json({ ok: true });
    if (path === '/admin/invitations' && method === 'GET') return json({ items: invitations });
    if (path === '/admin/invitations' && method === 'POST') return json({ invitation: invitations[0], token: '9f2c1d6e7a8b4c3d9e0f1a2b3c4d5e6f', acceptUrl: 'http://localhost:5173/accept-invite?token=9f2c1d6e7a8b4c3d9e0f1a2b3c4d5e6f', emailSent: true }, 201);
    if (path === '/holidays') return json({ items: holidays(url.searchParams.get('year') ?? '2026') });
    if (path === '/audit') return json({ items: audit, total: 312 });
    if (path === `/tenders/${tender.id}`) return json({ tender, permissions: { canWrite: true, canSeeFinancial: true } });
    if (path.startsWith('/tenders/')) return error(404, 'not_found', 'Δεν βρέθηκε');
    return json({ items: [] });
  });
}

/* ------------------------------------------------------------------ shots */
const viewports = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 740 } };

const shots = [
  { name: 'login', loggedIn: false, path: '/login' },
  { name: 'login-totp', loggedIn: false, path: '/login', run: async (page) => {
      await page.getByLabel('Email').fill('kostas@example.gr');
      await page.getByLabel('Κωδικός').fill('correct horse battery');
      await page.getByRole('button', { name: 'Συνέχεια' }).click();
      await page.getByText('Έλεγχος δύο βημάτων').waitFor();
    } },
  { name: 'login-totp-setup', loggedIn: false, loginNext: 'totp_setup', path: '/login', fullPage: true, run: async (page) => {
      await page.getByLabel('Email').fill('eleni@example.gr');
      await page.getByLabel('Κωδικός').fill('correct horse battery');
      await page.getByRole('button', { name: 'Συνέχεια' }).click();
      await page.getByRole('img', { name: /QR/ }).waitFor();
    } },
  { name: 'invite', loggedIn: false, path: '/accept-invite?token=9f2c1d6e7a8b4c3d9e0f1a2b3c4d5e6f', fullPage: true },
  { name: 'logout', path: '/', only: 'desktop', run: async (page) => {
      await page.getByRole('button', { name: 'Μενού χρήστη' }).click();
      await page.getByRole('menuitem', { name: 'Αποσύνδεση' }).click();
      await page.getByText('Αποσυνδεθήκατε.').waitFor();
    } },
  { name: 'login-full-flow', loggedIn: false, path: '/tenders', only: 'desktop', run: async (page) => {
      // guard → login → TOTP → back to the page that was asked for
      await page.getByLabel('Email').fill('kostas@example.gr');
      await page.getByLabel('Κωδικός').fill('correct horse battery');
      await page.getByRole('button', { name: 'Συνέχεια' }).click();
      await page.getByLabel(/Κωδικός 6 ψηφίων/).fill('123456');
      await page.getByRole('heading', { name: 'Διαγωνισμοί' }).waitFor();
      if (!page.url().endsWith('/tenders')) throw new Error(`expected /tenders, got ${page.url()}`);
    } },
  { name: 'dashboard', path: '/' },
  { name: 'nav-open', path: '/', only: 'mobile', run: async (page) => { await page.getByRole('button', { name: 'Άνοιγμα μενού' }).click(); await page.waitForTimeout(300); } },
  { name: 'user-menu', path: '/', only: 'desktop', run: async (page) => { await page.getByRole('button', { name: 'Μενού χρήστη' }).click(); } },
  { name: 'tender', path: `/tenders/${tender.id}` },
  { name: 'tender-not-found', path: `/tenders/${uid(999)}`, only: 'desktop' },
  { name: 'users', path: '/admin/users' },
  { name: 'users-row-menu', path: '/admin/users', only: 'desktop', run: async (page) => { await page.getByRole('button', { name: /Περισσότερες ενέργειες: Μαρία/ }).click(); } },
  { name: 'users-invitations', path: '/admin/users', run: async (page) => { await page.getByRole('tab', { name: /Προσκλήσεις/ }).click(); } },
  { name: 'users-invite-modal', path: '/admin/users', run: async (page) => { await page.getByRole('button', { name: 'Πρόσκληση χρήστη' }).first().click(); } },
  { name: 'users-invite-created', path: '/admin/users', run: async (page) => {
      await page.getByRole('button', { name: 'Πρόσκληση χρήστη' }).first().click();
      await page.getByRole('dialog').getByLabel('Email').fill('sofia@example.gr');
      await page.getByRole('button', { name: 'Δημιουργία πρόσκλησης' }).click();
      await page.getByText('Σύνδεσμος πρόσκλησης').waitFor();
    } },
  { name: 'holidays', path: '/admin/holidays', fullPage: true },
  { name: 'holidays-add', path: '/admin/holidays', only: 'desktop', run: async (page) => { await page.getByRole('button', { name: 'Προσθήκη αργίας' }).click(); } },
  { name: 'audit', path: '/admin/audit' },
  { name: 'audit-detail', path: '/admin/audit', run: async (page) => { await page.getByRole('row', { name: /Μαρία Αντωνίου/ }).click(); await page.getByRole('dialog').waitFor(); } },
  { name: 'not-found', path: '/nope', only: 'desktop' },
];

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch();
let failed = 0;
try {
  for (const [vpName, viewport] of Object.entries(viewports)) {
    for (const shot of shots) {
      if (shot.only && shot.only !== vpName) continue;
      if (only && !shot.name.includes(only)) continue;
      const context = await browser.newContext({ viewport, locale: 'el-GR', timezoneId: 'Europe/Athens', deviceScaleFactor: 1 });
      const page = await context.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/401|404/.test(m.text())) problems.push(`console: ${m.text()}`); });
      await mockApi(page, { loggedIn: shot.loggedIn !== false, loginNext: shot.loginNext ?? 'totp' });
      try {
        await page.goto(base + shot.path, { waitUntil: 'networkidle' });
        if (shot.run) await shot.run(page);
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) problems.push(`horizontal page overflow: ${overflow}px`);
        const file = resolve(outDir, `${shot.name}-${vpName}.png`);
        await page.screenshot({ path: file, fullPage: Boolean(shot.fullPage) });
        console.log(`${problems.length ? '!' : '✓'} ${shot.name}-${vpName}${problems.length ? '\n    ' + problems.join('\n    ') : ''}`);
        failed += problems.length;
      } catch (err) {
        failed++;
        console.log(`✗ ${shot.name}-${vpName}: ${err.message.split('\n')[0]}`);
        await page.screenshot({ path: resolve(outDir, `${shot.name}-${vpName}-FAILED.png`) }).catch(() => {});
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\nScreenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
