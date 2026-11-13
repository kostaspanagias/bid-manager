import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '@/lib/cx';
import type { Tone } from './types';

export interface TabItem {
  /** Value used with `value` / `onChange` in controlled mode */
  key: string;
  label: ReactNode;
  /** Route mode: renders a NavLink (active state from the URL) */
  to?: string;
  /** With `to`: match the path exactly (for the index tab) */
  end?: boolean;
  /** Small counter after the label (e.g. open items) */
  count?: number | string;
  /** Colour of the counter: red = something blocking inside this tab */
  countTone?: Tone;
  disabled?: boolean;
}

export interface TabsProps {
  items: ReadonlyArray<TabItem>;
  /** Controlled mode: active key */
  value?: string;
  onChange?: (key: string) => void;
  /** Accessible name of the tab list */
  label: string;
  className?: string;
}

function inner(item: TabItem) {
  return (
    <>
      <span>{item.label}</span>
      {item.count !== undefined && item.count !== null && (
        <span className={cx('ui-tabs__count', `ui-tone-${item.countTone ?? 'neutral'}`)}>{item.count}</span>
      )}
    </>
  );
}

/**
 * Tab strip (scrolls sideways when it does not fit).
 * Route mode: give every item a `to` — used by the tender layout.
 * Controlled mode: `value` + `onChange` — for in-page sections; render the panel yourself.
 */
export function Tabs({ items, value, onChange, label, className }: TabsProps) {
  const routeMode = items.some((i) => i.to !== undefined);
  if (routeMode) {
    return (
      <nav className={cx('ui-tabs', className)} aria-label={label}>
        <div className="ui-tabs__list">
          {items.map((item) => (
            <NavLink
              key={item.key}
              to={item.to ?? '.'}
              end={item.end}
              className={({ isActive }) => cx('ui-tabs__tab', isActive && 'is-active')}
            >
              {inner(item)}
            </NavLink>
          ))}
        </div>
      </nav>
    );
  }
  return (
    <div className={cx('ui-tabs', className)}>
      <div className="ui-tabs__list" role="tablist" aria-label={label}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={item.key === value}
            disabled={item.disabled}
            className={cx('ui-tabs__tab', item.key === value && 'is-active')}
            onClick={() => onChange?.(item.key)}
          >
            {inner(item)}
          </button>
        ))}
      </div>
    </div>
  );
}
