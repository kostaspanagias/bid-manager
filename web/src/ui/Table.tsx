import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';
import type { Tone } from './types';

export interface Column<T> {
  /** Unique key; also the property read from the row when `render` is not given */
  key: string;
  /** Header text (string) or node */
  header: ReactNode;
  /** Cell renderer; default is String(row[key]) with «—» for null/empty */
  render?: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** CSS width of the column, e.g. 120 or '20%' */
  width?: number | string;
  /** Allow the cell text to wrap (long free text). Default: cells do not wrap and the table scrolls sideways. */
  wrap?: boolean;
  /** Monospace + tabular numbers (codes, dates, amounts) */
  mono?: boolean;
  /** Extra class for the cells of this column */
  className?: string;
  /** Header for screen readers only (e.g. an actions column) */
  srOnlyHeader?: boolean;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T> | undefined;
  /** Stable key per row; default uses row.id */
  rowKey?: (row: T, index: number) => string;
  /** Makes rows clickable and keyboard-activable (Enter/Space) */
  onRowClick?: (row: T) => void;
  /** Coloured marker on the row's left edge: red = late/blocking, orange = warning… */
  rowTone?: (row: T) => Tone | undefined | null;
  /** Extra class per row (e.g. 'is-muted' for cancelled items) */
  rowClassName?: (row: T) => string | undefined;
  /** Shown instead of rows when there are none: a node, or use emptyTitle/emptyDescription */
  empty?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Shows a loading row while there are no rows yet; dims existing rows while refetching */
  loading?: boolean;
  /** Keep the header visible while the body scrolls inside the table container (sets a max height) */
  stickyHeader?: boolean;
  /** Max height of the scroll container when stickyHeader is on. Default 'min(70vh, 720px)'. */
  maxHeight?: number | string;
  /** Tighter rows for long registers */
  dense?: boolean;
  /** Accessible name of the table */
  caption?: string;
  /** Optional footer row content (totals) rendered in <tfoot> spanning all columns */
  footer?: ReactNode;
  className?: string;
}

function defaultCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="u-faint">—</span>;
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}

/**
 * Data table. Scrolls horizontally inside its own container on narrow screens.
 *
 *   <Table columns={[{ key: 'code', header: 'Κωδικός', mono: true }, …]} rows={items} onRowClick={open} />
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowTone,
  rowClassName,
  empty,
  emptyTitle,
  emptyDescription,
  loading,
  stickyHeader,
  maxHeight,
  dense,
  caption,
  footer,
  className,
}: TableProps<T>) {
  const { t } = useTranslation();
  const list = rows ?? [];
  const isEmpty = list.length === 0;
  const wrapStyle: CSSProperties | undefined = stickyHeader ? { maxHeight: maxHeight ?? 'min(70vh, 720px)' } : undefined;

  const keyOf = (row: T, i: number) => {
    if (rowKey) return rowKey(row, i);
    const id = (row as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : String(i);
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  return (
    <div
      className={cx('ui-table-wrap', stickyHeader && 'ui-table-wrap--sticky', className)}
      style={wrapStyle}
      aria-busy={loading || undefined}
    >
      <table className={cx('ui-table', dense && 'ui-table--dense', loading && !isEmpty && 'is-loading')}>
        {caption && <caption className="u-sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{ width: c.width, textAlign: c.align }}>
                {c.srOnlyHeader ? <span className="u-sr-only">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr className="ui-table__empty-row">
              <td colSpan={columns.length}>
                {loading ? (
                  <div className="ui-table__loading">
                    <Spinner /> <span>{t('common:state.loading')}</span>
                  </div>
                ) : (
                  (empty ?? <EmptyState compact title={emptyTitle ?? t('common:state.empty')} description={emptyDescription} />)
                )}
              </td>
            </tr>
          ) : (
            list.map((row, i) => {
              const tone = rowTone?.(row);
              return (
                <tr
                  key={keyOf(row, i)}
                  className={cx(onRowClick && 'is-clickable', tone && `ui-row-tone ui-tone-${tone}`, rowClassName?.(row))}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => onKey(e, row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx(c.wrap && 'is-wrap', c.mono && 'u-mono', c.className)}
                      style={{ textAlign: c.align }}
                    >
                      {c.render ? c.render(row, i) : defaultCell((row as Record<string, unknown>)[c.key])}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
        {footer && !isEmpty && (
          <tfoot>
            <tr>
              <td colSpan={columns.length}>{footer}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Wrap interactive cell content (buttons, menus, links) so clicks do not trigger onRowClick. */
export function CellActions({ children }: { children: ReactNode }) {
  return (
    <div className="ui-table__actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
