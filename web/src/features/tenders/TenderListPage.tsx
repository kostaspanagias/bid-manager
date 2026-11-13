import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { TENDER_STATUSES, type TenderStatus } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { enumLabel } from '@/lib/enums';
import { Badge, Banner, Button, DateText, EmptyState, Field, FilterBar, LinkButton, PageHeader, Select, Table, TMinus, type Column } from '@/ui';
import { listTenders, tenderKeys, type TenderListItem } from './tenderApi';
import './tenders.css';

type StatusFilter = 'active' | 'all' | TenderStatus;
const isActive = (t: TenderListItem) => t.status === 'evaluation' || t.status === 'in_progress';

/** /tenders — the tenders the user can reach, soonest deadline first. */
export function TenderListPage() {
  const { t } = useTranslation('tenders');
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const canCreate = hasRole('admin', 'bid_manager');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [search, setSearch] = useState('');

  const query = useQuery({ queryKey: tenderKeys.list(), queryFn: () => listTenders() });
  const all = query.data ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('el');
    return all
      .filter((r) => (status === 'all' ? true : status === 'active' ? isActive(r) : r.status === status))
      .filter((r) => !q || [r.title, r.authority, r.adam, r.esidis_no].some((v) => (v ?? '').toLocaleLowerCase('el').includes(q)));
  }, [all, status, search]);
  const activeCount = all.filter(isActive).length;

  const columns: Column<TenderListItem>[] = [
    {
      key: 'title',
      header: t('list.columns.title'),
      wrap: true,
      render: (r) => (
        <div className="tender-list__title">
          <strong>{r.title}</strong>
          <span className="u-muted">{r.authority}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common:labels.status'),
      render: (r) => (
        <span className="tender-list__status">
          <StatusBadge kind="tender_status" value={r.status} dot />
          {r.compressed_mode && isActive(r) && <Badge tone="orange">{t('list.compressed')}</Badge>}
        </span>
      ),
    },
    { key: 'deadline', header: t('list.columns.deadline'), mono: true, render: (r) => <DateText value={r.submission_deadline_at} withWeekday withTime /> },
    { key: 'tminus', header: t('list.columns.tMinus'), render: (r) => (isActive(r) ? <TMinus n={r.tMinus} /> : <span className="u-faint">—</span>) },
    {
      key: 'next_gate',
      header: t('list.columns.nextGate'),
      render: (r) =>
        r.next_gate ? (
          <span className="tender-list__gate">
            <Badge tone="neutral">{r.next_gate.key}</Badge>
            <DateText value={r.next_gate.due_date} withWeekday className="u-mono" />
          </span>
        ) : (
          <span className="u-faint">—</span>
        ),
    },
  ];

  const statusOptions = [
    { value: 'active', label: t('list.filters.active') },
    { value: 'all', label: t('list.filters.all') },
    ...TENDER_STATUSES.map((s) => ({ value: s, label: enumLabel('tender_status', s) })),
  ];
  const filtered = status !== 'active' || search.trim() !== '';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canCreate && (
            <LinkButton to="/tenders/new" variant="primary" icon="plus">
              {t('new')}
            </LinkButton>
          )
        }
      />

      {query.isError ? (
        <Banner
          tone="red"
          title={t('common:errors.loadFailed')}
          actions={
            <Button size="sm" onClick={() => void query.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Banner>
      ) : !query.isPending && all.length === 0 ? (
        <EmptyState
          icon="folder"
          title={t('list.empty.title')}
          description={canCreate ? t('list.empty.description') : t('list.empty.descriptionMember')}
          action={
            canCreate && (
              <LinkButton to="/tenders/new" variant="primary" icon="plus">
                {t('new')}
              </LinkButton>
            )
          }
        />
      ) : (
        <>
          <FilterBar
            search={{ value: search, onChange: setSearch, placeholder: t('list.filters.search') }}
            active={filtered}
            onReset={() => {
              setStatus('active');
              setSearch('');
            }}
            summary={t('list.summary', { count: rows.length, active: activeCount })}
          >
            <Field label={t('common:labels.status')} hideLabel>
              <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} options={statusOptions} />
            </Field>
          </FilterBar>
          <div className="tender-list__table">
            <Table
              caption={t('title')}
              columns={columns}
              rows={rows}
              loading={query.isPending}
              onRowClick={(r) => navigate(`/tenders/${r.id}`)}
              rowTone={(r) => (!isActive(r) ? undefined : r.tMinus <= 2 ? 'red' : r.compressed_mode ? 'orange' : undefined)}
              rowClassName={(r) => (isActive(r) ? undefined : 'is-muted')}
              emptyTitle={t('common:state.emptyFiltered')}
            />
          </div>
          {/* phones: the same rows as cards, so T and T−n are visible without scrolling sideways */}
          <ul className="tender-cards" aria-label={t('title')}>
            {rows.map((r) => (
              <li key={r.id} className={isActive(r) ? undefined : 'is-muted'}>
                <Link to={`/tenders/${r.id}`} className="tender-cards__link">
                  <strong>{r.title}</strong>
                  <span className="u-muted">{r.authority}</span>
                  <span className="tender-cards__row">
                    <StatusBadge kind="tender_status" value={r.status} dot />
                    {r.compressed_mode && isActive(r) && <Badge tone="orange">{t('list.compressed')}</Badge>}
                  </span>
                  <span className="tender-cards__row">
                    <DateText value={r.submission_deadline_at} withWeekday withTime className="u-mono" />
                    {isActive(r) && <TMinus n={r.tMinus} />}
                  </span>
                  {r.next_gate && (
                    <span className="tender-cards__row u-muted">
                      {t('list.columns.nextGate')}: <Badge tone="neutral">{r.next_gate.key}</Badge>
                      <DateText value={r.next_gate.due_date} withWeekday className="u-mono" />
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {!query.isPending && rows.length === 0 && <li className="tender-cards__empty u-muted">{t('common:state.emptyFiltered')}</li>}
          </ul>
        </>
      )}
    </>
  );
}
