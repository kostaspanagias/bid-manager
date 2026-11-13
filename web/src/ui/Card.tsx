import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import type { Tone } from './types';

export interface CardProps {
  /** Header title (rendered as h3 by default) */
  title?: ReactNode;
  /** Small text next to / under the title */
  subtitle?: ReactNode;
  /** Header actions (buttons, menu) */
  actions?: ReactNode;
  /** Footer row */
  footer?: ReactNode;
  /** Remove body padding — use when the body is a Table */
  flush?: boolean;
  /** Coloured top edge to flag the card's state */
  tone?: Tone;
  as?: 'section' | 'div' | 'article';
  className?: string;
  children?: ReactNode;
}

/** Surface that groups related content. */
export function Card({ title, subtitle, actions, footer, flush, tone, as: Tag = 'section', className, children }: CardProps) {
  return (
    <Tag className={cx('ui-card', tone && `ui-card--toned ui-tone-${tone}`, className)}>
      {(title || actions) && (
        <header className="ui-card__header">
          <div className="ui-card__heading">
            {title && <h3 className="ui-card__title">{title}</h3>}
            {subtitle && <p className="ui-card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="ui-card__actions">{actions}</div>}
        </header>
      )}
      <div className={cx('ui-card__body', flush && 'ui-card__body--flush')}>{children}</div>
      {footer && <footer className="ui-card__footer">{footer}</footer>}
    </Tag>
  );
}
