import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { cx } from '@/lib/cx';
import { formatDate, weekdayLong } from '@/lib/dates';
import { enumLabel } from '@/lib/enums';
import { Badge, Banner, Button, Card, DateText, EmptyState, LinkButton, PageHeader, PageSpinner } from '@/ui';
import { AttentionStrip } from './AttentionStrip';
import { dashboardKeys, fetchDashboard, type Dashboard } from './dashboardApi';
import { NotificationsCard } from './NotificationsCard';
import { TenderCard } from './TenderCard';
import './dashboard.css';

/** "/" — what needs attention today, across every tender the user can see. */
export function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const query = useQuery({ queryKey: dashboardKeys.all, queryFn: fetchDashboard, refetchOnWindowFocus: true });
  const data = query.data;

  if (query.isPending) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <PageSpinner />
      </>
    );
  }
  if (query.isError || !data) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Banner tone="red" title={t('loadFailed')} actions={<Button size="sm" onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>}>
          {errorMessage(query.error)}
        </Banner>
      </>
    );
  }

  const canCreate = data.permissions.canCreateTender;
  const subtitle = `${t('today', { weekday: weekdayLong(data.today), date: formatDate(data.today) })} · ${t('activeCount', { count: data.tenders.length })}`;

  return (
    <div className="dash">
      <PageHeader
        title={t('title')}
        subtitle={subtitle}
        actions={
          canCreate &&
          data.tenders.length > 0 && (
            <LinkButton to="/tenders/new" variant="primary" icon="plus">
              {t('newTender')}
            </LinkButton>
          )
        }
      />

      <AttentionStrip items={data.attention} />
      <MyItems my={data.my} />

      <section aria-labelledby="dash-tenders">
        <h2 id="dash-tenders" className="dash__heading">
          {t('tenders.title')}
        </h2>
        {data.tenders.length === 0 ? (
          <Card>
            <EmptyState
              icon="folder"
              title={t('empty.title')}
              description={canCreate ? t('empty.manager') : t('empty.member')}
              action={
                canCreate && (
                  <LinkButton to="/tenders/new" variant="primary" icon="plus">
                    {t('empty.action')}
                  </LinkButton>
                )
              }
            />
          </Card>
        ) : (
          <div className="dash__tenders">
            {data.tenders.map((tender) => (
              <TenderCard key={tender.id} tender={tender} />
            ))}
          </div>
        )}
      </section>

      <div className="dash__grid">
        {data.org && <OrgDocuments docs={data.org.documents} />}
        <RecentlyClosed items={data.recentlyClosed} />
        <NotificationsCard />
      </div>
    </div>
  );
}

function MyItems({ my }: { my: Dashboard['my'] }) {
  const { t } = useTranslation('dashboard');
  const tiles = [
    { key: 'overdue', n: my.overdue, tone: 'red' },
    { key: 'today', n: my.today, tone: 'orange' },
    { key: 'upcoming', n: my.upcoming, tone: 'neutral' },
    { key: 'waiting', n: my.waiting, tone: 'info' },
  ] as const;
  return (
    <section className="dash-my" aria-labelledby="dash-my">
      <div className="dash-my__head">
        <h2 id="dash-my" className="dash__heading">
          {t('my.title')}
        </h2>
        <Link to="/my" className="dash-my__all">
          {t('my.open')} →
        </Link>
      </div>
      <ul className="dash-my__tiles">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <Link to="/my" className={cx('dash-my__tile', tile.n > 0 && `ui-tone-${tile.tone} is-active`)}>
              <span className="dash-my__n">{tile.n}</span>
              <span className="dash-my__label">{t(`my.${tile.key}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OrgDocuments({ docs }: { docs: NonNullable<Dashboard['org']>['documents'] }) {
  const { t } = useTranslation('dashboard');
  const tone = docs.expired > 0 ? 'red' : docs.expiring > 0 ? 'orange' : undefined;
  return (
    <Card
      title={t('orgDocs.title')}
      subtitle={t('orgDocs.subtitle')}
      tone={tone}
      actions={
        <LinkButton to="/company-documents" size="sm" variant="ghost">
          {t('orgDocs.open')}
        </LinkButton>
      }
    >
      {docs.items.length === 0 ? (
        <p className="u-text-green">{t('orgDocs.none')}</p>
      ) : (
        <>
          <p className="u-row dash-docs__summary">
            {docs.expired > 0 && (
              <Badge tone="red" dot>
                {t('orgDocs.expired')}: {docs.expired}
              </Badge>
            )}
            {docs.expiring > 0 && (
              <Badge tone="orange" dot>
                {t('orgDocs.expiring')}: {docs.expiring}
              </Badge>
            )}
          </p>
          <ul className="dash-list">
            {docs.items.map((d) => (
              <li key={d.id} className="dash-list__row">
                <span className="dash-list__main">
                  <span className="dash-list__title">{d.title}</span>
                  {enumLabel('company_document_type', d.type) !== d.title && <span className="u-muted"> · {enumLabel('company_document_type', d.type)}</span>}
                </span>
                <span className={cx('dash-list__side', d.expired ? 'u-text-red' : 'u-text-orange')}>
                  <DateText value={d.expires_at} />{' '}
                  <span className="dash-list__note">
                    {d.expired ? t('orgDocs.expiredOn') : d.daysLeft === 0 ? t('orgDocs.expiresToday') : t('orgDocs.daysLeft', { count: d.daysLeft })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function RecentlyClosed({ items }: { items: Dashboard['recentlyClosed'] }) {
  const { t } = useTranslation('dashboard');
  return (
    <Card title={t('closed.title')} subtitle={t('closed.subtitle')}>
      {items.length === 0 ? (
        <p className="u-muted">{t('closed.none')}</p>
      ) : (
        <ul className="dash-list">
          {items.map((c) => (
            <li key={c.id} className="dash-list__row">
              <span className="dash-list__main">
                <Link to={`/tenders/${c.id}/overview`} className="dash-list__title">
                  {c.title}
                </Link>
                {c.authority && <span className="u-muted"> · {c.authority}</span>}
              </span>
              <span className="dash-list__side">
                <StatusBadge kind="tender_status" value={c.status} /> <DateText value={c.closedAt ?? c.T} />{' '}
                <Link to={`/tenders/${c.id}/lessons`}>{t('closed.lessons')}</Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
