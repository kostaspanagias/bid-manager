import { beforeEach, describe, expect, it } from 'vitest';
import { createOrg, dbFor } from '../test/harness.js';
import { catchUpDailyJobs, clearJobs, DAILY_07, JOBS_TIMEZONE, loadModuleJobs, registeredJobs, registerJob, runJob } from './index.js';

beforeEach(() => clearJobs());

describe('job registry', () => {
  it('registers jobs and validates name and cron expression', async () => {
    registerJob('daily-digest', DAILY_07, async () => undefined);
    expect(registeredJobs()).toEqual([{ name: 'daily-digest', cronExpr: '0 7 * * *' }]);
    expect(JOBS_TIMEZONE).toBe('Europe/Athens');
    expect(() => registerJob('daily-digest', DAILY_07, async () => undefined)).toThrow(/already registered/);
    expect(() => registerJob('bad', 'every morning', async () => undefined)).toThrow(/invalid cron/);
    expect(() => registerJob('Bad Name', DAILY_07, async () => undefined)).toThrow(/invalid job name/);
    await expect(runJob('nope')).rejects.toThrow(/unknown job/);
  });

  it('loadModuleJobs imports modules/<name>/jobs.ts files without failing when there are none', async () => {
    expect(Array.isArray(await loadModuleJobs())).toBe(true);
  });
});

describe('runJob — at most once per org per date, every execution logged', () => {
  it('runs once per organization with a scoped db and logs the result in job_run', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const seen: string[] = [];
    registerJob('t-once', DAILY_07, async ({ orgId, db, runDate }) => {
      seen.push(`${orgId}:${runDate}`);
      expect(db.orgId).toBe(orgId);
      expect(db.userId).toBeNull();
      await db.insert('email_log', { kind: 'digest', dedupe_key: `digest:${runDate}` });
      return { sent: 1 };
    });

    const first = await runJob('t-once', { date: '2027-05-05' });
    const mine = first.filter((r) => [orgA.id, orgB.id].includes(r.orgId));
    expect(mine).toEqual([
      { orgId: orgA.id, status: 'ok', detail: { sent: 1 } },
      { orgId: orgB.id, status: 'ok', detail: { sent: 1 } },
    ]);
    expect(seen).toContain(`${orgA.id}:2027-05-05`);
    expect(seen).toContain(`${orgB.id}:2027-05-05`);

    const run = await dbFor(orgA).findOne('job_run', { job: 't-once', run_date: '2027-05-05' });
    expect(run).toMatchObject({ status: 'ok', detail: { sent: 1 }, attempts: 1, org_id: orgA.id });
    expect(run?.finished_at.getTime()).toBeGreaterThanOrEqual(run?.started_at.getTime());

    // second run for the same date: skipped everywhere, fn not called again
    const callsBefore = seen.length;
    const second = await runJob('t-once', { date: '2027-05-05' });
    expect(second.every((r) => r.status === 'skipped')).toBe(true);
    expect(seen.length).toBe(callsBefore);
    expect(await dbFor(orgA).count('email_log')).toBe(1);
    expect(await dbFor(orgB).count('email_log')).toBe(1);

    // a new date runs again
    const third = await runJob('t-once', { date: '2027-05-06', orgId: orgA.id });
    expect(third).toEqual([{ orgId: orgA.id, status: 'ok', detail: { sent: 1 } }]);
    expect(await dbFor(orgA).count('job_run', { job: 't-once' })).toBe(2);
    expect(await dbFor(orgB).count('job_run', { job: 't-once' })).toBe(1);
  });

  it('concurrent runs for the same org and date execute the job exactly once', async () => {
    const org = await createOrg();
    let calls = 0;
    registerJob('t-concurrent', DAILY_07, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => runJob('t-concurrent', { date: '2027-05-05', orgId: org.id })));
    expect(calls).toBe(1);
    expect(results.flat().map((r) => r.status).sort()).toEqual(['ok', 'skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('a failure is logged, does not stop other orgs, and the run can be retried', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    let failA = true;
    registerJob('t-retry', DAILY_07, async ({ orgId }) => {
      if (orgId === orgA.id && failA) throw new Error('smtp down');
      return { ok: true };
    });
    const first = await runJob('t-retry', { date: '2027-05-05' });
    expect(first.find((r) => r.orgId === orgA.id)).toEqual({ orgId: orgA.id, status: 'failed', detail: { error: 'smtp down' } });
    expect(first.find((r) => r.orgId === orgB.id)?.status).toBe('ok');
    expect(await dbFor(orgA).findOne('job_run', { job: 't-retry' })).toMatchObject({ status: 'failed', detail: { error: 'smtp down' }, attempts: 1 });

    failA = false;
    const second = await runJob('t-retry', { date: '2027-05-05' });
    expect(second.find((r) => r.orgId === orgA.id)?.status).toBe('ok');
    expect(second.find((r) => r.orgId === orgB.id)?.status).toBe('skipped');
    expect(await dbFor(orgA).findOne('job_run', { job: 't-retry' })).toMatchObject({ status: 'ok', attempts: 2 });
    expect(await dbFor(orgA).count('job_run', { job: 't-retry' })).toBe(1);
  });

  it('a stale "running" row (crashed process) is taken over; a fresh one is not', async () => {
    const org = await createOrg();
    let calls = 0;
    registerJob('t-stale', DAILY_07, async () => void calls++);
    const db = dbFor(org);
    const row = await db.insert('job_run', { job: 't-stale', run_date: '2027-05-05', status: 'running' });
    expect(await runJob('t-stale', { date: '2027-05-05', orgId: org.id })).toEqual([{ orgId: org.id, status: 'skipped' }]);
    await db.update('job_run', row.id, { started_at: new Date(Date.now() - 2 * 3_600_000) });
    expect((await runJob('t-stale', { date: '2027-05-05', orgId: org.id }))[0]?.status).toBe('ok');
    expect(calls).toBe(1);
  });

  it('defaults the run date to today in Athens', async () => {
    const org = await createOrg();
    registerJob('t-today', DAILY_07, async ({ runDate }) => ({ runDate }));
    const [res] = await runJob('t-today', { orgId: org.id });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
    expect(res?.detail).toEqual({ runDate: today });
  });
});

