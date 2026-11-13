import express, { type Express } from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countRoutes, createApp, listApiRoutes } from './app.js';
import { reportError, setErrorReporter, type ErrorEvent } from './core/errorTracking.js';
import { errorHandler } from './core/errors.js';
import { anon, as, createOrg, createTender, createUser, getApp } from './test/harness.js';

describe('app', () => {
  it('GET /api/health checks the database and needs no session', async () => {
    const res = await request(getApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('sends security headers and never lets API responses be cached', async () => {
    const res = await request(getApp()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('every module is mounted behind the auth middleware', async () => {
    const paths = [
      '/api/tenders', '/api/templates', '/api/my', '/api/company-documents', '/api/dashboard', '/api/notifications', '/api/gdpr',
      '/api/users', '/api/holidays', '/api/audit', '/api/admin/users', '/api/admin/invitations',
      ...['gates', 'requirements', 'tasks', 'watch', 'risks', 'changes', 'files', 'documents', 'lessons', 'milestones'].map(
        (m) => `/api/tenders/00000000-0000-4000-8000-000000000000/${m}`,
      ),
      '/api/anything-else',
    ];
    for (const path of paths) {
      const res = await anon().get(path);
      expect([path, res.status, res.body.error?.code]).toEqual([path, 401, 'unauthorized']);
      const post = await anon().post(path).send({});
      expect([path, post.status]).toEqual([path, 401]);
    }
  });

  it('unknown API paths answer 404 in the documented error shape, for every method, once authenticated', async () => {
    const org = await createOrg();
    const api = await as(await createUser(org, 'admin'));
    const tender = await createTender(org);
    const NOT_FOUND = { error: { code: 'not_found', message: 'Unknown API endpoint' } };
    for (const path of ['/api/nope', '/api/tenders/' + tender.id + '/nope', '/api/admin/nope', '/api/dashboard/nope/deeper', '/api/auth/nope']) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const res = await api[method](path);
        expect([method, path, res.status]).toEqual([method, path, 404]);
        expect(res.body).toEqual(NOT_FOUND);
        expect(res.headers['content-type']).toMatch(/application\/json/);
      }
    }
    // the real modules answer on their own paths (they are no longer stubs)
    for (const path of ['/api/tenders', '/api/templates', '/api/my', '/api/company-documents', '/api/dashboard', `/api/tenders/${tender.id}/gates`]) {
      expect([path, (await api.get(path)).status]).toEqual([path, 200]);
    }
  });

  it('listApiRoutes() lists every route mounted on the app (nothing is mounted outside the table)', () => {
    const routes = listApiRoutes();
    const stack = (getApp() as unknown as { router: { stack: Parameters<typeof countRoutes>[0] } }).router.stack;
    expect(routes.length).toBe(countRoutes(stack));
    expect(routes.length).toBeGreaterThan(120);
    expect(routes).toContainEqual({ method: 'GET', path: '/api/tenders/:tenderId/files/:fileId/download' });
    expect(routes).toContainEqual({ method: 'POST', path: '/api/admin/users/:id/reset-password' });
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
  });

  it('every response carries a request id', async () => {
    const res = await request(getApp()).get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('non-API paths are not served when no web build is mounted', async () => {
    expect((await request(getApp()).get('/')).status).toBe(404);
  });
});

describe('error tracking hook', () => {
  it('an unhandled error reaches the reporter with the request id and no request data; the client gets a bare 500', async () => {
    const events: ErrorEvent[] = [];
    const previous = setErrorReporter((e) => void events.push(e));
    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as { id?: string }).id = 'req-123';
        next();
      });
      app.get('/api/boom', () => {
        throw new Error('database exploded: secret detail');
      });
      app.use(errorHandler);
      const res = await request(app).get('/api/boom?token=abc');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ name: 'Error', message: 'database exploded: secret detail', context: { source: 'http', requestId: 'req-123', method: 'GET', path: '/api/boom' } });
      expect(JSON.stringify(events[0]!.context)).not.toContain('abc');
      // expected (4xx) errors are not reported
      const org = await createOrg();
      await as(await createUser(org, 'admin')).get('/api/nope');
      expect(events).toHaveLength(1);
    } finally {
      setErrorReporter(previous);
    }
  });

  it('a throwing or rejecting reporter never breaks the response', async () => {
    const previous = setErrorReporter(() => Promise.reject(new Error('tracker down')));
    try {
      expect(() => reportError(new Error('x'), { source: 'job', job: 'demo' })).not.toThrow();
      setErrorReporter(() => {
        throw new Error('tracker down');
      });
      expect(() => reportError('plain string', { source: 'process' })).not.toThrow();
    } finally {
      setErrorReporter(previous);
    }
  });
});

describe('serving the built web app (production)', () => {
  let dir: string;
  let app: Express;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bm-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body></html>');
    writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    app = createApp({ webDir: dir });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('index.html is served for / and for client routes (history fallback) and is never cached', async () => {
    for (const url of ['/', '/tenders', '/tenders/123/gates', '/invite/some-token', '/reset/some-token']) {
      const res = await request(app).get(url).set('Accept', 'text/html');
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.text).toContain('<div id="root">');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-type']).toMatch(/text\/html/);
    }
  });

  it('hashed assets are immutable for a year; other static files get a short cache', async () => {
    const asset = await request(app).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await request(app).get('/favicon.svg');
    expect([icon.status, icon.headers['cache-control']]).toEqual([200, 'public, max-age=3600']);
  });

  it('the fallback never answers for /api, for missing assets or files, for dotfiles, or for non-GET', async () => {
    const api = await request(app).get('/api/nope').set('Accept', 'text/html');
    expect([api.status, api.body.error?.code]).toEqual([401, 'unauthorized']);
    expect(api.headers['cache-control']).toBe('no-store');
    const health = await request(app).get('/api/health');
    expect(health.body).toEqual({ status: 'ok', db: 'up' });
    const missingAsset = await request(app).get('/assets/index-old000.js').set('Accept', 'text/html');
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.text).not.toContain('<div id="root">');
    expect((await request(app).get('/missing.png').set('Accept', 'text/html')).status).toBe(404);
    const dot = await request(app).get('/.env');
    expect(dot.text ?? '').not.toContain('SECRET');
    expect((await request(app).post('/tenders').set('Accept', 'text/html')).status).toBe(404);
    expect((await request(app).get('/tenders').set('Accept', 'application/json')).status).toBe(404);
  });

  it('the CSP allows only same-origin scripts and forbids framing', async () => {
    const res = await request(app).get('/').set('Accept', 'text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });
});
