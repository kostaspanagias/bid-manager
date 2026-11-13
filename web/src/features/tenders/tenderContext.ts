import { createContext, useContext } from 'react';
import type { ID, Tender } from '@/api/types';
import type { NextGate, TenderWarning } from './tenderApi';
import type { DateString } from '@/lib/dates';

export interface TenderContextValue {
  tender: Tender;
  tenderId: ID;
  /** T — Athens-local date of the submission deadline ('YYYY-MM-DD') */
  T: DateString;
  /** Working days from today to T (the n of "T−n"); negative after the deadline; null while loading */
  tMinus: number | null;
  /** The tender is still being worked on (status evaluation / in_progress) */
  isActive: boolean;
  /** The current user may change data of this tender (not a viewer, tender not closed). UI hint — server enforces. */
  canWrite: boolean;
  /** The current user may see financial-folder files (R18). UI hint — server enforces. */
  canSeeFinancial: boolean;
  /** Admin / bid manager: may edit basic fields, team, deadline, status and milestone dates. UI hint — server enforces. */
  canManage: boolean;
  /** Server-computed warnings (R7 late G0 target, R8 compressed / guarantee, R15 expired documents, R16 guarantee validity) */
  warnings: TenderWarning[];
  /** The next gate waiting for a decision, if any */
  nextGate: NextGate | null;
  /** Re-fetch the tender record (after changing deadline, status, flags…) */
  refetch: () => Promise<unknown>;
}

export const TenderContext = createContext<TenderContextValue | null>(null);

/**
 * Inside any tab under /tenders/:tenderId:
 *   const { tender, tenderId, T, tMinus, canWrite, refetch } = useTender();
 */
export function useTender(): TenderContextValue {
  const ctx = useContext(TenderContext);
  if (!ctx) throw new Error('useTender must be used inside TenderLayout (a /tenders/:tenderId route)');
  return ctx;
}
