import { useTranslation } from 'react-i18next';
import { useUsers } from '@/features/shared/useUsers';
import { Badge, Button, Card, EmptyState, Menu, ProgressBar } from '@/ui';
import type { TaskEditing } from './TaskModal';
import type { TaskList, TaskView } from './tasksApi';
import { useTaskActions } from './useTaskActions';

interface Props {
  data: TaskList;
  tenderId: string;
  canWrite: boolean;
  onEdit: (editing: TaskEditing) => void;
}

/** Checklists per role: tick a line, or mark it «Δ/Α» (never deleted — blueprint). Progress ignores Δ/Α lines. */
export function ChecklistsView({ data, tenderId, canWrite, onEdit }: Props) {
  const { t } = useTranslation('tasks');
  const { nameOf } = useUsers();
  const { update, remove } = useTaskActions(tenderId);
  const lines = data.items.filter((x) => x.section === 'checklist');

  const keys: Array<string | null> = data.roles.map((r) => r.key);
  for (const x of lines) if (!keys.includes(x.owner_role_key)) keys.push(x.owner_role_key);
  const groups = keys
    .map((key) => {
      const role = data.roles.find((r) => r.key === key);
      const items = lines.filter((x) => x.owner_role_key === key).sort((a, b) => a.sort - b.sort);
      const off = items.filter((x) => x.status === 'na' || x.status === 'cancelled').length;
      return { key, role, items, applicable: items.length - off, done: items.filter((x) => x.status === 'done').length, off };
    })
    .filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon="check"
        title={t('checklists.empty')}
        description={t('checklists.emptyHint')}
        action={
          canWrite ? (
            <Button variant="primary" icon="plus" onClick={() => onEdit({ mode: 'add', section: 'checklist' })}>
              {t('checklists.add')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const setStatus = (x: TaskView, status: TaskView['status']) => update.mutate({ id: x.id, body: { status }, silent: true });

  return (
    <div className="checklists">
      {groups.map((g) => {
        const mine = g.key !== null && data.me.role_keys.includes(g.key);
        const people = (g.role?.user_ids ?? []).map((id) => nameOf(id)).filter(Boolean).join(', ');
        const name = g.role?.name ?? g.key ?? t('checklists.noRole');
        return (
          <Card
            key={g.key ?? '-'}
            title={
              <>
                {name}
                {mine && <Badge tone="info" className="tasks-chip">{t('checklists.mine')}</Badge>}
              </>
            }
            subtitle={people || undefined}
            actions={
              canWrite && (
                <Button size="sm" variant="ghost" icon="plus" onClick={() => onEdit({ mode: 'add', section: 'checklist', roleKey: g.key ?? undefined })}>
                  {t('checklists.addLine')}
                </Button>
              )
            }
          >
            <ProgressBar
              label={t('checklists.progress')}
              value={g.done}
              max={Math.max(g.applicable, 1)}
              valueText={g.off > 0 ? t('checklists.progressWithNa', { done: g.done, total: g.applicable, na: g.off }) : `${g.done}/${g.applicable}`}
              tone={g.applicable === 0 ? 'neutral' : 'auto'}
            />
            <ul className="checklist">
              {g.items.map((x) => {
                const off = x.status === 'na' || x.status === 'cancelled';
                const id = `chk-${x.id}`;
                return (
                  <li key={x.id} className={`checklist__item${off ? ' is-off' : ''}${x.status === 'done' ? ' is-done' : ''}`}>
                    <input
                      id={id}
                      type="checkbox"
                      className="checklist__box"
                      checked={x.status === 'done'}
                      disabled={!canWrite || off}
                      onChange={(e) => setStatus(x, e.target.checked ? 'done' : 'open')}
                    />
                    <label htmlFor={id} className="checklist__text">
                      {x.title}
                      {x.description && <span className="tasks-desc">{x.description}</span>}
                    </label>
                    {off && <Badge>{t(x.status === 'na' ? 'checklists.na' : 'common:enums.task_status.cancelled')}</Badge>}
                    {canWrite && (
                      <span className="checklist__actions">
                        <Button size="sm" variant={off ? 'secondary' : 'ghost'} aria-pressed={x.status === 'na'} title={t('checklists.naHint')} onClick={() => setStatus(x, x.status === 'na' ? 'open' : 'na')}>
                          {x.status === 'na' ? t('checklists.applies') : t('checklists.na')}
                        </Button>
                        <Menu
                          label={`${t('common:actions.more')}: ${x.title}`}
                          items={[
                            { label: t('common:actions.edit'), icon: 'edit', onSelect: () => onEdit({ mode: 'edit', task: x }) },
                            // Template lines are never deleted (Δ/Α instead); only lines the team added by hand.
                            !x.from_template && { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => remove.mutate({ id: x.id }) },
                          ]}
                        />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
