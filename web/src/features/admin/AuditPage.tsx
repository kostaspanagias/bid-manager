import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import type { Json } from '@/api/types';
import { UserSelect } from '@/features/shared/UserSelect';
import { useUsers } from '@/features/shared/useUsers';
import { cx } from '@/lib/cx';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DateText,
  Field,
  FilterBar,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Table,
  type Column,
  type Tone,
} from '@/ui';
import { AUDIT_ENTITIES, auditKeys, changedFields, diffAudit, listAudit, type AuditFilters, type AuditItem } from './auditApi';
import './admin.css';

const PAGE_SIZES = [25, 50, 100];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_TONE: Record<string, Tone> = { insert: 'green', create: 'green', update: 'info', delete: 'red', remove: 'red' };

/**
 * /admin/audit — append-only change history with before/after diff.
 * Filters live in the URL, so other screens can deep-link: /admin/audit?entity=tender&entity_id=<uuid>
 */
export function AuditPage() {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<AuditItem | null>(null);
  const { nameOf } = useUsers();

  const entity = params.get('entity') ?? '';
  const entityId = params.get('entity_id') ?? '';
  const userId = params.get('user_id') ?? '';
  const limit = PAGE_SIZES.includes(Number(params.get('limit'))) ? Number(params.get('limit')) : 50;
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const entityIdValid = !entityId || UUID_RE.test(entityId.trim());

  const setParam = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params);
    if (!('offset' in changes)) next.delete('offset'); // any filter change goes back to the first page
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '' || v === 0) next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  };

  const filters: AuditFilters = {
    entity: entity || undefined,
    entity_id: entityIdValid && entityId ? entityId.trim() : undefined,
    user_id: userId || undefined,
    limit,
    offset,
  };
  const query = useQuery({ queryKey: auditKeys.list(filters), queryFn: () => listAudit(filters), placeholderData: keepPreviousData });

  const entityLabel = (name: string) => t(`audit.entities.${name}`, { defaultValue: name });
  const actionLabel = (name: string) => t(`audit.actions.${name}`, { defaultValue: name });
  const userLabel = (item: AuditItem) => item.user_name || nameOf(item.user_id) || (item.user_id ? item.user_id.slice(0, 8) : t('audit.system'));

  const columns: Column<AuditItem>[] = [
    { key: 'at', header: t('audit.columns.at'), mono: true, width: 150, render: (a) => <DateText value={a.at} withTime /> },
    { key: 'user', header: t('audit.columns.user'), render: userLabel },
    {
      key: 'action',
      header: t('audit.columns.action'),
      render: (a) => <Badge tone={ACTION_TONE[a.action] ?? 'neutral'}>{actionLabel(a.action)}</Badge>,
    },
    { key: 'entity', header: t('audit.columns.entity'), render: (a) => entityLabel(a.entity) },
    {
      key: 'entity_id',
      header: t('audit.columns.entityId'),
      mono: true,
      render: (a) => (a.entity_id ? <span title={a.entity_id}>{a.entity_id.slice(0, 8)}</span> : <span className="u-faint">—</span>),
    },
    {
      key: 'changes',
      header: t('audit.columns.changes'),
      render: (a) => {
        if (!a.before || !a.after) return <span className="u-faint">—</span>;
        const fields = changedFields(a);
        return (
          <span className="audit-fields">
            <span className="u-mono">{fields.slice(0, 3).join(', ')}</span>
            {fields.length > 3 && ` +${fields.length - 3}`}
          </span>
        );
      },
    },
  ];

  const total = query.data?.total ?? 0;
  const active = Boolean(entity || entityId || userId);

  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />

      <FilterBar active={active} onReset={() => setParams(new URLSearchParams(limit !== 50 ? { limit: String(limit) } : {}), { replace: true })}>
        <Field label={t('audit.filters.entity')}>
          <Select
            value={entity}
            onChange={(e) => setParam({ entity: e.target.value })}
            placeholder={t('audit.filters.entityAll')}
            options={AUDIT_ENTITIES.map((value) => ({ value, label: entityLabel(value) })).sort((a, b) => a.label.localeCompare(b.label, 'el'))}
          />
        </Field>
        <Field label={t('audit.filters.user')}>
          <UserSelect value={userId || null} onChange={(id) => setParam({ user_id: id })} emptyLabel={t('audit.filters.userAll')} />
        </Field>
        <Field
          label={t('audit.filters.entityId')}
          error={entityIdValid ? undefined : t('audit.filters.entityIdPlaceholder')}
          className="audit-filter-id"
        >
          <Input
            value={entityId}
            onChange={(e) => setParam({ entity_id: e.target.value })}
            placeholder={t('audit.filters.entityIdPlaceholder')}
            spellCheck={false}
            className="u-mono"
          />
        </Field>
      </FilterBar>

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
      ) : (
        <>
          <Table
            caption={t('audit.title')}
            columns={columns}
            rows={query.data?.items}
            loading={query.isPending || query.isPlaceholderData}
            onRowClick={setSelected}
            dense
            emptyTitle={active ? t('common:state.emptyFiltered') : t('audit.empty')}
          />
          <div className="u-row u-row--between" style={{ marginTop: 'var(--sp-3)' }}>
            <Field label={t('audit.filters.pageSize')} hideLabel>
              <Select
                value={String(limit)}
                onChange={(e) => setParam({ limit: Number(e.target.value) === 50 ? null : e.target.value })}
                options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / ${t('audit.filters.pageSize').toLowerCase()}` }))}
                style={{ width: 'auto' }}
              />
            </Field>
            <Pagination offset={offset} limit={limit} total={total} onChange={(next) => setParam({ offset: next })} />
          </div>
        </>
      )}

      <AuditDetail
        item={selected}
        onClose={() => setSelected(null)}
        userLabel={userLabel}
        entityLabel={entityLabel}
        actionLabel={actionLabel}
        onFilterRecord={(item) => {
          setSelected(null);
          setParams(new URLSearchParams({ entity: item.entity, entity_id: item.entity_id ?? '' }), { replace: true });
        }}
      />
    </>
  );
}

function Value({ value }: { value: Json | undefined }) {
  const { t } = useTranslation('admin');
  if (value === undefined || value === null || value === '') return <span className="audit-diff__null">{t('audit.diff.empty')}</span>;
  if (typeof value === 'object') return <>{JSON.stringify(value, null, 2)}</>;
  return <>{String(value)}</>;
}

interface AuditDetailProps {
  item: AuditItem | null;
  onClose: () => void;
  userLabel: (item: AuditItem) => string;
  entityLabel: (name: string) => string;
  actionLabel: (name: string) => string;
  onFilterRecord: (item: AuditItem) => void;
}

function AuditDetail({ item, onClose, userLabel, entityLabel, actionLabel, onFilterRecord }: AuditDetailProps) {
  const { t } = useTranslation('admin');
  const [onlyChanged, setOnlyChanged] = useState(true);
  if (!item) return null;

  const rows = diffAudit(item);
  const isUpdate = Boolean(item.before && item.after);
  const visible = isUpdate && onlyChanged ? rows.filter((r) => r.changed) : rows;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${actionLabel(item.action)} · ${entityLabel(item.entity)}`}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
      }
    >
      <dl className="audit-meta">
        <dt>{t('audit.columns.at')}</dt>
        <dd>
          <DateText value={item.at} withTime withWeekday />
        </dd>
        <dt>{t('audit.columns.user')}</dt>
        <dd>{userLabel(item)}</dd>
        <dt>{t('audit.columns.entityId')}</dt>
        <dd className="u-mono">{item.entity_id ?? '—'}</dd>
      </dl>

      <div className="audit-diff-tools">
        {isUpdate ? (
          <Checkbox label={t('audit.diff.onlyChanged')} checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
        ) : (
          <span />
        )}
        {item.entity_id && (
          <Button size="sm" variant="ghost" icon="history" onClick={() => onFilterRecord(item)}>
            {t('audit.diff.filterThis')}
          </Button>
        )}
      </div>

      <Table
        className="audit-diff"
        dense
        caption={t('audit.detailTitle')}
        rowKey={(r) => r.field}
        rows={visible}
        rowClassName={(r) => cx(isUpdate && r.changed && 'is-changed')}
        emptyTitle={t('audit.diff.noChanges')}
        columns={[
          { key: 'field', header: t('audit.diff.field'), mono: true },
          ...(item.before
            ? [{ key: 'before', header: t('audit.diff.before'), mono: true, className: 'audit-diff__before', render: (r: (typeof rows)[number]) => <Value value={r.before} /> }]
            : []),
          ...(item.after
            ? [{ key: 'after', header: t('audit.diff.after'), mono: true, className: 'audit-diff__after', render: (r: (typeof rows)[number]) => <Value value={r.after} /> }]
            : []),
        ]}
      />
    </Modal>
  );
}
