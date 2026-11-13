import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TASK_STATUSES, type TaskStatus } from '@/api/types';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { enumOptions } from '@/lib/enums';
import { Badge, Button, CellActions, Checkbox, ConfirmDialog, DateText, EmptyState, Field, FilterBar, Menu, Select, Table, type Column } from '@/ui';
import { OwnerSelect, useOwnerLabel, type OwnerValue } from './owner';
import type { TaskEditing } from './TaskModal';
import type { TaskList, TaskView } from './tasksApi';
import { useTaskActions } from './useTaskActions';

interface Props {
  data: TaskList;
  tenderId: string;
  canWrite: boolean;
  loading: boolean;
  onEdit: (editing: TaskEditing) => void;
}

const TASK_ONLY_STATUSES = TASK_STATUSES.filter((s) => s !== 'na');
const NO_OWNER: OwnerValue = { owner_user_id: null, owner_role_key: null };

/** Tasks (section `task`): table with filters, inline status, owner and due date. */
export function TasksView({ data, tenderId, canWrite, loading, onEdit }: Props) {
  const { t } = useTranslation('tasks');
  const { update, remove } = useTaskActions(tenderId);
  const ownerLabel = useOwnerLabel(data.roles);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'active' | TaskStatus>('active');
  const [owner, setOwner] = useState<OwnerValue>(NO_OWNER);
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [removing, setRemoving] = useState<TaskView | null>(null);

  const all = useMemo(() => data.items.filter((x) => x.section === 'task'), [data.items]);
  const rows = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('el');
    return all
      .filter((x) => (status === '' ? true : status === 'active' ? x.status === 'open' || x.status === 'in_progress' : x.status === status))
      .filter((x) => (owner.owner_user_id ? x.owner_user_id === owner.owner_user_id : owner.owner_role_key ? x.owner_role_key === owner.owner_role_key : true))
      .filter((x) => !onlyOverdue || x.overdue)
      .filter((x) => !onlyMine || x.owner_user_id !== null || data.me.role_keys.includes(x.owner_role_key ?? '') ? !onlyMine || isMine(x) : false)
      .filter((x) => !q || `${x.title} ${x.description ?? ''}`.toLocaleLowerCase('el').includes(q))
      .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.sort - b.sort);
    function isMine(x: TaskView) {
      return (x.owner_role_key !== null && data.me.role_keys.includes(x.owner_role_key)) || (x.owner_user_id !== null && x.owner_user_id === meId);
    }
  }, [all, search, status, owner, onlyOverdue, onlyMine, data.me.role_keys]);

  const filtersActive = search !== '' || status !== 'active' || owner.owner_user_id !== null || owner.owner_role_key !== null || onlyOverdue || onlyMine;
  const reset = () => {
    setSearch('');
    setStatus('active');
    setOwner(NO_OWNER);
    setOnlyOverdue(false);
    setOnlyMine(false);
  };
  const overdueCount = all.filter((x) => x.overdue).length;

  const columns: Column<TaskView>[] = [
    {
      key: 'title',
      header: t('common:labels.title'),
      wrap: true,
      className: 'tasks-col-title',
      render: (x) => (
        <>
          <span className={x.status === 'cancelled' ? 'tasks-struck' : undefined}>{x.title}</span>
          {x.milestone && <Badge className="tasks-chip">{x.milestone.key}</Badge>}
          {x.description && <div className="tasks-desc">{x.description}</div>}
        </>
      ),
    },
    {
      key: 'owner',
      header: t('common:labels.owner'),
      render: (x) =>
        canWrite ? (
          <OwnerSelect
            className="tasks-inline"
            aria-label={`${t('common:labels.owner')}: ${x.title}`}
            value={x}
            roles={data.roles}
            onChange={(v) => update.mutate({ id: x.id, body: v, silent: true })}
          />
        ) : (
          ownerLabel(x) || <span className="u-faint">{t('common:labels.unassigned')}</span>
        ),
    },
    {
      key: 'due_date',
      header: t('common:labels.dueDate'),
      mono: true,
      render: (x) => (
        <span className={x.overdue ? 'tasks-overdue' : undefined}>
          <DateText value={x.due_date} withWeekday />
          {x.overdue && <Badge tone="red">{t('common:state.overdue')}</Badge>}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('common:labels.status'),
      render: (x) =>
        canWrite ? (
          <Select
            className="tasks-inline"
            aria-label={`${t('common:labels.status')}: ${x.title}`}
            options={enumOptions('task_status', TASK_ONLY_STATUSES)}
            value={x.status}
            onChange={(e) => update.mutate({ id: x.id, body: { status: e.target.value as TaskStatus }, silent: true })}
          />
        ) : (
          <StatusBadge kind="task_status" value={x.status} />
        ),
    },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (x) =>
        canWrite && (
          <CellActions>
            <Menu
              label={`${t('common:actions.more')}: ${x.title}`}
              items={[
                { label: t('common:actions.edit'), icon: 'edit', onSelect: () => onEdit({ mode: 'edit', task: x }) },
                { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => setRemoving(x) },
              ]}
            />
          </CellActions>
        ),
    },
  ];

  return (
    <>
      <FilterBar
        search={{ value: search, onChange: setSearch, placeholder: t('tasks.search') }}
        active={filtersActive}
        onReset={reset}
        summary={t('tasks.summary', { count: rows.length, total: all.length })}
        actions={
          canWrite && (
            <Button variant="primary" icon="plus" onClick={() => onEdit({ mode: 'add', section: 'task' })}>
              {t('tasks.add')}
            </Button>
          )
        }
      >
        <Field label={t('common:labels.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} placeholder={t('common:labels.all')}>
            <option value="active">{t('tasks.statusActive')}</option>
            {enumOptions('task_status', TASK_ONLY_STATUSES).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('common:labels.owner')}>
          <OwnerSelect value={owner} onChange={setOwner} roles={data.roles} emptyLabel={t('common:labels.all')} />
        </Field>
        <div className="tasks-filter-checks">
          <Checkbox label={t('tasks.onlyOverdue', { count: overdueCount })} checked={onlyOverdue} onChange={(e) => setOnlyOverdue(e.target.checked)} />
          <Checkbox label={t('tasks.onlyMine')} checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
        </div>
      </FilterBar>

      <Table
        caption={t('views.tasks')}
        columns={columns}
        rows={rows}
        loading={loading}
        rowTone={(x) => (x.overdue ? 'red' : undefined)}
        rowClassName={(x) => (x.status === 'cancelled' || x.status === 'done' ? 'is-muted' : undefined)}
        empty={
          <EmptyState
            compact
            icon="inbox"
            title={all.length === 0 ? t('tasks.empty') : t('common:state.emptyFiltered')}
            description={all.length === 0 ? t('tasks.emptyHint') : undefined}
            action={
              all.length > 0 && filtersActive ? (
                <Button onClick={reset}>{t('common:actions.clearFilters')}</Button>
              ) : undefined
            }
          />
        }
      />

      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('tasks.removeTitle')}
        message={removing ? t('tasks.removeMessage', { title: removing.title }) : null}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate({ id: removing.id }, { onSettled: () => setRemoving(null) })}
      />
    </>
  );
}
