import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { useTender } from '@/features/tenders/tenderContext';
import { cx } from '@/lib/cx';
import { formatDate, weekdayLong, weekdayShort } from '@/lib/dates';
import { enumLabel } from '@/lib/enums';
import { Badge, Banner, Button, DateInput, DateText, EmptyState, Field, Icon, Menu, Modal, PageHeader, PageSpinner, TMinus, useToast, type MenuItem } from '@/ui';
import { DeadlineDialog } from './DeadlineDialog';
import { fetchSchedule, formatOffset, patchMilestone, resetMilestone, scheduleKeys, type ScheduleMilestone, type ScheduleResponse } from './scheduleApi';
import './schedule.css';

/** How the date was derived, e.g. «T−8», «G0+2», «στόχος T0+3 · αργότερο 21/04/2027». */
function useRuleText() {
  const { t } = useTranslation('schedule');
  return (m: ScheduleMilestone): string => {
    const cf = m.computed_from;
    if (!cf || !cf.anchor) return t('rule.none');
    const cal = t('rule.calendar');
    if (cf.rule === 'compressed' && cf.compressed) return t('rule.compressed', { rule: formatOffset(cf.compressed, cal), normal: formatOffset(cf, cal) });
    if (cf.target && cf.rule === 'target') return t('rule.target', { target: formatOffset(cf.target, cal), latest: formatOffset(cf, cal), latestDate: formatDate(cf.latest_date) });
    if (cf.target && cf.rule === 'latest') return t('rule.latest', { target: formatOffset(cf.target, cal), latest: formatOffset(cf, cal), targetDate: formatDate(cf.target_date) });
    return formatOffset(cf, cal);
  };
}

