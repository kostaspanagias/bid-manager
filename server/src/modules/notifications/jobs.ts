// Daily digest — 07:00 Europe/Athens, once per organization and date (job_run), idempotent per user (email_log).
import { DAILY_07, registeredJobs, registerJob } from '../../jobs/index.js';
import { DIGEST_JOB, runDigest } from './service.js';

/** Registers the job unless it is there already (routes.ts imports this file too, for the admin "run now"). */
export function ensureDigestJob(): void {
  if (registeredJobs().some((j) => j.name === DIGEST_JOB)) return;
  registerJob(DIGEST_JOB, DAILY_07, ({ db, runDate }) => runDigest(db, runDate));
}

ensureDigestJob();
