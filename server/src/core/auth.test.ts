import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { anon, as, createOrg, createUser, dbFor, getApp, type Agent, type TestUser } from '../test/harness.js';
import request from 'supertest';
import { SESSION_COOKIE } from './auth.js';
import { createApp } from '../app.js';
import { MAX_FAILED_LOGINS, MAX_TOTP_ATTEMPTS, MAX_TOTP_FAILURES } from './authRoutes.js';
import { sha256Hex } from './crypto.js';
import { testOutbox } from './mailer.js';

const PASSWORD = 'correct horse battery staple';

/** A valid code for the current step, or for a later step (to get past replay protection on a second login). */
const code = (secret: string, stepsAhead = 0) => generate({ secret, epoch: Math.floor(Date.now() / 1000) + stepsAhead * 30 });

function sessionCookie(res: request.Response): string | undefined {
  const raw = ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(raw.length).toBeLessThanOrEqual(1); // never two conflicting Set-Cookie headers
  return raw[0];
}
const cookieToken = (cookie: string) => cookie.split(';')[0]!.split('=')[1]!;

async function login(agent: Agent, user: TestUser, password = PASSWORD) {
  return agent.post('/api/auth/login').send({ email: user.email, password });
}

/** Full login (password + TOTP) through the real endpoints. */
async function fullLogin(user: TestUser, stepsAhead = 0): Promise<{ agent: Agent; csrf: string }> {
  const agent = anon();
  await login(agent, user).then((r) => expect(r.status).toBe(200));
  const res = await agent.post('/api/auth/totp').send({ code: await code(user.totpSecret!, stepsAhead) });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.csrfToken };
}

