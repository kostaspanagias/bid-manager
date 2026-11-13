import argon2 from 'argon2';
import { config } from '../config.js';

// Argon2id. Production parameters follow the OWASP baseline (19 MiB, t=2, p=1); tests use the cheapest
// parameters so suites stay fast.
const OPTIONS: argon2.HashOptions = config.isTest
  ? { type: argon2.argon2id, memoryCost: 1024, timeCost: 2, parallelism: 1 }
  : { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password. When there is no hash (unknown e-mail, inactive user, user without password) it still
 * burns the same Argon2 work against a dummy hash, so response time does not reveal whether the account exists.
 */
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
