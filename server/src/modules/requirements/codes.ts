// R17 — requirement codes. The canonical form is `ΥΠ-nnn`: Greek capital upsilon + pi, a hyphen and the number
// zero-padded to at least three digits. Everything a person or a tool may plausibly type for the same row
// ("YΠ-1" with a Latin Y, "υπ 001", "YP_01", "1") collapses to that one form, so it can never become a second row.

export const CODE_PREFIX = 'ΥΠ';
const MAX_NUMBER = 999_999;

/** Latin capitals that look like (or are typed instead of) the two Greek letters of the prefix. */
const TO_GREEK: Record<string, string> = { Y: 'Υ', P: 'Π' };

/** Canonical `ΥΠ-nnn` for any accepted spelling, or `null` when the input is not a requirement code. */
export function canonicalCode(input: unknown): string | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const raw = String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents (ύ → υ)
    .toUpperCase()
    .replace(/[YP]/g, (c) => TO_GREEK[c] as string)
    .replace(/[\s ._\-‐-―−/#:]+/g, ''); // spacing and separators
  const m = /^(?:ΥΠ)?(\d{1,9})$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) return null;
  return formatCode(n);
}

export function formatCode(n: number): string {
  return `${CODE_PREFIX}-${String(n).padStart(3, '0')}`;
}

/** The number of a canonical (or canonicalisable) code; null otherwise. */
export function codeNumber(code: unknown): number | null {
  const canonical = canonicalCode(code);
  return canonical ? Number(canonical.slice(CODE_PREFIX.length + 1)) : null;
}

/** Next free code: one after the highest number in use (gaps are not refilled, so codes stay in reading order). */
export function nextCode(existing: Iterable<string>): string {
  let max = 0;
  for (const code of existing) {
    const n = codeNumber(code);
    if (n !== null && n > max) max = n;
  }
  return formatCode(Math.min(max + 1, MAX_NUMBER));
}
