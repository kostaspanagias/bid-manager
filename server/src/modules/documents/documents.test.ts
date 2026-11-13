import { describe, expect, it } from 'vitest';
import { shiftDays } from '../../domain/calendar.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';

// T = Friday 07/05/2027 (Athens). 21:30 UTC on 6 May is already 00:30 on 7 May in Athens — R3.
const DEADLINE = '2027-05-06T21:30:00Z';
const T = '2027-05-07';

async function setup() {
  const org = await createOrg();
  const admin = await createUser(org, 'admin');
  const bidManager = await createUser(org, 'bid_manager');
  const member = await createUser(org, 'member');
  const viewer = await createUser(org, 'viewer');
  const outsider = await createUser(org, 'member');
  const tender = await createTender(org, { submission_deadline_at: DEADLINE });
  await addMember(tender, member, 'A');
  await addMember(tender, viewer);
  const api = await as(admin);
  const mk = async (body: Record<string, unknown>) => (await api.post('/api/company-documents').send(body)).body as { id: string };
  return { org, admin, bidManager, member, viewer, outsider, tender, mk, base: `/api/tenders/${tender.id}/documents` };
}

describe('/api/tenders/:id/documents — links and R15', () => {
  it('R15: a linked document with expires_at < T is flagged; expiring on T itself, later or never is not', async () => {
    const s = await setup();
    const before = await s.mk({ type: 'tax', title: 'Φορολογική', expires_at: shiftDays(T, -1) });
    const onT = await s.mk({ type: 'insurance', title: 'Ασφαλιστική', expires_at: T });
    const after = await s.mk({ type: 'gemi', title: 'ΓΕΜΗ', expires_at: shiftDays(T, 1) });
    const never = await s.mk({ type: 'iso', title: 'ISO 9001' });
    const api = await as(s.member);
    for (const d of [before, onT, after, never]) {
      const res = await api.post(s.base).send({ company_document_id: d.id });
      expect(res.status).toBe(201);
      expect(res.body.expires_before_T).toBe(d.id === before.id);
    }
    const list = await api.get(s.base);
    expect(list.status).toBe(200);
    expect(list.body.T).toBe(T);
    expect(list.body.expired_count).toBe(1);
    const flags = Object.fromEntries(list.body.items.map((d: { id: string; expires_before_T: boolean }) => [d.id, d.expires_before_T]));
    expect(flags).toEqual({ [before.id]: true, [onT.id]: false, [after.id]: false, [never.id]: false });
    expect(list.body.items[0]).toMatchObject({ link_id: expect.any(String), linked_by: s.member.id, status: expect.any(String) });

    // an extension that moves T past another expiry turns that one red too (the flag is computed, not stored)
    await dbFor(s.org).update('tender', s.tender.id, { submission_deadline_at: '2027-05-10T10:00:00Z' });
    const later = await api.get(s.base);
    expect(later.body.T).toBe('2027-05-10');
    expect(later.body.items.filter((d: { expires_before_T: boolean }) => d.expires_before_T).map((d: { id: string }) => d.id).sort()).toEqual([before.id, onT.id, after.id].sort());
  });

  it('link / unlink: duplicates, unknown and archived documents; suggestions list what is not linked yet, by type', async () => {
    const s = await setup();
    const iso1 = await s.mk({ type: 'iso', title: 'ISO 9001' });
    const iso2 = await s.mk({ type: 'iso', title: 'ISO 27001', expires_at: shiftDays(T, -10) });
    const tax = await s.mk({ type: 'tax', title: 'Φορολογική' });
    const archived = await s.mk({ type: 'gemi', title: 'ΓΕΜΗ (παλιό)' });
    await (await as(s.admin)).post(`/api/company-documents/${archived.id}/archive`);
    const api = await as(s.member);

    const all = await api.get(`${s.base}/suggestions`);
    expect(all.body.T).toBe(T);
    expect(all.body.items.map((g: { type: string; documents: { title: string }[] }) => [g.type, g.documents.map((d) => d.title)])).toEqual([
      ['iso', ['ISO 27001', 'ISO 9001']],
      ['tax', ['Φορολογική']],
    ]);
    expect(all.body.items[0].documents[0].expires_before_T).toBe(true);

    expect((await api.post(s.base).send({ company_document_id: iso1.id })).status).toBe(201);
    const dup = await api.post(s.base).send({ company_document_id: iso1.id });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'document_already_linked']);
    expect((await api.post(s.base).send({ company_document_id: missingId() })).status).toBe(404);
    expect((await api.post(s.base).send({ company_document_id: 'x' })).status).toBe(400);
    expect((await api.post(s.base).send({})).status).toBe(400);
    const arch = await api.post(s.base).send({ company_document_id: archived.id });
    expect([arch.status, arch.body.error.code]).toEqual([422, 'document_archived']);

    const rest = await api.get(`${s.base}/suggestions`);
    expect(rest.body.items.map((g: { type: string; documents: unknown[] }) => [g.type, g.documents.length])).toEqual([
      ['iso', 1],
      ['tax', 1],
    ]);

    expect((await api.delete(`${s.base}/${iso1.id}`)).status).toBe(204);
    const again = await api.delete(`${s.base}/${iso1.id}`);
    expect([again.status, again.body.error.code]).toEqual([404, 'document_not_linked']);
    expect((await api.get(s.base)).body.items).toEqual([]);
    // the document itself is untouched
    expect(await dbFor(s.org).get('company_document', iso1.id)).not.toBeNull();
    void tax;
    void iso2;
  });

  it('CVs: only a manager links one; unlinked CVs are not suggested to members', async () => {
    const s = await setup();
    const cv = await s.mk({ type: 'cv', title: 'CV Άννα Δήμου', person_name: 'Άννα Δήμου' });
    await s.mk({ type: 'iso', title: 'ISO 9001' });
    const member = await as(s.member);
    const suggested = await member.get(`${s.base}/suggestions`);
    expect(suggested.body.items.map((g: { type: string }) => g.type)).toEqual(['iso']);
    expect(JSON.stringify(suggested.body)).not.toContain('Δήμου');
    // not visible → "does not exist"
    expect((await member.post(s.base).send({ company_document_id: cv.id })).status).toBe(404);

    const bm = await as(s.bidManager);
    expect((await bm.get(`${s.base}/suggestions`)).body.items.map((g: { type: string }) => g.type)).toEqual(['iso', 'cv']);
    expect((await bm.post(s.base).send({ company_document_id: cv.id })).status).toBe(201);
    expect((await member.get(s.base)).body.items.map((d: { person_name: string | null }) => d.person_name)).toEqual(['Άννα Δήμου']);

    // a member who sees the CV through this tender still cannot hand it to another team
    const other = await createTender(s.org);
    await addMember(other, s.member);
    const relink = await member.post(`/api/tenders/${other.id}/documents`).send({ company_document_id: cv.id });
    expect([relink.status, relink.body.error.code]).toEqual([403, 'cv_link_restricted']);
  });

  it('viewer read-only; non-member 403; closed tender read-only', async () => {
    const s = await setup();
    const doc = await s.mk({ type: 'iso', title: 'ISO 9001' });
    await (await as(s.member)).post(s.base).send({ company_document_id: doc.id });

    const viewer = await as(s.viewer);
    expect((await viewer.get(s.base)).body.items).toHaveLength(1);
    expect((await viewer.get(`${s.base}/suggestions`)).status).toBe(200);
    expect((await viewer.post(s.base).send({ company_document_id: doc.id })).status).toBe(403);
    expect((await viewer.delete(`${s.base}/${doc.id}`)).status).toBe(403);

    const outsider = await as(s.outsider);
    for (const res of [await outsider.get(s.base), await outsider.get(`${s.base}/suggestions`), await outsider.post(s.base).send({ company_document_id: doc.id }), await outsider.delete(`${s.base}/${doc.id}`)]) {
      expect(res.status).toBe(403);
    }

    await dbFor(s.org).update('tender', s.tender.id, { status: 'submitted', closed_at: new Date() });
    const bm = await as(s.bidManager);
    expect((await bm.get(s.base)).body.items).toHaveLength(1);
    const closed = await bm.delete(`${s.base}/${doc.id}`);
    expect([closed.status, closed.body.error.code]).toEqual([422, 'tender_closed']);
    expect((await bm.post(s.base).send({ company_document_id: doc.id })).status).toBe(422);
    expect(await dbFor(s.org).count('tender_document', { tender_id: s.tender.id })).toBe(1);
  });

  it('cross-org: a second organization never sees or touches links, and cannot link foreign documents', async () => {
    const s = await setup();
    const doc = await s.mk({ type: 'iso', title: 'ISO 9001' });
    await (await as(s.member)).post(s.base).send({ company_document_id: doc.id });

    const org2 = await createOrg();
    const foreign = await as(await createUser(org2, 'admin'));
    const foreignTender = await createTender(org2);
    for (const res of [await foreign.get(s.base), await foreign.get(`${s.base}/suggestions`), await foreign.post(s.base).send({ company_document_id: doc.id }), await foreign.delete(`${s.base}/${doc.id}`)]) {
      expect(res.status).toBe(404);
    }
    const own = `/api/tenders/${foreignTender.id}/documents`;
    expect((await foreign.get(own)).body.items).toEqual([]);
    expect((await foreign.get(`${own}/suggestions`)).body.items).toEqual([]);
    expect((await foreign.post(own).send({ company_document_id: doc.id })).status).toBe(404);
    expect((await foreign.delete(`${own}/${doc.id}`)).status).toBe(404);
    expect(await dbFor(s.org).count('tender_document', {})).toBe(1);
    expect(await dbFor(org2).count('tender_document', {})).toBe(0);
  });
});
