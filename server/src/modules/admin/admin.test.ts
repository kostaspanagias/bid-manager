import { describe, expect, it } from 'vitest';
import { testOutbox } from '../../core/mailer.js';
import { addMember, addRole, anon, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';

describe('/api/admin/users', () => {
  it('admin lists the users of the own org only, without secrets', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const admin = await createUser(org, 'admin', { name: 'Alpha' });
    await createUser(org, 'viewer', { name: 'Beta', password: 'a long enough password' });
    await createUser(other, 'admin', { name: 'Foreign' });
    const res = await as(admin).get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.items.map((u: { name: string }) => u.name)).toEqual(['Alpha', 'Beta']);
    expect(Object.keys(res.body.items[1]).sort()).toEqual(['active', 'created_at', 'email', 'id', 'last_login_at', 'name', 'org_role', 'totp_enabled', 'totp_enabled_at']);
    expect(res.body.items[1]).toMatchObject({ org_role: 'viewer', active: true, totp_enabled: true });
    expect(res.body.items[0].totp_enabled).toBe(false);
  });

  it('is admin-only', async () => {
    const org = await createOrg();
    const target = await createUser(org, 'member');
    for (const role of ['bid_manager', 'member', 'approver', 'viewer'] as const) {
      const api = await as(await createUser(org, role));
      expect((await api.get('/api/admin/users')).status).toBe(403);
      expect((await api.patch(`/api/admin/users/${target.id}`).send({ org_role: 'admin' })).status).toBe(403);
      expect((await api.post(`/api/admin/users/${target.id}/reset-totp`)).status).toBe(403);
      expect((await api.get('/api/admin/invitations')).status).toBe(403);
      expect((await api.post('/api/admin/invitations').send({ email: 'x@example.com' })).status).toBe(403);
    }
    expect((await dbFor(org).get('user', target.id))?.org_role).toBe('member');
  });

  it('changes role and name, with audit trail', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const user = await createUser(org, 'member', { name: 'Old' });
    const res = await as(admin).patch(`/api/admin/users/${user.id}`).send({ org_role: 'approver', name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: user.id, org_role: 'approver', name: 'New' });
    const log = await dbFor(org).findOne('audit_log', { entity: 'user', entity_id: user.id, action: 'update' });
    expect(log).toMatchObject({ user_id: admin.id, before: { org_role: 'member', name: '[redacted]' }, after: { org_role: 'approver', name: '[redacted]' } }); // review M2: no personal data in the audit log
  });

  it('validates input', async () => {
    const org = await createOrg();
    const api = await as(await createUser(org, 'admin'));
    const user = await createUser(org, 'member');
    expect((await api.patch(`/api/admin/users/${user.id}`).send({ org_role: 'superuser' })).status).toBe(400);
    expect((await api.patch(`/api/admin/users/${user.id}`).send({ email: 'new@example.com' })).status).toBe(400); // unknown key
    expect((await api.patch(`/api/admin/users/${user.id}`).send({ password_hash: 'x' })).status).toBe(400);
    expect((await api.patch(`/api/admin/users/${missingId()}`).send({ name: 'x' })).status).toBe(404);
    expect((await api.patch('/api/admin/users/not-a-uuid').send({ name: 'x' })).status).toBe(404);
  });

  it('deactivation ends the user\'s sessions and blocks login-less access', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const user = await createUser(org, 'member');
    const userApi = await as(user);
    expect((await userApi.get('/api/users')).status).toBe(200);
    const res = await as(admin).patch(`/api/admin/users/${user.id}`).send({ active: false });
    expect(res.body.active).toBe(false);
    expect(await dbFor(org).count('session', { user_id: user.id })).toBe(0);
    expect((await userApi.get('/api/users')).status).toBe(401);
    // deactivated users disappear from pickers
    const picker = await as(admin).get('/api/users');
    expect(picker.body.items.map((u: { id: string }) => u.id)).toEqual([admin.id]);
    // and can be reactivated
    expect((await as(admin).patch(`/api/admin/users/${user.id}`).send({ active: true })).body.active).toBe(true);
  });

  it('protects the last admin and the acting admin', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const api = await as(admin);
    for (const patch of [{ active: false }, { org_role: 'member' }]) {
      const res = await api.patch(`/api/admin/users/${admin.id}`).send(patch);
      expect([res.status, res.body.error.code]).toEqual([422, 'self_change']);
    }
    const second = await createUser(org, 'admin');
    await dbFor(org).update('user', admin.id, { active: false }); // the acting admin was deactivated meanwhile…
    await dbFor(org).update('user', admin.id, { active: true });
    await dbFor(org).update('user', second.id, { active: true });
    // second is the only OTHER admin; demoting them is fine while `admin` stays
    expect((await (await as(admin)).patch(`/api/admin/users/${second.id}`).send({ org_role: 'member' })).status).toBe(200);
    // now make `third` an admin and deactivate `admin` directly: third is then the last active admin
    const third = await createUser(org, 'admin');
    const fourth = await createUser(org, 'admin', { active: false });
    const thirdApi = await as(third);
    await dbFor(org).update('user', admin.id, { active: false });
    const res = await as(fourth).get('/api/admin/users');
    expect(res.status).toBe(401); // inactive admin has no access at all
    const demote = await thirdApi.patch(`/api/admin/users/${third.id}`).send({ org_role: 'member' });
    expect(demote.status).toBe(422);
    expect((await dbFor(org).get('user', third.id))?.org_role).toBe('admin');
  });

  it('reset-totp clears 2FA so the user enrols again, and ends their sessions', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const user = await createUser(org, 'member', { password: 'a long enough password' });
    await as(user);
    const res = await as(admin).post(`/api/admin/users/${user.id}/reset-totp`);
    expect(res.status).toBe(200);
    expect(res.body.totp_enabled).toBe(false);
    const row = await dbFor(org).get('user', user.id);
    expect(row).toMatchObject({ totp_secret: null, totp_enabled_at: null, totp_last_step: null });
    expect(await dbFor(org).count('session', { user_id: user.id })).toBe(0);
    expect(JSON.stringify(await dbFor(org).list('audit_log', { entity_id: user.id }))).not.toContain(user.totpSecret);
    expect((await as(admin).post(`/api/admin/users/${missingId()}/reset-totp`)).status).toBe(404);
  });

  it('cross-org: an admin cannot see or change users of another organization', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const victim = await createUser(orgA, 'member', { name: 'Victim' });
    const foreign = await as(await createUser(orgB, 'admin'));
    expect((await foreign.patch(`/api/admin/users/${victim.id}`).send({ org_role: 'admin', active: false })).status).toBe(404);
    expect((await foreign.post(`/api/admin/users/${victim.id}/reset-totp`)).status).toBe(404);
    expect(JSON.stringify((await foreign.get('/api/admin/users')).body)).not.toContain(victim.id);
    expect(JSON.stringify((await foreign.get('/api/users')).body)).not.toContain(victim.id);
    expect(await dbFor(orgA).get('user', victim.id)).toMatchObject({ org_role: 'member', active: true, name: 'Victim' });
  });
});

