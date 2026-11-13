import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { useTender } from '@/features/tenders/tenderContext';
import { Banner, Button, PageHeader, PageSpinner, Tabs } from '@/ui';
import { ChecklistsView } from './ChecklistsView';
import { HandoffsView } from './HandoffsView';
import { TaskModal, type TaskEditing } from './TaskModal';
import { listTasks, tasksKeys } from './tasksApi';
import { TasksView } from './TasksView';
import './tasks.css';

const VIEWS = ['tasks', 'checklists', 'handoffs'] as const;
type View = (typeof VIEWS)[number];

/** /tenders/:tenderId/tasks — three views over the tender's `task` rows: Tasks, Checklists per role, Handoffs. */
export function TasksTab() {
  const { t } = useTranslation('tasks');
  const { tenderId, canWrite } = useTender();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<TaskEditing>(null);
  const view: View = (VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as View) : 'tasks';

  const query = useQuery({ queryKey: tasksKeys.list(tenderId), queryFn: () => listTasks(tenderId) });
  const data = query.data;
  const items = data?.items ?? [];
  const open = (x: { status: string }) => x.status === 'open' || x.status === 'in_progress';
  const count = (section: string) => items.filter((x) => x.section === section && open(x)).length;
  const late = (section: string) => items.some((x) => x.section === section && x.overdue);

  return (
    <>
      <PageHeader level={2} title={t('title')} subtitle={t('subtitle')} />
      <Tabs
        label={t('title')}
        className="tasks-views"
        value={view}
        onChange={(key) => setParams(key === 'tasks' ? {} : { view: key }, { replace: true })}
        items={[
          { key: 'tasks', label: t('views.tasks'), count: count('task'), countTone: late('task') ? 'red' : undefined },
          { key: 'checklists', label: t('views.checklists'), count: count('checklist') },
          { key: 'handoffs', label: t('views.handoffs'), count: count('handoff'), countTone: late('handoff') ? 'red' : undefined },
        ]}
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
      ) : !data ? (
        <PageSpinner />
      ) : view === 'tasks' ? (
        <TasksView data={data} tenderId={tenderId} canWrite={canWrite} loading={query.isPending} onEdit={setEditing} />
      ) : view === 'checklists' ? (
        <ChecklistsView data={data} tenderId={tenderId} canWrite={canWrite} onEdit={setEditing} />
      ) : (
        <HandoffsView data={data} tenderId={tenderId} canWrite={canWrite} loading={query.isPending} onEdit={setEditing} />
      )}
      <TaskModal editing={editing} tenderId={tenderId} roles={data?.roles ?? []} onClose={() => setEditing(null)} />
    </>
  );
}
