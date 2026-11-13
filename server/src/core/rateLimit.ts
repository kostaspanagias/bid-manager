import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { config } from '../config.js';

/**
 * Per-IP limiter for the credential endpoints. Disabled under NODE_ENV=test (suites log in hundreds of times).
 * Account-level protection (lockout after repeated failures, TOTP attempt cap per session) lives in authRoutes.ts.
 */
export function authLimiter(limit: number, windowMinutes = 15, enabled = !config.isTest): RateLimitRequestHandler {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' } });
    },
  });
}
