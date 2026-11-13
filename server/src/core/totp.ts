import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { decryptSecret, encryptSecret } from './crypto.js';

const ISSUER = 'Bid Manager';
const PERIOD = 30;

export function newTotpSecret(): string {
  return generateSecret();
}

/** TOTP secrets are stored encrypted (AES-256-GCM, key derived from FILE_ENCRYPTION_KEY). */
export const sealTotpSecret = (secret: string): string => encryptSecret(secret, 'totp');
export const openTotpSecret = (stored: string): string => decryptSecret(stored, 'totp');

export async function totpEnrolment(email: string, secret: string): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret });
  return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }) };
}

/**
 * Verifies a 6-digit code with ±1 period of clock drift. `lastStep` is the time step of the last code this user
 * successfully used: codes from that step or earlier are rejected (replay protection). Returns the matched time
 * step, or null when the code is wrong.
 */
export async function verifyTotp(secret: string, code: string, lastStep: number | null, epoch?: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const result = await verify({
      secret,
      token: code,
      period: PERIOD,
      epochTolerance: PERIOD,
      ...(epoch !== undefined ? { epoch } : {}),
      ...(lastStep !== null ? { afterTimeStep: lastStep } : {}),
    });
    if (!result.valid) return null;
    const now = epoch ?? Math.floor(Date.now() / 1000);
    return Math.floor(now / PERIOD) + result.delta;
  } catch {
    return null;
  }
}
