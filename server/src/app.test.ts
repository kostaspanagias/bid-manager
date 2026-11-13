import request from 'supertest';
import { describe, expect, it } from 'vitest';
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

  it('stub routers answer 404 in the documented error shape once authenticated', async () => {
    const org = await createOrg();
    const api = await as(await createUser(org, 'admin'));
    const tender = await createTender(org);
    for (const path of ['/api/tenders', '/api/templates', '/api/my', '/api/company-documents', '/api/dashboard', '/api/notifications', '/api/gdpr',
      `/api/tenders/${tender.id}/gates`, '/api/nope']) {
      const res = await api.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(res.body).toEqual({ error: { code: 'not_found', message: 'Unknown API endpoint' } });
    }
  });

  it('non-API paths are not served by the API', async () => {
    expect((await request(getApp()).get('/')).status).toBe(404);
  });
});
