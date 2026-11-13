import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ID, RequirementStatus } from '@/api/types';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { cx } from '@/lib/cx';
import { enumLabel, enumTone } from '@/lib/enums';
import { Icon, Spinner } from '@/ui';
import { REQUIREMENT_STATUSES, lacksEvidence, ownerLabel, type Sort, type SortKey } from './registerModel';
import type { Owners, RegisterRow } from './requirementsApi';

/**
 * The register table. It extends the kit's Table markup (.ui-table) with what 1,000 rows need: fixed-height rows
 * rendered only around the viewport (windowing), sortable headers, row selection and an inline status select.
 * Below ~720px of width the columns collapse into two-line rows.
 */
export interface RegisterTableProps {
  rows: readonly RegisterRow[];
  owners: Owners | undefined;
  sort: Sort;
  onSort: (sort: Sort) => void;
  selected: ReadonlySet<ID>;
  onToggle: (id: ID, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (row: RegisterRow) => void;
  onStatus: (row: RegisterRow, status: RequirementStatus) => void;
  /** Row whose status is being saved */
  savingId: ID | null;
  canWrite: boolean;
  loading?: boolean;
  empty: ReactNode;
}

interface ColumnDef {
  key: SortKey;
  width?: number;
  /** Shown only when the table is at least this wide */
  minWidth?: number;
}
const COLUMNS: ColumnDef[] = [
  { key: 'code', width: 104 },
  { key: 'type', width: 142 },
  { key: 'text' },
  { key: 'source_ref', width: 168, minWidth: 1300 },
  { key: 'folder', width: 104, minWidth: 1080 },
  { key: 'owner', width: 124 },
  { key: 'response_ref', width: 132, minWidth: 1300 },
  { key: 'evidence_ref', width: 148 },
  { key: 'status', width: 138 },
];
const ROW_H = 36;
const CARD_H = 78;
const OVERSCAN = 12;
const NARROW = 720;

function useWindowing(count: number, rowHeight: number, headerHeight: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600, width: 1024 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight && v.width === el.clientWidth ? v : { ...v, height: el.clientHeight, width: el.clientWidth }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = ref.current;
    if (el) setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
  };
  const first = Math.max(0, Math.floor((view.top - headerHeight) / rowHeight) - OVERSCAN);
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN);
  return { ref, onScroll, first, last, width: view.width };
}

interface RowProps {
  row: RegisterRow;
  owners: Owners | undefined;
  columns: ColumnDef[];
  selected: boolean;
  saving: boolean;
  canWrite: boolean;
  onToggle: (id: ID, checked: boolean) => void;
  onOpen: (row: RegisterRow) => void;
  onStatus: (row: RegisterRow, status: RequirementStatus) => void;
}

function StatusControl({ row, saving, canWrite, onStatus }: Pick<RowProps, 'row' | 'saving' | 'canWrite' | 'onStatus'>) {
  const { t } = useTranslation('requirements');
  if (!canWrite) return <StatusBadge kind="requirement_status" value={row.status} />;
  return (
    <select
      className={cx('reg-status', `ui-tone-${enumTone('requirement_status', row.status)}`)}
      value={row.status}
      disabled={saving}
      aria-label={t('table.statusOf', { code: row.code })}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => onStatus(row, e.target.value as RequirementStatus)}
    >
      {REQUIREMENT_STATUSES.map((s) => (
        <option key={s} value={s}>
          {enumLabel('requirement_status', s)}
        </option>
      ))}
    </select>
  );
}

function RowCheck({ row, selected, onToggle }: Pick<RowProps, 'row' | 'selected' | 'onToggle'>) {
  const { t } = useTranslation('requirements');
  return (
    <input
      type="checkbox"
      className="reg-check"
      checked={selected}
      aria-label={t('table.selectRow', { code: row.code })}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => onToggle(row.id, e.target.checked)}
    />
  );
}

function MissingEvidence() {
  const { t } = useTranslation('requirements');
  return (
    <span className="reg-missing">
      <Icon name="block" /> {t('table.missingEvidence')}
    </span>
  );
}

const dash = <span className="u-faint">—</span>;

