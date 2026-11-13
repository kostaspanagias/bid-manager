import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './core/logger.js';
import { closeDatabase } from './db/admin.js';
import { startJobs, stopJobs } from './jobs/index.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'bid-manager server listening');
});

startJobs().catch((err: unknown) => logger.error({ err }, 'failed to start jobs'));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  await stopJobs().catch(() => undefined);
  server.close(() => {
    closeDatabase()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
