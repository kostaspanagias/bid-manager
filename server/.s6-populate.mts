import { randomBytes, randomUUID } from 'node:crypto';
const base = '/home/user/bid-manager/server/src';
const { migrate } = await import(`${base}/db/migrate.ts`);
await migrate(process.env.DATABASE_URL!);
const { createOrganization, closeDatabase } = await import(`${base}/db/admin.ts`);
const { scopedDb } = await import(`${base}/db/scoped.ts`);
const { getStorage, storageKey, verify } = await import(`${base}/core/storage.ts`);
const mode = process.argv[2];
if (mode === 'populate') {
  const org = await createOrganization({ name: 'Backup test org' });
  const db = scopedDb(org.id, null);
  const user = await db.insert('user', { email: 'a@example.com', name: 'Admin', org_role: 'admin' });
  const tender = await db.insert('tender', { title: 'Διαγωνισμός', submission_deadline_at: new Date(Date.now() + 1e9) });
  for (const [tenderId, n] of [[tender.id, 5], [null, 2]] as const) {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const key = storageKey(org.id, tenderId, id);
      const r = await getStorage().put(key, randomBytes(1000 + i * 77777));
      await db.insert('file', { id, tender_id: tenderId, storage_key: key, filename: `f${i}.pdf`, size: r.size, sha256: r.sha256, enc: r.enc, uploaded_by: user.id, folder: i === 0 ? 'financial' : 'other', confidentiality: i === 0 ? 'financial' : 'normal' });
    }
  }
  console.log('populated', org.id);
} else {
  // verify: every file row decrypts from the (restored) storage to the recorded sha256
  const { listOrganizations } = await import(`${base}/db/admin.ts`);
  let ok = 0;
  for (const org of await listOrganizations()) {
    const db = scopedDb(org.id, null);
    for (const f of await db.list('file', {})) {
      const v = await verify(getStorage(), f.storage_key, f.enc);
      if (v.sha256 !== f.sha256 || v.size !== Number(f.size)) throw new Error(`mismatch ${f.id}`);
      ok++;
    }
  }
  console.log(`verified ${ok} files decrypt to their recorded sha256`);
}
await closeDatabase();
