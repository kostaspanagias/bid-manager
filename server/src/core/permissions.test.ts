import { describe, expect, it } from 'vitest';
import { listApiRoutes } from '../app.js';
import { addMember, addRole, as, createOrg, createTender, createUser, dbFor, missingId, type Agent, type TestUser } from '../test/harness.js';
import { accessibleTenderIds, assertRole, canSeeFinancial, requireFinancialAccess, requireTenderAccess } from './permissions.js';
import type { OrgRole } from './types.js';

const ctxOf = (user: TestUser) => ({
  user: { id: user.id, org_id: user.org_id, email: user.email, name: user.name, org_role: user.org_role },
  db: dbFor({ id: user.org_id }, user),
});

async function scenario() {
  const org = await createOrg();
  const tender = await createTender(org);
  const otherTender = await createTender(org);
  await addRole(tender, 'A', { folder: 'participation' });
  await addRole(tender, 'B', { folder: 'technical' });
  await addRole(tender, 'C', { folder: 'financial', financial: true });
  const mk = (role: OrgRole) => createUser(org, role);
  const u = {
    admin: await mk('admin'),
    bidManager: await mk('bid_manager'),
    financialMember: await mk('member'),
    technicalMember: await mk('member'),
    plainMember: await mk('member'),
    outsiderMember: await mk('member'),
    approverMember: await mk('approver'),
    approverOutsider: await mk('approver'),
    viewerMember: await mk('viewer'),
    viewerWithFinancialRole: await mk('viewer'),
    viewerOutsider: await mk('viewer'),
  };
  await addMember(tender, u.financialMember, 'C');
  await addMember(tender, u.technicalMember, 'B');
  await addMember(tender, u.plainMember, null);
  await addMember(tender, u.approverMember, null);
  await addMember(tender, u.viewerMember, null);
  await addMember(tender, u.viewerWithFinancialRole, 'C');
  // membership of ANOTHER tender must not count
  await addMember(otherTender, u.outsiderMember, 'C');
  await addRole(otherTender, 'C', { financial: true });
  return { org, tender, otherTender, u };
}

describe('requireRole / assertRole', () => {
  it('allows only the listed organization roles', async () => {
    const org = await createOrg();
    const member = await createUser(org, 'member');
    const admin = await createUser(org, 'admin');
    expect(() => assertRole(ctxOf(admin), 'admin', 'bid_manager')).not.toThrow();
    expect(() => assertRole(ctxOf(member), 'admin', 'bid_manager')).toThrow(expect.objectContaining({ status: 403 }));
    // as middleware, on a real route
    expect((await as(member).get('/api/admin/users')).status).toBe(403);
    expect((await as(admin).get('/api/admin/users')).status).toBe(200);
  });
});

describe('requireTenderAccess', () => {
  it('admin and bid_manager reach every tender of the org, read and write', async () => {
    const { tender, otherTender, u } = await scenario();
    for (const user of [u.admin, u.bidManager]) {
      for (const t of [tender, otherTender]) {
        expect((await requireTenderAccess(ctxOf(user), t.id, 'read')).id).toBe(t.id);
        expect((await requireTenderAccess(ctxOf(user), t.id, 'write')).id).toBe(t.id);
      }
    }
  });

  it('member and approver only where they have a tender_member row', async () => {
    const { tender, otherTender, u } = await scenario();
    for (const user of [u.financialMember, u.technicalMember, u.plainMember, u.approverMember]) {
      expect((await requireTenderAccess(ctxOf(user), tender.id, 'write')).id).toBe(tender.id);
      await expect(requireTenderAccess(ctxOf(user), otherTender.id, 'read')).rejects.toMatchObject({ status: 403 });
    }
    for (const user of [u.approverOutsider, u.outsiderMember]) {
      await expect(requireTenderAccess(ctxOf(user), tender.id, 'read')).rejects.toMatchObject({ status: 403 });
      await expect(requireTenderAccess(ctxOf(user), tender.id, 'write')).rejects.toMatchObject({ status: 403 });
    }
  });

  it('viewer is read-only everywhere, and only on tenders where they are a member', async () => {
    const { tender, u } = await scenario();
    expect((await requireTenderAccess(ctxOf(u.viewerMember), tender.id)).id).toBe(tender.id); // default mode = read
    await expect(requireTenderAccess(ctxOf(u.viewerMember), tender.id, 'write')).rejects.toMatchObject({ status: 403 });
    await expect(requireTenderAccess(ctxOf(u.viewerOutsider), tender.id, 'read')).rejects.toMatchObject({ status: 403 });
  });

  it('missing, malformed or other-org tender → 404, even for an admin', async () => {
    const { tender, u } = await scenario();
    const otherOrg = await createOrg();
    const foreignAdmin = await createUser(otherOrg, 'admin');
    await expect(requireTenderAccess(ctxOf(foreignAdmin), tender.id, 'read')).rejects.toMatchObject({ status: 404 });
    await expect(requireTenderAccess(ctxOf(u.admin), missingId(), 'read')).rejects.toMatchObject({ status: 404 });
    await expect(requireTenderAccess(ctxOf(u.admin), 'not-a-uuid', 'read')).rejects.toMatchObject({ status: 404 });
  });

  it('accessibleTenderIds: null (= all) for admin/bid_manager, memberships for the rest', async () => {
    const { tender, otherTender, u } = await scenario();
    expect(await accessibleTenderIds(ctxOf(u.admin))).toBeNull();
    expect(await accessibleTenderIds(ctxOf(u.bidManager))).toBeNull();
    expect(await accessibleTenderIds(ctxOf(u.plainMember))).toEqual([tender.id]);
    expect(await accessibleTenderIds(ctxOf(u.outsiderMember))).toEqual([otherTender.id]);
    expect(await accessibleTenderIds(ctxOf(u.viewerOutsider))).toEqual([]);
  });
});