describe('login: password, then mandatory TOTP', () => {
  it('password alone gives only a partial session; TOTP completes it', async () => {
    const org = await createOrg({ name: 'ACS' });
    const user = await createUser(org, 'bid_manager', { password: PASSWORD, name: 'Β' });
    const agent = anon();

    const res = await login(agent, user);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stage: 'totp', next: 'totp', csrfToken: expect.any(String) });
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/i); // secure only in production (see the cookie test below)

    // the partial session opens nothing but the auth endpoints
    expect((await agent.get('/api/users')).status).toBe(401);
    expect((await agent.get('/api/users')).body.error.code).toBe('totp_required');
    expect((await agent.get('/api/holidays')).status).toBe(401);
    expect((await agent.get('/api/tenders')).status).toBe(401);
    const partialMe = await agent.get('/api/auth/me');
    expect(partialMe.status).toBe(401);
    expect(partialMe.body.error).toEqual({ code: 'totp_required', message: 'Two-factor verification required', details: { stage: 'totp' } });
    // …and cannot (re-)enrol TOTP for a user who already has it
    expect((await agent.get('/api/auth/totp/setup')).status).toBe(409);

    const wrong = await agent.post('/api/auth/totp').send({ code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_code');

    const ok = await agent.post('/api/auth/totp').send({ code: await code(user.totpSecret!) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      ok: true,
      stage: 'ready',
      user: { id: user.id, email: user.email, name: 'Β', org_role: 'bid_manager' },
      org: { id: org.id, name: 'ACS', timezone: 'Europe/Athens' },
      csrfToken: expect.any(String),
    });
    // the session token is rotated when the session becomes fully authenticated
    const rotated = sessionCookie(ok)!;
    expect(cookieToken(rotated)).not.toBe(cookieToken(cookie));
    expect(ok.body.csrfToken).not.toBe(res.body.csrfToken);
    expect(await dbFor(org).get('session', sha256Hex(cookieToken(cookie)))).toBeNull();

    expect((await agent.get('/api/users')).status).toBe(200);
    expect((await agent.get('/api/auth/me')).body).toEqual({ ...ok.body, ok: undefined });
    const row = await dbFor(org).get('user', user.id);
    expect(row?.last_login_at).toBeInstanceOf(Date);
    expect(await dbFor(org).count('audit_log', { entity: 'user', entity_id: user.id, action: 'login' })).toBe(1);
  });

  it('stores only the hash of the session token', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const res = await login(anon(), user);
    const token = cookieToken(sessionCookie(res)!);
    const sessions = await dbFor(org).list('session', { user_id: user.id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sha256Hex(token));
    expect(JSON.stringify(sessions)).not.toContain(token);
    expect(sessions[0].totp_verified).toBe(false);
  });

  it('gives the same answer for wrong password, unknown e-mail, inactive user and user without password', async () => {
    const org = await createOrg();
    const active = await createUser(org, 'member', { password: PASSWORD });
    const inactive = await createUser(org, 'member', { password: PASSWORD, active: false });
    const noPassword = await createUser(org, 'member');
    const attempts = [
      { email: active.email, password: 'wrong password 123' },
      { email: 'nobody-here@example.com', password: PASSWORD },
      { email: inactive.email, password: PASSWORD },
      { email: noPassword.email, password: PASSWORD },
    ];
    const bodies = new Set<string>();
    for (const a of attempts) {
      const res = await anon().post('/api/auth/login').send(a);
      expect(res.status).toBe(401);
      expect(sessionCookie(res)).toBeUndefined();
      bodies.add(JSON.stringify(res.body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: 'invalid_credentials', message: 'Invalid e-mail or password' } })]);
  });

  it('e-mail is case-insensitive; malformed input is a 400 with details', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    expect((await anon().post('/api/auth/login').send({ email: `  ${user.email.toUpperCase()} `, password: PASSWORD })).status).toBe(200);
    const bad = await anon().post('/api/auth/login').send({ email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'password']);
    expect((await anon().post('/api/auth/login').set('Content-Type', 'application/json').send('{oops')).body.error.code).toBe('invalid_json');
  });

  it('repeated wrong passwords lock that client address out of the account — without revealing it, and without locking the owner out (review M5)', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    // an app that trusts one proxy hop, so the test can speak from different client addresses
    const proxied = createApp();
    proxied.set('trust proxy', 1);
    const from = (ip: string, password = PASSWORD) => request(proxied).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email: user.email, password });

    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      expect((await from('203.0.113.7', 'wrong password 123')).status).toBe(401);
    }
    const row = await dbFor(org).get('user', user.id);
    expect(row?.failed_login_count).toBe(MAX_FAILED_LOGINS);
    expect(row?.locked_until).toBeNull(); // the ACCOUNT is not locked
    const throttle = await dbFor(org).findOne('login_throttle', { user_id: user.id, ip: '203.0.113.7' });
    expect(throttle?.locked_until.getTime()).toBeGreaterThan(Date.now());

    // the attacker's address is locked out, even with the right password, and gets the same answer as before
    const locked = await from('203.0.113.7');
    expect([locked.status, locked.body.error.code]).toEqual([401, 'invalid_credentials']);
    // the owner, from their own address, logs in as usual
    const owner = await from('198.51.100.20');
    expect([owner.status, owner.body.stage]).toEqual([200, 'totp']);

    // the lock expires; a successful login clears the throttle and the counter
    await dbFor(org).sql("UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE org_id = :org_id AND user_id = :id", { id: user.id });
    expect((await from('203.0.113.7')).status).toBe(200);
    expect(await dbFor(org).count('login_throttle', { user_id: user.id, ip: '203.0.113.7' })).toBe(0);
    const { agent } = await fullLogin(user);
    expect((await agent.get('/api/users')).status).toBe(200);
    expect((await dbFor(org).get('user', user.id))?.failed_login_count).toBe(0);
  });

  it('wrong TOTP codes are counted per user across logins: after 10 the second factor is locked, a success resets the count (review M5)', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const wrong = async (n: number) => {
      // each login allows MAX_TOTP_ATTEMPTS codes; keep logging in again, as somebody who knows the password would
      let sent = 0;
      while (sent < n) {
        const agent = anon();
        expect((await login(agent, user)).status).toBe(200);
        for (let i = 0; i < MAX_TOTP_ATTEMPTS && sent < n; i++, sent++) {
          const res = await agent.post('/api/auth/totp').send({ code: '000000' });
          expect(res.status).toBe(401);
        }
      }
    };
    await wrong(4);
    expect((await dbFor(org).get('user', user.id))?.totp_failed_count).toBe(4);
    // a correct code resets the counter
    await fullLogin(user);
    expect(await dbFor(org).get('user', user.id)).toMatchObject({ totp_failed_count: 0, totp_locked_until: null });

    await wrong(MAX_TOTP_FAILURES);
    const row = await dbFor(org).get('user', user.id);
    expect(row?.totp_locked_until.getTime()).toBeGreaterThan(Date.now());
    // locked: even the right code is refused, with a distinct answer, and the partial session ends
    const agent = anon();
    await login(agent, user);
    const res = await agent.post('/api/auth/totp').send({ code: await code(user.totpSecret!, 1) });
    expect([res.status, res.body.error.code]).toEqual([429, 'totp_locked']);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await dbFor(org).list('audit_log', { entity_id: user.id })).map((a) => a.action)).toContain('totp_locked');
    // after the lock the user is back in
    await dbFor(org).sql('UPDATE "user" SET totp_locked_until = now() - interval \'1 second\' WHERE org_id = :org_id AND id = :id', { id: user.id });
    const back = anon();
    await login(back, user);
    expect((await back.post('/api/auth/totp').send({ code: await code(user.totpSecret!, 1) })).status).toBe(200);
  });

  it('a TOTP code cannot be replayed, and too many wrong codes end the partial session', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const first = anon();
    await login(first, user);
    const used = await code(user.totpSecret!);
    expect((await first.post('/api/auth/totp').send({ code: used })).status).toBe(200);

    const second = anon();
    await login(second, user);
    expect((await second.post('/api/auth/totp').send({ code: used })).status).toBe(401); // replay
    for (let i = 1; i < MAX_TOTP_ATTEMPTS; i++) {
      expect((await second.post('/api/auth/totp').send({ code: '123456' })).status).toBe(401);
    }
    // the partial session is gone: even a fresh, valid code no longer works without the password
    const after = await second.post('/api/auth/totp').send({ code: await code(user.totpSecret!, 1) });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('unauthorized');
    expect(await dbFor(org).count('session', { user_id: user.id, totp_verified: false })).toBe(0);
    expect((await second.post('/api/auth/totp').send({ code: 'abc' })).status).toBe(401);
  });

  it('logging in again replaces the previous session of that browser', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const { agent } = await fullLogin(user);
    expect(await dbFor(org).count('session', { user_id: user.id })).toBe(1);
    await login(agent, user);
    const sessions = await dbFor(org).list('session', { user_id: user.id });
    expect(sessions.map((s) => s.totp_verified)).toEqual([false]);
    expect((await agent.get('/api/users')).status).toBe(401);
  });
});

