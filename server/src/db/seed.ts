// npm run seed -w server — idempotent bootstrap of the single organization, its first admin and the holidays.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../core/password.js';
import { seedHolidaysForYear } from '../domain/holidays.js';
import { todayAthens } from '../domain/time.js';
import { createOrganization, listOrganizations } from './admin.js';
import { closePool } from './pool.js';
import { scopedDb } from './scoped.js';
import { seedTemplateL11 } from './seeds/templateL11.js';

export { seedTemplateL11 };

export interface SeedResult {
  orgId: string;
  orgCreated: boolean;
  adminEmail: string;
  adminCreated: boolean;
  /** Only set when the admin was created now with a generated password. */
  generatedPassword: string | null;
  holidaysAdded: number;
  /** Template «L v1.1» (blueprint content) was created now. */
  templateCreated: boolean;
}

export async function seed(env: NodeJS.ProcessEnv = process.env): Promise<SeedResult> {
  const existing = await listOrganizations();
  const org = existing[0] ?? (await createOrganization({ name: env.SEED_ORG_NAME?.trim() || 'Organization', timezone: 'Europe/Athens' }));
  const db = scopedDb(org.id, null);

  const adminEmail = (env.SEED_ADMIN_EMAIL?.trim() || 'admin@example.com').toLowerCase();
  let adminCreated = false;
  let generatedPassword: string | null = null;
  if (!(await db.findOne('user', { email: adminEmail }))) {
    let password = env.SEED_ADMIN_PASSWORD ?? '';
    if (password === '') {
      password = randomBytes(18).toString('base64url');
      generatedPassword = password;
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    await db.insert('user', { email: adminEmail, name: 'Administrator', org_role: 'admin', password_hash: await hashPassword(password) });
    adminCreated = true;
  }

  const year = Number(todayAthens().slice(0, 4));
  let holidaysAdded = 0;
  for (let y = year - 1; y <= year + 2; y++) holidaysAdded += (await seedHolidaysForYear(db, y)).length;

  const template = await seedTemplateL11(db);

  return { orgId: org.id, orgCreated: existing.length === 0, adminEmail, adminCreated, generatedPassword, holidaysAdded, templateCreated: template.created };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await seed();
    console.log(`Organization ${r.orgId} ${r.orgCreated ? 'created' : 'already exists'}.`);
    if (r.adminCreated) {
      console.log(`Admin user created: ${r.adminEmail}`);
      if (r.generatedPassword) console.log(`Generated password (shown once, store it now): ${r.generatedPassword}`);
      console.log('Two-factor authentication is set up at first login.');
    } else {
      console.log(`Admin user ${r.adminEmail} already exists (password unchanged).`);
    }
    console.log(`Holidays added: ${r.holidaysAdded}.`);
    console.log(`Template «L v1.1» ${r.templateCreated ? 'created' : 'already exists'}.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
