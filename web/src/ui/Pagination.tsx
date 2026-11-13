import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { Button } from './Button';

export interface PaginationProps {
  /** Zero-based index of the first row shown */
  offset: number;
  /** Page size */
  limit: number;
  /** Total number of rows */
  total: number;
  onChange: (offset: number) => void;
  className?: string;
}

/** «1–50 από 312» with previous/next, for offset/limit endpoints. */
export function Pagination({ offset, limit, total, onChange, className }: PaginationProps) {
  const { t } = useTranslation();
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className={cx('ui-pagination', className)} aria-label={t('common:pagination.range', { from, to, total })}>
      <span className="ui-pagination__range">
        {total === 0 ? t('common:pagination.empty') : t('common:pagination.range', { from, to, total })}
      </span>
      <Button size="sm" icon="chevronLeft" iconOnly disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        {t('common:pagination.previous')}
      </Button>
      <Button size="sm" icon="chevronRight" iconOnly disabled={to >= total} onClick={() => onChange(offset + limit)}>
        {t('common:pagination.next')}
      </Button>
    </nav>
  );
}
