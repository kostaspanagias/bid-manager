import type { TFunction } from 'i18next';
import { formatDate } from '@/lib/dates';
import type { DashboardWarning } from './dashboardApi';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const date = (v: unknown): string => (typeof v === 'string' ? formatDate(v) : '');

/** Short label for the badge on a tender card. */
export function warningBadge(t: TFunction<'dashboard'>, w: DashboardWarning): string {
  const p = w.params;
  return t(`warnings.${w.code}.badge`, { count: Number(p.count ?? 1), gate: String(p.gate ?? '') });
}

/** The tender-specific half of a warning (the general half is `warnings.<code>.title`). '' when there is none. */
export function warningDetail(t: TFunction<'dashboard'>, w: DashboardWarning): string {
  const p = w.params;
  const more = (shown: string[]) => (Number(p.count ?? 0) > shown.length ? t('warnings.more') : '');
  switch (w.code) {
    case 'deadline_passed':
      return t('warnings.deadline_passed.detail', { date: date(p.T) });
    case 'guarantee_urgent':
      return t('warnings.guarantee_urgent.detail', { count: Number(p.workingDays ?? 0) });
    case 'documents_expiring':
      return t('warnings.documents_expiring.detail', { titles: list(p.titles).join(', ') + more(list(p.titles)) });
    case 'watch_request_overdue':
      return t('warnings.watch_request_overdue.detail', { names: list(p.names).join(', ') + more(list(p.names)) });
    case 'gate_overdue':
      return t('warnings.gate_overdue.detail', { gate: String(p.gate ?? ''), date: date(p.dueDate) });
    case 'guarantee_validity':
      return t('warnings.guarantee_validity.detail', { validUntil: date(p.validUntil), requiredUntil: date(p.requiredUntil) });
    case 'compressed':
      return '';
  }
}
