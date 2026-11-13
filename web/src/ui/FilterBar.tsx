import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import { Icon } from './icons';

export interface FilterBarProps {
  /** Filter controls — usually <Field label=…><Select …/></Field> items; they wrap on narrow screens */
  children?: ReactNode;
  /** Built-in search box on the left */
  search?: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string };
  /** Shows «Καθαρισμός φίλτρων» when given and `active` is true */
  onReset?: () => void;
  /** Whether any filter is set (controls the reset button) */
  active?: boolean;
  /** Right-aligned text, e.g. «42 γραμμές» */
  summary?: ReactNode;
  /** Right-aligned extra controls (export button, view switch) */
  actions?: ReactNode;
  className?: string;
}

/** Row of filters above a table. */
export function FilterBar({ children, search, onReset, active, summary, actions, className }: FilterBarProps) {
  const { t } = useTranslation();
  const searchLabel = search?.label ?? search?.placeholder ?? t('common:actions.search');
  return (
    <div className={cx('ui-filterbar', className)} role="search">
      {search && (
        <div className="ui-filterbar__search">
          <Icon name="search" />
          <input
            type="search"
            className="ui-input"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? t('common:actions.search')}
            aria-label={searchLabel}
          />
        </div>
      )}
      {children}
      {onReset && active && (
        <Button variant="ghost" size="sm" icon="close" onClick={onReset} className="ui-filterbar__reset">
          {t('common:actions.clearFilters')}
        </Button>
      )}
      {(summary || actions) && (
        <div className="ui-filterbar__end">
          {summary && <span className="ui-filterbar__summary">{summary}</span>}
          {actions}
        </div>
      )}
    </div>
  );
}
