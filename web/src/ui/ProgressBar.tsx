import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import type { Tone } from './types';

export interface ProgressBarProps {
  /** Current value (0…max) */
  value: number;
  /** Default 100 */
  max?: number;
  /** Accessible name and, unless hideLabel, visible caption (e.g. «Αποκλεισμού») */
  label: string;
  hideLabel?: boolean;
  /** Text on the right; default is the rounded percentage. Pass e.g. «12/15». */
  valueText?: ReactNode;
  /** 'auto' (default): 100% green, ≥ 50% orange, below red. Or force a tone. */
  tone?: Tone | 'auto';
  className?: string;
}

/** Horizontal bar for coverage percentages (register coverage per type, checklist completion). */
export function ProgressBar({ value, max = 100, label, hideLabel, valueText, tone = 'auto', className }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const rounded = Math.floor(pct + 1e-9); // never show 100% unless complete
  const resolved: Tone = tone === 'auto' ? (pct >= 100 ? 'green' : pct >= 50 ? 'orange' : 'red') : tone;
  return (
    <div className={cx('ui-progress', `ui-tone-${resolved}`, className)}>
      <div className="ui-progress__head">
        <span className={cx('ui-progress__label', hideLabel && 'u-sr-only')}>{label}</span>
        <span className="ui-progress__value">{valueText ?? `${rounded}%`}</span>
      </div>
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
      >
        <div className="ui-progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
