import { createApp } from './app.js';
import { config } from './config.js';
import { reportError } from './core/errorTracking.js';
import { logger } from './core/logger.js';
import { closeDatabase } from './db/admin.js';
import { startJobs, stopJobs } from './jobs/index.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'bid-manager server listening');
});

if (config.isProd && !config.smtp.host) {
  logger.warn('SMTP_HOST is not set: invitations, password resets and notifications will NOT be e-mailed');
}

startJobs().catch((err: unknown) => logger.error({ err }, 'failed to start jobs'));

// Last line of defence: nothing should reach these, but if it does it must be visible in error tracking.
process.on('unhandledRejection', (reason) => reportError(reason, { source: 'process', kind: 'unhandledRejection' }));
process.on('uncaughtException', (err) => {
  reportError(err, { source: 'process', kind: 'uncaughtException' });
  void shutdown('uncaughtException');
});

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
