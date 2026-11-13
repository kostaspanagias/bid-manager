import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { useTaskActions } from '@/features/tasks/useTaskActions';
import { Badge, Banner, Button, Card, DateText, EmptyState, LinkButton, PageHeader, PageSpinner, type Tone } from '@/ui';
import { fetchMyWork, MY_BUCKETS, myKeys, type MyBucket, type MyItem } from './myApi';
import './my.css';

const BUCKET_TONE: Record<MyBucket, Tone | undefined> = { overdue: 'red', today: 'orange', soon: 'info', later: undefined };

function href(item: MyItem): string {
  const view = item.kind === 'checklist' ? '?view=checklists' : item.kind === 'handoff_deliver' || item.kind === 'handoff_receive' ? '?view=handoffs' : '';
  return `/tenders/${item.tender_id}/${item.tab}${view}`;
}

/** /my — everything waiting for the current user across the active tenders, overdue first. */
export function MyWorkPage() {
  const { t } = useTranslation('my');
  const query = useQuery({ queryKey: myKeys.all, queryFn: fetchMyWork, refetchOnWindowFocus: true });
  const { update, handoff } = useTaskActions();
  const data = query.data;
  const busy = (item: MyItem) => (update.isPending && update.variables?.id === item.id) || (handoff.isPending && handoff.variables?.id === item.id);

  const action = (item: MyItem) => {
    const where = { tenderId: item.tender_id, id: item.id };
    switch (item.kind) {
      case 'task':
      case 'checklist':
        return (
          <Button size="sm" icon="check" loading={busy(item)} onClick={() => update.mutate({ ...where, body: { status: 'done' } })}>
            {t('actions.done')}
          </Button>
        );
      case 'handoff_receive':
        return (
          <Button size="sm" variant="primary" icon="check" loading={busy(item)} onClick={() => handoff.mutate({ ...where, action: 'receive' })}>
            {t('actions.receive')}
          </Button>
        );
      case 'handoff_deliver':
        return (
          <Button size="sm" icon="upload" loading={busy(item)} onClick={() => handoff.mutate({ ...where, action: 'deliver' })}>
            {t('actions.deliver')}
          </Button>
        );
      default:
        return (
          <LinkButton size="sm" to={href(item)}>
            {t(item.kind === 'gate' ? 'actions.openGate' : 'actions.openWatch')}
          </LinkButton>
        );
    }
  };

  const note = (item: MyItem): string | null => {
    if (item.kind === 'handoff_receive') return t(item.info.delivered ? 'notes.delivered' : 'notes.notDelivered', { from: item.info.from_role_name ?? item.info.from_role ?? '—' });
    if (item.kind === 'handoff_deliver') return t('notes.toDeliver', { to: item.info.to_role_name ?? item.info.to_role ?? '—' });
    if (item.kind === 'watch') return t(`notes.watch.${item.info.request_overdue ? 'request_overdue' : (item.info.state ?? 'not_requested')}`);
    if (item.kind === 'gate') return t(item.info.requested ? 'notes.gateRequested' : 'notes.gatePending');
    return item.via === 'role' && item.role_key ? t('notes.viaRole', { role: item.role_name ?? item.role_key }) : null;
  };

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
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
      ) : data.counts.total === 0 ? (
        <EmptyState icon="checkCircle" title={t('empty')} description={t('emptyHint')} action={<LinkButton to="/tenders">{t('toTenders')}</LinkButton>} />
      ) : (
        <div className="u-stack">
          <ul className="my-counts" aria-label={t('summary')}>
            {MY_BUCKETS.map((b) => (
              <li key={b} className={`my-count${data.counts[b] > 0 && BUCKET_TONE[b] ? ` ui-tone-${BUCKET_TONE[b]}` : ''}`}>
                <a href={`#my-${b}`}>
                  <strong>{data.counts[b]}</strong>
                  <span>{t(`buckets.${b}`)}</span>
                </a>
              </li>
            ))}
          </ul>
          {MY_BUCKETS.filter((b) => data.groups[b].length > 0).map((b) => (
            <Card
              key={b}
              flush
              tone={BUCKET_TONE[b]}
              title={<span id={`my-${b}`}>{t(`buckets.${b}`)}</span>}
              subtitle={b === 'soon' ? t('soonHint', { date: data.horizon.split('-').reverse().join('/') }) : undefined}
              actions={<Badge tone={BUCKET_TONE[b] ?? 'neutral'}>{data.groups[b].length}</Badge>}
            >
              <ul className="my-list">
                {data.groups[b].map((item) => {
                  const extra = note(item);
                  return (
                    <li key={`${item.kind}-${item.id}`} className={`my-item${b === 'overdue' ? ' is-overdue' : ''}`}>
                      <div className="my-item__main">
                        <div className="my-item__title">
                          <Badge tone={item.kind === 'gate' ? 'info' : 'neutral'}>{t(`kinds.${item.kind}`)}</Badge>
                          <Link to={href(item)}>{item.title}</Link>
                        </div>
                        <div className="my-item__meta">
                          <Link to={`/tenders/${item.tender_id}`} className="my-item__tender">
                            {item.tender_title}
                          </Link>
                          {extra && <span>· {extra}</span>}
                        </div>
                      </div>
                      <div className="my-item__date">
                        {item.date ? <DateText value={item.date} withWeekday /> : <span className="u-faint">{t('noDate')}</span>}
                        {b === 'overdue' && <Badge tone="red">{t('common:state.overdue')}</Badge>}
                      </div>
                      <div className="my-item__action">{action(item)}</div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
