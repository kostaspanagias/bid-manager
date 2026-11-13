import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { reportError } from './errorTracking.js';

/** Throw from anywhere in a request: becomes `{ error: { code, message, details? } }` with the given status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message = 'Invalid request', details?: unknown, code = 'validation_error') =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new HttpError(404, code, message);
export const conflict = (message = 'Conflict', details?: unknown, code = 'conflict') => new HttpError(409, code, message, details);
/** 422: a business rule (R-rule) rejected the request. */
export const unprocessable = (message: string, details?: unknown, code = 'business_rule') =>
  new HttpError(422, code, message, details);

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Maps any thrown value to status + documented body. Exported for unit tests. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody; expose: boolean } {
  if (err instanceof HttpError) {
    const error: ErrorBody['error'] = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { status: err.status, body: { error }, expose: true };
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
    return { status: 400, body: { error: { code: 'validation_error', message: 'Invalid request', details } }, expose: true };
  }
  const e = (err ?? {}) as { type?: string; status?: number; statusCode?: number; code?: string; constraint?: string; name?: string };
  // body-parser
  if (e.type === 'entity.parse.failed') {
    return { status: 400, body: { error: { code: 'invalid_json', message: 'Malformed JSON body' } }, expose: true };
  }
  if (e.type === 'entity.too.large') {
    return { status: 413, body: { error: { code: 'payload_too_large', message: 'Request body too large' } }, expose: true };
  }
  // multer
  if (e.name === 'MulterError') {
    const tooLarge = e.code === 'LIMIT_FILE_SIZE';
    return {
      status: tooLarge ? 413 : 400,
      body: { error: { code: tooLarge ? 'payload_too_large' : 'invalid_upload', message: tooLarge ? 'File too large' : 'Invalid upload' } },
      expose: true,
    };
  }
  // PostgreSQL constraint violations that slipped past the service layer
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    const details = e.constraint ? { constraint: e.constraint } : undefined;
    const pg = (status: number, code: string, message: string) => ({
      status,
      body: { error: details ? { code, message, details } : { code, message } },
      expose: true,
    });
    if (e.code === '23505') return pg(409, 'conflict', 'A record with the same key already exists');
    if (e.code === '23503') return pg(409, 'conflict', 'The record is referenced by, or references, another record');
    if (e.code === '23514') return pg(422, 'business_rule', 'The change violates a data rule');
    if (e.code === '23502') return pg(400, 'validation_error', 'A required field is missing');
    if (e.code === '22P02' || e.code === '22007' || e.code === '22008' || e.code === '22003') {
      return pg(400, 'validation_error', 'A value has an invalid format');
    }
  }
  // http-errors thrown by express itself (static files, malformed URLs, range errors): keep their 4xx status
  const httpStatus = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    const notFoundStatus = httpStatus === 404;
    return {
      status: httpStatus,
      body: { error: { code: notFoundStatus ? 'not_found' : 'bad_request', message: notFoundStatus ? 'Not found' : 'Bad request' } },
      expose: true,
    };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } }, expose: false };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const { status, body, expose } = toErrorResponse(err);
  if (!expose) {
    reportError(err, {
      source: 'http',
      requestId: String(req.id ?? ''),
      method: req.method,
      path: String(req.originalUrl ?? req.url).split('?')[0],
      orgId: req.ctx?.orgId,
      userId: req.ctx?.user.id,
    });
  }
  res.status(status).json(body);
};

export const apiNotFound: RequestHandler = (_req, _res, next) => next(notFound('Unknown API endpoint'));
