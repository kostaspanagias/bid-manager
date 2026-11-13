import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { deriveKey } from './crypto.js';

// File storage (spec: "Αρχεία" — outside the web root, encrypted at rest, sha256 for integrity; tenant rule 4).
//
// Callers only ever see the `Storage` interface: put / get / delete by an opaque key. The key is built by
// `storageKey()` from ids that come from the session and the database ({org_id}/{tender_id|org}/{file_id}) — never
// from user input; the original filename lives only in the `file` table. An S3-compatible implementation only has
// to implement the same three methods (and may keep its own fields in `enc`); nothing else changes.

/** Encryption metadata persisted in `file.enc`. Implementations may add fields; callers treat it as opaque. */
export interface EncMeta {
  v: 1;
  alg: 'aes-256-gcm';
  /** base64 — random per file */
  iv: string;
  /** base64 — GCM authentication tag */
  tag: string;
}

export interface PutResult {
  /** Plaintext size in bytes. */
  size: number;
  /** Hex sha256 of the plaintext, computed while streaming. */
  sha256: string;
  enc: EncMeta;
}

export interface Storage {
  /** Stores the content under `key` (replacing nothing: keys are unique per file). Streams; never buffers the file. */
  put(key: string, data: Readable | Buffer): Promise<PutResult>;
  /**
   * Plaintext stream of a stored object. The stream fails with a `StorageError` ('tampered') when the content or
   * the metadata was modified; because GCM authenticates at the end, consume the whole stream before trusting it
   * (see `verify`). Throws `StorageError` ('missing') when there is no such object.
   */
  get(key: string, enc: unknown): Promise<Readable>;
  /** Removes the object. Removing something that does not exist is not an error (idempotent). */
  delete(key: string): Promise<void>;
}

export type StorageErrorCode = 'invalid_key' | 'missing' | 'tampered' | 'bad_metadata';
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^${UUID}/(?:${UUID}|org)/${UUID}$`);
const UUID_RE = new RegExp(`^${UUID}$`);

/**
 * The storage key of a file: `{org_id}/{tender_id}/{file_id}`, or `{org_id}/org/{file_id}` for organization-level
 * files (company documents). All three parts must be uuids — anything else throws, so a key can never be made
 * from a filename or another user-controlled string.
 */
export function storageKey(orgId: string, tenderId: string | null, fileId: string): string {
  const parts = [orgId, tenderId ?? 'org', fileId].map((p) => String(p).toLowerCase());
  if (!UUID_RE.test(parts[0] as string) || !UUID_RE.test(parts[2] as string) || (tenderId !== null && !UUID_RE.test(parts[1] as string))) {
    throw new StorageError('invalid_key', 'Storage keys are built from uuids only');
  }
  return parts.join('/');
}

function parseEnc(enc: unknown): { iv: Buffer; tag: Buffer } {
  const e = (enc ?? {}) as Partial<EncMeta>;
  if (e.v !== 1 || e.alg !== 'aes-256-gcm' || typeof e.iv !== 'string' || typeof e.tag !== 'string') {
    throw new StorageError('bad_metadata', 'Unsupported or missing encryption metadata');
  }
  const iv = Buffer.from(e.iv, 'base64');
  const tag = Buffer.from(e.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new StorageError('bad_metadata', 'Malformed encryption metadata');
  return { iv, tag };
}

/**
 * Local disk, AES-256-GCM per file: random 96-bit IV, key = HKDF(FILE_ENCRYPTION_KEY, 'files'), the storage key
 * as additional authenticated data (a blob moved to another path does not decrypt). Only ciphertext touches the
 * disk; IV and tag are returned for `file.enc`.
 */
export class LocalDiskStorage implements Storage {
  readonly root: string;
  private readonly key: Buffer;

  constructor(root: string, key: Buffer = deriveKey('files')) {
    this.root = path.resolve(root);
    if (key.length !== 32) throw new Error('LocalDiskStorage: the key must be 32 bytes');
    this.key = key;
  }

  /** Absolute path of a key — validated twice: by shape, and by staying inside the root. */
  pathOf(key: string): string {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new StorageError('invalid_key', 'Invalid storage key');
    const full = path.resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('invalid_key', 'Invalid storage key');
    return full;
  }

  async put(key: string, data: Readable | Buffer): Promise<PutResult> {
    const target = this.pathOf(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomUUID()}.part`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(key, 'utf8'));
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Buffer.isBuffer(data) ? Readable.from([data]) : data, meter, cipher, createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    return {
      size,
      sha256: hash.digest('hex'),
      enc: { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    };
  }

  async get(key: string, enc: unknown): Promise<Readable> {
    const file = this.pathOf(key);
    const { iv, tag } = parseEnc(enc);
    try {
      if (!(await stat(file)).isFile()) throw new StorageError('missing', 'Stored object is not a file');
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('missing', 'Stored object not found');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(key, 'utf8'));
    decipher.setAuthTag(tag);
    const source = createReadStream(file);
    // A generator keeps the two failure kinds apart: I/O errors of the read stream pass through unchanged, while
    // a failing GCM tag check (decipher.final()) becomes StorageError('tampered'). Closing the consumer early
    // closes the read stream too.
    async function* plaintext(): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        const plain = decipher.update(chunk as Buffer);
        if (plain.length > 0) yield plain;
      }
      let last: Buffer;
      try {
        last = decipher.final();
      } catch {
        throw new StorageError('tampered', 'Stored object failed authentication (modified, moved, or wrong key)');
      }
      if (last.length > 0) yield last;
    }
    return Readable.from(plaintext(), { objectMode: false });
  }

  async delete(key: string): Promise<void> {
    const target = this.pathOf(key);
    await rm(target, { force: true });
    // Tidy the now possibly empty {tender|org} directory; never the root. Failure (not empty) is expected.
    await rmdir(path.dirname(target)).catch(() => undefined);
  }
}

/**
 * Reads an object to the end and returns what was actually stored: plaintext size and sha256. Rejects with
 * `StorageError('tampered')` when the ciphertext does not authenticate. Used before a download is sent, so a
 * corrupted file produces an error response instead of a silently broken download.
 */
export async function verify(storage: Storage, key: string, enc: unknown): Promise<{ size: number; sha256: string }> {
  const stream = await storage.get(key, enc);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { size, sha256: hash.digest('hex') };
}

let current: Storage | undefined;

/**
 * The process-wide storage. Production/dev: FILE_STORAGE_DIR. Under NODE_ENV=test it never touches the configured
 * directory: a per-process folder in the OS temp dir is used unless a test installs its own with `setStorage()`.
 */
export function getStorage(): Storage {
  if (!current) {
    const root = config.isTest ? path.join(tmpdir(), `bid-manager-test-storage-${process.pid}`) : config.fileStorageDir;
    current = new LocalDiskStorage(root);
  }
  return current;
}

/** Replace the storage implementation (tests; or wiring an S3 implementation at startup). Returns the previous one. */
export function setStorage(storage: Storage | undefined): Storage | undefined {
  const previous = current;
  current = storage;
  return previous;
}
