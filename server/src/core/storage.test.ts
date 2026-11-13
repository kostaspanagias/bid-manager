import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage, StorageError, storageKey, verify, type EncMeta } from './storage.js';

let root: string;
let storage: LocalDiskStorage;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bm-storage-test-'));
  storage = new LocalDiskStorage(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const newKey = (tender: string | null = randomUUID()) => storageKey(randomUUID(), tender, randomUUID());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('storageKey', () => {
  it('is {org}/{tender|org}/{file} and accepts uuids only (tenant rule 4)', () => {
    const [org, tender, file] = [randomUUID(), randomUUID(), randomUUID()];
    expect(storageKey(org, tender, file)).toBe(`${org}/${tender}/${file}`);
    expect(storageKey(org, null, file)).toBe(`${org}/org/${file}`);
    for (const bad of ['../etc', 'offer.pdf', '', `${file}/..`, 'org']) {
      expect(() => storageKey(org, tender, bad)).toThrow(StorageError);
      expect(() => storageKey(org, bad, file)).toThrow(StorageError);
      expect(() => storageKey(bad, tender, file)).toThrow(StorageError);
    }
  });
});

describe('LocalDiskStorage', () => {
  it('round-trips a buffer and a multi-chunk stream; reports plaintext size and sha256', async () => {
    const small = Buffer.from('Οικονομική προσφορά: 1.234.567,89 €', 'utf8');
    const k1 = newKey();
    const r1 = await storage.put(k1, small);
    expect(r1).toMatchObject({ size: small.length, sha256: sha(small), enc: { v: 1, alg: 'aes-256-gcm' } });
    expect((await read(await storage.get(k1, r1.enc))).equals(small)).toBe(true);

    const big = randomBytes(3 * 1024 * 1024 + 17);
    const k2 = newKey(null);
    const r2 = await storage.put(k2, Readable.from([big.subarray(0, 1000), big.subarray(1000, 2_000_000), big.subarray(2_000_000)]));
    expect(r2.size).toBe(big.length);
    expect(r2.sha256).toBe(sha(big));
    expect((await read(await storage.get(k2, r2.enc))).equals(big)).toBe(true);
    expect(await verify(storage, k2, r2.enc)).toEqual({ size: big.length, sha256: sha(big) });

    const empty = await storage.put(newKey(), Buffer.alloc(0));
    expect(empty.size).toBe(0);
  });

  it('writes only ciphertext, at {root}/{org}/{tender}/{file}, with a fresh IV per file and no temp files left', async () => {
    const plain = Buffer.from('SECRET-PRICE-LIST '.repeat(500));
    const key = newKey();
    const a = await storage.put(key, plain);
    const onDisk = await readFile(path.join(root, ...key.split('/')));
    expect(onDisk.length).toBe(plain.length); // GCM is a stream cipher: no padding, tag kept in the database
    expect(onDisk.includes(Buffer.from('SECRET-PRICE-LIST'))).toBe(false);
    const b = await storage.put(newKey(), plain);
    expect(b.enc.iv).not.toBe(a.enc.iv);
    expect(await readdir(path.dirname(path.join(root, ...key.split('/'))))).toEqual([key.split('/')[2]]);
  });

  it('detects tampering: modified, truncated or extended ciphertext, wrong tag/IV, a blob moved to another key', async () => {
    const plain = randomBytes(200_000);
    const key = newKey();
    const { enc } = await storage.put(key, plain);
    const file = path.join(root, ...key.split('/'));
    const original = await readFile(file);

    const flipped = Buffer.from(original);
    flipped[1234] = (flipped[1234] as number) ^ 0x01;
    const cases: [string, Buffer][] = [
      ['one flipped bit', flipped],
      ['truncated', original.subarray(0, original.length - 1)],
      ['extended', Buffer.concat([original, Buffer.from([0])])],
    ];
    for (const [name, content] of cases) {
      await writeFile(file, content);
      await expect(read(await storage.get(key, enc)), name).rejects.toMatchObject({ name: 'StorageError', code: 'tampered' });
      await expect(verify(storage, key, enc), name).rejects.toMatchObject({ code: 'tampered' });
    }
    await writeFile(file, original);
    expect((await read(await storage.get(key, enc))).equals(plain)).toBe(true);

    const otherTag: EncMeta = { ...enc, tag: randomBytes(16).toString('base64') };
    await expect(read(await storage.get(key, otherTag))).rejects.toMatchObject({ code: 'tampered' });
    const otherIv: EncMeta = { ...enc, iv: randomBytes(12).toString('base64') };
    await expect(read(await storage.get(key, otherIv))).rejects.toMatchObject({ code: 'tampered' });

    // The key is authenticated too: the same bytes under another file's path do not decrypt.
    const moved = newKey();
    const movedPath = storage.pathOf(moved);
    await storage.put(moved, Buffer.from('x'));
    await rename(file, movedPath);
    await expect(read(await storage.get(moved, enc))).rejects.toMatchObject({ code: 'tampered' });
  });

  it('a different encryption key cannot read the data', async () => {
    const key = newKey();
    const { enc } = await storage.put(key, Buffer.from('confidential'));
    const stranger = new LocalDiskStorage(root, randomBytes(32));
    await expect(read(await stranger.get(key, enc))).rejects.toMatchObject({ code: 'tampered' });
  });

  it('rejects bad metadata and missing objects clearly', async () => {
    const key = newKey();
    const { enc } = await storage.put(key, Buffer.from('abc'));
    for (const bad of [null, undefined, {}, { ...enc, alg: 'none' }, { ...enc, iv: 'AAAA' }, { ...enc, tag: '' }, { ...enc, v: 2 }]) {
      await expect(storage.get(key, bad)).rejects.toMatchObject({ code: 'bad_metadata' });
    }
    await expect(storage.get(newKey(), enc)).rejects.toMatchObject({ code: 'missing' });
  });

  it('never resolves a key outside its root', async () => {
    const id = randomUUID();
    for (const bad of ['../outside', `${id}/../../x`, `/etc/passwd`, `${id}/${id}`, `${id}/${id}/${id}/extra`, `${id}/${id}/offer.pdf`, `${id}\\${id}\\${id}`, '']) {
      expect(() => storage.pathOf(bad), bad).toThrow(StorageError);
      await expect(storage.put(bad, Buffer.from('x')), bad).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(storage.delete(bad), bad).rejects.toMatchObject({ code: 'invalid_key' });
    }
    expect(existsSync(path.join(root, '..', 'outside'))).toBe(false);
  });

  it('delete removes the blob, is idempotent, and tidies the empty folder', async () => {
    const key = newKey();
    await storage.put(key, Buffer.from('bye'));
    const file = storage.pathOf(key);
    expect(existsSync(file)).toBe(true);
    await storage.delete(key);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.dirname(file))).toBe(false);
    await storage.delete(key);
    await storage.delete(newKey());
  });
});
