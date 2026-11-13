import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load server/.env when present (never in tests: the test database comes from globalSetup).
if (process.env.NODE_ENV !== 'test' && process.env.BM_NO_DOTENV !== '1') {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const DEV_DATABASE_URL = 'postgres://bidmanager:bidmanager@127.0.0.1:5432/bidmanager_dev';
// Fixed, public key: used ONLY under NODE_ENV=test. Every other run must bring its own key (see the check below).
const TEST_FILE_ENCRYPTION_KEY = '6465762d6f6e6c792d6b65792d646f2d6e6f742d7573652d696e2d70726f6421';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const bool = z.preprocess(
  (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : v),
  z.boolean(),
);

function parseKey(value: string): Buffer | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v, 'base64');
  return b.length === 32 ? b : null;
}

const schema = z
  .object({
    NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'production']).default('development')),
    PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().default(DEV_DATABASE_URL)),
    APP_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:5173')),
    SESSION_IDLE_MINUTES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1440).default(30)),
    TRUST_PROXY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(10).default(0)),
    FILE_STORAGE_DIR: z.preprocess(emptyToUndefined, z.string().default('./storage')),
    FILE_ENCRYPTION_KEY: opt(z.string()),
    SMTP_HOST: opt(z.string()),
    SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().default(587)),
    SMTP_SECURE: z.preprocess(emptyToUndefined, bool.default(false)),
    SMTP_USER: opt(z.string()),
    SMTP_PASS: opt(z.string()),
    SMTP_FROM: z.preprocess(emptyToUndefined, z.string().default('Bid Manager <no-reply@example.com>')),
    /** Directory of the built SPA (web/dist). Served by this process when it exists; set to `off` to disable. */
    WEB_DIST_DIR: opt(z.string()),
    /** Optional URL that receives unhandled errors as JSON POSTs (see core/errorTracking.ts). */
    ERROR_TRACKING_DSN: opt(z.string().url()),
    /** Optional version label attached to error events (e.g. a git SHA). */
    RELEASE: opt(z.string().max(100)),
    LOG_LEVEL: opt(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])),
  })
  .superRefine((env, ctx) => {
    if (env.FILE_ENCRYPTION_KEY && !parseKey(env.FILE_ENCRYPTION_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['FILE_ENCRYPTION_KEY'], message: 'must be 32 bytes (64 hex chars or base64)' });
    }
    if (env.NODE_ENV === 'production' && !env.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'required in production (invitations, password resets and notifications are e-mails)' });
    }
    if (env.NODE_ENV === 'production' && process.env.TRUST_PROXY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: 'must be set explicitly in production: the number of reverse proxies in front of the app (1 behind Caddy/nginx, 0 when exposed directly)',
      });
    }
    if (env.NODE_ENV !== 'test' && !env.FILE_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['FILE_ENCRYPTION_KEY'],
        message: 'required — generate one with `openssl rand -hex 32` and put it in server/.env (development) or the environment (production)',
      });
    }
    if (env.NODE_ENV === 'production' && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must be https in production' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${lines}`);
}
const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  appUrl: env.APP_URL.replace(/\/+$/, ''),
  sessionIdleMinutes: env.SESSION_IDLE_MINUTES,
  trustProxy: env.TRUST_PROXY,
  fileStorageDir: env.FILE_STORAGE_DIR,
  /** 32-byte key for AES-256-GCM (files at rest, TOTP secrets). */
  fileEncryptionKey: parseKey(env.FILE_ENCRYPTION_KEY ?? TEST_FILE_ENCRYPTION_KEY) as Buffer,
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
  },
  /**
   * Where the built web app lives. Default: <repo>/web/dist (the same relative path from src/ and from dist/).
   * Never served under NODE_ENV=test unless a test passes a directory to createApp(); `off` disables it.
   */
  webDistDir: env.WEB_DIST_DIR === 'off' ? null : (env.WEB_DIST_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url))),
  errorTrackingDsn: env.ERROR_TRACKING_DSN ?? null,
  release: env.RELEASE ?? null,
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
} as const;

export type Config = typeof config;
