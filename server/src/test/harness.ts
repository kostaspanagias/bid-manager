import type { Express } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../app.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../core/auth.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { hashPassword } from '../core/password.js';
import { newTotpSecret, sealTotpSecret } from '../core/totp.js';
import type { OrgRole } from '../core/types.js';
import { createOrganization, type Organization } from '../db/admin.js';
import { scopedDb, type Row, type ScopedDb } from '../db/scoped.js';
import { seedHolidaysForYear } from '../domain/holidays.js';

// Test harness: factories that write straight through the scoped data layer, and authenticated supertest agents.
// The database is the per-run database created by globalSetup.ts; tests never clean up — they create their own
// organization(s) instead, so files and tests stay independent.

export interface TestOrg extends Organization {}
export interface TestUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  org_role: OrgRole;
  active: boolean;
  /** Only when created with `{ password }`. */
  password?: string;
  /** Base32 TOTP secret — only when created with `{ password }` and `totp` not false. */
  totpSecret?: string;
  [column: string]: unknown;
}
export interface TestTender extends Row {
  id: string;
  org_id: string;
  title: string;
  status: string;
  submission_deadline_at: Date;
}
export type Agent = TestAgent;

let app: Express | undefined;
let seq = 0;
const unique = () => `${(++seq).toString(36)}${randomBytes(4).toString('hex')}`;

/** The express app under test (one per test file). */
export function getApp(): Express {
  return (app ??= createApp());
}

/** Scoped data layer for an org (optionally acting as a user) — for arranging and asserting data directly. */
export function dbFor(org: { id: string }, user?: { id: string } | null): ScopedDb {
  return scopedDb(org.id, user?.id ?? null);
}

export async function createOrg(overrides: { name?: string; timezone?: string; settings?: Record<string, unknown>; retention_days?: number | null } = {}): Promise<TestOrg> {
  return createOrganization({ name: `Org ${unique()}`, ...overrides });
}

/**
 * Creates a user. By default the user cannot log in with a password (fast — no Argon2) and is used through
 * `as(user)`. Pass `{ password: '...' }` to get a real credential plus an enabled TOTP secret (`user.totpSecret`)
 * for tests of the login flow; add `totp: false` for a user who still has to enrol.
 */
export async function createUser(
  org: { id: string },
  role: OrgRole = 'member',
  overrides: Row & { password?: string; totp?: boolean } = {},
): Promise<TestUser> {
  const { password, totp, ...columns } = overrides;
  const data: Row = { email: `user-${unique()}@example.com`, name: `User ${seq}`, org_role: role, ...columns };
  data.email = String(data.email).toLowerCase();
  let totpSecret: string | undefined;
  if (password !== undefined) {
    data.password_hash = await hashPassword(password);
    if (totp !== false) {
      totpSecret = newTotpSecret();
      data.totp_secret = sealTotpSecret(totpSecret);
      data.totp_enabled_at = new Date();
    }
  }
  const row = await dbFor(org).insert<TestUser>('user', data);
  return { ...row, ...(password !== undefined ? { password } : {}), ...(totpSecret ? { totpSecret } : {}) };
}

/**
 * Creates a tender with sensible defaults (status in_progress, T = 30 days from now at 12:00 UTC, T0 = now).
 * Any tender column can be overridden. No template is applied: add roles/milestones yourself as needed.
 */
export async function createTender(org: { id: string }, overrides: Row = {}): Promise<TestTender> {
  const now = Date.now();
  const deadline = new Date(now + 30 * 86_400_000);
  deadline.setUTCHours(12, 0, 0, 0);
  return dbFor(org).insert<TestTender>('tender', {
    title: `Tender ${unique()}`,
    authority: 'Αναθέτουσα Αρχή',
    status: 'in_progress',
    t0_published_at: new Date(now),
    submission_deadline_at: deadline,
    offer_validity_days: 180,
    ...overrides,
  });
}

/** Adds a per-tender role (snapshot of a template role). `payload.financial = true` marks the financial role (R18). */
export async function addRole(tender: { id: string; org_id: string }, key: string, payload: Record<string, unknown> = {}, name = key): Promise<Row> {
  return dbFor({ id: tender.org_id }).insert('tender_role', { tender_id: tender.id, key, name, payload });
}

/**
 * Makes the user a member of the tender, optionally holding the tender role `roleKey`.
 * The role row itself is not required to exist; create it with `addRole()` when its payload matters.
 */
export async function addMember(tender: { id: string; org_id: string }, user: { id: string }, roleKey: string | null = null): Promise<Row> {
  return dbFor({ id: tender.org_id }).insert('tender_member', { tender_id: tender.id, user_id: user.id, tender_role_key: roleKey });
}

/** Seeds the Greek holidays (R2) of the given year(s) for the org. */
export async function seedHolidays(org: { id: string }, years: number | number[]): Promise<void> {
  for (const year of [years].flat()) await seedHolidaysForYear(dbFor(org), year);
}

/**
 * A supertest agent authenticated as `user`: a full (TOTP-verified) session row is inserted directly, and the
 * agent sends the session cookie and the X-CSRF-Token header on every request. Usable both ways:
 *   const res = await as(admin).post('/api/holidays').send({ date: '2027-06-01', name: 'x' }).expect(201);
 *   const api = await as(admin);  await api.get('/api/holidays');  await api.delete(...);   // one session, reused
 * (The session insert is asynchronous; the first form defers the request chain until the session exists.)
 */
export function as(user: { id: string; org_id: string }): AuthedAgent {
  const start = (async () => {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    await scopedDb(user.org_id, user.id).insert('session', {
      id: sha256Hex(token),
      user_id: user.id,
      totp_verified: true,
      csrf_token: csrfToken,
      expires_at: new Date(Date.now() + 3_600_000),
    });
    const agent = request.agent(getApp());
    agent.set('Cookie', `${SESSION_COOKIE}=${token}`);
    agent.set(CSRF_HEADER, csrfToken);
    return agent;
  })();
  start.catch(() => undefined); // surfaced when awaited
  return deferred(start, []) as AuthedAgent;
}

export type AuthedAgent = Agent & PromiseLike<Agent>;

/** Records a chain of calls (.post(url).send(body).expect(201)…) and replays it on the agent once it exists. */
function deferred(start: Promise<Agent>, calls: [string, unknown[]][]): unknown {
  const settle = () =>
    start.then((agent) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let current: any = agent;
      for (const [method, args] of calls) current = current[method](...args);
      return current;
    });
  // Only real agent / request methods are recordable, so the object does not pretend to have every property
  // (assertion libraries and util.inspect probe for things like asymmetricMatch, toJSON, nodeType…).
  const proto = (calls.length === 0 ? request.agent.prototype : request.Test.prototype) as unknown as Record<string, unknown>;
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then') return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => settle().then(onOk, onErr);
        if (prop === 'catch') return (onErr?: (e: unknown) => unknown) => settle().catch(onErr);
        if (prop === 'finally') return (fn?: () => void) => settle().finally(fn);
        if (typeof proto[prop] !== 'function') return undefined;
        return (...args: unknown[]) => deferred(start, [...calls, [prop, args]]);
      },
    },
  );
}

/** An unauthenticated agent (keeps cookies between requests, like a browser) — for login-flow tests. */
export function anon(): Agent {
  return request.agent(getApp());
}

/** A random uuid that matches no row. */
export const missingId = (): string => randomUUID();
