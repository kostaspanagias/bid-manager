import { afterEach, describe, expect, it } from 'vitest';
import { createOrg, createUser, dbFor } from '../test/harness.js';
import { clearEventHandlers, emit, flushEvents, on, type EventCtx } from './events.js';

afterEach(() => clearEventHandlers());

async function ctx(): Promise<EventCtx> {
  const org = await createOrg();
  const user = await createUser(org, 'bid_manager');
  return { orgId: org.id, user: { id: user.id, org_id: org.id, email: user.email, name: user.name, org_role: 'bid_manager' }, db: dbFor(org, user) };
}

describe('event bus', () => {
  it('delivers typed payloads to every subscriber, after the emitting code has continued', async () => {
    const c = await ctx();
    const seen: string[] = [];
    on('tender.extended', (handlerCtx, p) => {
      seen.push(`a:${p.tenderId}:${p.oldT}->${p.newT}:${handlerCtx.orgId === c.orgId}`);
    });
    on('tender.extended', async (_ctx, p) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(`b:${p.tenderId}`);
    });
    on('tender.created', () => void seen.push('other'));

    emit(c, 'tender.extended', { tenderId: 't1', oldT: '2027-05-07', newT: '2027-05-14' });
    expect(seen).toEqual([]); // nothing ran synchronously (handlers run after the response path)
    await flushEvents();
    expect(seen).toEqual(['a:t1:2027-05-07->2027-05-14:true', 'b:t1']);
  });

  it('a throwing or rejecting handler never reaches the emitter and does not stop the others', async () => {
    const c = await ctx();
    const seen: string[] = [];
    on('gate.decided', () => {
      throw new Error('sync boom');
    });
    on('gate.decided', async () => {
      throw new Error('async boom');
    });
    on('gate.decided', (_ctx, p) => void seen.push(p.decision));
    expect(() => emit(c, 'gate.decided', { tenderId: 't', gateId: 'g', decision: 'approved' })).not.toThrow();
    await expect(flushEvents()).resolves.toBeUndefined();
    expect(seen).toEqual(['approved']);
  });

  it('handlers get a scoped db; unsubscribe works; events emitted by handlers are flushed too', async () => {
    const c = await ctx();
    const seen: string[] = [];
    const off = on('tender.created', async (handlerCtx, p) => {
      const org = await handlerCtx.db.get('organization', handlerCtx.orgId);
      seen.push(`created:${p.tenderId}:${org?.id === c.orgId}`);
      emit(handlerCtx, 'handoff.delivered', { tenderId: p.tenderId, taskId: 'k' });
    });
    on('handoff.delivered', (_ctx, p) => void seen.push(`handoff:${p.taskId}`));
    emit(c, 'tender.created', { tenderId: 't2' });
    await flushEvents();
    expect(seen).toEqual(['created:t2:true', 'handoff:k']);
    off();
    emit(c, 'tender.created', { tenderId: 't3' });
    await flushEvents();
    expect(seen).toHaveLength(2);
  });

  it('emitting without subscribers is a no-op', async () => {
    const c = await ctx();
    emit(c, 'gate.approval_requested', { tenderId: 't', gateId: 'g', approverUserId: 'u' });
    await flushEvents();
  });
});