describe('TOTP enrolment is mandatory before a full session', () => {
  it('a user without TOTP must enrol; the secret is shown once and never again', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD, totp: false });
    const agent = anon();
    const res = await login(agent, user);
    expect(res.body.stage).toBe('totp_setup');
    expect((await agent.get('/api/users')).status).toBe(401);
    expect((await agent.get('/api/auth/me')).body.error.details).toEqual({ stage: 'totp_setup' });
    expect((await agent.post('/api/auth/totp').send({ code: '123456' })).status).toBe(409);
    expect((await agent.post('/api/auth/totp/enable').send({ code: '123456' })).status).toBe(409); // setup not started

    const setup = await agent.get('/api/auth/totp/setup');
    expect(setup.status).toBe(200);
    expect(setup.headers['cache-control']).toBe('no-store');
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    expect(setup.body.otpauthUrl).toContain(encodeURIComponent(user.email));
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    // reloading the page shows the same pending secret
    expect((await agent.get('/api/auth/totp/setup')).body.secret).toBe(setup.body.secret);
    // the secret is encrypted at rest
    const stored = (await dbFor(org).get('user', user.id))?.totp_secret as string;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(setup.body.secret);

    expect((await agent.post('/api/auth/totp/enable').send({ code: '000000' })).status).toBe(401);
    expect((await agent.get('/api/users')).status).toBe(401);
    const enabled = await agent.post('/api/auth/totp/enable').send({ code: await code(setup.body.secret) });
    expect(enabled.status).toBe(200);
    expect(enabled.body.stage).toBe('ready');
    expect(enabled.body.user.id).toBe(user.id);
    expect(JSON.stringify(enabled.body)).not.toContain(setup.body.secret);
    expect((await agent.get('/api/users')).status).toBe(200);

    // never returned again — not by setup, not by me, not by the admin user list, not in the audit log
    expect((await agent.get('/api/auth/totp/setup')).status).toBe(409);
    expect(JSON.stringify((await agent.get('/api/auth/me')).body)).not.toContain(setup.body.secret);
    const admin = await createUser(org, 'admin');
    const list = await as(admin).get('/api/admin/users');
    expect(JSON.stringify(list.body)).not.toMatch(/totp_secret|password_hash/);
    expect(JSON.stringify(await dbFor(org).list('audit_log'))).not.toContain(setup.body.secret);

    // next login asks for a code (not for enrolment) and the enrolled secret works
    const again = anon();
    expect((await login(again, user)).body.stage).toBe('totp');
    expect((await again.post('/api/auth/totp').send({ code: await code(setup.body.secret, 1) })).status).toBe(200);
  });

  it('enrolment endpoints need the password step first', async () => {
    expect((await anon().get('/api/auth/totp/setup')).status).toBe(401);
    expect((await anon().post('/api/auth/totp/enable').send({ code: '123456' })).status).toBe(401);
    expect((await anon().post('/api/auth/totp').send({ code: '123456' })).status).toBe(401);
    expect((await anon().get('/api/auth/me')).status).toBe(401);
  });
});

