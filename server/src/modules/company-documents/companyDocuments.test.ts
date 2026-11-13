import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, setStorage } from '../../core/storage.js';
import { shiftDays } from '../../domain/calendar.js';
import { todayAthens } from '../../domain/time.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId, type Agent } from '../../test/harness.js';
import { documentStatus } from './service.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bm-docs-test-'));
  setStorage(new LocalDiskStorage(root));
});
afterAll(async () => {
  setStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

async function orgBlobs(org: { id: string }): Promise<string[]> {
  const dir = path.join(root, org.id, 'org');
  return existsSync(dir) ? readdir(dir) : [];
}

function download(api: Agent, url: string) {
  return api
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

const today = todayAthens();

describe('documentStatus (R15)', () => {
  it('valid / expiring within 30 days (inclusive, today included) / expired', () => {
    const t = '2027-05-07';
    expect(documentStatus(null, t)).toEqual({ status: 'valid', days_to_expiry: null });
    expect(documentStatus('2027-06-07', t)).toEqual({ status: 'valid', days_to_expiry: 31 });
    expect(documentStatus('2027-06-06', t)).toEqual({ status: 'expiring', days_to_expiry: 30 });
    expect(documentStatus('2027-05-08', t)).toEqual({ status: 'expiring', days_to_expiry: 1 });
    expect(documentStatus('2027-05-07', t)).toEqual({ status: 'expiring', days_to_expiry: 0 });
    expect(documentStatus('2027-05-06', t)).toEqual({ status: 'expired', days_to_expiry: -1 });
  });
});

describe('/api/company-documents — register', () => {
  it('admin and bid manager add and update; members and viewers only read; archive and delete are admin only', async () => {
    const org = await createOrg();
    const admin = await as(await createUser(org, 'admin'));
    const bm = await as(await createUser(org, 'bid_manager'));

    const created = await bm.post('/api/company-documents').send({ type: 'iso', title: 'ISO 9001:2015', issued_at: '2025-01-10', expires_at: shiftDays(today, 400), notes: ' TÜV ' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ type: 'iso', title: 'ISO 9001:2015', issued_at: '2025-01-10', notes: 'TÜV', person_name: null, status: 'valid', days_to_expiry: 400, file: null, archived_at: null });
    const id = created.body.id as string;

    for (const body of [
      { type: 'iso' },
      { type: 'passport', title: 'x' },
      { type: 'iso', title: 'x', expires_at: '31/12/2027' },
      { type: 'iso', title: 'x', file_id: missingId() },
      { type: 'iso', title: 'x', org_id: missingId() },
    ]) {
      expect((await admin.post('/api/company-documents').send(body)).status, JSON.stringify(body)).toBe(400);
    }
    const backwards = await admin.post('/api/company-documents').send({ type: 'tax', title: 'x', issued_at: '2027-02-01', expires_at: '2027-01-01' });
    expect([backwards.status, backwards.body.error.code]).toEqual([422, 'expiry_before_issue']);
    const noPerson = await admin.post('/api/company-documents').send({ type: 'cv', title: 'CV' });
    expect([noPerson.status, noPerson.body.error.code]).toEqual([422, 'person_name_required']);
    // a person's name is only kept on CVs
    const stray = await admin.post('/api/company-documents').send({ type: 'reference_project', title: 'Έργο Χ', person_name: 'Κάποιος' });
    expect(stray.body.person_name).toBeNull();

    const patched = await bm.patch(`/api/company-documents/${id}`).send({ expires_at: shiftDays(today, 10) });
    expect(patched.body).toMatchObject({ status: 'expiring', days_to_expiry: 10, title: 'ISO 9001:2015' });
    expect((await bm.patch(`/api/company-documents/${id}`).send({ issued_at: shiftDays(today, 20) })).status).toBe(422);

    for (const role of ['member', 'approver', 'viewer'] as const) {
      const api = await as(await createUser(org, role));
      expect((await api.get('/api/company-documents')).body.items.map((d: { id: string }) => d.id)).toContain(id);
      expect((await api.get(`/api/company-documents/${id}`)).status).toBe(200);
      expect((await api.post('/api/company-documents').send({ type: 'iso', title: 'x' })).status).toBe(403);
      expect((await api.patch(`/api/company-documents/${id}`).send({ title: 'x' })).status).toBe(403);
      expect((await api.put(`/api/company-documents/${id}/file`).attach('file', Buffer.from('x'), 'x.pdf')).status).toBe(403);
      expect((await api.delete(`/api/company-documents/${id}/file`)).status).toBe(403);
      expect((await api.post(`/api/company-documents/${id}/archive`)).status).toBe(403);
      expect((await api.delete(`/api/company-documents/${id}`)).status).toBe(403);
      expect((await api.get('/api/company-documents/expiring')).status).toBe(403);
    }
    expect(await orgBlobs(org)).toEqual([]);
    expect((await bm.post(`/api/company-documents/${id}/archive`)).status).toBe(403);
    expect((await bm.delete(`/api/company-documents/${id}`)).status).toBe(403);

    const archived = await admin.post(`/api/company-documents/${id}/archive`);
    expect(archived.body.archived_at).toEqual(expect.any(String));
    expect((await bm.get('/api/company-documents')).body.items.map((d: { id: string }) => d.id)).not.toContain(id);
    expect((await bm.get('/api/company-documents?include_archived=1')).body.items.map((d: { id: string }) => d.id)).toContain(id);
    // include_archived is a management view
    const member = await as(await createUser(org, 'member'));
    expect((await member.get('/api/company-documents?include_archived=1')).body.items.map((d: { id: string }) => d.id)).not.toContain(id);
    expect((await admin.post(`/api/company-documents/${id}/unarchive`)).body.archived_at).toBeNull();

    expect((await admin.delete(`/api/company-documents/${id}`)).status).toBe(204);
    expect((await admin.get(`/api/company-documents/${id}`)).status).toBe(404);
    expect((await admin.get(`/api/company-documents/${missingId()}`)).status).toBe(404);
    expect((await admin.get('/api/company-documents/not-a-uuid')).status).toBe(404);
  });

  it('filters by type and status', async () => {
    const org = await createOrg();
    const admin = await as(await createUser(org, 'admin'));
    const mk = (type: string, title: string, expires_at: string | null) => admin.post('/api/company-documents').send({ type, title, expires_at });
    await mk('tax', 'Φορολογική', shiftDays(today, -2));
    await mk('insurance', 'Ασφαλιστική', shiftDays(today, 12));
    await mk('gemi', 'ΓΕΜΗ', shiftDays(today, 200));
    await mk('iso', 'ISO 27001', null);
    const titles = async (qs: string) => (await admin.get(`/api/company-documents${qs}`)).body.items.map((d: { title: string }) => d.title).sort();
    expect(await titles('')).toHaveLength(4);
    expect(await titles('?type=tax')).toEqual(['Φορολογική']);
    expect(await titles('?status=expired')).toEqual(['Φορολογική']);
    expect(await titles('?status=expiring')).toEqual(['Ασφαλιστική']);
    expect(await titles('?status=valid')).toEqual(['ISO 27001', 'ΓΕΜΗ'].sort());
    expect((await admin.get('/api/company-documents?type=nope')).status).toBe(400);
  });

  it('GET /expiring: non-archived documents expiring within 30 days, expired ones included, soonest first', async () => {
    const org = await createOrg();
    const admin = await as(await createUser(org, 'admin'));
    const mk = async (title: string, expires_at: string | null) => (await admin.post('/api/company-documents').send({ type: 'tax', title, expires_at })).body.id as string;
    await mk('expired', shiftDays(today, -5));
    await mk('today', today);
    await mk('day 30', shiftDays(today, 30));
    await mk('day 31', shiftDays(today, 31));
    await mk('no expiry', null);
    const archivedId = await mk('archived', shiftDays(today, 3));
    await admin.post(`/api/company-documents/${archivedId}/archive`);

    const res = await admin.get('/api/company-documents/expiring');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ today, days: 30 });
    expect(res.body.items.map((d: { title: string; status: string }) => [d.title, d.status])).toEqual([
      ['expired', 'expired'],
      ['today', 'expiring'],
      ['day 30', 'expiring'],
    ]);
    expect((await admin.get('/api/company-documents/expiring?days=60')).body.items).toHaveLength(4);
    expect((await (await as(await createUser(org, 'bid_manager'))).get('/api/company-documents/expiring')).status).toBe(200);
  });

  it('file: upload, download, replace (new row, old row and blob gone), remove; deleting the document removes the blob', async () => {
    const org = await createOrg();
    const admin = await as(await createUser(org, 'admin'));
    const member = await as(await createUser(org, 'member'));
    const { id } = (await admin.post('/api/company-documents').send({ type: 'gemi', title: 'Πιστοποιητικό ΓΕΜΗ' })).body;
    expect((await member.get(`/api/company-documents/${id}/download`)).body.error.code).toBe('document_has_no_file');

    const up = await admin.put(`/api/company-documents/${id}/file`).attach('file', Buffer.from('version 1'), { filename: 'ΓΕΜΗ 2026.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(200);
    expect(up.body.file).toMatchObject({ filename: 'ΓΕΜΗ 2026.pdf', mime: 'application/pdf', size: 9 });
    const firstFileId = up.body.file.id as string;
    expect(await dbFor(org).get('file', firstFileId)).toMatchObject({ tender_id: null, storage_key: `${org.id}/org/${firstFileId}`, confidentiality: 'normal' });
    expect(await orgBlobs(org)).toEqual([firstFileId]);

    const dl = await download(member, `/api/company-documents/${id}/download`);
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).toString()).toBe('version 1');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');

    const replaced = await admin.put(`/api/company-documents/${id}/file`).attach('file', Buffer.from('version 2!'), 'gemi-2027.pdf');
    expect(replaced.body.file).toMatchObject({ filename: 'gemi-2027.pdf', size: 10 });
    expect(replaced.body.file.id).not.toBe(firstFileId);
    expect(await dbFor(org).get('file', firstFileId)).toBeNull();
    expect(await orgBlobs(org)).toEqual([replaced.body.file.id]);
    expect(((await download(member, `/api/company-documents/${id}/download`)).body as Buffer).toString()).toBe('version 2!');

    // an org-level file is not reachable through any tender's files endpoint
    const tender = await createTender(org);
    expect((await admin.get(`/api/tenders/${tender.id}/files/${replaced.body.file.id}`)).status).toBe(404);
    expect((await admin.get(`/api/tenders/${tender.id}/files/${replaced.body.file.id}/download`)).status).toBe(404);
    expect((await admin.delete(`/api/tenders/${tender.id}/files/${replaced.body.file.id}`)).status).toBe(404);

    const two = await admin.put(`/api/company-documents/${id}/file`).attach('files', Buffer.from('a'), 'a.pdf').attach('files', Buffer.from('b'), 'b.pdf');
    expect(two.status).toBe(400);
    expect((await admin.put(`/api/company-documents/${missingId()}/file`).attach('file', Buffer.from('x'), 'x.pdf')).status).toBe(404);
    expect(await orgBlobs(org)).toEqual([replaced.body.file.id]);

    const removed = await admin.delete(`/api/company-documents/${id}/file`);
    expect(removed.body.file).toBeNull();
    expect(await orgBlobs(org)).toEqual([]);
    expect(await dbFor(org).count('file')).toBe(0);

    await admin.put(`/api/company-documents/${id}/file`).attach('file', Buffer.from('v3'), 'v3.pdf');
    expect(await orgBlobs(org)).toHaveLength(1);
    expect((await admin.delete(`/api/company-documents/${id}`)).status).toBe(204);
    expect(await orgBlobs(org)).toEqual([]);
    expect(await dbFor(org).count('file')).toBe(0);
  });
});

describe('CVs are personal data', () => {
  async function setup() {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const bidManager = await createUser(org, 'bid_manager');
    const tender = await createTender(org);
    const otherTender = await createTender(org);
    const teamMember = await createUser(org, 'member');
    const teamApprover = await createUser(org, 'approver');
    const teamViewer = await createUser(org, 'viewer');
    const otherTeamMember = await createUser(org, 'member');
    const unassigned = await createUser(org, 'member');
    const unassignedApprover = await createUser(org, 'approver');
    await addMember(tender, teamMember, 'B');
    await addMember(tender, teamApprover);
    await addMember(tender, teamViewer);
    await addMember(otherTender, otherTeamMember, 'B');
    const api = await as(admin);
    const cv = (await api.post('/api/company-documents').send({ type: 'cv', title: 'CV Μαρία Παππά', person_name: 'Μαρία Παππά', notes: 'PMP, 12 έτη' })).body;
    await api.put(`/api/company-documents/${cv.id}/file`).attach('file', Buffer.from('CV-CONTENT'), 'CV_Pappa_Maria.pdf');
    const iso = (await api.post('/api/company-documents').send({ type: 'iso', title: 'ISO 9001' })).body;
    return { org, admin, bidManager, tender, otherTender, teamMember, teamApprover, teamViewer, otherTeamMember, unassigned, unassignedApprover, cv, iso };
  }

  it('an unlinked CV exists only for admin and bid manager', async () => {
    const s = await setup();
    for (const user of [s.admin, s.bidManager]) {
      const api = await as(user);
      expect((await api.get('/api/company-documents?type=cv')).body.items).toHaveLength(1);
      expect((await api.get(`/api/company-documents/${s.cv.id}`)).body).toMatchObject({ person_name: 'Μαρία Παππά', file: { filename: 'CV_Pappa_Maria.pdf' } });
      expect(((await download(api, `/api/company-documents/${s.cv.id}/download`)).body as Buffer).toString()).toBe('CV-CONTENT');
    }
    for (const user of [s.teamMember, s.teamApprover, s.teamViewer, s.otherTeamMember, s.unassigned, s.unassignedApprover]) {
      const api = await as(user);
      const list = await api.get('/api/company-documents');
      expect(list.body.items.map((d: { id: string }) => d.id)).toEqual([s.iso.id]);
      expect(JSON.stringify(list.body)).not.toMatch(/Παππά|Pappa/);
      expect((await api.get('/api/company-documents?type=cv')).body.items).toEqual([]);
      for (const url of [`/api/company-documents/${s.cv.id}`, `/api/company-documents/${s.cv.id}/download`]) {
        const res = await api.get(url);
        expect([res.status, res.body.error.code], `${user.org_role} ${url}`).toEqual([404, 'document_not_found']);
      }
    }
  });

  it('linked to a tender: visible to the members of THAT tender only', async () => {
    const s = await setup();
    const link = await (await as(s.bidManager)).post(`/api/tenders/${s.tender.id}/documents`).send({ company_document_id: s.cv.id });
    expect(link.status).toBe(201);

    for (const user of [s.teamMember, s.teamApprover, s.teamViewer]) {
      const api = await as(user);
      expect((await api.get('/api/company-documents?type=cv')).body.items.map((d: { id: string }) => d.id)).toEqual([s.cv.id]);
      expect((await api.get(`/api/company-documents/${s.cv.id}`)).body.person_name).toBe('Μαρία Παππά');
      expect(((await download(api, `/api/company-documents/${s.cv.id}/download`)).body as Buffer).toString()).toBe('CV-CONTENT');
      // …but they still cannot change it
      expect((await api.patch(`/api/company-documents/${s.cv.id}`).send({ notes: 'x' })).status).toBe(403);
    }
    for (const user of [s.otherTeamMember, s.unassigned, s.unassignedApprover]) {
      const api = await as(user);
      expect((await api.get('/api/company-documents?type=cv')).body.items).toEqual([]);
      expect((await api.get(`/api/company-documents/${s.cv.id}`)).status).toBe(404);
      expect((await api.get(`/api/company-documents/${s.cv.id}/download`)).status).toBe(404);
    }
    // downloads of a CV are audited (who had the personal data)
    const downloads = await dbFor(s.org).list('audit_log', { entity: 'file', action: 'download' });
    expect(downloads.map((d) => d.user_id).sort()).toEqual([s.teamMember.id, s.teamApprover.id, s.teamViewer.id].sort());

    // unlinking (or leaving the tender) closes the door again
    await dbFor(s.org).remove('tender_member', (await dbFor(s.org).findOne('tender_member', { tender_id: s.tender.id, user_id: s.teamApprover.id }))?.id);
    expect((await (await as(s.teamApprover)).get(`/api/company-documents/${s.cv.id}/download`)).status).toBe(404);
    expect((await (await as(s.bidManager)).delete(`/api/tenders/${s.tender.id}/documents/${s.cv.id}`)).status).toBe(204);
    expect((await (await as(s.teamMember)).get(`/api/company-documents/${s.cv.id}`)).status).toBe(404);
  });

  it('the audit log never receives the personal values of a CV (name, title, notes, file name)', async () => {
    const s = await setup();
    const api = await as(s.admin);
    await api.patch(`/api/company-documents/${s.cv.id}`).send({ title: 'CV Μαρία Παππά (2027)', notes: 'PMP, 13 έτη', expires_at: '2030-01-01' });
    await api.put(`/api/company-documents/${s.cv.id}/file`).attach('file', Buffer.from('CV-2'), 'CV_Pappa_2027.pdf');
    await api.delete(`/api/company-documents/${s.cv.id}`);

    const rows = await dbFor(s.org).list('audit_log', {});
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Παππά|Pappa|PMP/);
    // the events themselves are all there
    const of = (entity: string, action: string) => rows.filter((r) => r.entity === entity && r.action === action);
    expect(of('company_document', 'create').find((r) => r.entity_id === s.cv.id)?.after).toMatchObject({ type: 'cv', title: '[personal data]', person_name: '[personal data]', notes: '[personal data]' });
    expect(of('company_document', 'update').some((r) => r.entity_id === s.cv.id && r.after.expires_at === '2030-01-01' && r.after.title === '[personal data]')).toBe(true);
    expect(of('company_document', 'delete').find((r) => r.entity_id === s.cv.id)?.before).toMatchObject({ person_name: '[personal data]' });
    expect(of('file', 'create').every((r) => r.after.filename === '[personal data]' || r.after.tender_id !== null)).toBe(true);
    expect(of('file', 'delete')).toHaveLength(2);
    // a non-CV document is audited in full, like the automatic audit
    expect(of('company_document', 'create').find((r) => r.entity_id === s.iso.id)).toMatchObject({ user_id: s.admin.id, after: { title: 'ISO 9001', type: 'iso' } });
  });

  it('turning a CV into another type drops the person name', async () => {
    const s = await setup();
    const api = await as(s.admin);
    const res = await api.patch(`/api/company-documents/${s.cv.id}`).send({ type: 'other', title: 'Βιογραφικά (γενικό)' });
    expect(res.body).toMatchObject({ type: 'other', person_name: null });
    expect((await api.patch(`/api/company-documents/${s.iso.id}`).send({ type: 'cv' })).status).toBe(422);
  });
});

