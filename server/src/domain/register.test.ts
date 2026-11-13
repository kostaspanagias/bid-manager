import { describe, expect, it } from 'vitest';
import { coverageByType } from './register.js';

describe('R17 — register coverage = (covered + verified) / total, per type', () => {
  it('counts covered and verified only', () => {
    const rows = [
      { type: 'exclusion', status: 'covered' },
      { type: 'exclusion', status: 'verified' },
      { type: 'exclusion', status: 'open' },
      { type: 'exclusion', status: 'deviation' },
      { type: 'scored', status: 'in_progress' },
      { type: 'scored', status: 'verified' },
      { type: 'formal', status: 'covered' },
    ];
    const c = coverageByType(rows);
    expect(c.exclusion).toEqual({ total: 4, covered: 2, ratio: 0.5 });
    expect(c.scored).toEqual({ total: 2, covered: 1, ratio: 0.5 });
    expect(c.formal).toEqual({ total: 1, covered: 1, ratio: 1 });
    expect(c.all).toEqual({ total: 7, covered: 4, ratio: 4 / 7 });
  });

  it('a type without rows has ratio null (not 0 or 100%)', () => {
    const c = coverageByType([{ type: 'formal', status: 'open' }]);
    expect(c.exclusion).toEqual({ total: 0, covered: 0, ratio: null });
    expect(c.formal).toEqual({ total: 1, covered: 0, ratio: 0 });
    expect(coverageByType([]).all).toEqual({ total: 0, covered: 0, ratio: null });
  });

  it('rows of an unknown type count only in the total', () => {
    const c = coverageByType([{ type: 'weird', status: 'covered' }]);
    expect(c.all).toEqual({ total: 1, covered: 1, ratio: 1 });
    expect(c.exclusion.total + c.scored.total + c.formal.total).toBe(0);
  });
});
