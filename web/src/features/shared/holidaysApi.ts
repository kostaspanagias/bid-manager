import { api, type ListResponse } from '@/api/client';
import type { Holiday } from '@/api/types';

export const holidaysKeys = {
  all: ['holidays'] as const,
  year: (year: number) => ['holidays', year] as const,
};

/** Assumed: GET /api/holidays?year=2027 → { items: [{ id, date: 'YYYY-MM-DD', name, source }] } (any role). */
export function fetchHolidays(year: number): Promise<Holiday[]> {
  return api.get<ListResponse<Holiday>>('/holidays', { query: { year } }).then((r) => r.items);
}
