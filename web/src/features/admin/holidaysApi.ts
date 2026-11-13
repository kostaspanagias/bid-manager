/**
 * Admin → holidays (mutations). Reading is shared: features/shared/holidaysApi.ts.
 *
 *   POST   /api/holidays        { date: 'YYYY-MM-DD', name } → the holiday (source = 'manual')
 *   PATCH  /api/holidays/:id    { date?, name? }             → the holiday (move / rename)
 *   DELETE /api/holidays/:id                                 → 204
 *   POST   /api/holidays/seed   { year }                     → anything (list is refetched)
 */
import { api } from '@/api/client';
import type { DateString, ID } from '@/api/types';

export { fetchHolidays, holidaysKeys } from '@/features/shared/holidaysApi';

export function createHoliday(input: { date: DateString; name: string }): Promise<unknown> {
  return api.post('/holidays', input);
}

export function updateHoliday(id: ID, patch: { date?: DateString; name?: string }): Promise<unknown> {
  return api.patch(`/holidays/${id}`, patch);
}

export function deleteHoliday(id: ID): Promise<void> {
  return api.del(`/holidays/${id}`);
}

export function seedHolidays(year: number): Promise<unknown> {
  return api.post('/holidays/seed', { year });
}
