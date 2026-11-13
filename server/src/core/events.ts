import { reportError } from './errorTracking.js';
import type { Ctx } from './types.js';

/** Every event of the in-process bus and its payload. Add new events here. */
export interface AppEvents {
  'gate.approval_requested': { tenderId: string; gateId: string; approverUserId: string };
  'gate.decided': { tenderId: string; gateId: string; decision: string };
  'tender.extended': { tenderId: string; oldT: string; newT: string };
  'tender.created': { tenderId: string };
  'handoff.delivered': { tenderId: string; taskId: string };
}
export type EventName = keyof AppEvents;
/** What handlers get: who caused the event and a scoped db for that org. */
export type EventCtx = Pick<Ctx, 'orgId' | 'user' | 'db'>;
export type EventHandler<N extends EventName> = (ctx: EventCtx, payload: AppEvents[N]) => void | Promise<void>;

const handlers = new Map<EventName, Set<EventHandler<EventName>>>();
const pending = new Set<Promise<void>>();

/** Subscribe (typically at module load, top level of a module's routes.ts or jobs.ts). Returns an unsubscribe fn. */
export function on<N extends EventName>(name: N, handler: EventHandler<N>): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(handler as unknown as EventHandler<EventName>);
  return () => void set.delete(handler as unknown as EventHandler<EventName>);
}

/**
 * Fire-and-forget: handlers run after the current call stack (so after the response path) and can never throw
 * into the emitter — failures are logged. Emit AFTER your transaction has committed.
 */
export function emit<N extends EventName>(ctx: EventCtx, name: N, payload: AppEvents[N]): void {
  const set = handlers.get(name);
  if (!set || set.size === 0) return;
  for (const handler of [...set]) {
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => handler({ orgId: ctx.orgId, user: ctx.user, db: ctx.db }, payload))
      .catch((err: unknown) => reportError(err, { source: 'event', event: name, orgId: ctx.orgId }))
      .finally(() => pending.delete(run));
    pending.add(run);
  }
}

/** Tests: wait until every handler triggered so far (and whatever they emitted) has finished. */
export async function flushEvents(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/** Tests: drop all subscriptions. */
export function clearEventHandlers(): void {
  handlers.clear();
}