describe('sessions', () => {
  it('expire after inactivity and are removed', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const { agent } = await fullLogin(user);
    expect((await agent.get('/api/users')).status).toBe(200);
    await dbFor(org).sql("UPDATE session SET expires_at = now() - interval '1 second' WHERE org_id = :org_id AND user_id = :id", { id: user.id });
    const res = await agent.get('/api/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(await dbFor(org).count('session', { user_id: user.id })).toBe(0);
  });

  it('activity pushes the idle expiry forward', async () => {
    const org = await createOrg();
    const user = await createUser(org);
    const api = await as(user);
    await dbFor(org).sql(
      "UPDATE session SET last_seen_at = now() - interval '5 minutes', expires_at = now() + interval '2 minutes' WHERE org_id = :org_id AND user_id = :id",
      { id: user.id },
    );
    expect((await api.get('/api/users')).status).toBe(200);
    const [s] = await dbFor(org).list('session', { user_id: user.id });
    expect(s.expires_at.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(s.last_seen_at.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('end after the absolute lifetime even when active', async () => {
    const org = await createOrg();
    const user = await createUser(org);
    const api = await as(user);
    await dbFor(org).sql("UPDATE session SET created_at = now() - interval '13 hours' WHERE org_id = :org_id AND user_id = :id", { id: user.id });
    expect((await api.get('/api/users')).status).toBe(401);
  });

  it('die immediately when the user is deactivated', async () => {
    const org = await createOrg();
    const user = await createUser(org);
    const api = await as(user);
    expect((await api.get('/api/users')).status).toBe(200);
    await dbFor(org).update('user', user.id, { active: false });
    expect((await api.get('/api/users')).status).toBe(401);
  });

  it('logout destroys the session and clears the cookie', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const { agent, csrf } = await fullLogin(user);
    expect((await agent.post('/api/auth/logout')).status).toBe(403); // CSRF header required
    const res = await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(await dbFor(org).count('session', { user_id: user.id })).toBe(0);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await anon().post('/api/auth/logout')).status).toBe(204); // idempotent without a session
  });

  it('unknown, malformed or forged cookies are just "not logged in"', async () => {
    for (const value of ['x', 'a'.repeat(43), 'a'.repeat(500), '../../etc/passwd']) {
      const res = await request(getApp()).get('/api/users').set('Cookie', `${SESSION_COOKIE}=${value}`);
      expect(res.status).toBe(401);
    }
    // the stored id (hash) is not accepted as a token
    const org = await createOrg();
    const user = await createUser(org);
    await as(user);
    const [s] = await dbFor(org).list('session', { user_id: user.id });
    expect((await request(getApp()).get('/api/users').set('Cookie', `${SESSION_COOKIE}=${s.id}`)).status).toBe(401);
  });
});

describe('CSRF', () => {
  it('mutating requests need X-CSRF-Token matching the session; reads do not', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin', { password: PASSWORD });
    const { agent, csrf } = await fullLogin(admin);
    const body = { date: '2033-01-02', name: 'x' };

    expect((await agent.get('/api/holidays')).status).toBe(200);
    const missing = await agent.post('/api/holidays').send(body);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('csrf_invalid');
    expect((await agent.post('/api/holidays').set('X-CSRF-Token', 'wrong').send(body)).status).toBe(403);
    expect((await agent.patch('/api/holidays/whatever').send({})).status).toBe(403);
    expect((await agent.delete('/api/holidays/whatever')).status).toBe(403);
    expect(await dbFor(org).count('holiday')).toBe(0);

    // another session's token does not work either
    const other = await fullLogin(admin, 1);
    expect((await agent.post('/api/holidays').set('X-CSRF-Token', other.csrf).send(body)).status).toBe(403);

    expect((await agent.post('/api/holidays').set('X-CSRF-Token', csrf).send(body)).status).toBe(201);
  });

  it('as(user) agents send the header automatically', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    expect((await as(admin).post('/api/holidays').send({ date: '2033-02-02', name: 'x' })).status).toBe(201);
  });
});

