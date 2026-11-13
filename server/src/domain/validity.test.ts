import { describe, expect, it } from 'vitest';
import { expiredOnT, expiringWithin, guaranteeRequiredUntil, guaranteeWarning } from './validity.js';

describe('R15 — document validity', () => {
  const docs = [
    { id: 'iso', expires_at: '2027-05-06' },
    { id: 'tax', expires_at: '2027-05-07' },
    { id: 'gemi', expires_at: '2027-12-31' },
    { id: 'cv', expires_at: null },
  ];

  it('expiredOnT: expires_at strictly before T is red; expiring on T itself is still valid', () => {
    expect(expiredOnT(docs, '2027-05-07').map((d) => d.id)).toEqual(['iso']);
    expect(expiredOnT(docs, '2027-05-08').map((d) => d.id)).toEqual(['iso', 'tax']);
    expect(expiredOnT(docs, '2027-01-01')).toEqual([]);
    expect(expiredOnT([], '2027-05-07')).toEqual([]);
  });

  it('after an extension the same documents are re-evaluated against the new T', () => {
    expect(expiredOnT(docs, '2027-05-07').map((d) => d.id)).toEqual(['iso']);
    expect(expiredOnT(docs, '2027-05-14').map((d) => d.id)).toEqual(['iso', 'tax']);
  });

  it('expiringWithin: documents expiring in ≤ 30 days (admin digest), expired ones included', () => {
    expect(expiringWithin(docs, '2027-04-07').map((d) => d.id)).toEqual(['iso', 'tax']); // 29 and 30 days ahead
    expect(expiringWithin(docs, '2027-04-06').map((d) => d.id)).toEqual(['iso']);
    expect(expiringWithin(docs, '2027-06-01', 30).map((d) => d.id)).toEqual(['iso', 'tax']);
    expect(expiringWithin(docs, '2027-04-06', 300).map((d) => d.id)).toEqual(['iso', 'tax', 'gemi']);
  });
});

describe('R16 — participation guarantee validity', () => {
  // T = 07/05/2027 (15:00 Athens). Offer validity 180 days, margin 30 → required until T + 210 days = 03/12/2027.
  const base = { submission_deadline_at: '2027-05-07T12:00:00Z', offer_validity_days: 180, guarantee_margin_days: 30 };

  it('computes the required date in calendar days from T (Athens date)', () => {
    expect(guaranteeRequiredUntil(base)).toBe('2027-12-03');
    expect(guaranteeRequiredUntil({ ...base, guarantee_margin_days: 0 })).toBe('2027-11-03');
    expect(guaranteeRequiredUntil({ ...base, guarantee_margin_days: undefined })).toBe('2027-12-03'); // default 30
    expect(guaranteeRequiredUntil({ ...base, submission_deadline_at: new Date('2027-05-07T21:30:00Z') })).toBe('2027-12-04'); // T is 08/05 in Athens
  });

  it('warns only when valid_until < required', () => {
    expect(guaranteeWarning({ ...base, guarantee_valid_until: '2027-12-03' })).toBeNull();
    expect(guaranteeWarning({ ...base, guarantee_valid_until: '2028-01-31' })).toBeNull();
    expect(guaranteeWarning({ ...base, guarantee_valid_until: '2027-12-02' })).toEqual({
      requiredUntil: '2027-12-03',
      validUntil: '2027-12-02',
      shortByDays: 1,
    });
    expect(guaranteeWarning({ ...base, guarantee_valid_until: '2027-11-03' })?.shortByDays).toBe(30);
  });

  it('an extension of T can turn a valid guarantee into a warning', () => {
    const guarantee = { ...base, guarantee_valid_until: '2027-12-05' };
    expect(guaranteeWarning(guarantee)).toBeNull();
    expect(guaranteeWarning({ ...guarantee, submission_deadline_at: '2027-05-14T12:00:00Z' })).toMatchObject({ requiredUntil: '2027-12-10', shortByDays: 5 });
  });

  it('returns null while the inputs are not filled in', () => {
    expect(guaranteeWarning({ ...base, guarantee_valid_until: null })).toBeNull();
    expect(guaranteeWarning({ ...base, offer_validity_days: null, guarantee_valid_until: '2027-06-01' })).toBeNull();
  });
});