/** Schedule tab (F3): the reverse timeline from T0 to T with gates, milestones and handoffs. */
export function ScheduleTab() {
  const { t } = useTranslation('schedule');
  const { tender, tenderId, canWrite, canManage, T } = useTender();
  const toast = useToast();
  const queryClient = useQueryClient();
  const ruleText = useRuleText();
  const [editing, setEditing] = useState<ScheduleMilestone | null>(null);
  const [deadlineOpen, setDeadlineOpen] = useState(false);

  const query = useQuery({ queryKey: scheduleKeys.list(tenderId), queryFn: () => fetchSchedule(tenderId) });
  const applied = async (data: ScheduleResponse) => {
    queryClient.setQueryData(scheduleKeys.list(tenderId), data);
    // handoff tasks, watch items and gates mirror milestone dates
    await queryClient.invalidateQueries({ queryKey: ['tenders', tenderId], predicate: (q) => q.queryKey[2] !== 'milestones' });
  };
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof patchMilestone>[2] }) => patchMilestone(tenderId, id, body),
    onSuccess: async (data) => {
      await applied(data);
      toast.success(t('common:state.saved'));
      setEditing(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reset = useMutation({
    mutationFn: (id: string) => resetMilestone(tenderId, id),
    onSuccess: async (data) => {
      await applied(data);
      toast.success(t('resetDone'));
      setEditing(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isPending) return <PageSpinner />;
  if (query.isError) {
    return (
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
    );
  }

  const { items, today, T0 } = query.data;
  const canEditDates = canWrite && canManage;
  const review = items.filter((m) => m.needs_review);
  const busy = patch.isPending || reset.isPending;
  // where the «Σήμερα» marker goes: before the first row dated today or later
  const todayIndex = items.findIndex((m) => m.due_date !== null && m.due_date >= today);
  const todayInRange = (T0 === null || today >= T0) && today <= T;

  const actionsFor = (m: ScheduleMilestone): MenuItem[] => {
    const list: Array<MenuItem | false> = [
      canEditDates && !m.done && { label: t('actions.editDate'), icon: 'calendar', onSelect: () => setEditing(m) },
      canEditDates && !m.done && m.is_manual && { label: t('actions.reset'), icon: 'history', onSelect: () => reset.mutate(m.id) },
      canEditDates && m.needs_review && { label: t('actions.reviewed'), icon: 'check', onSelect: () => patch.mutate({ id: m.id, body: { needs_review: false } }) },
      canWrite && m.kind === 'milestone' && !m.done && { label: t('actions.markDone'), icon: 'checkCircle', onSelect: () => patch.mutate({ id: m.id, body: { done: true } }) },
      canWrite && m.kind === 'milestone' && m.done && { label: t('actions.markUndone'), icon: 'history', onSelect: () => patch.mutate({ id: m.id, body: { done: false } }) },
      m.kind === 'gate' && { label: t('actions.openGate'), icon: 'external', to: `/tenders/${tenderId}/gates`, separatorBefore: canEditDates && !m.done },
      m.kind === 'handoff' && { label: t('actions.openHandoff'), icon: 'external', to: `/tenders/${tenderId}/tasks`, separatorBefore: canEditDates && !m.done },
    ];
    return list.filter((x): x is MenuItem => Boolean(x));
  };

  const todayRow = (
    <li className="timeline__today" key="_today" aria-label={t('today')}>
      <span>
        {t('today')} · {weekdayShort(today)} {formatDate(today)}
      </span>
    </li>
  );

  return (
    <>
      <PageHeader
        level={2}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canEditDates && (
            <Button icon="calendar" onClick={() => setDeadlineOpen(true)}>
              {t('deadline.open')}
            </Button>
          )
        }
      />

      {review.length > 0 && (
        <Banner tone="orange" title={t('review.title', { count: review.length })} className="schedule-banner">
          {t('review.body', { names: review.map((m) => m.key).join(', ') })}
        </Banner>
      )}

      {items.length === 0 ? (
        <EmptyState icon="calendar" title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ol className="timeline">
          <li className="timeline__edge">
            <div className="timeline__date">{T0 ? <DateText value={T0} withWeekday /> : <span className="u-faint">—</span>}</div>
            <div className="timeline__rail" aria-hidden>
              <span className="timeline__dot timeline__dot--edge" />
            </div>
            <div className="timeline__body">
              <strong>T0</strong> <span className="u-muted">{t('t0')}</span>
            </div>
          </li>

          {items.map((m, index) => {
            const menu = actionsFor(m);
            const state = m.done ? 'done' : m.overdue ? 'overdue' : m.needs_review ? 'review' : 'open';
            return (
              <Fragment key={m.id}>
                {todayInRange && index === todayIndex && todayRow}
                <li className={cx('timeline__item', `timeline__item--${m.kind}`, `is-${state}`)}>
                  <div className="timeline__date">
                    {m.due_date ? (
                      <>
                        <time dateTime={m.due_date} title={weekdayLong(m.due_date)}>
                          <span className="timeline__wd">{weekdayShort(m.due_date)}</span> {formatDate(m.due_date)}
                        </time>
                        <TMinus n={m.tMinus} tone="neutral" plain />
                      </>
                    ) : (
                      <span className="u-faint">{t('noDate')}</span>
                    )}
                  </div>
                  <div className="timeline__rail" aria-hidden>
                    <span className="timeline__dot">{m.done && <Icon name="check" size={12} />}</span>
                  </div>
                  <div className="timeline__body">
                    <div className="timeline__head">
                      <span className={cx('timeline__kind', `timeline__kind--${m.kind}`)}>{enumLabel('milestone_kind', m.kind)}</span>
                      <strong className="timeline__name">{m.name}</strong>
                    </div>
                    <div className="timeline__meta">
                      {m.handoff && (m.handoff.from_role || m.handoff.to_role) && (
                        <span className="timeline__roles">
                          {m.handoff.from_role ?? '?'} <Icon name="chevronRight" size={12} /> {m.handoff.to_role ?? '?'}
                        </span>
                      )}
                      <span className="u-muted">{ruleText(m)}</span>
                      {m.gate && m.gate.decision !== 'pending' && <StatusBadge kind="gate_decision" value={m.gate.decision} />}
                      {m.done && !m.gate && <Badge tone="green">{m.kind === 'handoff' ? t('markers.received') : t('markers.done')}</Badge>}
                      {m.overdue && <Badge tone="red">{t('common:state.overdue')}</Badge>}
                      {m.is_manual && (
                        <Badge tone="info" title={m.computed_date ? t('markers.manualHint', { date: formatDate(m.computed_date) }) : undefined}>
                          {t('markers.manual')}
                        </Badge>
                      )}
                      {m.needs_review && <Badge tone="orange">{t('markers.needsReview')}</Badge>}
                      {m.is_working_day === false && <Badge tone="orange">{t('markers.nonWorking')}</Badge>}
                    </div>
                    {m.is_manual && m.computed_date && m.computed_date !== m.due_date && (
                      <p className="timeline__note u-muted">{t('markers.manualHint', { date: formatDate(m.computed_date) })}</p>
                    )}
                  </div>
                  <div className="timeline__actions">{menu.length > 0 && <Menu label={t('actions.menu', { name: m.name })} items={menu} disabled={busy} />}</div>
                </li>
              </Fragment>
            );
          })}
          {todayInRange && todayIndex === -1 && todayRow}

          <li className="timeline__edge timeline__edge--end">
            <div className="timeline__date">
              <DateText value={tender.submission_deadline_at} withWeekday withTime />
            </div>
            <div className="timeline__rail" aria-hidden>
              <span className="timeline__dot timeline__dot--edge" />
            </div>
            <div className="timeline__body">
              <strong>T</strong> <span className="u-muted">{t('t')}</span>
            </div>
            <div className="timeline__actions">
              {canEditDates && (
                <Button size="sm" onClick={() => setDeadlineOpen(true)}>
                  {t('deadline.openShort')}
                </Button>
              )}
            </div>
          </li>
        </ol>
      )}

      {editing && (
        <EditDateModal
          milestone={editing}
          loading={busy}
          onClose={() => setEditing(null)}
          onSave={(due_date) => patch.mutate({ id: editing.id, body: { due_date } })}
          onReset={() => reset.mutate(editing.id)}
        />
      )}
      {deadlineOpen && <DeadlineDialog onClose={() => setDeadlineOpen(false)} />}
    </>
  );
}

function EditDateModal({
  milestone,
  loading,
  onClose,
  onSave,
  onReset,
}: {
  milestone: ScheduleMilestone;
  loading: boolean;
  onClose: () => void;
  onSave: (date: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('schedule');
  const [date, setDate] = useState<string | null>(milestone.due_date);
  const unchanged = !date || date === milestone.due_date;
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      onSubmit={() => date && !unchanged && onSave(date)}
      title={t('edit.title', { name: milestone.name })}
      footer={
        <>
          {milestone.is_manual && (
            <Button variant="ghost" icon="history" onClick={onReset} disabled={loading} className="edit-date__reset">
              {t('actions.reset')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" loading={loading} disabled={unchanged}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        <Field label={t('edit.date')} required hint={date ? weekdayLong(date) : undefined}>
          <DateInput value={date} onChange={setDate} autoFocus />
        </Field>
        <p className="u-muted">{t('edit.hint')}</p>
        {milestone.computed_date && (
          <p className="u-muted">
            {t('edit.computed')} <DateText value={milestone.computed_date} withWeekday />
          </p>
        )}
      </div>
    </Modal>
  );
}