describe('the last admin (review L2)', () => {
  it('two admins demoting / deactivating each other at the same time: exactly one succeeds, an admin always remains', async () => {
    for (let round = 0; round < 5; round++) {
      const org = await createOrg();
      const a = await createUser(org, 'admin');
      const b = await createUser(org, 'admin');
      const [apiA, apiB] = [await as(a), await as(b)];
      const patch = round % 2 === 0 ? { org_role: 'member' } : { active: false };
      const results = await Promise.all([apiA.patch(`/api/admin/users/${b.id}`).send(patch), apiB.patch(`/api/admin/users/${a.id}`).send(patch)]);
      // the loser is refused by the rule (422 last_admin) or because the winner just took their admin session away
      expect(results.filter((r) => r.status === 200), `round ${round}: ${results.map((r) => r.status)}`).toHaveLength(1);
      expect(await dbFor(org).count('user', { org_role: 'admin', active: true })).toBe(1);
    }
  });
});

describe('NUL characters in text (review L3)', () => {
  it('are a 400, never a 500 — in JSON bodies and in query strings', async () => {
    const org = await createOrg();
    const admin = await as(await createUser(org, 'admin'));
    const tender = await createTender(org);
    const bodies = [
      await admin.post(`/api/tenders/${tender.id}/risks`).send({ title: 'κίνδυνος\u0000με NUL' }),
      await admin.post('/api/holidays').send({ date: '2031-03-03', name: 'αργία\u0000' }),
      await admin.post('/api/company-documents').send({ type: 'iso', title: 'ISO\u0000 9001' }),
      await admin.post(`/api/tenders/${tender.id}/lessons`).send({ text: 'μάθημα\u0000' }),
      await admin.get('/api/tenders').query({ q: 'a\u0000b' }),
      await admin.get('/api/audit').query({ entity: 'ten\u0000der' }),
    ];
    for (const res of bodies) expect([res.status, res.body.error?.code], JSON.stringify(res.body)).toEqual([400, 'validation_error']);
  });
});

