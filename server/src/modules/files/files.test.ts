import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, setStorage } from '../../core/storage.js';
import { addMember, addRole, as, createOrg, createTender, createUser, dbFor, missingId, type Agent, type TestOrg, type TestTender, type TestUser } from '../../test/harness.js';
import { contentDisposition, downloadHeaders, sanitizeFilename, uploadLimits } from './service.js';

let root: string;
const defaults = { ...uploadLimits };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bm-files-test-'));
  setStorage(new LocalDiskStorage(root));
});
afterEach(() => {
  Object.assign(uploadLimits, defaults);
});
afterAll(async () => {
  setStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Every blob currently on disk for a tender (or the whole org). */
async function blobs(org: { id: string }, tender?: { id: string }): Promise<string[]> {
  const dir = tender ? path.join(root, org.id, tender.id) : path.join(root, org.id);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) out.push(e.name);
  return out;
}

function upload(api: Agent, tender: { id: string }, content: Buffer | string, filename: string, fields: Record<string, string> = {}, contentType = 'application/pdf') {
  let req = api.post(`/api/tenders/${tender.id}/files`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), { filename, contentType });
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

interface World {
  org: TestOrg;
  tender: TestTender;
  admin: TestUser;
  bidManager: TestUser;
  financialMember: TestUser;
  technicalMember: TestUser;
  plainMember: TestUser;
  approverMember: TestUser;
  approverOutside: TestUser;
  viewerMember: TestUser;
  outsider: TestUser;
  /** member of another tender of the same org (holding the financial role there) */
  otherTenderMember: TestUser;
  otherTender: TestTender;
}

/** One tender with the full cast of R18. */
async function world(): Promise<World> {
  const org = await createOrg();
  const tender = await createTender(org);
  const otherTender = await createTender(org);
  await addRole(tender, 'A', { folder: 'participation' });
  await addRole(tender, 'B', { folder: 'technical' });
  await addRole(tender, 'C', { folder: 'financial', financial: true });
  await addRole(otherTender, 'C', { folder: 'financial', financial: true });
  const [admin, bidManager, financialMember, technicalMember, plainMember, approverMember, approverOutside, viewerMember, outsider, otherTenderMember] = await Promise.all([
    createUser(org, 'admin'),
    createUser(org, 'bid_manager'),
    createUser(org, 'member'),
    createUser(org, 'member'),
    createUser(org, 'member'),
    createUser(org, 'approver'),
    createUser(org, 'approver'),
    createUser(org, 'viewer'),
    createUser(org, 'member'),
    createUser(org, 'member'),
  ]);
  await addMember(tender, financialMember, 'C');
  await addMember(tender, technicalMember, 'B');
  await addMember(tender, plainMember);
  await addMember(tender, approverMember, 'MGMT');
  await addMember(tender, viewerMember, 'C'); // even holding the financial role, a viewer never sees financial files
  await addMember(otherTender, otherTenderMember, 'C');
  return { org, tender, otherTender, admin, bidManager, financialMember, technicalMember, plainMember, approverMember, approverOutside, viewerMember, outsider, otherTenderMember };
}

describe('filename and download-header safety', () => {
  it('sanitizeFilename keeps a display name only: no paths, control or bidi characters, bounded length', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\Οικονομική προσφορά.xlsx')).toBe('Οικονομική προσφορά.xlsx');
    expect(sanitizeFilename('a\r\nSet-Cookie: x=1.pdf')).toBe('aSet-Cookie: x=1.pdf');
    expect(sanitizeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename(undefined)).toBe('file');
    const long = sanitizeFilename(`${'α'.repeat(400)}.pdf`);
    expect(long.length).toBe(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('contentDisposition cannot be broken out of', () => {
    expect(contentDisposition('offer.pdf')).toBe(`attachment; filename="offer.pdf"; filename*=UTF-8''offer.pdf`);
    const greek = contentDisposition('Οικονομική προσφορά.pdf');
    expect(greek).toBe(`attachment; filename="__________ ________.pdf"; filename*=UTF-8''${encodeURIComponent('Οικονομική προσφορά.pdf')}`);
    const evil = contentDisposition(`x"; filename="evil.html\r\nX-Injected: 1;'().pdf`);
    expect(evil).not.toMatch(/[\r\n]/);
    expect(evil.match(/"/g)).toHaveLength(2);
    expect(evil.split("filename*=UTF-8''")[1]).not.toMatch(/['()*";\s]/);
    expect(evil.startsWith('attachment; filename="x__ filename=_evil.htmlX-Injected: 1_')).toBe(true);
  });

  it('only a small safe list is ever served inline, and only on request', () => {
    const d = (mime: string | null, inline: boolean) => downloadHeaders({ filename: 'f', mime }, inline);
    expect(d('application/pdf', true)).toMatchObject({ type: 'application/pdf', disposition: expect.stringMatching(/^inline;/) });
    expect(d('image/png', true).disposition).toMatch(/^inline;/);
    expect(d('text/plain', true).type).toBe('text/plain; charset=utf-8');
    expect(d('application/pdf', false)).toMatchObject({ type: 'application/octet-stream', disposition: expect.stringMatching(/^attachment;/) });
    for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'text/html; charset=utf-8', 'TEXT/HTML', null, 'nonsense']) {
      expect(d(mime, true), String(mime)).toMatchObject({ type: 'application/octet-stream', disposition: expect.stringMatching(/^attachment;/) });
    }
  });
});

describe('tender files — upload, list, download', () => {
  it('a member uploads; the file is encrypted under {org}/{tender}/{file_id}; the download is identical and hardened', async () => {
    const w = await world();
    const api = await as(w.technicalMember);
    const content = randomBytes(300_000);
    const res = await upload(api, w.tender, content, 'Τεχνική προσφορά v2.pdf', { folder: 'technical', label: 'Τελικό' });
    expect(res.status).toBe(201);
    const [file] = res.body.items;
    expect(file).toMatchObject({
      tender_id: w.tender.id,
      filename: 'Τεχνική προσφορά v2.pdf',
      mime: 'application/pdf',
      size: content.length,
      sha256: sha(content),
      folder: 'technical',
      confidentiality: 'normal',
      label: 'Τελικό',
      uploaded_by: w.technicalMember.id,
      uploaded_by_name: w.technicalMember.name,
    });
    // storage internals never leave the server
    expect(Object.keys(file)).not.toContain('storage_key');
    expect(Object.keys(file)).not.toContain('enc');

    const row = await dbFor(w.org).get('file', file.id);
    expect(row).toMatchObject({ storage_key: `${w.org.id}/${w.tender.id}/${file.id}`, enc: { alg: 'aes-256-gcm' } });
    const onDisk = await readFile(path.join(root, w.org.id, w.tender.id, file.id));
    expect(onDisk.equals(content)).toBe(false);
    expect(await blobs(w.org, w.tender)).toEqual([file.id]);

    const dl = await download(api, `/api/tenders/${w.tender.id}/files/${file.id}/download`);
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="_______ ________ v2.pdf"; filename*=UTF-8''${encodeURIComponent('Τεχνική προσφορά v2.pdf')}`);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(dl.headers['content-length']).toBe(String(content.length));

    const inline = await download(api, `/api/tenders/${w.tender.id}/files/${file.id}/download?inline=1`);
    expect(inline.headers['content-type']).toBe('application/pdf');
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);

    const meta = await api.get(`/api/tenders/${w.tender.id}/files/${file.id}`);
    expect(meta.body).toMatchObject({ id: file.id, filename: 'Τεχνική προσφορά v2.pdf' });
    const list = await api.get(`/api/tenders/${w.tender.id}/files?folder=technical`);
    expect(list.body.items.map((f: { id: string }) => f.id)).toEqual([file.id]);
    expect((await api.get(`/api/tenders/${w.tender.id}/files?folder=nonsense`)).status).toBe(400);
  });

  it('a hostile filename never reaches the filesystem, and HTML/SVG are never rendered inline', async () => {
    const w = await world();
    const api = await as(w.plainMember);
    const html = await upload(api, w.tender, '<script>alert(1)</script>', '../../../evil.html', {}, 'text/html');
    expect(html.status).toBe(201);
    expect(html.body.items[0].filename).toBe('evil.html');
    const svg = await upload(api, w.tender, '<svg onload="alert(1)"/>', 'logo.svg', {}, 'image/svg+xml');
    // the blob is named by its uuid, inside the tender's folder — nothing else was created anywhere
    expect((await blobs(w.org)).sort()).toEqual([html.body.items[0].id, svg.body.items[0].id].sort());
    expect(existsSync(path.join(root, 'evil.html'))).toBe(false);
    expect(existsSync(path.join(root, '..', 'evil.html'))).toBe(false);
    for (const f of [html.body.items[0], svg.body.items[0]]) {
      const dl = await download(api, `/api/tenders/${w.tender.id}/files/${f.id}/download?inline=1`);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/octet-stream');
      expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('several files in one request; bad fields are rejected and leave nothing behind', async () => {
    const w = await world();
    const api = await as(w.plainMember);
    const multi = await api
      .post(`/api/tenders/${w.tender.id}/files`)
      .field('folder', 'tender_docs')
      .attach('files', Buffer.from('one'), 'diakiryxi.pdf')
      .attach('files', Buffer.from('two'), 'parartima-a.pdf');
    expect(multi.status).toBe(201);
    expect(multi.body.items.map((f: { filename: string }) => f.filename).sort()).toEqual(['diakiryxi.pdf', 'parartima-a.pdf']);
    expect(await blobs(w.org, w.tender)).toHaveLength(2);

    const badFolder = await upload(api, w.tender, 'x', 'a.pdf', { folder: 'secret' });
    expect(badFolder.status).toBe(400);
    const noFile = await api.post(`/api/tenders/${w.tender.id}/files`).field('folder', 'other');
    expect([noFile.status, noFile.body.error.code]).toEqual([400, 'file_required']);
    const json = await api.post(`/api/tenders/${w.tender.id}/files`).send({ folder: 'other' });
    expect([json.status, json.body.error.code]).toEqual([400, 'file_required']);
    const empty = await upload(api, w.tender, Buffer.alloc(0), 'empty.pdf');
    expect([empty.status, empty.body.error.code]).toEqual([400, 'file_empty']);
    const wrongField = await api.post(`/api/tenders/${w.tender.id}/files`).attach('document', Buffer.from('x'), 'a.pdf');
    expect([wrongField.status, wrongField.body.error.code]).toEqual([400, 'invalid_upload']);
    expect(await blobs(w.org, w.tender)).toHaveLength(2);
    expect(await dbFor(w.org).count('file', { tender_id: w.tender.id })).toBe(2);
  });

  it('upload limit: a file over the limit → 413 file_too_large, no row, no blob; exactly the limit is fine', async () => {
    expect(uploadLimits.maxBytes).toBe(200 * 1024 * 1024); // the spec's limit
    const w = await world();
    const api = await as(w.plainMember);
    uploadLimits.maxBytes = 64 * 1024;
    const over = await upload(api, w.tender, randomBytes(64 * 1024 + 1), 'big.bin', {}, 'application/octet-stream');
    expect(over.status).toBe(413);
    expect(over.body.error).toMatchObject({ code: 'file_too_large', details: { max_bytes: 64 * 1024 } });
    expect(await blobs(w.org, w.tender)).toEqual([]);
    expect(await dbFor(w.org).count('file', { tender_id: w.tender.id })).toBe(0);

    const exact = await upload(api, w.tender, randomBytes(64 * 1024), 'ok.bin', {}, 'application/octet-stream');
    expect(exact.status).toBe(201);

    // one oversized file fails the whole request, including the files that were fine
    const mixed = await api
      .post(`/api/tenders/${w.tender.id}/files`)
      .attach('files', Buffer.from('small'), 'small.txt')
      .attach('files', randomBytes(200 * 1024), 'big.bin');
    expect(mixed.status).toBe(413);
    expect(await blobs(w.org, w.tender)).toHaveLength(1);

    uploadLimits.maxFiles = 2;
    const many = await api
      .post(`/api/tenders/${w.tender.id}/files`)
      .attach('files', Buffer.from('1'), '1.txt')
      .attach('files', Buffer.from('2'), '2.txt')
      .attach('files', Buffer.from('3'), '3.txt');
    expect([many.status, many.body.error.code]).toEqual([400, 'invalid_upload']);
    expect(await blobs(w.org, w.tender)).toHaveLength(1);
  });

  it('integrity: a blob modified on disk is never sent — 500 file_integrity_error, audited', async () => {
    const w = await world();
    const api = await as(w.plainMember);
    const content = randomBytes(50_000);
    const { id } = (await upload(api, w.tender, content, 'contract.pdf')).body.items[0];
    const blob = path.join(root, w.org.id, w.tender.id, id);
    const original = await readFile(blob);

    const tampered = Buffer.from(original);
    tampered[100] = (tampered[100] as number) ^ 0xff;
    await writeFile(blob, tampered);
    const bad = await api.get(`/api/tenders/${w.tender.id}/files/${id}/download`);
    expect([bad.status, bad.body.error.code]).toEqual([500, 'file_integrity_error']);
    expect(bad.headers['content-disposition']).toBeUndefined();
    expect(await dbFor(w.org).findOne('audit_log', { entity: 'file', entity_id: id, action: 'integrity_failure' })).toMatchObject({ after: { reason: 'tampered' }, tender_id: w.tender.id });

    // intact ciphertext but a database hash that does not match (e.g. the row was edited)
    await writeFile(blob, original);
    await dbFor(w.org).sql('UPDATE file SET sha256 = :sha WHERE org_id = :org_id AND id = :id', { id, sha: sha(Buffer.from('something else')) });
    const mismatch = await api.get(`/api/tenders/${w.tender.id}/files/${id}/download`);
    expect([mismatch.status, mismatch.body.error.code]).toEqual([500, 'file_integrity_error']);
    await dbFor(w.org).sql('UPDATE file SET sha256 = :sha WHERE org_id = :org_id AND id = :id', { id, sha: sha(content) });
    expect((await download(api, `/api/tenders/${w.tender.id}/files/${id}/download`)).status).toBe(200);

    await rm(blob);
    const missing = await api.get(`/api/tenders/${w.tender.id}/files/${id}/download`);
    expect([missing.status, missing.body.error.code]).toEqual([500, 'file_integrity_error']);
  });
});

describe('R18 — financial files', () => {
  /** A financial file (uploaded by the financial-role member) and a normal one in the same tender. */
  async function withFiles() {
    const w = await world();
    const fin = await upload(await as(w.financialMember), w.tender, 'ΤΙΜΕΣ: 1.250.000 €', 'Οικονομική προσφορά.xlsx', { folder: 'financial' });
    expect(fin.status).toBe(201);
    expect(fin.body.items[0]).toMatchObject({ folder: 'financial', confidentiality: 'financial' });
    const normal = await upload(await as(w.technicalMember), w.tender, 'spec', 'spec.pdf', { folder: 'technical' });
    return { ...w, financialFile: fin.body.items[0] as { id: string }, normalFile: normal.body.items[0] as { id: string } };
  }

  it('acceptance: a viewer or the technical-role member asking for a financial file by direct URL → 403', async () => {
    const w = await withFiles();
    const base = `/api/tenders/${w.tender.id}/files/${w.financialFile.id}`;
    for (const user of [w.viewerMember, w.technicalMember, w.plainMember]) {
      const api = await as(user);
      for (const url of [base, `${base}/download`, `${base}/download?inline=1`]) {
        const res = await api.get(url);
        expect([res.status, res.body.error?.code], `${user.org_role} ${url}`).toEqual([403, 'financial_restricted']);
        expect(res.headers['content-disposition']).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain('Οικονομική');
      }
      expect((await api.head(`${base}/download`)).status).toBe(403);
    }
  });

  it('positive: the financial-role member, bid manager, admin and an approver who is a member read it', async () => {
    const w = await withFiles();
    const base = `/api/tenders/${w.tender.id}/files/${w.financialFile.id}`;
    for (const user of [w.financialMember, w.bidManager, w.admin, w.approverMember]) {
      const api = await as(user);
      const meta = await api.get(base);
      expect(meta.status, user.org_role).toBe(200);
      expect(meta.body.filename).toBe('Οικονομική προσφορά.xlsx');
      const dl = await download(api, `${base}/download`);
      expect(dl.status).toBe(200);
      expect((dl.body as Buffer).toString('utf8')).toBe('ΤΙΜΕΣ: 1.250.000 €');
      const list = await api.get(`/api/tenders/${w.tender.id}/files`);
      expect(list.body.can_see_financial).toBe(true);
      expect(list.body.items.map((f: { id: string }) => f.id).sort()).toEqual([w.financialFile.id, w.normalFile.id].sort());
    }
    // every download of a financial file leaves a trace
    const downloads = await dbFor(w.org).list('audit_log', { entity: 'file', entity_id: w.financialFile.id, action: 'download' });
    expect(downloads.map((d) => d.user_id).sort()).toEqual([w.financialMember.id, w.bidManager.id, w.admin.id, w.approverMember.id].sort());
  });

  it('negative: an approver who is not a member, a non-member, and a member of another tender get nothing', async () => {
    const w = await withFiles();
    const base = `/api/tenders/${w.tender.id}/files`;
    for (const user of [w.approverOutside, w.outsider, w.otherTenderMember]) {
      const api = await as(user);
      for (const url of [base, `${base}/${w.financialFile.id}`, `${base}/${w.financialFile.id}/download`, `${base}/${w.normalFile.id}/download`]) {
        expect((await api.get(url)).status, url).toBe(403);
      }
      expect((await upload(api, w.tender, 'x', 'x.pdf')).status).toBe(403);
      expect((await api.patch(`${base}/${w.normalFile.id}`).send({ label: 'x' })).status).toBe(403);
      expect((await api.delete(`${base}/${w.normalFile.id}`)).status).toBe(403);
    }
    // the financial-role member of ANOTHER tender cannot reach the file through their own tender either
    const other = await as(w.otherTenderMember);
    const viaOwn = `/api/tenders/${w.otherTender.id}/files`;
    expect((await other.get(`${viaOwn}/${w.financialFile.id}`)).status).toBe(404);
    expect((await other.get(`${viaOwn}/${w.financialFile.id}/download`)).status).toBe(404);
    expect((await other.patch(`${viaOwn}/${w.financialFile.id}`).send({ folder: 'other', confidentiality: 'normal' })).status).toBe(404);
    expect((await other.delete(`${viaOwn}/${w.financialFile.id}`)).status).toBe(404);
    expect((await other.get(viaOwn)).body.items).toEqual([]);
    expect(await dbFor(w.org).get('file', w.financialFile.id)).toMatchObject({ deleted_at: null, confidentiality: 'financial' });
  });

  it('financial files are entirely absent from lists for unauthorised users — no names, ids or counts', async () => {
    const w = await withFiles();
    for (const user of [w.viewerMember, w.technicalMember, w.plainMember]) {
      const api = await as(user);
      for (const url of [`/api/tenders/${w.tender.id}/files`, `/api/tenders/${w.tender.id}/files?folder=financial`]) {
        const res = await api.get(url);
        expect(res.status).toBe(200);
        expect(res.body.can_see_financial).toBe(false);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(w.financialFile.id);
        expect(text).not.toContain('Οικονομική');
        expect(Object.keys(res.body).sort()).toEqual(['can_see_financial', 'items']);
        expect(res.body.items.every((f: { confidentiality: string }) => f.confidentiality === 'normal')).toBe(true);
      }
      expect((await api.get(`/api/tenders/${w.tender.id}/files`)).body.items).toHaveLength(1);
      expect((await api.get(`/api/tenders/${w.tender.id}/files?folder=financial`)).body.items).toEqual([]);
    }
  });

  it('uploading or moving into financial, or marking a file financial, needs financial access; nothing is kept on refusal', async () => {
    const w = await withFiles();
    const tech = await as(w.technicalMember);
    const before = (await blobs(w.org, w.tender)).length;
    for (const fields of [{ folder: 'financial' }, { folder: 'other', confidentiality: 'financial' }] as Record<string, string>[]) {
      const res = await upload(tech, w.tender, 'guess', 'prices.xlsx', fields);
      expect([res.status, res.body.error.code]).toEqual([403, 'financial_restricted']);
    }
    expect((await blobs(w.org, w.tender)).length).toBe(before);
    const base = `/api/tenders/${w.tender.id}/files`;
    // their own normal file: may not be moved into financial or marked financial
    for (const body of [{ folder: 'financial' }, { confidentiality: 'financial' }]) {
      const res = await tech.patch(`${base}/${w.normalFile.id}`).send(body);
      expect([res.status, res.body.error.code]).toEqual([403, 'financial_restricted']);
    }
    // and the financial file cannot be touched at all — not even to "declassify" it
    for (const body of [{ confidentiality: 'normal', folder: 'other' }, { folder: 'technical' }, { filename: 'x.xlsx' }, { label: 'x' }]) {
      const res = await tech.patch(`${base}/${w.financialFile.id}`).send(body);
      expect([res.status, res.body.error.code]).toEqual([403, 'financial_restricted']);
    }
    expect((await tech.delete(`${base}/${w.financialFile.id}`)).status).toBe(403);
    expect(await dbFor(w.org).get('file', w.financialFile.id)).toMatchObject({ folder: 'financial', confidentiality: 'financial', deleted_at: null, filename: 'Οικονομική προσφορά.xlsx' });
    expect(await dbFor(w.org).get('file', w.normalFile.id)).toMatchObject({ folder: 'technical', confidentiality: 'normal' });
  });

  it('folder=financial forces confidentiality; a file elsewhere can be marked financial; leaving the folder keeps it confidential', async () => {
    const w = await withFiles();
    const fin = await as(w.financialMember);
    const base = `/api/tenders/${w.tender.id}/files`;
    const contradiction = await upload(fin, w.tender, 'x', 'x.pdf', { folder: 'financial', confidentiality: 'normal' });
    expect([contradiction.status, contradiction.body.error.code]).toEqual([422, 'financial_folder_confidential']);

    const marked = await upload(fin, w.tender, 'κοστολόγηση', 'costing.xlsx', { folder: 'other', confidentiality: 'financial' });
    expect(marked.body.items[0]).toMatchObject({ folder: 'other', confidentiality: 'financial' });
    expect((await (await as(w.technicalMember)).get(`${base}/${marked.body.items[0].id}`)).status).toBe(403);

    // move out of the financial folder: still confidential unless explicitly declassified
    const movedOut = await fin.patch(`${base}/${w.financialFile.id}`).send({ folder: 'other' });
    expect(movedOut.body).toMatchObject({ folder: 'other', confidentiality: 'financial' });
    expect((await (await as(w.viewerMember)).get(`${base}/${w.financialFile.id}/download`)).status).toBe(403);
    const backIn = await fin.patch(`${base}/${w.financialFile.id}`).send({ folder: 'financial', confidentiality: 'normal' });
    expect([backIn.status, backIn.body.error.code]).toEqual([422, 'financial_folder_confidential']);
    const declassified = await fin.patch(`${base}/${w.financialFile.id}`).send({ confidentiality: 'normal' });
    expect(declassified.body).toMatchObject({ folder: 'other', confidentiality: 'normal' });
    expect((await (await as(w.viewerMember)).get(`${base}/${w.financialFile.id}`)).status).toBe(200);

    // a bid manager moves someone's normal file into the financial folder → it disappears for the uploader
    const moved = await (await as(w.bidManager)).patch(`${base}/${w.normalFile.id}`).send({ folder: 'financial' });
    expect(moved.body).toMatchObject({ folder: 'financial', confidentiality: 'financial' });
    const tech = await as(w.technicalMember);
    expect((await tech.get(`${base}/${w.normalFile.id}`)).status).toBe(403);
    expect(JSON.stringify((await tech.get(base)).body)).not.toContain(w.normalFile.id);
  });

  it('losing the role or the membership removes access immediately (checked on every request)', async () => {
    const w = await withFiles();
    const api = await as(w.financialMember);
    const url = `/api/tenders/${w.tender.id}/files/${w.financialFile.id}/download`;
    expect((await api.get(url)).status).toBe(200);
    const db = dbFor(w.org);
    const [membership] = await db.list('tender_member', { tender_id: w.tender.id, user_id: w.financialMember.id });
    await db.update('tender_member', membership?.id, { tender_role_key: 'B' });
    expect((await api.get(url)).status).toBe(403);
    await db.remove('tender_member', membership?.id);
    expect((await api.get(url)).status).toBe(403);
    expect((await api.get(`/api/tenders/${w.tender.id}/files`)).status).toBe(403);
  });
});

describe('tender files — rename, move, delete', () => {
  it('the uploader, a bid manager or an admin rename/move/delete; other members cannot', async () => {
    const w = await world();
    const owner = await as(w.plainMember);
    const base = `/api/tenders/${w.tender.id}/files`;
    const { id } = (await upload(owner, w.tender, 'draft', 'draft.docx', { folder: 'other' })).body.items[0];

    const colleague = await as(w.technicalMember);
    const refused = await colleague.patch(`${base}/${id}`).send({ folder: 'technical' });
    expect([refused.status, refused.body.error.code]).toEqual([403, 'file_not_owner']);
    expect((await colleague.delete(`${base}/${id}`)).status).toBe(403);

    const renamed = await owner.patch(`${base}/${id}`).send({ filename: '../Υπεύθυνη δήλωση.docx', label: ' Προς υπογραφή ', folder: 'participation' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ filename: 'Υπεύθυνη δήλωση.docx', label: 'Προς υπογραφή', folder: 'participation', confidentiality: 'normal' });
    expect((await owner.patch(`${base}/${id}`).send({ label: '' })).body.label).toBeNull();
    for (const body of [{ folder: 'x' }, { filename: '' }, { storage_key: 'a/b/c' }, { tender_id: w.otherTender.id }, { sha256: 'x' }]) {
      expect((await owner.patch(`${base}/${id}`).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    // the blob never moves: the key is independent of name and folder
    expect(await dbFor(w.org).get('file', id)).toMatchObject({ storage_key: `${w.org.id}/${w.tender.id}/${id}` });
    expect((await (await as(w.bidManager)).patch(`${base}/${id}`).send({ folder: 'clarifications' })).body.folder).toBe('clarifications');

    expect((await (await as(w.admin)).delete(`${base}/${id}`)).status).toBe(204);
    expect(await blobs(w.org, w.tender)).toEqual([]);
    const row = await dbFor(w.org).get('file', id);
    expect(row?.deleted_at).toBeInstanceOf(Date);
    expect(row?.enc).toBeNull();
    for (const res of [await owner.get(`${base}/${id}`), await owner.get(`${base}/${id}/download`), await owner.patch(`${base}/${id}`).send({ label: 'x' }), await owner.delete(`${base}/${id}`)]) {
      expect(res.status).toBe(404);
    }
    expect((await owner.get(base)).body.items).toEqual([]);
    expect((await owner.get(`${base}/${missingId()}`)).status).toBe(404);
    expect((await owner.get(`${base}/not-a-uuid/download`)).status).toBe(404);
  });

  it('a viewer is read-only: lists and downloads normal files, cannot upload, change or delete', async () => {
    const w = await world();
    const { id } = (await upload(await as(w.plainMember), w.tender, 'spec', 'spec.pdf')).body.items[0];
    const viewer = await as(w.viewerMember);
    const base = `/api/tenders/${w.tender.id}/files`;
    expect((await viewer.get(base)).body.items).toHaveLength(1);
    expect((await download(viewer, `${base}/${id}/download`)).status).toBe(200);
    const before = await blobs(w.org, w.tender);
    expect((await upload(viewer, w.tender, 'x', 'x.pdf')).status).toBe(403);
    expect((await viewer.patch(`${base}/${id}`).send({ label: 'x' })).status).toBe(403);
    expect((await viewer.delete(`${base}/${id}`)).status).toBe(403);
    expect(await blobs(w.org, w.tender)).toEqual(before);
  });

  it('files stay usable on a closed tender', async () => {
    const w = await world();
    await dbFor(w.org).update('tender', w.tender.id, { status: 'submitted', closed_at: new Date() });
    const api = await as(w.plainMember);
    const res = await upload(api, w.tender, 'receipt', 'apodeixi-ypovolis.pdf', { folder: 'other' });
    expect(res.status).toBe(201);
    expect((await api.delete(`/api/tenders/${w.tender.id}/files/${res.body.items[0].id}`)).status).toBe(204);
  });
});

describe('tender files — isolation', () => {
  it('another organization never reaches a file, by any endpoint; unauthenticated requests get 401', async () => {
    const w = await world();
    const { id } = (await upload(await as(w.financialMember), w.tender, 'prices', 'prices.xlsx', { folder: 'financial' })).body.items[0];
    const { id: normalId } = (await upload(await as(w.plainMember), w.tender, 'spec', 'spec.pdf')).body.items[0];

    const org2 = await createOrg();
    const foreignAdmin = await createUser(org2, 'admin');
    const foreignTender = await createTender(org2);
    const foreign = await as(foreignAdmin);
    for (const fileId of [id, normalId]) {
      // through the real tender: the tender does not exist for them
      const base = `/api/tenders/${w.tender.id}/files`;
      for (const res of [
        await foreign.get(base),
        await foreign.get(`${base}/${fileId}`),
        await foreign.get(`${base}/${fileId}/download`),
        await foreign.patch(`${base}/${fileId}`).send({ label: 'x' }),
        await foreign.delete(`${base}/${fileId}`),
        await upload(foreign, w.tender, 'x', 'x.pdf'),
      ]) {
        expect(res.status).toBe(404);
      }
      // through their own tender: the file does not exist for them
      const own = `/api/tenders/${foreignTender.id}/files`;
      for (const res of [await foreign.get(`${own}/${fileId}`), await foreign.get(`${own}/${fileId}/download`), await foreign.patch(`${own}/${fileId}`).send({ label: 'x' }), await foreign.delete(`${own}/${fileId}`)]) {
        expect(res.status).toBe(404);
      }
    }
    expect((await foreign.get(`/api/tenders/${foreignTender.id}/files`)).body.items).toEqual([]);
    // their uploads land in their own org folder
    const mine = await upload(foreign, foreignTender, 'theirs', 'theirs.pdf');
    expect(await dbFor(org2).get('file', mine.body.items[0].id)).toMatchObject({ storage_key: `${org2.id}/${foreignTender.id}/${mine.body.items[0].id}` });
    expect(await blobs(org2)).toEqual([mine.body.items[0].id]);
    expect(await blobs(w.org, w.tender)).toHaveLength(2);
    expect(await dbFor(w.org).count('file', { deleted_at: null })).toBe(2);
  });

  it('no session → 401 before anything is read or written', async () => {
    const w = await world();
    const { id } = (await upload(await as(w.plainMember), w.tender, 'spec', 'spec.pdf')).body.items[0];
    const { anon } = await import('../../test/harness.js');
    expect((await anon().get(`/api/tenders/${w.tender.id}/files/${id}/download`)).status).toBe(401);
    expect((await anon().get(`/api/tenders/${w.tender.id}/files`)).status).toBe(401);
    expect((await anon().post(`/api/tenders/${w.tender.id}/files`).attach('file', Buffer.from('x'), 'x.pdf')).status).toBe(401);
    expect(await blobs(w.org, w.tender)).toHaveLength(1);
  });
});
