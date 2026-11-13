import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icons';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Usually one Button / LinkButton */
  action?: ReactNode;
  icon?: IconName;
  /** Less vertical padding (inside cards and tables) */
  compact?: boolean;
  className?: string;
}

/** Placeholder for "nothing here yet" and "no results". */
export function EmptyState({ title, description, action, icon = 'inbox', compact, className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', compact && 'ui-empty--compact', className)}>
      <span className="ui-empty__icon" aria-hidden>
        <Icon name={icon} size={20} />
      </span>
      <p className="ui-empty__title">{title}</p>
      {description && <p className="ui-empty__desc">{description}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
