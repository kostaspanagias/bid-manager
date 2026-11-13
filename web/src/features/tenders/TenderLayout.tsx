import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';
import { errorMessage, isApiError } from '@/api/client';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { useWorkingDaysTo } from '@/features/shared/useHolidays';
import { athensDate, formatDate, formatTime, weekdayShort } from '@/lib/dates';
import { Badge, Button, EmptyState, Icon, LinkButton, PageSpinner, Tabs, TMinus, type TabItem } from '@/ui';
import { fetchTender, tenderKeys } from './tenderApi';
import { TenderBanners } from './TenderBanners';
import { TenderContext, type TenderContextValue } from './tenderContext';

export { useTender } from './tenderContext';

const TAB_KEYS = [
  'overview',
  'schedule',
  'gates',
  'register',
  'tasks',
  'watch',
  'risks',
  'changes',
  'files',
  'documents',
  'lessons',
  'team',
] as const;

/**
 * /tenders/:tenderId — loads the tender, renders the header (title, authority, status, T, T−n), the banner slot
 * and the tabs, and provides useTender() to the tab routes rendered in the <Outlet/>.
 */
export function TenderLayout() {
  const { t } = useTranslation('tenders');
  const { tenderId = '' } = useParams();
  const location = useLocation();

  const query = useQuery({
    queryKey: tenderKeys.record(tenderId),
    queryFn: () => fetchTender(tenderId),
    enabled: Boolean(tenderId),
  });

  const detail = query.data;
  const tender = detail?.tender;
  const T = tender ? (athensDate(tender.submission_deadline_at) ?? '') : '';
  const computedTMinus = useWorkingDaysTo(T || null);
  const { refetch } = query;

  const ctx = useMemo<TenderContextValue | null>(() => {
    if (!detail || !tender) return null;
    const isActive = tender.status === 'evaluation' || tender.status === 'in_progress';
    return {
      tender,
      tenderId: tender.id,
      T,
      tMinus: detail.tMinus ?? computedTMinus,
      isActive,
      canWrite: detail.canWrite,
      canSeeFinancial: detail.canSeeFinancial,
      canManage: detail.canManage,
      warnings: detail.warnings,
      nextGate: detail.nextGate,
      refetch,
    };
  }, [detail, tender, T, computedTMinus, refetch]);

  if (query.isPending) return <PageSpinner />;

  if (query.isError || !ctx || !tender) {
    const notFound = isApiError(query.error) && (query.error.status === 404 || query.error.status === 403);
    return (
      <EmptyState
        icon={notFound ? 'search' : 'alert'}
        title={notFound ? t('notFound.title') : t('loadFailed')}
        description={notFound ? t('notFound.description') : errorMessage(query.error)}
        action={
          <div className="u-row" style={{ justifyContent: 'center' }}>
            {!notFound && <Button onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>}
            <LinkButton to="/tenders" variant="primary">
              {t('notFound.back')}
            </LinkButton>
          </div>
        }
      />
    );
  }

  const tabs: TabItem[] = TAB_KEYS.map((key) => ({ key, to: key, label: t(`nav:tenderTabs.${key}`) }));

  return (
    <TenderContext.Provider value={ctx}>
      <header className="tender-head">
        <Link to="/tenders" className="tender-head__back">
          <Icon name="chevronLeft" size={14} />
          {t('header.back')}
        </Link>
        <div className="tender-head__row">
          <div className="tender-head__main">
            <h1 className="tender-head__title">{tender.title}</h1>
            <div className="tender-head__meta">
              <span className="tender-head__authority" title={t('header.authority')}>
                {tender.authority}
              </span>
              <StatusBadge kind="tender_status" value={tender.status} dot />
              {tender.compressed_mode && <Badge tone="orange">{t('header.compressed')}</Badge>}
              {!ctx.canWrite && (
                <Badge tone="neutral">
                  <Icon name="lock" size={12} /> {t('header.readOnly')}
                </Badge>
              )}
              {tender.adam && (
                <span className="tender-head__kv">
                  {t('header.adam')} <span className="u-mono">{tender.adam}</span>
                </span>
              )}
              {tender.esidis_no && (
                <span className="tender-head__kv">
                  {t('header.esidis')} <span className="u-mono">{tender.esidis_no}</span>
                </span>
              )}
            </div>
          </div>
          <dl className="tender-head__deadline">
            <div>
              <dt>{t('header.deadline')}</dt>
              <dd>
                <time dateTime={tender.submission_deadline_at}>
                  <small>{weekdayShort(tender.submission_deadline_at)}</small> {formatDate(tender.submission_deadline_at)}
                  <small>{formatTime(tender.submission_deadline_at)}</small>
                </time>
              </dd>
            </div>
            {ctx.isActive && <TMinus n={ctx.tMinus} />}
          </dl>
        </div>
      </header>

      <div className="tender-banners">
        <TenderBanners />
      </div>

      <Tabs className="tender-tabs" items={tabs} label={t('nav:tenderTabs.label')} />

      <ErrorBoundary resetKey={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </TenderContext.Provider>
  );
}