describe('POST /api/admin/users/:id/reset-password', () => {
  const PASSWORD = 'a long enough password';
  const tokenOf = (url: string) => decodeURIComponent(url.split('/reset/')[1]!);

  it('admin only; ends the sessions, kills the old password and issues a single-use link — never a password', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const user = await createUser(org, 'member', { password: PASSWORD });
    const session = await as(user);
    expect((await session.get('/api/auth/me')).status).toBe(200);
    for (const role of ['bid_manager', 'member', 'approver', 'viewer'] as const) {
      expect((await as(await createUser(org, role)).post(`/api/admin/users/${user.id}/reset-password`)).status).toBe(403);
    }
    testOutbox.length = 0;
    const res = await as(admin).post(`/api/admin/users/${user.id}/reset-password`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ user: { id: user.id }, expiresInHours: 24, emailSent: true });
    expect(res.body.resetUrl).toMatch(/\/reset\/[\w-]{20,}$/);
    const token = tokenOf(res.body.resetUrl);
    // sessions gone, old password dead, only the hash of the token stored, nothing secret in audit or mail
    expect((await session.get('/api/auth/me')).status).toBe(401);
    expect((await anon().post('/api/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(401);
    const rows = await dbFor(org).list('password_reset', { user_id: user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(await dbFor(org).list('audit_log', { entity_id: user.id }))).not.toContain(token);
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]).toMatchObject({ to: user.email });
    expect(testOutbox[0]!.text).toContain(res.body.resetUrl);

    // the link: info, then set a password once
    const info = await anon().post('/api/auth/reset-info').send({ token });
    expect([info.status, info.body.email]).toEqual([200, user.email]);
    expect((await anon().post('/api/auth/reset-password').send({ token, password: 'short' })).status).toBe(400);
    const set = await anon().post('/api/auth/reset-password').send({ token, password: 'a brand new password' });
    expect([set.status, set.body.ok]).toEqual([200, true]);
    const again = await anon().post('/api/auth/reset-password').send({ token, password: 'yet another password' });
    expect([again.status, again.body.error.code]).toEqual([404, 'reset_invalid']);
    expect((await anon().post('/api/auth/reset-info').send({ token })).status).toBe(404);
    // new password works and still needs the second factor (TOTP untouched)
    const login = await anon().post('/api/auth/login').send({ email: user.email, password: 'a brand new password' });
    expect([login.status, login.body.stage]).toEqual([200, 'totp']);
    expect((await anon().post('/api/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(401);
    const actions = (await dbFor(org).list('audit_log', { entity_id: user.id })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['password_reset_requested', 'password_reset_completed']));
  });

  it('a new link revokes the previous one; expired links, inactive users and unknown ids are refused', async () => {
    const org = await createOrg();
    const api = await as(await createUser(org, 'admin'));
    const user = await createUser(org, 'member', { password: PASSWORD });
    const first = tokenOf((await api.post(`/api/admin/users/${user.id}/reset-password`)).body.resetUrl);
    const second = tokenOf((await api.post(`/api/admin/users/${user.id}/reset-password`)).body.resetUrl);
    expect((await anon().post('/api/auth/reset-info').send({ token: first })).status).toBe(404);
    expect((await anon().post('/api/auth/reset-info').send({ token: second })).status).toBe(200);
    await dbFor(org).sql("UPDATE password_reset SET expires_at = now() - interval '1 minute' WHERE org_id = :org_id AND user_id = :id", { id: user.id });
    const expired = await anon().post('/api/auth/reset-password').send({ token: second, password: 'a brand new password' });
    expect([expired.status, expired.body.error.code]).toEqual([404, 'reset_invalid']);

    const inactive = await createUser(org, 'member', { active: false });
    const res = await api.post(`/api/admin/users/${inactive.id}/reset-password`);
    expect([res.status, res.body.error.code]).toEqual([422, 'user_inactive']);
    expect((await api.post(`/api/admin/users/${missingId()}/reset-password`)).status).toBe(404);
    // a link stops working when the user is deactivated afterwards
    const later = await createUser(org, 'member', { password: PASSWORD });
    const token = tokenOf((await api.post(`/api/admin/users/${later.id}/reset-password`)).body.resetUrl);
    await api.patch(`/api/admin/users/${later.id}`).send({ active: false });
    expect((await anon().post('/api/auth/reset-password').send({ token, password: 'a brand new password' })).status).toBe(404);
  });

  it('cross-org: an admin cannot reset a user of another organization', async () => {
    const orgA = await createOrg();
    const victim = await createUser(orgA, 'member', { password: PASSWORD });
    const foreign = await as(await createUser(await createOrg(), 'admin'));
    expect((await foreign.post(`/api/admin/users/${victim.id}/reset-password`)).status).toBe(404);
    expect(await dbFor(orgA).count('password_reset', {})).toBe(0);
    expect((await anon().post('/api/auth/login').send({ email: victim.email, password: PASSWORD })).status).toBe(200);
  });
});

describe('/api/admin/invitations', () => {
  it('creates, lists and revokes; a new invitation replaces a pending one for the same e-mail', async () => {
    const org = await createOrg();
    const api = await as(await createUser(org, 'admin'));
    const first = await api.post('/api/admin/invitations').send({ email: 'a@example.com' });
    expect(first.status).toBe(201);
    expect(first.body.invitation).toMatchObject({ email: 'a@example.com', org_role: 'member', status: 'pending' });
    const expires = new Date(first.body.invitation.expires_at).getTime() - Date.now();
    expect(expires).toBeGreaterThan(6.9 * 86_400_000);
    expect(expires).toBeLessThan(7.1 * 86_400_000);

    const second = await api.post('/api/admin/invitations').send({ email: 'A@example.com', org_role: 'viewer' });
    expect(second.body.token).not.toBe(first.body.token);
    const list = await api.get('/api/admin/invitations');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: second.body.invitation.id, org_role: 'viewer' });
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['accepted_at', 'created_at', 'email', 'expires_at', 'id', 'org_role', 'status']);

    expect((await api.delete(`/api/admin/invitations/${second.body.invitation.id}`)).status).toBe(204);
    expect((await api.delete(`/api/admin/invitations/${second.body.invitation.id}`)).status).toBe(404);
    expect((await api.get('/api/admin/invitations')).body.items).toEqual([]);
  });

  it('rejects invalid input and e-mails that already have an account', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const api = await as(admin);
    expect((await api.post('/api/admin/invitations').send({ email: 'nope' })).status).toBe(400);
    expect((await api.post('/api/admin/invitations').send({ email: 'a@example.com', org_role: 'owner' })).status).toBe(400);
    expect((await api.post('/api/admin/invitations').send({ email: 'a@example.com', org_id: missingId() })).status).toBe(400);
    const dup = await api.post('/api/admin/invitations').send({ email: admin.email.toUpperCase() });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'user_exists']);
  });

  it('cross-org: invitations are invisible and irrevocable from another organization; the same e-mail can be invited by both', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const a = await as(await createUser(orgA, 'admin'));
    const b = await as(await createUser(orgB, 'admin'));
    const inv = await a.post('/api/admin/invitations').send({ email: 'shared@example.com' });
    expect((await b.get('/api/admin/invitations')).body.items).toEqual([]);
    expect((await b.delete(`/api/admin/invitations/${inv.body.invitation.id}`)).status).toBe(404);
    expect((await b.post('/api/admin/invitations').send({ email: 'shared@example.com' })).status).toBe(201);
    expect((await a.get('/api/admin/invitations')).body.items).toHaveLength(1);
    expect((await dbFor(orgA).list('invitation'))[0].org_id).toBe(orgA.id);
  });
});

