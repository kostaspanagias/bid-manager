// Infrastructure for the end-to-end run: a private database, a real server serving the built web app, and small
// Playwright helpers. No API mocking anywhere.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
const pg = require('pg');
const otp = require('otplib');

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');
export const outDir = resolve(here, 'out');
export const shotsDir = resolve(outDir, 'screenshots');

const ADMIN_DB_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://bidmanager:bidmanager@127.0.0.1:5432/bidmanager_dev';
export const PORT = Number(process.env.E2E_PORT ?? 3399);
export const BASE = `http://127.0.0.1:${PORT}`;
export const ADMIN = { email: 'admin@e2e.example.gr', password: 'e2e-admin-password-1' };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export { log };

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** Creates the database, migrates, seeds, (builds the web app when missing) and starts the server. */
export async function startStack({ build = false } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const dbName = `bidmanager_e2e_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_DB_URL);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();

  const env = {
    NODE_ENV: 'development',
    PORT: String(PORT),
    DATABASE_URL: databaseUrl,
    APP_URL: BASE,
    FILE_STORAGE_DIR: resolve(outDir, 'storage'),
    WEB_DIST_DIR: resolve(repoRoot, 'web', 'dist'),
    SEED_ADMIN_EMAIL: ADMIN.email,
    SEED_ADMIN_PASSWORD: ADMIN.password,
    SEED_ORG_NAME: 'Active Computer Systems (e2e)',
    SMTP_HOST: '',
    FILE_ENCRYPTION_KEY: process.env.E2E_FILE_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
    BM_NO_DOTENV: '1',
    LOG_LEVEL: 'info',
  };
  if (build || !existsSync(resolve(repoRoot, 'web', 'dist', 'index.html'))) {
    log('building the web app…');
    run('npm', ['run', 'build', '-w', 'web'], {});
  }
  log('migrate + seed →', dbName);
  run('npm', ['run', 'migrate', '-w', 'server'], env);
  run('npm', ['run', 'seed', '-w', 'server'], env);

  const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: resolve(repoRoot, 'server'), env: { ...process.env, ...env }, detached: true });
  const serverLog = createWriteStream(resolve(outDir, 'server.log'));
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 80) throw new Error('server did not start — see web/e2e/out/server.log');
    await new Promise((r) => setTimeout(r, 250));
  }
  log('server up on', BASE);

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const stop = async ({ keep = false } = {}) => {
    await db.end().catch(() => undefined);
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 800));
    if (keep) {
      log('kept database', dbName);
      return;
    }
    const c = new pg.Client({ connectionString: ADMIN_DB_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
    rmSync(resolve(outDir, 'storage'), { recursive: true, force: true });
  };
  return { db, databaseUrl, env, stop };
}

/** A fresh 6-digit code that the server has not seen yet for this secret (it refuses a time step twice). */
const lastStep = new Map();
export async function totp(secret) {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if ((lastStep.get(secret) ?? 0) < step) {
      lastStep.set(secret, step);
      return otp.generate({ secret });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ------------------------------------------------------------------ page helpers */

export const problems = [];
const toasts = [];
export const seenToasts = toasts;

/** Console errors, page errors, CSP violations and 5xx answers are collected; expected 4xx are whitelisted per test. */
export function watch(page, who) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/status of (401|403|404|409|422)/.test(text)) return; // refused requests the script provokes on purpose
    problems.push(`[${who}] console: ${text}`);
  });
  page.on('pageerror', (e) => problems.push(`[${who}] pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`[${who}] ${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

export async function newUserContext(browser, who, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'el-GR', timezoneId: 'Europe/Athens', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  watch(page, who);
  return { context, page, who };
}

let shotNo = 0;
export async function shot(page, name, { fullPage = true } = {}) {
  await settle(page);
  await collectToasts(page);
  const file = resolve(shotsDir, `${String(++shotNo).padStart(3, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  await scanText(page, name);
  return file;
}

export async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.locator('.ui-spinner').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
}

export async function collectToasts(page) {
  for (const text of await page.locator('.ui-toast__msg').allTextContents()) {
    if (!toasts.includes(text)) toasts.push(text);
  }
}

/** Waits for a toast containing `text` (Greek), records it, and dismisses nothing (toasts time out). */
export async function expectToast(page, text) {
  await page.locator('.ui-toast__msg', { hasText: text }).first().waitFor();
  await collectToasts(page);
}

const NAMESPACES = 'common|auth|nav|dashboard|tenders|schedule|gates|requirements|tasks|watch|risks|changes|files|documents|lessons|templates|admin|my|account';
const RAW_KEY = new RegExp(`\\b(?:${NAMESPACES})[:.][a-zA-Z_]+(?:\\.[a-zA-Z_0-9]+)+\\b|\\b(?:errorCodes|enums|actions|labels|state)\\.[a-z_A-Z.]+\\b`);
const ISO_DATE = /\b20\d\d-\d\d-\d\d(?:T\d\d:\d\d)?/;
const ENGLISH_SENTENCE = /\b(?:The|A|An|Only|This|Unknown|Invalid|Not|Cannot|Missing)\s+[a-z]+\s+[a-z]+\s+[a-z]+/;

/** Raw i18n keys, ISO dates and English sentences have no place in the Greek UI. */
export async function scanText(page, where) {
  const text = await page.locator('body').innerText();
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (RAW_KEY.test(l)) problems.push(`[${where}] raw i18n key: "${l.slice(0, 160)}"`);
    if (ISO_DATE.test(l) && !/\.(pdf|csv|xlsx|txt|docx)\b/.test(l)) problems.push(`[${where}] ISO date in UI: "${l.slice(0, 160)}"`);
    if (ENGLISH_SENTENCE.test(l)) problems.push(`[${where}] English text: "${l.slice(0, 160)}"`);
    if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(l)) problems.push(`[${where}] broken value: "${l.slice(0, 160)}"`);
  }
  // horizontal overflow of the page itself = broken layout
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) problems.push(`[${where}] page overflows horizontally by ${overflow}px`);
}

