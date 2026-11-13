import { gateShortName } from '@/lib/enums';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { cx } from '@/lib/cx';
import { formatDate, formatTMinus } from '@/lib/dates';
import { enumLabel } from '@/lib/enums';
import { Badge, DateText, ProgressBar, TMinus, tMinusTone } from '@/ui';
import type { DashboardTender } from './dashboardApi';
import { warningBadge, warningDetail } from './warnings';

const TYPES = ['exclusion', 'scored', 'formal'] as const;

/** One active tender at a glance: T−n, next gate, register coverage, overdue counts, warning badges. */
export function TenderCard({ tender }: { tender: DashboardTender }) {
  const { t } = useTranslation('dashboard');
  const base = `/tenders/${tender.id}`;
  const gate = tender.nextGate;
  const worst = tender.warnings.some((w) => w.tone === 'red') ? 'red' : tender.warnings.length > 0 ? 'orange' : null;
  const tone = tMinusTone(tender.tMinus);
  const { overdueTasks, overdueHandoffs, watchRequestOverdue } = tender.counts;
  const anyOverdue = overdueTasks + overdueHandoffs + watchRequestOverdue > 0;

  const gateWhen = !gate
    ? ''
    : gate.inWorkingDays === null
      ? t('tenders.gateNoDate')
      : gate.overdue
        ? t('tenders.gateOverdue', { count: Math.max(1, -gate.inWorkingDays) })
        : gate.inWorkingDays === 0
          ? t('tenders.gateToday')
          : t('tenders.gateIn', { count: gate.inWorkingDays });

  return (
    <article className={cx('dash-tender', worst && `dash-tender--${worst}`)}>
      <Link to={`${base}/schedule`} className={cx('dash-tender__t', `ui-tone-${tone}`)} title={t('tenders.deadline')}>
        <span className="dash-tender__tn">{formatTMinus(tender.tMinus)}</span>
        <span className="dash-tender__tleft">
          {tender.tMinus > 0 ? t('tenders.tminusLeft', { count: tender.tMinus }) : tender.tMinus === 0 ? t('tenders.tminusToday') : t('tenders.tminusPast')}
        </span>
        <span className="dash-tender__tdate">{formatDate(tender.T).slice(0, 5)}</span>
      </Link>

      <div className="dash-tender__main">
        <h3 className="dash-tender__title">
          <Link to={`${base}/overview`}>{tender.title}</Link>
        </h3>
        <p className="dash-tender__meta">
          {tender.authority && <span>{tender.authority}</span>}
          <StatusBadge kind="tender_status" value={tender.status} />
        </p>
        <p className="dash-tender__deadline">
          <span className="u-muted">{t('tenders.deadline')}: </span>
          <DateText value={tender.deadlineAt} withTime withWeekday />
        </p>
        {tender.warnings.length > 0 && (
          <ul className="dash-tender__badges">
            {tender.warnings.map((w) => (
              <li key={w.code}>
                <Link to={`${base}/${w.tab}`} title={[t(`warnings.${w.code}.title`), warningDetail(t, w)].filter(Boolean).join(' — ')}>
                  <Badge tone={w.tone} dot>
                    {warningBadge(t, w)}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dash-tender__col">
        <p className="dash-tender__label">{t('tenders.nextGate')}</p>
        {gate ? (
          <Link to={`${base}/gates`} className="dash-tender__gate">
            <span className="dash-tender__gate-head">
              <strong>{gate.key}</strong> {gateShortName(gate.key, gate.name)}
            </span>
            <span className={cx('dash-tender__gate-when', gate.overdue && 'u-text-red')}>
              <DateText value={gate.dueDate} withWeekday /> <TMinus n={gate.tMinus} tone="neutral" plain /> · {gateWhen}
            </span>
            <span className="dash-tender__gate-who">
              {gate.approver ? t('tenders.approver', { name: gate.approver.name ?? '—' }) : t('tenders.noApprover')}
              {gate.requested && (
                <>
                  {' '}
                  <Badge tone="info">{t('tenders.requested')}</Badge>
                </>
              )}
            </span>
          </Link>
        ) : (
          <p className="u-muted">{t('tenders.noGate')}</p>
        )}
      </div>

      <div className="dash-tender__col">
        <p className="dash-tender__label">
          <Link to={`${base}/register`}>{t('tenders.coverage')}</Link>
        </p>
        {tender.coverage.all.total === 0 ? (
          <p className="u-muted">{t('tenders.noRequirements')}</p>
        ) : (
          <div className="dash-tender__bars">
            {TYPES.filter((type) => tender.coverage[type].total > 0).map((type) => (
              <ProgressBar
                key={type}
                label={enumLabel('requirement_type', type)}
                value={tender.coverage[type].covered}
                max={tender.coverage[type].total}
                valueText={`${tender.coverage[type].covered}/${tender.coverage[type].total}`}
              />
            ))}
          </div>
        )}
      </div>

      <div className="dash-tender__col dash-tender__col--counts">
        <p className="dash-tender__label">{t('tenders.overdue')}</p>
        {anyOverdue ? (
          <ul className="dash-tender__counts">
            <Count to={`${base}/tasks`} n={overdueTasks} label={t('tenders.overdueTasks')} />
            <Count to={`${base}/tasks`} n={overdueHandoffs} label={t('tenders.overdueHandoffs')} />
            <Count to={`${base}/watch`} n={watchRequestOverdue} label={t('tenders.overdueWatch')} />
          </ul>
        ) : (
          <p className="u-text-green">{t('tenders.nothingOverdue')}</p>
        )}
      </div>
    </article>
  );
}

function Count({ to, n, label }: { to: string; n: number; label: string }) {
  if (n === 0) return null;
  return (
    <li>
      <Link to={to} className="dash-tender__count">
        <span className="dash-tender__count-n">{n}</span> {label}
      </Link>
    </li>
  );
}
