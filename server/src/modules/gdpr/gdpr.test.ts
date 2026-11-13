import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, setStorage } from '../../core/storage.js';
import { shiftDays } from '../../domain/calendar.js';
import { todayAthens } from '../../domain/time.js';
import { loadModuleJobs, registeredJobs, runJob } from '../../jobs/index.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';
import { RETENTION_JOB } from './jobs.js';
import { ERASED_USER_NAME, erasedEmail, normalizeName, purgeExpiredFiles } from './service.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bm-gdpr-test-'));
  setStorage(new LocalDiskStorage(root));
});
afterAll(async () => {
  setStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

async function blobs(org: { id: string }): Promise<string[]> {
  const dir = path.join(root, org.id);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) out.push(e.name);
  return out.sort();
}

/** An org with a person (user + two CVs, one linked to a tender), a namesake-free colleague and unrelated documents. */
async function setup() {
  const org = await createOrg();
  const admin = await createUser(org, 'admin');
  // e-mails are looked up across organizations at login, so each test gets its own address
  const email = `g.pappas.${org.id.slice(0, 8)}@example.com`;
  const person = await createUser(org, 'member', { name: 'Γιώργος Παππάς', email, password: 'correct horse battery', settings: { digest: false } });
  const colleague = await createUser(org, 'member', { name: 'Ελένη Ρήγα' });
  const tender = await createTender(org);
  await addMember(tender, person, 'B');
  await addMember(tender, colleague, 'A');
  const api = await as(admin);
  const mk = async (body: Record<string, unknown>, file?: string) => {
    const doc = (await api.post('/api/company-documents').send(body)).body as { id: string };
    if (file) await api.put(`/api/company-documents/${doc.id}/file`).attach('file', Buffer.from(`content of ${file}`), file);
    return doc;
  };
  const cv1 = await mk({ type: 'cv', title: 'CV Γιώργος Παππάς', person_name: 'Γιώργος Παππάς', notes: 'Senior engineer' }, 'CV_Pappas.pdf');
  const cv2 = await mk({ type: 'cv', title: 'CV (EN)', person_name: 'ΓΙΩΡΓΟΣ  ΠΑΠΠΑΣ' }, 'CV_Pappas_EN.pdf');
  const otherCv = await mk({ type: 'cv', title: 'CV Ελένη Ρήγα', person_name: 'Ελένη Ρήγα' }, 'CV_Riga.pdf');
  const iso = await mk({ type: 'iso', title: 'ISO 9001' }, 'iso.pdf');
  await api.post(`/api/tenders/${tender.id}/documents`).send({ company_document_id: cv1.id });
  await api.post(`/api/tenders/${tender.id}/documents`).send({ company_document_id: otherCv.id });
  // traces of the person elsewhere
  const personSession = await as(person);
  expect((await personSession.get('/api/holidays')).status).toBe(200);
  const db = dbFor(org);
  await db.insert('invitation', { email, org_role: 'member', token_hash: 'h1', expires_at: new Date(Date.now() + 1e6), accepted_user_id: person.id });
  await db.insert('email_log', { user_id: person.id, to_email: email, kind: 'digest', dedupe_key: `d-${person.id}`, subject: 'Γιώργο, 3 εκκρεμότητες', body: 'Καλημέρα Γιώργο Παππά' });
  const task = await db.insert('task', { tender_id: tender.id, title: 'Τεχνική περιγραφή', owner_user_id: person.id });
  return { email, org, admin, person, colleague, tender, api, cv1, cv2, otherCv, iso, personSession, task, db };
}

describe('normalizeName', () => {
  it('ignores case, accents and spacing', () => {
    expect(normalizeName(' Γιώργος   Παππάς ')).toBe(normalizeName('ΓΙΩΡΓΟΣ ΠΑΠΠΑΣ'));
    expect(normalizeName('Γιώργος Παππάς')).not.toBe(normalizeName('Γιώργος Παππά'));
    expect(normalizeName(null)).toBe('');
  });
});

describe('POST /api/gdpr/erase-person', () => {
  it('admin only; needs a target; never your own account; unknown user → 404', async () => {
    const s = await setup();
    for (const role of ['bid_manager', 'member', 'approver', 'viewer'] as const) {
      const api = await as(await createUser(s.org, role));
      expect((await api.post('/api/gdpr/erase-person').send({ user_id: s.person.id, dry_run: false })).status).toBe(403);
      expect((await api.get('/api/gdpr/retention')).status).toBe(403);
      expect((await api.put('/api/gdpr/retention').send({ retention_days: 1 })).status).toBe(403);
    }
    const none = await s.api.post('/api/gdpr/erase-person').send({ dry_run: false });
    expect([none.status, none.body.error.code]).toEqual([400, 'erase_target_required']);
    const self = await s.api.post('/api/gdpr/erase-person').send({ user_id: s.admin.id, dry_run: false });
    expect([self.status, self.body.error.code]).toEqual([422, 'cannot_erase_self']);
    const unknown = await s.api.post('/api/gdpr/erase-person').send({ user_id: missingId(), dry_run: false });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'user_not_found']);
    expect((await s.api.post('/api/gdpr/erase-person').send({ user_id: s.person.id, confirm: true })).status).toBe(400);
    expect((await s.db.get('user', s.person.id))?.name).toBe('Γιώργος Παππάς');
    expect(await blobs(s.org)).toHaveLength(4);
  });

  it('dry run (the default) reports exactly what would go and changes nothing', async () => {
    const s = await setup();
    const auditBefore = await s.db.count('audit_log');
    const res = await s.api.post('/api/gdpr/erase-person').send({ user_id: s.person.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dry_run: true,
      erased: false,
      user: { id: s.person.id, name: 'Γιώργος Παππάς', email: s.email, already_anonymized: false },
      counts: { documents: 2, files: 2, tender_links: 1, sessions: 1, invitations: 1, emails: 1 },
      matching_users: [],
    });
    expect(res.body.documents.map((d: { id: string }) => d.id).sort()).toEqual([s.cv1.id, s.cv2.id].sort());
    expect(res.body.documents.find((d: { id: string }) => d.id === s.cv1.id)).toMatchObject({ has_file: true, tenders: [{ id: s.tender.id, title: s.tender.title }] });

    expect(await s.db.count('company_document')).toBe(4);
    expect(await s.db.count('tender_document')).toBe(2);
    expect(await blobs(s.org)).toHaveLength(4);
    expect(await s.db.get('user', s.person.id)).toMatchObject({ name: 'Γιώργος Παππάς', active: true, anonymized_at: null });
    expect((await s.personSession.get('/api/holidays')).status).toBe(200);
    expect(await s.db.count('audit_log')).toBe(auditBefore);

    // by name only: the CVs, plus a hint that an account with that name exists and is NOT touched
    const byName = await s.api.post('/api/gdpr/erase-person').send({ person_name: 'γιωργος παππας' });
    expect(byName.body).toMatchObject({ user: null, counts: { documents: 2, files: 2, tender_links: 1, sessions: 0 }, matching_users: [{ id: s.person.id }] });
  });

  it('real run: CVs, blobs and links gone; the user anonymised and locked out; everything else intact', async () => {
    const s = await setup();
    const personFiles = (await s.db.list('company_document', { id: [s.cv1.id, s.cv2.id] })).map((d) => d.file_id as string);
    const res = await s.api.post('/api/gdpr/erase-person').send({ user_id: s.person.id, dry_run: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dry_run: false, erased: true, counts: { documents: 2, files: 2, tender_links: 1 } });

    // CV documents, their file rows, blobs and tender links
    expect(await s.db.list('company_document', { id: [s.cv1.id, s.cv2.id] })).toEqual([]);
    expect(await s.db.list('file', { id: personFiles })).toEqual([]);
    const left = await blobs(s.org);
    expect(left).toHaveLength(2);
    for (const id of personFiles) expect(left).not.toContain(id);
    expect((await s.db.list('tender_document', {})).map((l) => l.company_document_id)).toEqual([s.otherCv.id]);
    expect((await s.api.get(`/api/company-documents/${s.cv1.id}/download`)).status).toBe(404);

    // the account: row kept, identity gone, cannot log in
    const user = await s.db.get('user', s.person.id);
    expect(user).toMatchObject({
      name: ERASED_USER_NAME,
      email: erasedEmail(s.person.id),
      active: false,
      password_hash: null,
      totp_secret: null,
      totp_enabled_at: null,
      settings: {},
      org_role: 'member',
    });
    expect(user?.anonymized_at).toBeInstanceOf(Date);
    expect(await s.db.count('session', { user_id: s.person.id })).toBe(0);
    expect((await s.personSession.get('/api/holidays')).status).toBe(401);
    const { anon } = await import('../../test/harness.js');
    expect((await anon().post('/api/auth/login').send({ email: s.email, password: 'correct horse battery' })).status).toBe(401);
    expect(await s.db.sql('SELECT id FROM invitation WHERE org_id = :org_id', {})).toEqual([]);
    expect(await s.db.findOne('email_log', { user_id: s.person.id })).toMatchObject({ to_email: null, subject: '', body: '' });

    // referential integrity: memberships, tasks and the audit trail still point at the (anonymised) user
    expect(await s.db.count('tender_member', { user_id: s.person.id })).toBe(1);
    expect(await s.db.get('task', s.task.id)).toMatchObject({ owner_user_id: s.person.id });
    // other people's data is untouched
    expect(await s.db.get('user', s.colleague.id)).toMatchObject({ name: 'Ελένη Ρήγα', active: true });
    expect((await s.api.get(`/api/company-documents/${s.otherCv.id}`)).body).toMatchObject({ person_name: 'Ελένη Ρήγα', file: { filename: 'CV_Riga.pdf' } });
    expect((await s.api.get(`/api/company-documents/${s.iso.id}/download`)).status).toBe(200);

    // idempotent: a second run finds nothing and breaks nothing
    const again = await s.api.post('/api/gdpr/erase-person').send({ user_id: s.person.id, dry_run: false });
    expect(again.body).toMatchObject({ erased: true, user: { already_anonymized: true, name: ERASED_USER_NAME }, counts: { documents: 0, files: 0, tender_links: 0, sessions: 0 } });
    expect(await blobs(s.org)).toHaveLength(2);
  });

  it('audit: the erasure is recorded, and no audit row written by it or by the CV lifecycle holds the erased values', async () => {
    const s = await setup();
    const before = await s.db.count('audit_log');
    await s.api.post('/api/gdpr/erase-person').send({ user_id: s.person.id, dry_run: false });
    const all = await s.db.list('audit_log', {}, { orderBy: 'at, id' });
    const fresh = all.slice(before);
    // exactly one new row, and it carries ids and counts only
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ entity: 'gdpr', action: 'erase_person', entity_id: s.person.id, user_id: s.admin.id, before: null });
    expect(fresh[0]?.after).toMatchObject({ user_id: s.person.id, user_anonymized: true, counts: { documents: 2, files: 2, tender_links: 1 } });
    expect((fresh[0]?.after.document_ids as string[]).sort()).toEqual([s.cv1.id, s.cv2.id].sort());
    expect(JSON.stringify(fresh)).not.toMatch(/Παππ|ΠΑΠΠ|Pappas|pappas|Γιώργο|Senior/);

    // rows written BEFORE the erasure by this slice (CV create / file upload / link) never contained them either
    const mine = all.filter((r) => ['company_document', 'file', 'tender_document', 'gdpr'].includes(r.entity as string));
    expect(JSON.stringify(mine)).not.toMatch(/Παππ|ΠΑΠΠ|Pappas|Senior/);
    // (the user row itself was created through the automatic audit of the foundation — see the slice report)
    // the log is still append-only
    await expect(s.db.sql('DELETE FROM audit_log WHERE org_id = :org_id', {})).rejects.toThrow(/append-only/);
  });

  it('by person name only: removes the CVs and leaves accounts alone', async () => {
    const s = await setup();
    const res = await s.api.post('/api/gdpr/erase-person').send({ person_name: 'Ελένη Ρήγα', dry_run: false });
    expect(res.body).toMatchObject({ erased: true, user: null, counts: { documents: 1, files: 1, tender_links: 1 }, matching_users: [{ id: s.colleague.id }] });
    expect(await s.db.get('company_document', s.otherCv.id)).toBeNull();
    expect(await s.db.get('user', s.colleague.id)).toMatchObject({ name: 'Ελένη Ρήγα', active: true, anonymized_at: null });
    expect(await s.db.count('company_document')).toBe(3);
    const row = await s.db.findOne('audit_log', { entity: 'gdpr', action: 'erase_person' });
    expect(row).toMatchObject({ entity_id: null, after: { user_id: null, user_anonymized: false } });
    expect(JSON.stringify(row)).not.toMatch(/Ρήγα/);
    // a name that matches nothing is a harmless no-op
    expect((await s.api.post('/api/gdpr/erase-person').send({ person_name: 'Κανένας Τέτοιος', dry_run: false })).body.counts.documents).toBe(0);
  });

  it('cross-org: an admin of another organization can neither see nor erase', async () => {
    const s = await setup();
    const org2 = await createOrg();
    const foreign = await as(await createUser(org2, 'admin'));
    expect((await foreign.post('/api/gdpr/erase-person').send({ user_id: s.person.id, dry_run: false })).status).toBe(404);
    expect((await foreign.post('/api/gdpr/erase-person').send({ user_id: s.person.id })).status).toBe(404);
    const byName = await foreign.post('/api/gdpr/erase-person').send({ person_name: 'Γιώργος Παππάς', dry_run: false });
    expect(byName.body).toMatchObject({ counts: { documents: 0, files: 0 }, matching_users: [], documents: [] });
    expect(await s.db.count('company_document')).toBe(4);
    expect(await blobs(s.org)).toHaveLength(4);
    expect((await s.db.get('user', s.person.id))?.name).toBe('Γιώργος Παππάς');
  });
});

