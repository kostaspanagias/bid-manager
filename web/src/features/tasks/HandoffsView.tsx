import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUsers } from '@/features/shared/useUsers';
import { formatDateTime } from '@/lib/dates';
import { Badge, Banner, Button, CellActions, ConfirmDialog, DateText, EmptyState, Field, Menu, Modal, Table, Textarea, type Column, type Tone } from '@/ui';
import { roleName } from './owner';
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

export function handoffBadge(x: TaskView): { tone: Tone; key: string } {
  if (x.status === 'na') return { tone: 'neutral', key: 'na' };
  if (x.status === 'cancelled') return { tone: 'neutral', key: 'cancelled' };
  const state = x.handoff?.state ?? 'pending';
  if (state === 'received') return { tone: 'green', key: 'received' };
  if (x.overdue) return { tone: 'red', key: state === 'delivered' ? 'deliveredLate' : 'pendingLate' };
  return state === 'delivered' ? { tone: 'info', key: 'delivered' } : { tone: 'neutral', key: 'pending' };
}

/** Handoffs (F6): «Από → Προς», what, when; the sender delivers, the recipient confirms receipt. */
export function HandoffsView({ data, tenderId, canWrite, loading, onEdit }: Props) {
  const { t } = useTranslation('tasks');
  const { nameOf } = useUsers();
  const { update, remove, handoff } = useTaskActions(tenderId);
  const [receiving, setReceiving] = useState<TaskView | null>(null);
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<TaskView | null>(null);

  const rows = data.items
    .filter((x) => x.section === 'handoff')
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.sort - b.sort);
  const waiting = rows.filter((x) => x.handoff?.can_receive && !x.handoff.receive_needs_note && x.handoff.state === 'delivered');

  const receive = (x: TaskView) => {
    if (x.handoff?.receive_needs_note) {
      setNote('');
      setReceiving(x);
    } else handoff.mutate({ id: x.id, action: 'receive' });
  };

  const columns: Column<TaskView>[] = [
    {
      key: 'route',
      header: t('handoffs.route'),
      render: (x) => (
        <span className="handoff-route">
          <strong>{roleName(data.roles, x.handoff_from_role)}</strong>
          <span aria-hidden="true">→</span>
          <span className="u-sr-only">{t('handoffs.to')}</span>
          <strong>{roleName(data.roles, x.handoff_to_role)}</strong>
        </span>
      ),
    },
    {
      key: 'title',
      header: t('handoffs.what'),
      wrap: true,
      className: 'tasks-col-title',
      render: (x) => (
        <>
          {x.title}
          {x.description && <div className="tasks-desc">{x.description}</div>}
        </>
      ),
    },
    {
      key: 'due_date',
      header: t('handoffs.when'),
      mono: true,
      render: (x) => <DateText value={x.due_date} withWeekday />,
    },
    {
      key: 'state',
      header: t('common:labels.status'),
      render: (x) => {
        const b = handoffBadge(x);
        const h = x.handoff;
        return (
          <div className="handoff-state">
            <Badge tone={b.tone} dot>
              {t(`handoffs.state.${b.key}`)}
            </Badge>
            {h?.state === 'received' && x.received_at && (
              <span className="tasks-desc">
                {t(h.received_by_override ? 'handoffs.receivedByOverride' : 'handoffs.receivedBy', { name: nameOf(x.received_by) || '—', at: formatDateTime(x.received_at) })}
              </span>
            )}
            {h?.state === 'delivered' && h.delivered_at && (
              <span className="tasks-desc">{t('handoffs.deliveredBy', { name: nameOf(h.delivered_by) || '—', at: formatDateTime(h.delivered_at) })}</span>
            )}
            {(h?.receive_note || (h?.state === 'delivered' && h.delivery_note)) && <span className="tasks-desc">«{h.receive_note ?? h.delivery_note}»</span>}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (x) => {
        const h = x.handoff;
        if (!canWrite || !h) return null;
        const live = x.status === 'open' || x.status === 'in_progress';
        return (
          <CellActions>
            {h.can_receive && (h.state === 'delivered' || !h.can_deliver) && (
              <Button size="sm" variant="primary" icon="check" loading={handoff.isPending && handoff.variables?.id === x.id} onClick={() => receive(x)}>
                {t('handoffs.receive')}
              </Button>
            )}
            {h.can_deliver && (
              <Button size="sm" icon="upload" loading={handoff.isPending && handoff.variables?.id === x.id} onClick={() => handoff.mutate({ id: x.id, action: 'deliver' })}>
                {t('handoffs.deliver')}
              </Button>
            )}
            <Menu
              label={`${t('common:actions.more')}: ${x.title}`}
              items={[
                { label: t('common:actions.edit'), icon: 'edit', onSelect: () => onEdit({ mode: 'edit', task: x }) },
                h.can_receive && h.can_deliver && h.state === 'pending' && { label: t('handoffs.receiveDirect'), icon: 'check', onSelect: () => receive(x) },
                live && h.state === 'delivered' && (data.me.can_manage || data.me.role_keys.includes(x.handoff_from_role ?? '')) && {
                  label: t('handoffs.undoDeliver'),
                  icon: 'history',
                  onSelect: () => handoff.mutate({ id: x.id, action: 'undo-deliver' }),
                },
                h.can_undo_receive && { label: t('handoffs.undoReceive'), icon: 'history', onSelect: () => handoff.mutate({ id: x.id, action: 'undo-receive' }) },
                data.me.can_manage && live && { label: t('handoffs.markNa'), icon: 'block', separatorBefore: true, onSelect: () => update.mutate({ id: x.id, body: { status: 'na' } }) },
                data.me.can_manage && (x.status === 'na' || x.status === 'cancelled') && { label: t('handoffs.reopen'), icon: 'history', onSelect: () => update.mutate({ id: x.id, body: { status: 'open' } }) },
                !x.from_template && h.state !== 'received' && { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => setRemoving(x) },
              ]}
            />
          </CellActions>
        );
      },
    },
  ];

  return (
    <>
      {waiting.length > 0 && (
        <Banner tone="info" title={t('handoffs.waitingTitle', { count: waiting.length })}>
          {waiting.map((x) => x.title).join(' · ')}
        </Banner>
      )}
      <div className="tasks-toolbar">
        <p className="u-muted">{t('handoffs.hint')}</p>
        {canWrite && (
          <Button icon="plus" onClick={() => onEdit({ mode: 'add', section: 'handoff' })}>
            {t('handoffs.add')}
          </Button>
        )}
      </div>
      <Table
        caption={t('views.handoffs')}
        columns={columns}
        rows={rows}
        loading={loading}
        rowTone={(x) => (x.overdue ? 'red' : x.handoff?.state === 'received' ? 'green' : undefined)}
        rowClassName={(x) => (x.status === 'na' || x.status === 'cancelled' ? 'is-muted' : undefined)}
        empty={<EmptyState compact icon="inbox" title={t('handoffs.empty')} description={t('handoffs.emptyHint')} />}
      />

      <Modal
        open={receiving !== null}
        onClose={() => setReceiving(null)}
        size="sm"
        title={t('handoffs.overrideTitle')}
        description={receiving ? t('handoffs.overrideHint', { role: roleName(data.roles, receiving.handoff_to_role) }) : undefined}
        onSubmit={() => {
          if (receiving && note.trim()) handoff.mutate({ id: receiving.id, action: 'receive', note: note.trim() }, { onSuccess: () => setReceiving(null) });
        }}
        footer={
          <>
            <Button onClick={() => setReceiving(null)}>{t('common:actions.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!note.trim()} loading={handoff.isPending}>
              {t('handoffs.receive')}
            </Button>
          </>
        }
      >
        <Field label={t('handoffs.overrideNote')} required>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
        </Field>
      </Modal>
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('handoffs.removeTitle')}
        message={removing ? t('tasks.removeMessage', { title: removing.title }) : null}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate({ id: removing.id }, { onSettled: () => setRemoving(null) })}
      />
    </>
  );
}