describe('invitations (no public sign-up)', () => {
  it('admin invites → token → accept sets name + password → login → TOTP enrolment', async () => {
    const org = await createOrg({ name: 'ACS' });
    const admin = await createUser(org, 'admin', { name: 'Κώστας' });
    testOutbox.length = 0;

    const created = await as(admin).post('/api/admin/invitations').send({ email: 'New.Member@Example.com', org_role: 'approver' });
    expect(created.status).toBe(201);
    expect(created.body.invitation).toMatchObject({ email: 'new.member@example.com', org_role: 'approver', status: 'pending' });
    expect(created.body.emailSent).toBe(true);
    const token: string = created.body.token;
    expect(created.body.inviteUrl).toMatch(new RegExp(`^https?://[^/]+/invite/${token}$`));
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]).toMatchObject({ to: 'new.member@example.com' });
    expect(testOutbox[0]!.text).toContain(created.body.inviteUrl);

    // only the hash is stored, and it is never listed
    const stored = await dbFor(org).findOne('invitation', { email: 'new.member@example.com' });
    expect(stored?.token_hash).toBe(sha256Hex(token));
    const listed = await as(admin).get('/api/admin/invitations');
    expect(listed.body.items).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toMatch(/token/);

    const info = await anon().post('/api/auth/invite-info').send({ token });
    expect(info.body).toEqual({ email: 'new.member@example.com', org_role: 'approver', org_name: 'ACS' });

    const short = await anon().post('/api/auth/accept-invite').send({ token, name: 'Νέο Μέλος', password: 'short' });
    expect(short.status).toBe(400);
    const accepted = await anon().post('/api/auth/accept-invite').send({ token, name: 'Νέο Μέλος', password: PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({ ok: true, email: 'new.member@example.com' });

    const user = await dbFor(org).findOne('user', { email: 'new.member@example.com' });
    expect(user).toMatchObject({ name: 'Νέο Μέλος', org_role: 'approver', active: true, totp_enabled_at: null, org_id: org.id });
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);
    expect((await as(admin).get('/api/admin/invitations')).body.items[0].status).toBe('accepted');

    // the token is single-use
    expect((await anon().post('/api/auth/accept-invite').send({ token, name: 'Again', password: PASSWORD })).status).toBe(404);
    expect((await anon().post('/api/auth/invite-info').send({ token })).status).toBe(404);

    // the new user logs in and must enrol TOTP before reaching anything
    const agent = anon();
    const res = await agent.post('/api/auth/login').send({ email: 'new.member@example.com', password: PASSWORD });
    expect(res.body.stage).toBe('totp_setup');
    expect((await agent.get('/api/users')).status).toBe(401);
    const setup = await agent.get('/api/auth/totp/setup');
    const done = await agent.post('/api/auth/totp/enable').send({ code: await code(setup.body.secret) });
    expect(done.body.user).toMatchObject({ email: 'new.member@example.com', org_role: 'approver' });
  });

  it('rejects unknown, expired and revoked tokens identically', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const api = await as(admin);
    const expired = await api.post('/api/admin/invitations').send({ email: 'expired@example.com' });
    await dbFor(org).update('invitation', expired.body.invitation.id, { expires_at: new Date(Date.now() - 1000) });
    const revoked = await api.post('/api/admin/invitations').send({ email: 'revoked@example.com' });
    expect((await api.delete(`/api/admin/invitations/${revoked.body.invitation.id}`)).status).toBe(204);

    const bodies = new Set<string>();
    for (const token of [expired.body.token, revoked.body.token, 'x'.repeat(43)]) {
      const res = await anon().post('/api/auth/accept-invite').send({ token, name: 'X', password: PASSWORD });
      expect(res.status).toBe(404);
      bodies.add(JSON.stringify(res.body));
    }
    expect(bodies.size).toBe(1);
    expect(await dbFor(org).count('user')).toBe(1);
    expect((await api.get('/api/admin/invitations')).body.items.map((i: { status: string }) => i.status)).toEqual(['expired']);
  });

  it('there is no sign-up endpoint', async () => {
    for (const path of ['/api/auth/signup', '/api/auth/register', '/api/users', '/api/admin/users']) {
      const res = await anon().post(path).send({ email: 'x@example.com', password: PASSWORD, name: 'x' });
      expect([401, 404]).toContain(res.status);
    }
  });
});

