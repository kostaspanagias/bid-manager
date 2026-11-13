import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { ID, RequirementFolder, RequirementStatus, RequirementType } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { tenderKeys } from '@/features/tenders/tenderApi';
import { useTender } from '@/features/tenders/tenderContext';
import { enumOptions } from '@/lib/enums';
import { Banner, Button, EmptyState, Field, FilterBar, Menu, PageHeader, PageSpinner, Select, useToast } from '@/ui';
import { BulkDialog } from './BulkDialog';
import { CoverageHeader } from './CoverageHeader';
import { ImportWizard } from './ImportWizard';
import { RegisterTable } from './RegisterTable';
import { RequirementEditor, type EditorTarget } from './RequirementEditor';
import {
  DEFAULT_SORT,
  NO_FILTERS,
  REQUIREMENT_FOLDERS,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
  buildHaystack,
  filterRows,
  hasFilters,
  sortRows,
  type Filters,
  type Sort,
} from './registerModel';
import { exportUrl, fetchCoverage, fetchRegister, registerKeys, templateUrl, updateRequirement, type RegisterResponse, type RegisterRow } from './requirementsApi';
import './register.css';

const download = (url: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/** Requirements register (F5): coverage, the table of ΥΠ-nnn rows, row editor, bulk actions, import/export. */
export function RegisterTab() {
  const { t } = useTranslation('requirements');
  const { tenderId, canWrite } = useTender();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = registerKeys.list(tenderId);

  // The whole register comes in one response (≤ 1,000 rows by spec); filtering and sorting happen here.
  const register = useQuery({ queryKey: key, queryFn: () => fetchRegister(tenderId) });
  const data = register.data;

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<ReadonlySet<ID>>(new Set());
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [savingId, setSavingId] = useState<ID | null>(null);
  const setFilter = <K extends keyof Filters>(name: K, value: Filters[K]) => setFilters((f) => ({ ...f, [name]: value }));

  const deferredQ = useDeferredValue(filters.q);
  const haystack = useMemo(() => buildHaystack(data?.items ?? []), [data?.items]);
  const rows = useMemo(
    () => sortRows(filterRows(data?.items ?? [], { ...filters, q: deferredQ }, data?.owners, user?.id, haystack), sort, data?.owners),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.items, data?.owners, filters.type, filters.folder, filters.status, filters.owner, filters.missingEvidence, deferredQ, sort, user?.id, haystack],
  );
  const codes = useMemo(() => new Set((data?.items ?? []).map((r) => r.code)), [data?.items]);
  const selectedIds = useMemo(() => (data?.items ?? []).filter((r) => selected.has(r.id)).map((r) => r.id), [data?.items, selected]);

  /** Put a saved row into the cached list and refresh the small coverage block, instead of re-reading 1,000 rows. */
  const patchCache = useCallback(
    (fn: (items: RegisterRow[]) => RegisterRow[]) => {
      queryClient.setQueryData<RegisterResponse>(key, (old) => (old ? { ...old, items: fn(old.items), total: fn(old.items).length } : old));
      void fetchCoverage(tenderId)
        .then((coverage) => queryClient.setQueryData<RegisterResponse>(key, (old) => (old ? { ...old, coverage } : old)))
        .catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, tenderId],
  );
  const reload = () => queryClient.invalidateQueries({ queryKey: tenderKeys.detail(tenderId) });

  const status = useMutation({
    mutationFn: ({ row, value }: { row: RegisterRow; value: RequirementStatus }) => updateRequirement(tenderId, row.id, { status: value }),
    onMutate: ({ row }) => setSavingId(row.id),
    onSuccess: (saved) => patchCache((items) => items.map((r) => (r.id === saved.id ? saved : r))),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => setSavingId(null),
  });
  const mutateStatus = status.mutate;
  const onStatus = useCallback(
    (row: RegisterRow, value: RequirementStatus) => {
      if (value === row.status) return;
      // R17: a deviation needs its note first — open the editor on that field instead of failing.
      if (value === 'deviation' && !(row.deviation_note ?? '').trim()) setEditor({ row, status: 'deviation' });
      else mutateStatus({ row, value });
    },
    [mutateStatus],
  );
  const onOpen = useCallback((row: RegisterRow) => setEditor({ row }), []);
  const onToggle = useCallback((id: ID, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const onToggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (checked) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  };

  if (register.isPending) return <PageSpinner />;
  if (register.isError || !data) {
    return (
      <>
        <PageHeader level={2} title={t('title')} subtitle={t('subtitle')} />
        <Banner tone="red" actions={<Button size="sm" onClick={() => void register.refetch()}>{t('common:actions.retry')}</Button>}>
          {errorMessage(register.error)}
        </Banner>
      </>
    );
  }

  const active = hasFilters(filters);
  const total = data.items.length;
  const exportFilters = { type: filters.type, folder: filters.folder, status: filters.status, owner: filters.owner, q: filters.q.trim(), missing_evidence: filters.missingEvidence };
  const ownerOptions = (
    <>
      <option value="me">{t('filters.mine')}</option>
      <option value="none">{t('filters.noOwner')}</option>
      <optgroup label={t('filters.roles')}>
        {data.owners.roles.map((r) => (
          <option key={r.key} value={`role:${r.key}`}>
            {r.name && r.name !== r.key ? `${r.key} — ${r.name}` : r.key}
          </option>
        ))}
      </optgroup>
      <optgroup label={t('filters.users')}>
        {data.owners.users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </optgroup>
    </>
  );

  return (
    <>
      <PageHeader
        level={2}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="reg-toolbar">
            <Menu
              label={t('actions.more')}
              triggerClassName="ui-btn ui-btn--secondary"
              trigger={t('actions.export')}
              items={[
                { label: t('actions.exportAll'), icon: 'download', disabled: total === 0, onSelect: () => download(exportUrl(tenderId)) },
                active && rows.length > 0 && { label: t('actions.exportFiltered', { count: rows.length }), icon: 'filter', onSelect: () => download(exportUrl(tenderId, exportFilters)) },
                { label: t('actions.template'), icon: 'file', separatorBefore: true, onSelect: () => download(templateUrl(tenderId)) },
              ]}
            />
            {canWrite && (
              <Button icon="upload" onClick={() => setImporting(true)}>
                {t('actions.import')}
              </Button>
            )}
            {canWrite && (
              <Button variant="primary" icon="plus" onClick={() => setEditor({ row: null })}>
                {t('actions.add')}
              </Button>
            )}
          </div>
        }
      />

      {total > 0 && <CoverageHeader coverage={data.coverage} onShowMissingEvidence={() => setFilters({ ...NO_FILTERS, missingEvidence: true })} />}

      <div className="reg-section">
        <FilterBar
          search={{ value: filters.q, onChange: (v) => setFilter('q', v), placeholder: t('filters.search') }}
          active={active}
          onReset={() => setFilters(NO_FILTERS)}
          summary={active ? t('filters.summaryOf', { shown: rows.length, total }) : t('filters.summary', { count: total })}
        >
          <Field label={t('filters.type')}>
            <Select value={filters.missingEvidence ? 'missing' : filters.type} onChange={(e) => (e.target.value === 'missing' ? setFilters((f) => ({ ...f, type: '', missingEvidence: true })) : setFilters((f) => ({ ...f, type: e.target.value as RequirementType | '', missingEvidence: false })))} placeholder={t('filters.all')}>
              {enumOptions('requirement_type', REQUIREMENT_TYPES).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              <option value="missing">{t('filters.missingEvidence')}</option>
            </Select>
          </Field>
          <Field label={t('filters.folder')}>
            <Select value={filters.folder} onChange={(e) => setFilter('folder', e.target.value as RequirementFolder | 'none' | '')} placeholder={t('filters.all')}>
              {enumOptions('folder', REQUIREMENT_FOLDERS).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              <option value="none">{t('filters.noFolder')}</option>
            </Select>
          </Field>
          <Field label={t('filters.owner')}>
            <Select value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)} placeholder={t('filters.allOwners')}>
              {ownerOptions}
            </Select>
          </Field>
          <Field label={t('filters.status')}>
            <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value as RequirementStatus | '')} options={enumOptions('requirement_status', REQUIREMENT_STATUSES)} placeholder={t('filters.all')} />
          </Field>
        </FilterBar>

        {canWrite && selectedIds.length > 0 && (
          <div className="reg-bulk" role="region" aria-label={t('actions.bulk')}>
            <span className="reg-bulk__count">{t('bulk.selected', { count: selectedIds.length })}</span>
            <Button size="sm" variant="primary" icon="edit" onClick={() => setBulk(true)}>
              {t('actions.bulk')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('actions.clearSelection')}
            </Button>
          </div>
        )}

        <RegisterTable
          rows={rows}
          owners={data.owners}
          sort={sort}
          onSort={setSort}
          selected={selected}
          onToggle={onToggle}
          onToggleAll={onToggleAll}
          onOpen={onOpen}
          onStatus={onStatus}
          savingId={savingId}
          canWrite={canWrite}
          loading={register.isFetching && total === 0}
          empty={
            total === 0 ? (
              <EmptyState
                icon="inbox"
                title={t('table.emptyTitle')}
                description={canWrite ? t('table.emptyDescription') : t('table.emptyReadOnly')}
                action={
                  canWrite ? (
                    <div className="reg-toolbar">
                      <Button icon="upload" onClick={() => setImporting(true)}>
                        {t('actions.import')}
                      </Button>
                      <Button variant="primary" icon="plus" onClick={() => setEditor({ row: null })}>
                        {t('actions.add')}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState compact title={t('common:state.emptyFiltered')} description={t('table.emptyFilteredDescription')} action={<Button size="sm" onClick={() => setFilters(NO_FILTERS)}>{t('common:actions.clearFilters')}</Button>} />
            )
          }
        />
      </div>

      {editor && (
        <RequirementEditor
          key={editor.row?.id ?? 'new'}
          tenderId={tenderId}
          target={editor}
          owners={data.owners}
          nextCode={data.nextCode}
          codes={codes}
          canWrite={canWrite}
          onClose={() => setEditor(null)}
          onSaved={(saved, created) => {
            setEditor(null);
            if (created) void queryClient.invalidateQueries({ queryKey: key });
            else patchCache((items) => items.map((r) => (r.id === saved.id ? saved : r)));
          }}
          onDeleted={(id) => {
            setEditor(null);
            onToggle(id, false);
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      )}
      {bulk && (
        <BulkDialog
          tenderId={tenderId}
          ids={selectedIds}
          owners={data.owners}
          onClose={() => setBulk(false)}
          onDone={() => {
            setBulk(false);
            setSelected(new Set());
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      )}
      {importing && (
        <ImportWizard
          tenderId={tenderId}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            void reload();
          }}
        />
      )}
    </>
  );
}