describe('canSeeFinancial (R18)', () => {
  it('admin, bid_manager, member approvers and the financial-role holder — nobody else, a viewer never', async () => {
    const { tender, u } = await scenario();
    const expected: Record<keyof typeof u, boolean> = {
      admin: true,
      bidManager: true,
      financialMember: true,
      approverMember: true,
      technicalMember: false,
      plainMember: false,
      outsiderMember: false, // holds a financial role, but on another tender
      approverOutsider: false, // approver, but not a member of this tender
      viewerMember: false,
      viewerWithFinancialRole: false, // even with the financial tender role
      viewerOutsider: false,
    };
    for (const [name, allowed] of Object.entries(expected)) {
      const ctx = ctxOf(u[name as keyof typeof u]);
      expect(await canSeeFinancial(ctx, tender.id), name).toBe(allowed);
      if (allowed) await expect(requireFinancialAccess(ctx, tender.id)).resolves.toBeUndefined();
      else await expect(requireFinancialAccess(ctx, tender.id), name).rejects.toMatchObject({ status: 403, code: 'financial_restricted' });
    }
  });

  it('only payload.financial === true counts; a second role is enough', async () => {
    const org = await createOrg();
    const tender = await createTender(org);
    await addRole(tender, 'B', { folder: 'technical', financial: 'yes' });
    await addRole(tender, 'C', { folder: 'financial', financial: true });
    const user = await createUser(org, 'member');
    await addMember(tender, user, 'B');
    expect(await canSeeFinancial(ctxOf(user), tender.id)).toBe(false);
    await addMember(tender, user, 'C');
    expect(await canSeeFinancial(ctxOf(user), tender.id)).toBe(true);
    // a role key without a tender_role row grants nothing
    const ghost = await createUser(org, 'member');
    await addMember(tender, ghost, 'Z');
    expect(await canSeeFinancial(ctxOf(ghost), tender.id)).toBe(false);
  });

  it('never true across organizations or for unknown tenders', async () => {
    const { tender, u } = await scenario();
    const otherOrg = await createOrg();
    for (const role of ['admin', 'bid_manager', 'approver'] as const) {
      expect(await canSeeFinancial(ctxOf(await createUser(otherOrg, role)), tender.id)).toBe(false);
    }
    expect(await canSeeFinancial(ctxOf(u.admin), missingId())).toBe(false);
    expect(await canSeeFinancial(ctxOf(u.admin), 'not-a-uuid')).toBe(false);
  });
});

