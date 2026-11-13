import { describe, expect, it } from 'vitest';
import { canonicalCode, codeNumber, nextCode } from './codes.js';

describe('R17 — requirement codes', () => {
  it('collapses every spelling of the same code to ΥΠ-nnn with Greek letters and at least three digits', () => {
    const greek = 'ΥΠ-001';
    expect([...greek].map((c) => c.codePointAt(0))).toEqual([0x3a5, 0x3a0, 0x2d, 0x30, 0x30, 0x31]);
    for (const spelling of ['ΥΠ-001', 'YΠ-1', 'υπ 001', 'ύπ-01', 'YP-1', 'yp_001', 'ΥΠ–1', 'ΥΠ.001', ' ΥΠ - 1 ', 'ΥΠ001', '1', '001', 1, 'ΥΠ-1']) {
      expect(canonicalCode(spelling), String(spelling)).toBe(greek);
    }
    expect(canonicalCode('υπ-12')).toBe('ΥΠ-012');
    expect(canonicalCode('ΥΠ-1000')).toBe('ΥΠ-1000');
    expect(canonicalCode('YP 0123')).toBe('ΥΠ-123');
  });

  it('rejects what is not a requirement code', () => {
    for (const bad of ['', '  ', 'ΥΠ-', 'ΥΠ-0', 'ΥΠ-1α', 'ΑΠ-001', 'ΥΠ-1.5x', 'REQ-1', 'ΥΠ-12345678', null, undefined, {}, 'ΥΠ--x']) {
      expect(canonicalCode(bad), String(bad)).toBeNull();
    }
  });

  it('suggests the code after the highest one in use', () => {
    expect(nextCode([])).toBe('ΥΠ-001');
    expect(nextCode(['ΥΠ-001', 'ΥΠ-007', 'ΥΠ-003'])).toBe('ΥΠ-008');
    expect(nextCode(['YΠ-9', 'legacy'])).toBe('ΥΠ-010');
    expect(nextCode(['ΥΠ-999'])).toBe('ΥΠ-1000');
    expect(codeNumber('υπ 042')).toBe(42);
    expect(codeNumber('x')).toBeNull();
  });
});
