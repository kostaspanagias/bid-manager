import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icons';

export interface MenuItem {
  key?: string;
  label: ReactNode;
  /** Action on select */
  onSelect?: () => void;
  /** Navigate to a route on select */
  to?: string;
  icon?: IconName;
  /** Red text for destructive actions */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item */
  separatorBefore?: boolean;
}

export interface MenuProps {
  /** Accessible name of the trigger (and tooltip for the default "⋯" trigger) */
  label: string;
  items: ReadonlyArray<MenuItem | false | null | undefined>;
  /** Custom trigger content; default is a "more" icon */
  trigger?: ReactNode;
  /** Class for the trigger button (default: ghost icon button) */
  triggerClassName?: string;
  /** Horizontal alignment of the popup relative to the trigger. Default 'end'. */
  align?: 'start' | 'end';
  /** Preferred side; flips automatically when there is no room. Default 'bottom'. */
  side?: 'bottom' | 'top';
  /** Non-interactive block above the items (e.g. user name + email) */
  header?: ReactNode;
  disabled?: boolean;
}

/**
 * Dropdown menu (row actions, user menu). The popup is portalled and fixed-positioned, so it is never
 * clipped by scrolling table containers. Keyboard: ↑ ↓ Home End to move, Enter/Space to select, Esc to close.
 */
export function Menu({ label, items, trigger, triggerClassName, align = 'end', side = 'bottom', header, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const navigate = useNavigate();
  const list = items.filter((i): i is MenuItem => Boolean(i));

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 4;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    const below = r.bottom + gap;
    const above = r.top - gap - ph;
    let top = side === 'bottom' ? below : above;
    if (side === 'bottom' && below + ph > vh - 8 && above >= 8) top = above;
    if (side === 'top' && above < 8) top = below;
    setStyle({ top, left, visibility: 'visible' });
    pop.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open, align, side]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScrollOrResize = (e: Event) => {
      if (e.type === 'scroll' && popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const nodes = Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      nodes[(idx + 1) % nodes.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      nodes[(idx - 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      nodes[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      nodes[nodes.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const select = (item: MenuItem) => {
    close();
    item.onSelect?.();
    if (item.to) navigate(item.to);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={triggerClassName ?? 'ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={trigger ? undefined : label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setStyle({ visibility: 'hidden' });
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger ?? <Icon name="more" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={menuId}
            className="ui-menu"
            role="menu"
            aria-label={label}
            style={style}
            onKeyDown={onMenuKey}
            onClick={(e) => e.stopPropagation()}
          >
            {header && <div className="ui-menu__header">{header}</div>}
            {list.map((item, i) => (
              <div key={item.key ?? i} role="none">
                {item.separatorBefore && <div className="ui-menu__sep" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className={cx('ui-menu__item', item.danger && 'is-danger')}
                  disabled={item.disabled}
                  onClick={() => select(item)}
                >
                  {item.icon && <Icon name={item.icon} />}
                  <span>{item.label}</span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