describe('/api/company-documents — isolation', () => {
  it('another organization sees nothing: list, expiring, get, download, update, file, archive, delete', async () => {
    const org = await createOrg();
    const admin = await as(await createUser(org, 'admin'));
    const doc = (await admin.post('/api/company-documents').send({ type: 'tax', title: 'Φορολογική ενημερότητα', expires_at: shiftDays(today, 5) })).body;
    const cv = (await admin.post('/api/company-documents').send({ type: 'cv', title: 'CV', person_name: 'Νίκος Γεωργίου' })).body;
    await admin.put(`/api/company-documents/${doc.id}/file`).attach('file', Buffer.from('tax'), 'tax.pdf');

    const org2 = await createOrg();
    const foreign = await as(await createUser(org2, 'admin'));
    expect((await foreign.get('/api/company-documents?include_archived=1')).body.items).toEqual([]);
    expect((await foreign.get('/api/company-documents/expiring')).body.items).toEqual([]);
    for (const id of [doc.id, cv.id]) {
      for (const res of [
        await foreign.get(`/api/company-documents/${id}`),
        await foreign.get(`/api/company-documents/${id}/download`),
        await foreign.patch(`/api/company-documents/${id}`).send({ title: 'hijacked' }),
        await foreign.put(`/api/company-documents/${id}/file`).attach('file', Buffer.from('x'), 'x.pdf'),
        await foreign.delete(`/api/company-documents/${id}/file`),
        await foreign.post(`/api/company-documents/${id}/archive`),
        await foreign.post(`/api/company-documents/${id}/unarchive`),
        await foreign.delete(`/api/company-documents/${id}`),
      ]) {
        expect(res.status).toBe(404);
      }
    }
    expect(await orgBlobs(org2)).toEqual([]);
    expect(await orgBlobs(org)).toHaveLength(1);
    expect((await admin.get(`/api/company-documents/${doc.id}`)).body).toMatchObject({ title: 'Φορολογική ενημερότητα', archived_at: null, file: { filename: 'tax.pdf' } });
    // and a foreign document cannot be linked to their tender
    const foreignTender = await createTender(org2);
    expect((await foreign.post(`/api/tenders/${foreignTender.id}/documents`).send({ company_document_id: doc.id })).status).toBe(404);
  });
});