describe('retention', () => {
  const today = todayAthens();
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  async function tenderWithFiles(org: { id: string }, admin: { id: string; org_id: string }, overrides: Record<string, unknown>, files = 2) {
    const tender = await createTender(org, overrides);
    const api = await as(admin);
    for (let i = 0; i < files; i++) {
      const res = await api.post(`/api/tenders/${tender.id}/files`).field('folder', i === 0 ? 'financial' : 'technical').attach('file', Buffer.from(`f${i}`), `f${i}.pdf`);
      expect(res.status).toBe(201);
    }
    return tender;
  }

  it('GET/PUT /api/gdpr/retention', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const api = await as(admin);
    expect((await api.get('/api/gdpr/retention')).body).toEqual({ retention_days: null, pending: { tenders: 0, files: 0 } });
    await tenderWithFiles(org, admin, { status: 'submitted', closed_at: daysAgo(100) });
    const set = await api.put('/api/gdpr/retention').send({ retention_days: 90 });
    expect(set.body).toEqual({ retention_days: 90, pending: { tenders: 1, files: 2 } });
    expect((await api.put('/api/gdpr/retention').send({ retention_days: 365 })).body.pending).toEqual({ tenders: 0, files: 0 });
    for (const bad of [{ retention_days: -1 }, { retention_days: 1.5 }, { retention_days: '90' }, {}, { retention_days: 90, org_id: missingId() }]) {
      expect((await api.put('/api/gdpr/retention').send(bad)).status).toBe(400);
    }
    expect((await api.put('/api/gdpr/retention').send({ retention_days: null })).body.retention_days).toBeNull();
    // another org's setting is its own
    const org2 = await createOrg({ retention_days: 7 });
    expect((await (await as(await createUser(org2, 'admin'))).get('/api/gdpr/retention')).body.retention_days).toBe(7);
    expect((await api.get('/api/gdpr/retention')).body.retention_days).toBeNull();
  });

  it('the job is registered; it purges blobs + file rows of tenders closed longer ago than the period, and only those', async () => {
    await loadModuleJobs();
    expect(registeredJobs()).toContainEqual({ name: RETENTION_JOB, cronExpr: '0 7 * * *' });

    const org = await createOrg({ retention_days: 90 });
    const admin = await createUser(org, 'admin');
    const db = dbFor(org);
    const old = await tenderWithFiles(org, admin, { status: 'submitted', closed_at: daysAgo(120) });
    const oldNoGo = await tenderWithFiles(org, admin, { status: 'no_go', closed_at: daysAgo(91) }, 1);
    const recent = await tenderWithFiles(org, admin, { status: 'submitted', closed_at: daysAgo(30) });
    const active = await tenderWithFiles(org, admin, { status: 'in_progress' }, 1);
    const closedNoDate = await tenderWithFiles(org, admin, { status: 'cancelled', closed_at: null }, 1);
    const reopened = await tenderWithFiles(org, admin, { status: 'in_progress', closed_at: daysAgo(200) }, 1);
    // an org-level company document file is never touched by retention
    const api = await as(admin);
    const doc = (await api.post('/api/company-documents').send({ type: 'iso', title: 'ISO' })).body;
    await api.put(`/api/company-documents/${doc.id}/file`).attach('file', Buffer.from('iso'), 'iso.pdf');
    // a second organization with an old closed tender but NO retention period
    const org2 = await createOrg();
    const admin2 = await createUser(org2, 'admin');
    const foreign = await tenderWithFiles(org2, admin2, { status: 'submitted', closed_at: daysAgo(500) });
    expect(await blobs(org)).toHaveLength(9);

    const [run] = await runJob(RETENTION_JOB, { orgId: org.id, date: today });
    expect(run).toMatchObject({ status: 'ok', detail: { retention_days: 90, cutoff: shiftDays(today, -90), tenders: 2, files: 3, swept_blobs: 0 } });
    await runJob(RETENTION_JOB, { orgId: org2.id, date: today });

    expect(await db.count('file', { tender_id: old.id })).toBe(0);
    expect(await db.count('file', { tender_id: oldNoGo.id })).toBe(0);
    expect(existsSync(path.join(root, org.id, old.id))).toBe(false);
    for (const [t, n] of [[recent, 2], [active, 1], [closedNoDate, 1], [reopened, 1]] as const) expect(await db.count('file', { tender_id: t.id })).toBe(n);
    expect(await blobs(org)).toHaveLength(6);
    expect((await api.get(`/api/company-documents/${doc.id}/download`)).status).toBe(200);
    expect(await dbFor(org2).count('file', { tender_id: foreign.id })).toBe(2);
    expect(await blobs(org2)).toHaveLength(2);
    // the tender and its other data stay; the purge is audited without file names
    expect(await db.get('tender', old.id)).not.toBeNull();
    const audit = await db.list('audit_log', { action: 'retention_purge' });
    expect(audit.map((a) => [a.entity, a.entity_id, a.after.files]).sort()).toEqual([['tender', old.id, 2], ['tender', oldNoGo.id, 1]].sort());
    expect(JSON.stringify(audit)).not.toContain('.pdf');
    expect(await db.findOne('job_run', { job: RETENTION_JOB, run_date: today })).toMatchObject({ status: 'ok', detail: { files: 3 } });

    // idempotent: same date → skipped by job_run; next day and a direct call → nothing left to do, nothing breaks
    expect((await runJob(RETENTION_JOB, { orgId: org.id, date: today }))[0]).toMatchObject({ status: 'skipped' });
    expect((await runJob(RETENTION_JOB, { orgId: org.id, date: shiftDays(today, 1) }))[0]).toMatchObject({ status: 'ok', detail: { tenders: 0, files: 0 } });
    expect(await purgeExpiredFiles(db, today)).toMatchObject({ tenders: 0, files: 0, swept_blobs: 0 });
    expect(await blobs(org)).toHaveLength(6);
    expect(await db.count('audit_log', { action: 'retention_purge' })).toBe(2);

    // time passes: the "recent" tender crosses the line exactly one day after the period
    expect((await purgeExpiredFiles(db, shiftDays(today, 60))).tenders).toBe(0);
    expect(await purgeExpiredFiles(db, shiftDays(today, 61))).toMatchObject({ tenders: 1, files: 2 });
    expect(await db.count('file', { tender_id: recent.id })).toBe(0);
  });

  it('sweeps the blob of a soft-deleted file whose removal had failed, even without a retention period', async () => {
    const org = await createOrg();
    const admin = await createUser(org, 'admin');
    const tender = await tenderWithFiles(org, admin, {}, 1);
    const db = dbFor(org);
    const [file] = await db.list('file', { tender_id: tender.id });
    await db.sql('UPDATE file SET deleted_at = now() WHERE org_id = :org_id AND id = :id', { id: file?.id });
    expect(await blobs(org)).toHaveLength(1);
    expect(await purgeExpiredFiles(db, today)).toEqual({ retention_days: null, cutoff: null, tenders: 0, files: 0, swept_blobs: 1 });
    expect(await blobs(org)).toEqual([]);
    expect((await purgeExpiredFiles(db, today)).swept_blobs).toBe(0);
  });
});