const TableRow = memo(function TableRow({ row, owners, columns, selected, saving, canWrite, onToggle, onOpen, onStatus }: RowProps) {
  const { t } = useTranslation('requirements');
  const blocking = lacksEvidence(row);
  const owner = ownerLabel(row, owners);
  const cell = (key: SortKey): ReactNode => {
    switch (key) {
      case 'code':
        return <span className="reg-code">{row.code}</span>;
      case 'type':
        return <StatusBadge kind="requirement_type" value={row.type} />;
      case 'text':
        return (
          <>
            {row.text}
            {row.changes.length > 0 && <span className="reg-link-count">· {t('table.changes', { count: row.changes.length })}</span>}
          </>
        );
      case 'folder':
        return row.folder ? enumLabel('folder', row.folder) : dash;
      case 'owner':
        return owner.role || owner.user ? (
          <>
            {owner.role && <span className="reg-owner-role">{owner.role}</span>}
            {owner.user}
          </>
        ) : (
          dash
        );
      case 'evidence_ref':
        return blocking ? <MissingEvidence /> : row.evidence_ref || dash;
      case 'status':
        return <StatusControl row={row} saving={saving} canWrite={canWrite} onStatus={onStatus} />;
      default:
        return row[key] || dash;
    }
  };
  return (
    <tr
      className={cx('reg-row is-clickable', selected && 'is-selected', blocking && 'ui-row-tone ui-tone-red')}
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(row);
        }
      }}
    >
      {canWrite && (
        <td className="reg-col-check">
          <RowCheck row={row} selected={selected} onToggle={onToggle} />
        </td>
      )}
      {columns.map((c) => (
        <td key={c.key} title={c.key === 'text' ? row.text : c.key === 'source_ref' ? (row.source_ref ?? undefined) : undefined}>
          {cell(c.key)}
        </td>
      ))}
    </tr>
  );
});

const CardRow = memo(function CardRow({ row, owners, selected, saving, canWrite, onToggle, onOpen, onStatus, top }: RowProps & { top: number }) {
  const blocking = lacksEvidence(row);
  const owner = ownerLabel(row, owners);
  const meta = [row.folder ? enumLabel('folder', row.folder) : null, [owner.role, owner.user].filter(Boolean).join(' · ') || null, blocking ? null : row.evidence_ref].filter(Boolean);
  return (
    <div
      className={cx('reg-card', selected && 'is-selected', blocking && 'ui-row-tone ui-tone-red')}
      style={{ top }}
      role="listitem"
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(row);
        }
      }}
    >
      {canWrite ? (
        <div className="reg-card__check">
          <RowCheck row={row} selected={selected} onToggle={onToggle} />
        </div>
      ) : (
        <span />
      )}
      <div className="reg-card__top">
        <span className="reg-code">{row.code}</span>
        <span className={cx('reg-card__type', row.type === 'exclusion' && 'is-exclusion')}>{enumLabel('requirement_type', row.type)}</span>
        <StatusControl row={row} saving={saving} canWrite={canWrite} onStatus={onStatus} />
      </div>
      <div className="reg-card__text">{row.text}</div>
      <div className="reg-card__meta">
        {blocking && <MissingEvidence />}
        {blocking && meta.length > 0 && ' · '}
        {meta.join(' · ')}
      </div>
    </div>
  );
});

