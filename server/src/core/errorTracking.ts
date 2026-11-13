import { config } from '../config.js';
import { logger } from './logger.js';

// Error tracking hook (spec: «Error tracking και health check endpoint»). Provider-agnostic and dependency-free:
// every unhandled error — a request that ends in a 500, a failed job, an unhandled rejection — goes through
// reportError(). It is always logged (structured, with the request id) and, when ERROR_TRACKING_DSN is set,
// forwarded as a JSON POST to that URL (a webhook, a log collector, or a small adapter in front of Sentry & co.).
// To plug a vendor SDK in later, call setErrorReporter() once at start-up; nothing else changes.
//
// The event never contains request bodies, cookies, headers or query strings (bid data is confidential).

export interface ErrorContext {
  /** Where it happened: 'http' | 'job' | 'event' | 'process' */
  source: string;
  requestId?: string;
  method?: string;
  /** Route path without the query string */
  path?: string;
  orgId?: string;
  userId?: string;
  job?: string;
  [extra: string]: unknown;
}

export interface ErrorEvent {
  at: string;
  env: string;
  release: string | null;
  name: string;
  message: string;
  stack: string | null;
  context: ErrorContext;
}

export type ErrorReporter = (event: ErrorEvent) => void | Promise<void>;

export function toErrorEvent(err: unknown, context: ErrorContext): ErrorEvent {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  return {
    at: new Date().toISOString(),
    env: config.env,
    release: config.release,
    name: e.name,
    message: e.message,
    stack: e.stack ?? null,
    context,
  };
}

/** Default forwarder: POST the event as JSON to ERROR_TRACKING_DSN. Failures are logged, never thrown. */
async function forwardToDsn(event: ErrorEvent): Promise<void> {
  if (!config.errorTrackingDsn) return;
  const res = await fetch(config.errorTrackingDsn, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`error-tracking endpoint answered ${res.status}`);
}

let reporter: ErrorReporter = forwardToDsn;

/** Replace the forwarder (e.g. with a vendor SDK's captureException). Returns the previous one. */
export function setErrorReporter(next: ErrorReporter | null): ErrorReporter {
  const previous = reporter;
  reporter = next ?? forwardToDsn;
  return previous;
}

/** Log an unhandled error and hand it to the reporter. Never throws and never delays the caller. */
export function reportError(err: unknown, context: ErrorContext): void {
  const event = toErrorEvent(err, context);
  logger.error({ err, ...context }, 'unhandled error');
  try {
    void Promise.resolve(reporter(event)).catch((failure: unknown) => {
      logger.warn({ err: failure }, 'error tracking: forwarding failed');
    });
  } catch (failure) {
    logger.warn({ err: failure }, 'error tracking: forwarding failed');
  }
}
