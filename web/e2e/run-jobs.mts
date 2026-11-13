// Runs every registered daily job once through the real job runner (used by full-flow.mjs, twice, to prove
// idempotency). Run with the server's environment:  npx tsx web/e2e/run-jobs.mts   (cwd: server/)
import { loadModuleJobs, registeredJobs, runJob } from '../../server/src/jobs/index.js';
import { closeDatabase } from '../../server/src/db/admin.js';

await loadModuleJobs();
const out: Record<string, string[]> = {};
for (const { name } of registeredJobs()) out[name] = (await runJob(name)).map((r) => r.status);
console.log(`JOBS ${JSON.stringify(out)}`);
await closeDatabase();
