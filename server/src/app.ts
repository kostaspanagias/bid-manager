import cookieParser from 'cookie-parser';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { requireAuth } from './core/auth.js';
import { authRouter } from './core/authRoutes.js';
import { apiNotFound, errorHandler } from './core/errors.js';
import { logger } from './core/logger.js';
import { tenderGuard } from './core/permissions.js';
import './core/types.js';
import { pingDatabase } from './db/admin.js';
import { router as adminInvitations } from './modules/admin/invitations.js';
import { router as adminUsers } from './modules/admin/users.js';
import { router as audit } from './modules/audit/routes.js';
import { router as changes } from './modules/changes/routes.js';
import { router as companyDocuments } from './modules/company-documents/routes.js';
import { router as dashboard } from './modules/dashboard/routes.js';
import { router as documents } from './modules/documents/routes.js';
import { router as files } from './modules/files/routes.js';
import { router as gates } from './modules/gates/routes.js';
import { router as gdpr } from './modules/gdpr/routes.js';
import { router as holidays } from './modules/holidays/routes.js';
import { router as lessons } from './modules/lessons/routes.js';
import { router as milestones } from './modules/milestones/routes.js';
import { router as my } from './modules/my/routes.js';
import { router as notifications } from './modules/notifications/routes.js';
import { router as requirements } from './modules/requirements/routes.js';
import { router as risks } from './modules/risks/routes.js';
import { router as tasks } from './modules/tasks/routes.js';
import { router as templates } from './modules/templates/routes.js';
import { router as tenders } from './modules/tenders/routes.js';
import { router as users } from './modules/users/routes.js';
import { router as watch } from './modules/watch/routes.js';

/** Routers mounted at /api/tenders/:tenderId/<name>, behind tenderGuard (access check + req.tender). */
const TENDER_SCOPED: Record<string, Router> = {
  gates,
  requirements,
  tasks,
  watch,
  risks,
  changes,
  files,
  documents,
  lessons,
  milestones,
};

/** Routers mounted at /api/<name>, behind requireAuth. */
const ORG_LEVEL: Record<string, Router> = {
  'admin/users': adminUsers,
  'admin/invitations': adminInvitations,
  holidays,
  users,
  audit,
  templates,
  my,
  'company-documents': companyDocuments,
  dashboard,
  notifications,
  gdpr,
};

/** Builds the express app (no listen, no jobs) — used by index.ts and by the tests. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  if (!config.isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/health' },
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  const api = Router();
  // API responses can carry confidential bid data: never cache them.
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', async (_req, res) => {
    const db = await pingDatabase();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db: db ? 'up' : 'down' });
  });

  api.use(express.json({ limit: '2mb' }));
  api.use(cookieParser());
  api.use('/auth', authRouter());

  // ---- everything below needs a full (password + TOTP) session; CSRF is checked on mutating requests ----
  api.use(requireAuth);
  for (const [name, router] of Object.entries(ORG_LEVEL)) api.use(`/${name}`, router);
  for (const [name, router] of Object.entries(TENDER_SCOPED)) api.use(`/tenders/:tenderId/${name}`, tenderGuard, router);
  api.use('/tenders', tenders);
  api.use(apiNotFound);

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
