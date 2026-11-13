import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../core/logger.js';
import { listOrganizations, purgeExpiredSessions } from '../db/admin.js';
import { scopedDb, type ScopedDb } from '../db/scoped.js';
import { todayAthens } from '../domain/time.js';

// Scheduled jobs. A job is a function run once per organization per date:
//   registerJob('daily-digest', DAILY_07, async ({ db, runDate }) => { ...; return { sent: 3 }; });
// Put the registerJob() calls of a feature in src/modules/<name>/jobs.ts — startJobs() imports every such file,
// so nobody needs to edit this one. Idempotency and the execution log come from the job_run table.

export const JOBS_TIMEZONE = 'Europe/Athens';
/** 07:00 Athens time, every day — the slot of the daily jobs (digest, expirations, R6). */
export const DAILY_07 = '0 7 * * *';
/** A "running" row older than this is considered a crashed run and may be taken over. */
const STALE_RUN_MINUTES = 60;

export interface JobContext {
  orgId: string;
  /** Scoped to the org, with no user (created_by / audit user are NULL). */
  db: ScopedDb;
  /** Athens date ('YYYY-MM-DD') this run is for. */
  runDate: string;
}
export type JobFn = (ctx: JobContext) => Promise<unknown> | unknown;
export interface JobRunResult {
  orgId: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: unknown;
}

interface JobDef {
  name: string;
  cronExpr: string;
  fn: JobFn;
}

const registry = new Map<string, JobDef>();
const tasks: ScheduledTask[] = [];

/** Registers a job. `fn` runs once per organization per Athens date; its return value is stored in job_run.detail. */
export function registerJob(name: string, cronExpr: string, fn: JobFn): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`registerJob: invalid job name "${name}"`);
  if (!cron.validate(cronExpr)) throw new Error(`registerJob: invalid cron expression "${cronExpr}" for job "${name}"`);
  if (registry.has(name)) throw new Error(`registerJob: job "${name}" is already registered`);
  registry.set(name, { name, cronExpr, fn });
}

export function registeredJobs(): { name: string; cronExpr: string }[] {
  return [...registry.values()].map(({ name, cronExpr }) => ({ name, cronExpr }));
}

/** Tests: empty the registry. */
export function clearJobs(): void {
  registry.clear();
}

/**
 * Runs a job now for every organization (or just `orgId`). An org whose job_run row for (job, date) already
 * exists is skipped — unless that run failed, or is a stale "running" row, in which case it is retried.
 * A failure in one org is logged and recorded and does not stop the others. Never throws for job errors.
 */
export async function runJob(name: string, opts: { date?: string; orgId?: string } = {}): Promise<JobRunResult[]> {
  const job = registry.get(name);
  if (!job) throw new Error(`runJob: unknown job "${name}"`);
  const runDate = opts.date ?? todayAthens();
  const orgIds = opts.orgId ? [opts.orgId] : (await listOrganizations()).map((o) => o.id);
  const results: JobRunResult[] = [];
  for (const orgId of orgIds) {
    const db = scopedDb(orgId, null);
    // Atomic claim: the unique key (org_id, job, run_date) guarantees at most one winner, also across processes.
    const [claim] = await db.sql<{ id: string }>(
      `INSERT INTO job_run (org_id, job, run_date, status, started_at)
       VALUES (:org_id, :job, :run_date, 'running', now())
       ON CONFLICT (org_id, job, run_date) DO UPDATE
          SET status = 'running', started_at = now(), finished_at = NULL, detail = NULL, attempts = job_run.attempts + 1
        WHERE job_run.status = 'failed'
           OR (job_run.status = 'running' AND job_run.started_at < now() - make_interval(mins => :stale))
       RETURNING id`,
      { job: name, run_date: runDate, stale: STALE_RUN_MINUTES },
    );
    if (!claim) {
      results.push({ orgId, status: 'skipped' });
      continue;
    }
    let status: 'ok' | 'failed' = 'ok';
    let detail: unknown = null;
    try {
      detail = (await job.fn({ orgId, db, runDate })) ?? null;
    } catch (err) {
      status = 'failed';
      detail = { error: err instanceof Error ? err.message : String(err) };
      logger.error({ err, job: name, orgId, runDate }, 'job failed');
    }
    await db.sql('UPDATE job_run SET status = :status, finished_at = now(), detail = CAST(:detail AS jsonb) WHERE org_id = :org_id AND id = :id', {
      id: claim.id,
      status,
      detail: JSON.stringify(detail),
    });
    logger.info({ job: name, orgId, runDate, status }, 'job run finished');
    results.push({ orgId, status, detail });
  }
  return results;
}

/** Imports src/modules/<name>/jobs.(ts|js) of every module that has one, so its registerJob() calls run. */
export async function loadModuleJobs(): Promise<string[]> {
  const modulesDir = fileURLToPath(new URL('../modules', import.meta.url));
  const loaded: string[] = [];
  if (!existsSync(modulesDir)) return loaded;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of ['jobs.js', 'jobs.ts']) {
      const full = path.join(modulesDir, entry.name, file);
      if (existsSync(full)) {
        await import(pathToFileURL(full).href);
        loaded.push(entry.name);
        break;
      }
    }
  }
  return loaded;
}

/** Called from index.ts only (never from createApp(), so tests do not start timers). */
export async function startJobs(): Promise<void> {
  if (tasks.length > 0) return;
  await loadModuleJobs();
  for (const job of registry.values()) {
    tasks.push(
      cron.schedule(
        job.cronExpr,
        async () => {
          try {
            await runJob(job.name);
          } catch (err) {
            logger.error({ err, job: job.name }, 'job runner failed');
          }
        },
        { timezone: JOBS_TIMEZONE, name: job.name, noOverlap: true },
      ),
    );
  }
  // Housekeeping that is not per-organization (so not a registered job): drop expired sessions nightly.
  tasks.push(
    cron.schedule(
      '30 3 * * *',
      async () => {
        try {
          await purgeExpiredSessions();
        } catch (err) {
          logger.error({ err }, 'session purge failed');
        }
      },
      { timezone: JOBS_TIMEZONE, name: 'purge-expired-sessions', noOverlap: true },
    ),
  );
  logger.info({ jobs: registeredJobs() }, 'jobs scheduled');
}

export async function stopJobs(): Promise<void> {
  for (const task of tasks.splice(0)) await task.stop();
}