export function RegisterTable({ rows, owners, sort, onSort, selected, onToggle, onToggleAll, onOpen, onStatus, savingId, canWrite, loading, empty }: RegisterTableProps) {
  const { t } = useTranslation('requirements');
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW);
  const rowHeight = narrow ? CARD_H : ROW_H;
  const { ref, onScroll, first, last, width } = useWindowing(rows.length, rowHeight, narrow ? 44 : 34);
  useEffect(() => setNarrow(width < NARROW), [width]);
  const headCheck = useRef<HTMLInputElement>(null);
  const selectedHere = rows.reduce((n, r) => n + (selected.has(r.id) ? 1 : 0), 0);
  const allSelected = rows.length > 0 && selectedHere === rows.length;
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = selectedHere > 0 && !allSelected;
  });
  // A new filter or sort starts from the top.
  const stamp = `${rows.length}:${rows[0]?.id ?? ''}:${sort.key}:${sort.dir}`;
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [stamp, ref]);

  // Depends only on which optional columns fit, so memoised rows are not re-rendered on every scroll event.
  const fit = COLUMNS.map((c) => !c.minWidth || width >= c.minWidth).join();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => COLUMNS.filter((c) => !c.minWidth || width >= c.minWidth), [fit]);
  const visible = rows.slice(first, last);
  const selectAll = (
    <input
      ref={headCheck}
      type="checkbox"
      className="reg-check"
      checked={allSelected}
      disabled={rows.length === 0}
      aria-label={t('table.selectAll')}
      onChange={(e) => onToggleAll(e.target.checked)}
    />
  );
  const body =
    rows.length === 0 ? (
      loading ? (
        <div className="ui-table__loading">
          <Spinner /> <span>{t('common:state.loading')}</span>
        </div>
      ) : (
        empty
      )
    ) : null;
  const style = { '--reg-row-h': `${rowHeight}px` } as CSSProperties;

  if (narrow) {
    return (
      <div ref={ref} onScroll={onScroll} className="ui-table-wrap ui-table-wrap--sticky reg-table-wrap reg-list-wrap" style={style} aria-busy={loading || undefined}>
        <div className="reg-list__head">
          {canWrite && selectAll}
          <label>
            <span className="u-sr-only">{t('table.sortBy')}</span>
            <select
              className="ui-input ui-select"
              value={`${sort.key}:${sort.dir}`}
              onChange={(e) => {
                const [key, dir] = e.target.value.split(':') as [SortKey, 'asc' | 'desc'];
                onSort({ key, dir });
              }}
            >
              {(['code', 'type', 'status', 'owner', 'folder'] as SortKey[]).flatMap((key) =>
                (['asc', 'desc'] as const).map((dir) => (
                  <option key={`${key}:${dir}`} value={`${key}:${dir}`}>
                    {t(dir === 'asc' ? 'table.sortAsc' : 'table.sortDesc', { column: t(`columns.${key}`) })}
                  </option>
                )),
              )}
            </select>
          </label>
        </div>
        {body ?? (
          <div className="reg-list" role="list" aria-label={t('table.caption')} style={{ height: rows.length * rowHeight }}>
            {visible.map((row, i) => (
              <CardRow
                key={row.id}
                top={(first + i) * rowHeight}
                row={row}
                owners={owners}
                columns={columns}
                selected={selected.has(row.id)}
                saving={savingId === row.id}
                canWrite={canWrite}
                onToggle={onToggle}
                onOpen={onOpen}
                onStatus={onStatus}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const span = columns.length + (canWrite ? 1 : 0);
  return (
    <div ref={ref} onScroll={onScroll} className="ui-table-wrap ui-table-wrap--sticky reg-table-wrap" style={style} aria-busy={loading || undefined}>
      <table className={cx('ui-table ui-table--dense reg-table', loading && rows.length > 0 && 'is-loading')} aria-rowcount={rows.length + 1}>
        <caption className="u-sr-only">{t('table.caption')}</caption>
        <colgroup>
          {canWrite && <col style={{ width: 40 }} />}
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {canWrite && (
              <th scope="col" className="reg-col-check">
                {selectAll}
              </th>
            )}
            {columns.map((c) => {
              const active = sort.key === c.key;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <button
                    type="button"
                    className={cx('reg-sort', active && 'is-active', active && sort.dir === 'desc' && 'is-desc')}
                    onClick={() => onSort({ key: c.key, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })}
                  >
                    <span className="u-truncate">{t(`columns.${c.key}`)}</span>
                    <svg className="reg-sort__arrow" viewBox="0 0 12 12" aria-hidden>
                      <path d="M6 2.5v7M3 5.5l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {body ? (
            <tr className="ui-table__empty-row">
              <td colSpan={span}>{body}</td>
            </tr>
          ) : (
            <>
              {first > 0 && (
                <tr className="reg-spacer" aria-hidden>
                  <td colSpan={span} style={{ height: first * rowHeight }} />
                </tr>
              )}
              {visible.map((row) => (
                <TableRow
                  key={row.id}
                  row={row}
                  owners={owners}
                  columns={columns}
                  selected={selected.has(row.id)}
                  saving={savingId === row.id}
                  canWrite={canWrite}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onStatus={onStatus}
                />
              ))}
              {last < rows.length && (
                <tr className="reg-spacer" aria-hidden>
                  <td colSpan={span} style={{ height: (rows.length - last) * rowHeight }} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
