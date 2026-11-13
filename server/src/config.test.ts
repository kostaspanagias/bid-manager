import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// config.ts validates the environment at import time, so each case loads it in a fresh process.
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'a'.repeat(64);

function load(env: Record<string, string>): { ok: boolean; output: string } {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BM_NO_DOTENV: '1' };
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./src/config.ts').then((m) => console.log('OK', JSON.stringify({ trustProxy: m.config.trustProxy, smtp: m.config.smtp.host })))"],
    { cwd: serverDir, env: { ...clean, ...env }, encoding: 'utf8' },
  );
  return { ok: r.status === 0 && r.stdout.includes('OK'), output: `${r.stdout}\n${r.stderr}` };
}

const PROD = {
  NODE_ENV: 'production',
  APP_URL: 'https://bids.example.gr',
  DATABASE_URL: 'postgres://u:p@db:5432/bidmanager',
  FILE_ENCRYPTION_KEY: KEY,
  SMTP_HOST: 'smtp.example.gr',
  TRUST_PROXY: '1',
};

describe('environment validation (review M3, M5, L4)', () => {
  it('a complete production environment starts', () => {
    const r = load(PROD);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain('"trustProxy":1');
  }, 30_000);

  it('production refuses to start without SMTP_HOST, without an explicit TRUST_PROXY, without https, without a key', () => {
    for (const [missing, env] of [
      ['SMTP_HOST', { ...PROD, SMTP_HOST: '' }],
      ['TRUST_PROXY', (({ TRUST_PROXY: _t, ...rest }) => rest)(PROD)],
      ['APP_URL', { ...PROD, APP_URL: 'http://bids.example.gr' }],
      ['FILE_ENCRYPTION_KEY', { ...PROD, FILE_ENCRYPTION_KEY: '' }],
    ] as const) {
      const r = load(env as Record<string, string>);
      expect(r.ok, missing).toBe(false);
      expect(r.output, missing).toContain(`${missing}:`);
    }
    // TRUST_PROXY=0 is an explicit choice (app exposed directly) and is accepted
    expect(load({ ...PROD, TRUST_PROXY: '0' }).ok).toBe(true);
  }, 60_000);

  it('development also needs its own FILE_ENCRYPTION_KEY — the built-in key exists for tests only', () => {
    const without = load({ NODE_ENV: 'development' });
    expect(without.ok).toBe(false);
    expect(without.output).toContain('FILE_ENCRYPTION_KEY');
    expect(load({ NODE_ENV: 'development', FILE_ENCRYPTION_KEY: KEY }).ok).toBe(true);
    expect(load({ NODE_ENV: 'test' }).ok).toBe(true);
  }, 60_000);
});