describe('cookie flags in production', () => {
  it('the session cookie is Secure when NODE_ENV=production', async () => {
    // config is read at import time, so check the option builder through a fresh module graph
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://bids.example.com');
    vi.stubEnv('FILE_ENCRYPTION_KEY', 'a'.repeat(64));
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('TRUST_PROXY', '1');
    try {
      const { config } = await import('../config.js');
      expect(config.isProd).toBe(true);
      const auth = await import('./auth.js');
      const cookies: { name: string; options: Record<string, unknown> }[] = [];
      const res = { clearCookie: (name: string, options: Record<string, unknown>) => cookies.push({ name, options }) };
      await auth.endSession(res as never, null);
      expect(cookies).toEqual([{ name: 'bm_session', options: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' } }]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('change password (POST /api/auth/change-password)', () => {
  const NEW_PASSWORD = 'a brand new passphrase';

  it('changes the password, ends the other sessions, keeps this one, and audits without secrets', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const here = await fullLogin(user);
    const elsewhere = await fullLogin(user, 1);
    expect((await elsewhere.agent.get('/api/auth/me')).status).toBe(200);

    const res = await here.agent.post('/api/auth/change-password').set('X-CSRF-Token', here.csrf).send({ current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect([res.status, res.body]).toEqual([200, { ok: true }]);

    expect((await here.agent.get('/api/auth/me')).status).toBe(200);
    expect((await elsewhere.agent.get('/api/auth/me')).status).toBe(401);
    expect(await dbFor(org).count('session', { user_id: user.id })).toBe(1);

    // the old password is dead, the new one works
    expect((await login(anon(), user)).status).toBe(401);
    expect((await login(anon(), user, NEW_PASSWORD)).status).toBe(200);

    const row = await dbFor(org).get('user', user.id);
    expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    const entry = await dbFor(org).findOne('audit_log', { entity: 'user', entity_id: user.id, action: 'password_changed' });
    expect(entry).toMatchObject({ user_id: user.id, after: { other_sessions_ended: 1 } });
    const text = JSON.stringify(entry);
    for (const secret of [PASSWORD, NEW_PASSWORD, row!.password_hash]) expect(text).not.toContain(secret);
  });

  it('rejects a wrong current password, a short or unchanged new one, and malformed input', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const { agent, csrf } = await fullLogin(user);
    const post = (body: Record<string, unknown>) => agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send(body);

    const wrong = await post({ current_password: 'not my password!!', new_password: NEW_PASSWORD });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'wrong_current_password']);
    const same = await post({ current_password: PASSWORD, new_password: PASSWORD });
    expect([same.status, same.body.error.code]).toEqual([422, 'password_unchanged']);
    // same minimum length as accept-invite (12)
    expect((await post({ current_password: PASSWORD, new_password: 'short-11-ch' })).status).toBe(400);
    expect((await post({ current_password: PASSWORD, new_password: 'x'.repeat(201) })).status).toBe(400);
    expect((await post({ new_password: NEW_PASSWORD })).status).toBe(400);
    expect((await post({ current_password: PASSWORD, new_password: NEW_PASSWORD, user_id: 'someone-else' })).status).toBe(400);

    // nothing changed: still logged in, old password still valid, nothing audited
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await login(anon(), user)).status).toBe(200);
    expect(await dbFor(org).count('audit_log', { entity: 'user', action: 'password_changed' })).toBe(0);
  });

  it('needs a full session and the CSRF token', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { password: PASSWORD });
    const body = { current_password: PASSWORD, new_password: NEW_PASSWORD };

    expect((await anon().post('/api/auth/change-password').send(body)).status).toBe(401);

    const partial = anon();
    const step1 = await login(partial, user);
    const half = await partial.post('/api/auth/change-password').set('X-CSRF-Token', step1.body.csrfToken).send(body);
    expect([half.status, half.body.error.code]).toEqual([401, 'totp_required']);

    const { agent } = await fullLogin(user);
    const noCsrf = await agent.post('/api/auth/change-password').send(body);
    expect([noCsrf.status, noCsrf.body.error.code]).toEqual([403, 'csrf_invalid']);
    expect((await login(anon(), user)).status).toBe(200);
  });

  it('only ever touches the caller: same e-mail in another organization keeps its password and sessions', async () => {
    const email = `shared-${Date.now()}@example.com`;
    const [orgA, orgB] = [await createOrg(), await createOrg()];
    const a = await createUser(orgA, 'member', { email, password: PASSWORD });
    const b = await createUser(orgB, 'member', { email, password: 'the other org passphrase' });
    await as(b);
    const { agent, csrf } = await fullLogin(a);
    const res = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrf).send({ current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(await dbFor(orgB).count('session', { user_id: b.id })).toBe(1);
    expect(await dbFor(orgB).count('audit_log', { action: 'password_changed' })).toBe(0);
    const after = anon();
    expect((await after.post('/api/auth/login').send({ email, password: 'the other org passphrase' })).status).toBe(200);
  });
});
