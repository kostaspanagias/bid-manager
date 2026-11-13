import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '@/lib/cx';
import { Icon } from './icons';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons on the right (wrap below the title on phones) */
  actions?: ReactNode;
  /** "Back to parent" link above the title */
  back?: { to: string; label: string };
  /** Inline items after the title (badges, T−n) */
  meta?: ReactNode;
  /** 1 = page title (h1, default); 2 = section title inside a tender tab (h2, smaller) */
  level?: 1 | 2;
  className?: string;
}

/** Title block of a page or of a tab inside the tender layout. */
export function PageHeader({ title, subtitle, actions, back, meta, level = 1, className }: PageHeaderProps) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header className={cx('ui-page-header', level === 2 && 'ui-page-header--section', className)}>
      <div className="ui-page-header__main">
        {back && (
          <Link to={back.to} className="ui-page-header__back">
            <Icon name="chevronLeft" size={14} />
            {back.label}
          </Link>
        )}
        <div className="ui-page-header__title-row">
          <Heading className="ui-page-header__title">{title}</Heading>
          {meta}
        </div>
        {subtitle && <p className="ui-page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}
