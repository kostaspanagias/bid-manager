import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../db/migrate.js';

// One fresh, uniquely named database per vitest run: created and migrated here, dropped at teardown.
// Parallel runs (several engineers/agents on one machine) therefore never collide.

const DEFAULT_URL = 'postgres://bidmanager:bidmanager@127.0.0.1:5432/bidmanager_dev';

export default async function setup(): Promise<() => Promise<void>> {
  // The server to create the test database on; the role needs CREATEDB. The database named here is only used
  // to connect — it is never modified.
  const adminUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || DEFAULT_URL;
  const name = `bidmanager_test_${Date.now().toString(36)}_${process.pid}_${randomBytes(3).toString('hex')}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  await migrate(testUrl.toString());

  // Inherited by the test workers (forked after this point); src/config.ts reads them there.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testUrl.toString();

  return async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };
}
