import cookieParser from 'cookie-parser';
import express, { Router, type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
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

export interface AppOptions {
  /**
   * Directory of the built SPA to serve. Default: config.webDistDir when it contains an index.html — except under
   * NODE_ENV=test, where nothing is served unless a test passes a directory. `null` = API only.
   */
  webDir?: string | null;
}

export interface ApiRoute {
  method: string;
  /** Full path with express parameters, e.g. /api/tenders/:tenderId/gates/:gateId */
  path: string;
}

/** Every router of the API with its mount path — the single source for mounting AND for listApiRoutes(). */
function apiMounts(auth: Router): { prefix: string; router: Router; guard: 'none' | 'auth' | 'tender' }[] {
  return [
    { prefix: '/auth', router: auth, guard: 'none' },
    ...Object.entries(ORG_LEVEL).map(([name, router]) => ({ prefix: `/${name}`, router, guard: 'auth' as const })),
    ...Object.entries(TENDER_SCOPED).map(([name, router]) => ({ prefix: `/tenders/:tenderId/${name}`, router, guard: 'tender' as const })),
    { prefix: '/tenders', router: tenders, guard: 'auth' },
  ];
}

interface StackLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: StackLayer[] };
}

/** Number of route handlers reachable from a router stack, whatever their mount path (walks nested routers). */
export function countRoutes(stack: StackLayer[]): number {
  let n = 0;
  for (const layer of stack) {
    if (layer.route) n += [layer.route.path].flat().length * Object.keys(layer.route.methods).length;
    else if (layer.handle?.stack) n += countRoutes(layer.handle.stack);
  }
  return n;
}

function routesOf(prefix: string, stack: StackLayer[]): ApiRoute[] {
  const out: ApiRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const p of [layer.route.path].flat()) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: `/api${prefix}${p === '/' ? '' : p}` });
      }
    }
  }
  return out;
}

/**
 * Every route registered on the API, read from the routers themselves (so a new route is listed automatically).
 * The acceptance suite sweeps this list for cross-organization leaks and checks, against the app's real router
 * stack, that no route is mounted outside it.
 */
export function listApiRoutes(): ApiRoute[] {
  return [
    { method: 'GET', path: '/api/health' },
    ...apiMounts(authRouter()).flatMap((m) => routesOf(m.prefix, (m.router as unknown as { stack: StackLayer[] }).stack)),
  ];
}

/** Content-Security-Policy for the API and the built SPA (no inline scripts, no third-party origins). */
function cspDirectives(): Record<string, string[] | null> {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'script-src-attr': ["'none'"],
    // React sets element styles through the DOM (allowed); 'unsafe-inline' covers style attributes in SVG markup.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'], // data: = the TOTP QR code and CSS icons
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    // Only where the app really is behind HTTPS; on plain-http localhost it would break every request.
    'upgrade-insecure-requests': config.isProd ? [] : null,
  };
}

/** Serves the built SPA: hashed assets immutable, index.html never cached, history fallback for client routes. */
function mountWebApp(app: Express, dir: string): void {
  const indexFile = path.join(dir, 'index.html');
  const noCache = (res: express.Response) => res.set('Cache-Control', 'no-cache');
  // /assets/* carry a content hash in their name (Vite): cache for a year. A missing asset is a 404, never the SPA.
  app.use(
    '/assets',
    express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false, dotfiles: 'ignore' }),
  );
  app.use(
    express.static(dir, {
      index: false,
      dotfiles: 'ignore',
      setHeaders: (res, file) => {
        if (file.endsWith('.html')) noCache(res);
        else res.set('Cache-Control', 'public, max-age=3600');
      },
    }),
  );
  // History fallback: any other GET that accepts HTML gets index.html and the client router takes over.
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api')) return next();
    if (path.extname(req.path) !== '' || !req.accepts('html')) return next();
    noCache(res);
    res.sendFile(indexFile);
  });
}

/** Builds the express app (no listen, no jobs) — used by index.ts and by the tests. */
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives() },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'same-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Request id: taken over by the access log and the error tracking hook, and echoed so a user can quote it.
  app.use((req, res, next) => {
    req.id ??= randomUUID();
    res.set('X-Request-Id', String(req.id));
    next();
  });
  if (!config.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => req.id,
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
  const mounts = apiMounts(authRouter());
  for (const m of mounts.filter((x) => x.guard === 'none')) api.use(m.prefix, m.router);

  // ---- everything below needs a full (password + TOTP) session; CSRF is checked on mutating requests ----
  api.use(requireAuth);
  for (const m of mounts.filter((x) => x.guard === 'auth' && x.prefix !== '/tenders')) api.use(m.prefix, m.router);
  for (const m of mounts.filter((x) => x.guard === 'tender')) api.use(m.prefix, tenderGuard, m.router);
  for (const m of mounts.filter((x) => x.guard === 'auth' && x.prefix === '/tenders')) api.use(m.prefix, m.router);
  api.use(apiNotFound);

  app.use('/api', api);

  const webDir = options.webDir !== undefined ? options.webDir : config.isTest ? null : config.webDistDir;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    mountWebApp(app, path.resolve(webDir));
    logger.info({ webDir: path.resolve(webDir) }, 'serving the web app');
  } else if (config.isProd && options.webDir === undefined) {
    logger.warn({ webDir }, 'web app build not found — serving the API only');
  }
  app.use(errorHandler);
  return app;
}