describe('tender guard on /api/tenders/:tenderId/<module>', () => {
  // Every route under /api/tenders/:tenderId/… (and /api/tenders/:id/…), read from the routers themselves, so a
  // route added later is covered without touching this test.
  const modules = ['gates', 'requirements', 'tasks', 'watch', 'risks', 'changes', 'files', 'documents', 'lessons', 'milestones'];
  const tenderRoutes = listApiRoutes().filter((r) => /^\/api\/tenders\/:(tenderId|id)(\/|$)/.test(r.path));
  const urlFor = (route: { path: string }, tenderId: string) =>
    route.path.replace(/:(tenderId|id)(?=\/|$)/, tenderId).replace(/:\w+/g, () => missingId());
  const call = (api: Agent, route: { method: string; path: string }, tenderId: string) => {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const req = api[method](urlFor(route, tenderId));
    return method === 'get' ? req : req.send({});
  };

  it('covers every tender-scoped module', () => {
    for (const m of modules) {
      expect(tenderRoutes.some((r) => r.path.startsWith(`/api/tenders/:tenderId/${m}`)), m).toBe(true);
    }
    expect(tenderRoutes.length).toBeGreaterThanOrEqual(60);
  });

  it('a user of the org who is not a member of the tender gets 403 on every route, read or write', async () => {
    const { tender, u } = await scenario();
    for (const user of [u.outsiderMember, u.approverOutsider, u.viewerOutsider]) {
      const api = await as(user);
      for (const route of tenderRoutes) {
        const res = await call(api, route, tender.id);
        expect([route.method, route.path, res.status], JSON.stringify(res.body)).toEqual([route.method, route.path, 403]);
        expect(res.body.error.code).toBe('forbidden');
      }
    }
  });

  it('another organization, an unknown tender and a malformed id get 404 on every route — nothing reveals the tender exists', async () => {
    const { tender, u } = await scenario();
    const foreignOrg = await createOrg();
    const foreignAdmin = await as(await createUser(foreignOrg, 'admin'));
    const foreignMember = await as(await createUser(foreignOrg, 'member'));
    const admin = await as(u.admin);
    for (const route of tenderRoutes) {
      // a foreign admin passes every role check, so only the org scope stands between them and the tender
      const foreign = await call(foreignAdmin, route, tender.id);
      expect([route.method, route.path, foreign.status], JSON.stringify(foreign.body)).toEqual([route.method, route.path, 404]);
      // a foreign member is refused either as "not found" or by a role check — never served
      const foreignLow = await call(foreignMember, route, tender.id);
      expect([403, 404], `${route.method} ${route.path}`).toContain(foreignLow.status);
      const unknown = await call(admin, route, missingId());
      expect([route.method, route.path, unknown.status], JSON.stringify(unknown.body)).toEqual([route.method, route.path, 404]);
      const malformed = await call(admin, route, 'not-a-uuid');
      expect([route.method, route.path, malformed.status], JSON.stringify(malformed.body)).toEqual([route.method, route.path, 404]);
    }
  });

  it('a viewer who is a member can read every list, and every mutating route refuses them', async () => {
    const { tender, u } = await scenario();
    const viewer = await as(u.viewerMember);
    for (const m of modules) {
      const res = await viewer.get(`/api/tenders/${tender.id}/${m}`);
      expect([m, res.status], JSON.stringify(res.body)).toEqual([m, 200]);
    }
    expect((await viewer.get(`/api/tenders/${tender.id}`)).status).toBe(200);
    const mutating = tenderRoutes.filter((r) => r.method !== 'GET');
    expect(mutating.length).toBeGreaterThanOrEqual(40);
    const before = await dbFor({ id: tender.org_id }).count('audit_log', { tender_id: tender.id });
    for (const route of mutating) {
      const res = await call(viewer, route, tender.id);
      expect([route.method, route.path, res.status, res.body.error?.code], JSON.stringify(res.body)).toEqual([route.method, route.path, 403, 'forbidden']);
    }
    // nothing was written on the way to those refusals
    expect(await dbFor({ id: tender.org_id }).count('audit_log', { tender_id: tender.id })).toBe(before);
  });

  it('a member passes the guard: requests reach the module (never the guard\'s 403/404)', async () => {
    const { tender, u } = await scenario();
    const member = await as(u.plainMember);
    for (const m of modules) {
      const res = await member.get(`/api/tenders/${tender.id}/${m}`);
      expect([m, res.status], JSON.stringify(res.body)).toEqual([m, 200]);
    }
    // a write with an empty body reaches the module's own validation
    const post = await member.post(`/api/tenders/${tender.id}/risks`).send({});
    expect([post.status, post.body.error.code]).toEqual([400, 'validation_error']);
  });
});