describe('/api/users (directory)', () => {
  it('admin and bid manager get id/name/email/org_role of every active user of the own org', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const admin = await createUser(org, 'admin', { name: 'Zed' });
    const member = await createUser(org, 'member', { name: 'Anna', password: 'a long enough password' });
    await createUser(org, 'member', { name: 'Gone', active: false });
    await createUser(other, 'member', { name: 'Foreign' });
    const expected = {
      items: [
        { id: member.id, name: 'Anna', email: member.email, org_role: 'member' },
        { id: admin.id, name: 'Zed', email: admin.email, org_role: 'admin' },
      ],
    };
    expect((await as(admin).get('/api/users')).body).toEqual(expected);
    const manager = await createUser(org, 'bid_manager', { name: 'Zz manager' });
    expect((await as(manager).get('/api/users')).body.items.map((u: { name: string }) => u.name)).toEqual(['Anna', 'Zed', 'Zz manager']);
  });

  it('everyone else sees only the people they share a tender with; a viewer never gets e-mail addresses (review M4)', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin', { name: 'Admin' });
    const manager = await createUser(org, 'bid_manager', { name: 'Manager' });
    const anna = await createUser(org, 'member', { name: 'Anna' });
    const bob = await createUser(org, 'approver', { name: 'Bob' });
    const carol = await createUser(org, 'member', { name: 'Carol' }); // only on another tender
    const viewer = await createUser(org, 'viewer', { name: 'Viewer' });
    const loner = await createUser(org, 'member', { name: 'Loner' }); // on no tender
    const t1 = await createTender(org);
    const t2 = await createTender(org);
    for (const u of [anna, bob, viewer]) await addMember(t1, u);
    await addMember(t2, carol);
    const names = async (u: { id: string; org_id: string }) => ((await as(u).get('/api/users')).body.items as { name: string }[]).map((x) => x.name);

    expect(await names(anna)).toEqual(['Admin', 'Anna', 'Bob', 'Manager', 'Viewer']);
    expect(await names(carol)).toEqual(['Admin', 'Carol', 'Manager']);
    expect(await names(loner)).toEqual(['Loner']);
    const asViewer = (await as(viewer).get('/api/users')).body.items as { id: string; name: string; email: string | null }[];
    expect(asViewer.map((u) => u.name)).toEqual(['Admin', 'Anna', 'Bob', 'Manager', 'Viewer']);
    expect(asViewer.filter((u) => u.email !== null).map((u) => u.id)).toEqual([viewer.id]); // only their own
    const text = JSON.stringify(asViewer);
    for (const u of [admin, manager, anna, bob, carol]) expect(text).not.toContain(u.email);
    expect((await as(anna).get('/api/users')).body.items.find((u: { id: string }) => u.id === bob.id).email).toBe(bob.email);

    // the same rules in the register's owner picker and in the team list
    await addRole(t1, 'A');
    const owners = async (u: { id: string; org_id: string }) => (await as(u).get(`/api/tenders/${t1.id}/requirements`)).body.owners.users as { name: string; email: string | null }[];
    expect((await owners(anna)).map((u) => u.name)).toEqual(['Admin', 'Anna', 'Bob', 'Manager', 'Viewer']);
    expect((await owners(admin)).map((u) => u.name)).toContain('Carol');
    expect((await owners(viewer)).every((u) => u.email === null)).toBe(true);
    const team = (await as(viewer).get(`/api/tenders/${t1.id}/members`)).body.items as { user: { email: string | null } }[];
    expect(team.length).toBe(3);
    expect(team.every((m) => m.user.email === null)).toBe(true);
    expect(((await as(anna).get(`/api/tenders/${t1.id}/members`)).body.items as { user: { email: string | null } }[]).every((m) => typeof m.user.email === 'string')).toBe(true);
  });
});
