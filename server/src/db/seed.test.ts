import { describe, expect, it } from 'vitest';
import { anon } from '../test/harness.js';
import { listOrganizations } from './admin.js';
import { scopedDb } from './scoped.js';
import { seed } from './seed.js';

describe('seed', () => {
  it('creates the organization, the admin and four years of holidays — idempotently', async () => {
    const email = `seed-${Date.now()}@Example.com`;
    const env = { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: 'seed password 12345' };
    const first = await seed(env);
    expect(first.adminCreated).toBe(true);
    expect(first.adminEmail).toBe(email.toLowerCase());
    expect(first.generatedPassword).toBeNull();
    expect((await listOrganizations()).some((o) => o.id === first.orgId)).toBe(true);

    const db = scopedDb(first.orgId, null);
    expect((await db.get('organization', first.orgId))?.timezone).toBe('Europe/Athens');
    const admin = await db.findOne('user', { email: email.toLowerCase() });
    expect(admin).toMatchObject({ org_role: 'admin', active: true, totp_enabled_at: null });
    expect(admin?.password_hash).toMatch(/^\$argon2id\$/);
    const year = new Date().getFullYear();
    for (let y = year - 1; y <= year + 2; y++) {
      const rows = await db.sql('SELECT 1 FROM holiday WHERE org_id = :org_id AND date >= :a AND date <= :b', { a: `${y}-01-01`, b: `${y}-12-31` });
      expect(rows.length, String(y)).toBeGreaterThanOrEqual(11);
    }

    const holidays = await db.count('holiday');
    const second = await seed({ ...env, SEED_ADMIN_PASSWORD: 'a different password 1' });
    expect(second).toMatchObject({ orgId: first.orgId, orgCreated: false, adminCreated: false, holidaysAdded: 0 });
    expect(await db.count('holiday')).toBe(holidays);
    expect(await db.count('user', { email: email.toLowerCase() })).toBe(1);

    // the seeded admin can log in with the first password and is sent to TOTP enrolment
    const res = await anon().post('/api/auth/login').send({ email, password: 'seed password 12345' });
    expect(res.body.stage).toBe('totp_setup');
    expect((await anon().post('/api/auth/login').send({ email, password: 'a different password 1' })).status).toBe(401);
  });

  it('generates and reports a random password when none is given; rejects a short one', async () => {
    const res = await seed({ SEED_ADMIN_EMAIL: `seed-gen-${Date.now()}@example.com` });
    expect(res.adminCreated).toBe(true);
    expect(res.generatedPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect((await anon().post('/api/auth/login').send({ email: res.adminEmail, password: res.generatedPassword })).status).toBe(200);
    await expect(seed({ SEED_ADMIN_EMAIL: `seed-short-${Date.now()}@example.com`, SEED_ADMIN_PASSWORD: 'short' })).rejects.toThrow(/at least 12/);
  });
});
