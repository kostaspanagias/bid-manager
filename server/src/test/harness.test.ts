import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { loadHolidays } from '../domain/holidays.js';
import { athensDate } from '../domain/time.js';
import { addMember, addRole, anon, as, createOrg, createTender, createUser, dbFor, missingId, seedHolidays } from './harness.js';

describe('test harness', () => {
  it('runs against a fresh, uniquely named test database', () => {
    expect(config.isTest).toBe(true);
    expect(new URL(config.databaseUrl).pathname).toMatch(/^\/bidmanager_test_[a-z0-9]+_\d+_[0-9a-f]{6}$/);
  });

  it('createOrg / createUser / createTender give usable rows with sensible defaults and overrides', async () => {
    const org = await createOrg({ name: 'ACS', retention_days: 365 });
    expect(org).toMatchObject({ name: 'ACS', timezone: 'Europe/Athens', retention_days: 365 });
    expect((await createOrg()).id).not.toBe(org.id);

    const member = await createUser(org);
    expect(member).toMatchObject({ org_id: org.id, org_role: 'member', active: true, password_hash: null });
    expect(member.email).toMatch(/@example\.com$/);
    const admin = await createUser(org, 'admin', { name: 'Κώστας', email: 'Kostas@Example.com' });
    expect(admin).toMatchObject({ org_role: 'admin', name: 'Κώστας', email: 'kostas@example.com' });
    const withLogin = await createUser(org, 'approver', { password: 'a long enough password' });
    expect(withLogin.password).toBe('a long enough password');
    expect(withLogin.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(withLogin.totp_enabled_at).toBeInstanceOf(Date);

    const tender = await createTender(org);
    expect(tender).toMatchObject({ org_id: org.id, status: 'in_progress', has_demo: false, has_partners: false, compressed_mode: false, guarantee_margin_days: 30 });
    expect(tender.submission_deadline_at.getTime()).toBeGreaterThan(Date.now() + 28 * 86_400_000);
    const custom = await createTender(org, { title: 'Προμήθεια εξοπλισμού', submission_deadline_at: '2027-05-07T12:00:00Z', has_demo: true, status: 'evaluation', cpv: ['30200000-1'] });
    expect(custom).toMatchObject({ title: 'Προμήθεια εξοπλισμού', has_demo: true, status: 'evaluation', cpv: ['30200000-1'] });
    expect(athensDate(custom.submission_deadline_at)).toBe('2027-05-07');
  });

  it('addRole / addMember / seedHolidays / dbFor', async () => {
    const org = await createOrg();
    const user = await createUser(org);
    const tender = await createTender(org);
    const role = await addRole(tender, 'C', { folder: 'financial', financial: true }, 'Οικονομική');
    expect(role).toMatchObject({ tender_id: tender.id, key: 'C', name: 'Οικονομική', payload: { financial: true } });
    expect(await addMember(tender, user, 'C')).toMatchObject({ tender_id: tender.id, user_id: user.id, tender_role_key: 'C', org_id: org.id });
    expect((await addMember(tender, await createUser(org))).tender_role_key).toBeNull();

    await seedHolidays(org, [2026, 2027]);
    await seedHolidays(org, 2027);
    expect((await loadHolidays(dbFor(org))).size).toBe(24);

    const db = dbFor(org, user);
    expect([db.orgId, db.userId]).toEqual([org.id, user.id]);
    expect(dbFor(org).userId).toBeNull();
    expect((await db.insert('risk', { tender_id: tender.id, title: 'r' })).created_by).toBe(user.id);
    expect(missingId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('as(user) works chained and awaited, sends cookie + CSRF header, and each user gets their own identity', async () => {
    const org = await createOrg({ name: 'Org One' });
    const admin = await createUser(org, 'admin');
    const viewer = await createUser(org, 'viewer');

    // chained form
    const me = await as(admin).get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ stage: 'ready', user: { id: admin.id, org_role: 'admin' }, org: { id: org.id, name: 'Org One' } });
    const created = await as(admin).post('/api/holidays').send({ date: '2036-03-03', name: 'x' }).expect(201);
    expect(created.body.date).toBe('2036-03-03');
    await expect(as(admin).get('/api/holidays').expect(500)).rejects.toThrow(/expected 500/);

    // awaited form: one session reused
    const api = await as(viewer);
    expect((await api.get('/api/auth/me')).body.user.id).toBe(viewer.id);
    expect((await api.post('/api/holidays').send({ date: '2036-03-04', name: 'x' })).status).toBe(403); // CSRF ok, role not
    expect((await api.get('/api/holidays')).body.items).toHaveLength(1);
    expect(await dbFor(org).count('session', { user_id: viewer.id })).toBe(1);

    expect((await anon().get('/api/auth/me')).status).toBe(401);
  });
});
