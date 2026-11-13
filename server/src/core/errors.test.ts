import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOrg, dbFor } from '../test/harness.js';
import { apiNotFound, badRequest, conflict, errorHandler, forbidden, HttpError, notFound, toErrorResponse, unauthorized, unprocessable } from './errors.js';

function appThatThrows(make: () => unknown) {
  const app = express();
  app.use(express.json());
  app.all('/sync', () => {
    throw make();
  });
  app.all('/async', async () => {
    await Promise.resolve();
    throw make();
  });
  app.use(apiNotFound);
  app.use(errorHandler);
  return app;
}

describe('error handling', () => {
  it('HttpError → { error: { code, message, details? } } with its status', async () => {
    const app = appThatThrows(() => new HttpError(422, 'gate_exception_required', 'Χρειάζεται αιτιολόγηση', { min: 20 }));
    for (const path of ['/sync', '/async']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: { code: 'gate_exception_required', message: 'Χρειάζεται αιτιολόγηση', details: { min: 20 } } });
    }
  });

  it('helpers map to the documented statuses', () => {
    expect([badRequest().status, unauthorized().status, forbidden().status, notFound().status, conflict().status, unprocessable('x').status]).toEqual([
      400, 401, 403, 404, 409, 422,
    ]);
    expect(toErrorResponse(notFound()).body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect(toErrorResponse(unprocessable('Η απόκλιση θέλει σημείωση')).body.error).toEqual({ code: 'business_rule', message: 'Η απόκλιση θέλει σημείωση' });
  });

  it('zod errors → 400 validation_error with a path per issue', async () => {
    const schema = z.object({ title: z.string().min(1), budget: z.number().positive(), lots: z.array(z.object({ no: z.number() })) });
    const app = appThatThrows(() => schema.safeParse({ title: '', budget: -1, lots: [{ no: 'x' }] }).error);
    const res = await request(app).post('/async');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(['title', 'budget', 'lots.0.no']);
    expect(res.body.error.details[0].message).toEqual(expect.any(String));
  });

  it('unknown errors → 500 without leaking internals', async () => {
    const app = appThatThrows(() => new Error('connection string postgres://user:secret@host/db'));
    const res = await request(app).get('/async');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(toErrorResponse('a string').status).toBe(500);
    expect(toErrorResponse(null).status).toBe(500);
  });

  it('malformed JSON → 400, oversized body → 413, unknown route → 404', async () => {
    const app = express();
    app.use(express.json({ limit: 50 }));
    app.post('/x', (_req, res) => void res.json({}));
    app.use(apiNotFound);
    app.use(errorHandler);
    expect((await request(app).post('/x').set('Content-Type', 'application/json').send('{"a":')).body.error.code).toBe('invalid_json');
    const big = await request(app).post('/x').send({ a: 'x'.repeat(200) });
    expect([big.status, big.body.error.code]).toEqual([413, 'payload_too_large']);
    const missing = await request(app).get('/nope');
    expect([missing.status, missing.body.error.code]).toEqual([404, 'not_found']);
  });

  it('PostgreSQL constraint violations become 409 / 422 / 400 instead of 500', async () => {
    const org = await createOrg();
    const db = dbFor(org);
    await db.insert('holiday', { date: '2034-01-01', name: 'x' });
    const grab = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => toErrorResponse(e));
    const unique = await grab(db.insert('holiday', { date: '2034-01-01', name: 'y' }));
    expect([unique?.status, unique?.body.error.code]).toEqual([409, 'conflict']);
    expect(unique?.body.error.details).toEqual({ constraint: 'holiday_org_id_date_key' });
    const check = await grab(db.insert('holiday', { date: '2034-01-02', name: 'y', source: 'nope' }));
    expect([check?.status, check?.body.error.code]).toEqual([422, 'business_rule']);
    const notNull = await grab(db.insert('holiday', { date: '2034-01-03' }));
    expect([notNull?.status, notNull?.body.error.code]).toEqual([400, 'validation_error']);
    const badDate = await grab(db.insert('holiday', { date: 'not-a-date', name: 'y' }));
    expect(badDate?.status).toBe(400);
    const fk = await grab(db.insert('task', { tender_id: '00000000-0000-4000-8000-000000000000', title: 't' }));
    expect([fk?.status, fk?.body.error.code]).toEqual([409, 'conflict']);
  });
});
