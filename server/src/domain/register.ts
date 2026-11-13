// R17: register coverage = (covered + verified) / total, per requirement type.

export const REQUIREMENT_TYPES = ['exclusion', 'scored', 'formal'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];
export const REQUIREMENT_STATUSES = ['open', 'in_progress', 'covered', 'verified', 'deviation'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface Coverage {
  total: number;
  /** Rows whose status is covered or verified. */
  covered: number;
  /** covered / total in [0, 1]; null when there are no rows of this type. */
  ratio: number | null;
}
export type CoverageByType = Record<RequirementType | 'all', Coverage>;

const COVERED: ReadonlySet<string> = new Set(['covered', 'verified']);

export function coverageByType(rows: Iterable<{ type: string; status: string }>): CoverageByType {
  const mk = (): Coverage => ({ total: 0, covered: 0, ratio: null });
  const out: CoverageByType = { exclusion: mk(), scored: mk(), formal: mk(), all: mk() };
  for (const row of rows) {
    const buckets = [out.all];
    if ((REQUIREMENT_TYPES as readonly string[]).includes(row.type)) buckets.push(out[row.type as RequirementType]);
    for (const b of buckets) {
      b.total++;
      if (COVERED.has(row.status)) b.covered++;
    }
  }
  for (const b of Object.values(out)) b.ratio = b.total === 0 ? null : b.covered / b.total;
  return out;
}
