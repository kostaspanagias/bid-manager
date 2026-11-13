import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { formatTMinus } from '@/lib/dates';
import type { Tone } from './types';

export interface TMinusProps {
  /** Working days until the submission deadline: 5 → «T−5», 0 → «T», −2 → «T+2». null/undefined renders nothing. */
  n: number | null | undefined;
  /**
   * 'auto' (default) colours by urgency: ≤ 2 or past = red, ≤ 5 = orange, otherwise neutral.
   * Pass a tone to override (e.g. 'neutral' for milestone offsets in a schedule table).
   */
  tone?: Tone | 'auto';
  /** Plain text without the chip background (inside dense table cells) */
  plain?: boolean;
  className?: string;
}

export function tMinusTone(n: number): Tone {
  if (n <= 2) return 'red';
  if (n <= 5) return 'orange';
  return 'neutral';
}

/** The "T−n" idiom: working days relative to the submission deadline T. */
export function TMinus({ n, tone = 'auto', plain, className }: TMinusProps) {
  const { t } = useTranslation();
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const resolved = tone === 'auto' ? tMinusTone(n) : tone;
  const aria =
    n === 0 ? t('common:tminus.ariaToday') : n > 0 ? t('common:tminus.aria', { count: n }) : t('common:tminus.ariaPast', { count: -n });
  return (
    <span className={cx('ui-tminus', plain && 'ui-tminus--plain', `ui-tone-${resolved}`, className)} title={aria}>
      <span aria-hidden>{formatTMinus(n)}</span>
      <span className="u-sr-only">{aria}</span>
    </span>
  );
}