describe('catchUpDailyJobs — a missed or failed 07:00 run is made up for (review M8)', () => {
  it('runs the daily jobs for today inside 07:00–12:59 Athens, retries failures, never repeats a success, and does nothing outside the window', async () => {
    const org = await createOrg();
    let calls = 0;
    let fail = true;
    registerJob('t-catch-up', DAILY_07, async ({ orgId }) => {
      if (orgId !== org.id) return null;
      calls++;
      if (fail) throw new Error('smtp down');
      return { sent: 1 };
    });
    registerJob('t-not-daily', '15 3 * * *', async ({ orgId }) => {
      if (orgId === org.id) calls += 100;
    });
    const run = async (iso: string) => (await catchUpDailyJobs(new Date(iso))).flatMap((j) => j.results).filter((r) => r.orgId === org.id);

    // 06:30 and 13:10 Athens (winter: UTC+2) — outside the window
    expect(await catchUpDailyJobs(new Date('2027-01-15T04:30:00Z'))).toEqual([]);
    expect(await catchUpDailyJobs(new Date('2027-01-15T11:10:00Z'))).toEqual([]);
    expect(calls).toBe(0);

    // 08:00 Athens: the 07:00 run never happened → it runs now, and fails
    expect(await run('2027-01-15T06:00:00Z')).toMatchObject([{ status: 'failed' }]);
    // 09:00: retried, succeeds
    fail = false;
    expect(await run('2027-01-15T07:00:00Z')).toMatchObject([{ status: 'ok', detail: { sent: 1 } }]);
    // 10:00 and a restart at 10:05: nothing more to do
    expect(await run('2027-01-15T08:00:00Z')).toMatchObject([{ status: 'skipped' }]);
    expect(await run('2027-01-15T08:05:00Z')).toMatchObject([{ status: 'skipped' }]);
    expect(calls).toBe(2);
    expect(await dbFor(org).findOne('job_run', { job: 't-catch-up', run_date: '2027-01-15' })).toMatchObject({ status: 'ok', attempts: 2 });
    // the next day is a new run
    expect(await run('2027-01-16T06:00:00Z')).toMatchObject([{ status: 'ok' }]);
    expect(calls).toBe(3);
  });
});
