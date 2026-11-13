import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import type { Tone } from './types';

export interface BadgeProps {
  /** red = blocking, orange = warning, green = ok, info, neutral (default) */
  tone?: Tone;
  /** Leading status dot */
  dot?: boolean;
  /** Tooltip text */
  title?: string;
  className?: string;
  children: ReactNode;
}

/** Compact status label. Always pair colour with text — never colour alone. */
export function Badge({ tone = 'neutral', dot, title, className, children }: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-tone-${tone}`, className)} title={title}>
      {dot && <span className="ui-badge__dot" aria-hidden />}
      {children}
    </span>
  );
}
