import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe random token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison (hashes both sides first so length does not leak either). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Purpose-bound 32-byte subkey of FILE_ENCRYPTION_KEY (HKDF-SHA256). */
export function deriveKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', config.fileEncryptionKey, Buffer.alloc(0), `bid-manager:${purpose}`, 32));
}

/** AES-256-GCM for small secrets kept in the database (TOTP secrets). Output: v1.iv.tag.ciphertext (base64url). */
export function encryptSecret(plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(purpose), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(value: string, purpose: string): string {
  const [version, iv, tag, data] = value.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
