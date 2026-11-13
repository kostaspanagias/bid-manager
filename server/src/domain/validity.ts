import { daysBetween, shiftDays } from './calendar.js';
import { athensDate } from './time.js';

/**
 * R15: the documents that are no longer valid on submission day — `expires_at` strictly before T.
 * A document expiring exactly on T is still valid; documents without expiry never expire.
 */
export function expiredOnT<D extends { expires_at: string | null }>(docs: readonly D[], T: string): D[] {
  return docs.filter((d) => d.expires_at !== null && d.expires_at < T);
}

/** R15 (admin digest): documents expiring within `days` days from `today` (already expired ones included). */
export function expiringWithin<D extends { expires_at: string | null }>(docs: readonly D[], today: string, days = 30): D[] {
  const limit = shiftDays(today, days);
  return docs.filter((d) => d.expires_at !== null && d.expires_at <= limit);
}

export interface GuaranteeInput {
  submission_deadline_at: Date | string;
  guarantee_valid_until: string | null;
  offer_validity_days: number | null;
  guarantee_margin_days?: number | null;
}
export interface GuaranteeWarning {
  /** T + offer_validity_days + guarantee_margin_days (calendar days). */
  requiredUntil: string;
  validUntil: string;
  /** How many days the guarantee falls short (> 0). */
  shortByDays: number;
}

/** The date the participation guarantee must at least be valid until, or null when offer validity is unknown. */
export function guaranteeRequiredUntil(tender: GuaranteeInput): string | null {
  if (tender.offer_validity_days == null) return null;
  const T = athensDate(tender.submission_deadline_at);
  return shiftDays(T, tender.offer_validity_days + (tender.guarantee_margin_days ?? 30));
}

/**
 * R16: warning when guarantee_valid_until < T + offer_validity_days + margin (margin: per tender, default 30).
 * Returns null when there is nothing to warn about, including when the inputs are not filled in yet.
 */
export function guaranteeWarning(tender: GuaranteeInput): GuaranteeWarning | null {
  const requiredUntil = guaranteeRequiredUntil(tender);
  if (requiredUntil === null || tender.guarantee_valid_until == null) return null;
  if (tender.guarantee_valid_until >= requiredUntil) return null;
  return {
    requiredUntil,
    validUntil: tender.guarantee_valid_until,
    shortByDays: daysBetween(tender.guarantee_valid_until, requiredUntil),
  };
}
