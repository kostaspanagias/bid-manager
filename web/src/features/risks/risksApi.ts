/**
 * Risk register of a tender (server: server/src/modules/risks/routes.ts).
 *
 *   GET    /api/tenders/:id/risks                 → { items: RiskView[] }
 *   POST   /api/tenders/:id/risks                 { title, trigger?, mitigation?, owner_user_id?, status? } → RiskView
 *   PATCH  /api/tenders/:id/risks/:riskId         any of the above → RiskView
 *   DELETE /api/tenders/:id/risks/:riskId         → 204
 *   POST   /api/tenders/:id/risks/seed-defaults   → { added, items } — the six usual risks of the blueprint, idempotent
 *                                                   (bid manager / admin)
 */
import { api, type ListResponse } from '@/api/client';
import type { ID, RiskStatus } from '@/api/types';
import { tenderKeys } from '@/features/tenders/tenderApi';

export interface RiskView {
  id: ID;
  tender_id: ID;
  title: string;
  /** έγκαιρη ένδειξη */
  trigger: string | null;
  /** αντίδραση */
  mitigation: string | null;
  owner_user_id: ID | null;
  status: RiskStatus;
  is_default: boolean;
}

export type RiskInput = Partial<Pick<RiskView, 'title' | 'trigger' | 'mitigation' | 'owner_user_id' | 'status'>>;

export const risksKeys = { list: (tenderId: ID) => [...tenderKeys.detail(tenderId), 'risks'] as const };

export const listRisks = (tenderId: ID) => api.get<ListResponse<RiskView>>(`/tenders/${tenderId}/risks`).then((r) => r.items);
export const createRisk = (tenderId: ID, body: RiskInput) => api.post<RiskView>(`/tenders/${tenderId}/risks`, body);
export const updateRisk = (tenderId: ID, riskId: ID, body: RiskInput) => api.patch<RiskView>(`/tenders/${tenderId}/risks/${riskId}`, body);
export const deleteRisk = (tenderId: ID, riskId: ID) => api.del(`/tenders/${tenderId}/risks/${riskId}`);
export const seedDefaultRisks = (tenderId: ID) => api.post<{ added: number; items: RiskView[] }>(`/tenders/${tenderId}/risks/seed-defaults`);
