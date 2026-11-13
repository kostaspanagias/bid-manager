// Scheduled work of the GDPR module (auto-loaded by jobs/index.ts → startJobs()).
import { DAILY_07, registerJob } from '../../jobs/index.js';
import { purgeExpiredFiles } from './service.js';

export const RETENTION_JOB = 'gdpr-retention';

/**
 * Daily, 07:00 Athens, once per organization per date (job_run): removes the files (blobs + rows) of tenders
 * closed longer ago than organization.retention_days. The result is stored in job_run.detail:
 * `{ retention_days, cutoff, tenders, files, swept_blobs }`. Idempotent — see purgeExpiredFiles().
 */
registerJob(RETENTION_JOB, DAILY_07, ({ db, runDate }) => purgeExpiredFiles(db, runDate));
