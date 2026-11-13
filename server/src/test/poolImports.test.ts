import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Tenant-ready rule: nothing outside src/db/ and the marked auth file may touch pg or the pool.
// Everything else must go through scopedDb() (req.ctx.db).

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = (rel: string) =>
  rel.startsWith('db/') || rel === 'core/authStore.ts' || rel === 'test/globalSetup.ts' || rel === 'test/poolImports.test.ts';

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

/** import/export … from '<spec>', import('<spec>'), require('<spec>') */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g;
  for (let m = re.exec(source); m; m = re.exec(source)) specs.push(m[2] as string);
  return specs;
}

const isForbidden = (spec: string) =>
  spec === 'pg' || spec.startsWith('pg/') || spec === 'pg-pool' || /(^|\/)pool(\.[cm]?[jt]s)?$/.test(spec) || /(^|\/)db\/admin(\.[cm]?[jt]s)?$/.test(spec);

/** db/admin.ts (cross-org helpers) may only be used by bootstrap code, never by request handlers. */
const ADMIN_ALLOWED = (rel: string) => ['app.ts', 'index.ts', 'jobs/index.ts', 'test/harness.ts', 'test/setup.ts'].includes(rel);

describe('pool import rule', () => {
  it('nothing outside src/db/ and core/authStore.ts imports pg or the pool', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      scanned++;
      if (ALLOWED(rel)) continue;
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (!isForbidden(spec)) continue;
        if (/db\/admin/.test(spec) && ADMIN_ALLOWED(rel)) continue;
        offenders.push(`${rel} imports "${spec}"`);
      }
    }
    expect(scanned).toBeGreaterThan(30);
    expect(offenders, `Use scopedDb()/req.ctx.db instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the detector recognises the forbidden forms', () => {
    const sample = `
      import pg from 'pg';
      import { getPool } from '../db/pool.js';
      import { Pool } from "pg";
      const x = await import('../../db/pool.js');
      const y = require('pg');
      export { getPool } from './pool.js';
      import '../db/pool.js';
      import { listOrganizations } from '../../db/admin.js';
      import { scopedDb } from '../db/scoped.js';
      import { z } from 'zod';
    `;
    expect(importSpecifiers(sample).filter(isForbidden)).toEqual([
      'pg', '../db/pool.js', 'pg', '../../db/pool.js', 'pg', './pool.js', '../db/pool.js', '../../db/admin.js',
    ]);
  });

  it('only authStore.ts in core/ holds unscoped queries and it is clearly marked', () => {
    const text = readFileSync(path.join(SRC, 'core/authStore.ts'), 'utf8');
    expect(text).toMatch(/UNSCOPED QUERIES/);
    expect(text).toMatch(/getPool/);
  });
});
