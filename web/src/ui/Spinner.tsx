import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';

export interface SpinnerProps {
  /** px, default 18 */
  size?: number;
  /** Screen-reader label; defaults to «Φόρτωση…» */
  label?: string;
  className?: string;
}

/** Inline loading indicator. */
export function Spinner({ size = 18, label, className }: SpinnerProps) {
  const { t } = useTranslation();
  return (
    <span className={cx('ui-spinner', className)} role="status" style={{ width: size, height: size }}>
      <span className="u-sr-only">{label ?? t('common:state.loading')}</span>
    </span>
  );
}

/** Centered spinner with visible text, for a loading page or panel. */
export function PageSpinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  const text = label ?? t('common:state.loading');
  return (
    <div className="ui-page-spinner" role="status">
      <span className="ui-spinner" style={{ width: 22, height: 22 }} aria-hidden />
      <span>{text}</span>
    </div>
  );
}