/** Password + TOTP login through the real pages. Enrols TOTP when the account has none yet. Returns the secret. */
export async function login(page, { email, password, secret }) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Συνέχεια' }).click();
  const code = page.getByLabel('Κωδικός 6 ψηφίων');
  await code.waitFor();
  let enrolled = secret;
  const setup = page.locator('code[aria-label="Κλειδί ρύθμισης"]');
  if (!secret) {
    await setup.waitFor();
    enrolled = (await setup.innerText()).replace(/\s+/g, '');
    await shot(page, `login-totp-setup-${email.split('@')[0]}`);
  }
  await code.fill(await totp(enrolled));
  // the code step submits by itself once six digits are in; press the button only if it is still there
  const inside = page.locator('.app-content');
  await inside.waitFor({ timeout: 1500 }).catch(async () => {
    await page.getByRole('button', { name: secret ? 'Είσοδος' : 'Ενεργοποίηση και είσοδος' }).click({ timeout: 3000 }).catch(() => undefined);
  });
  await inside.waitFor();
  return enrolled;
}

/** fetch() from inside the page — same cookies and CSRF as the app, for the "by direct URL" checks. */
export async function apiFetch(page, path, { method = 'GET', body } = {}) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const me = method === 'GET' ? null : await (await fetch('/api/auth/me')).json();
      const res = await fetch(path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(me ? { 'x-csrf-token': me.csrfToken } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, json, text: text.slice(0, 2000) };
    },
    { path, method, body },
  );
}

export function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}
export function assertEq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------------------------------------------ dates (Athens) */

const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const el = (isoDate) => `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
export function todayAthens() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
}
export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
/** The first Friday at least `minDays` after `from`. */
export function fridayAfter(from, minDays) {
  let d = addDays(from, minDays);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 5) d = addDays(d, 1);
  return d;
}

/** A form control by its exact visible label (required fields carry a trailing " *"). */
export function f(scope, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return scope.getByLabel(new RegExp(`^\\s*${escaped}(\\s*\\*)?\\s*$`));
}
