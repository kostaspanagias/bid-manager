import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { TenderStatus } from '@/api/types';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { useWorkingDaysTo } from '@/features/shared/useHolidays';
import { useTender } from '@/features/tenders/tenderContext';
import { addDays, athensDate } from '@/lib/dates';
import { Badge, Button, Card, ConfirmDialog, DateText, LinkButton, Modal, PageHeader, TMinus, useToast } from '@/ui';
import { setTenderStatus, STATUS_TRANSITIONS, tenderKeys, updateTender, type TenderPatch, type TenderRecord } from './tenderApi';
import {
  BudgetFields,
  DeadlineFields,
  formFromTender,
  GuaranteeFields,
  IdentityFields,
  NotesField,
  validateTenderForm,
  type TenderFormErrors,
  type TenderFormState,
} from './TenderFields';
import './tenders.css';

const eur = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' });
export const money = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? null : eur.format(Number(v)));

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  const empty = children === null || children === undefined || children === '' || children === false;
  return (
    <div className={wide ? 'facts__item facts__item--wide' : 'facts__item'}>
      <dt>{label}</dt>
      <dd>{empty ? <span className="u-faint">—</span> : children}</dd>
    </div>
  );
}

/** Overview: key facts, deadlines, next gate, guarantee, lots, status actions. Warnings are the banners above the tabs. */
export function TenderOverviewTab() {
  const { t } = useTranslation('tenders');
  const { tender: base, tenderId, canWrite, canManage, T, tMinus, isActive, nextGate, refetch } = useTender();
  const tender = base as TenderRecord;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<TenderStatus | null>(null);
  const questionsIn = useWorkingDaysTo(isActive ? athensDate(tender.questions_deadline_at) : null);

  const status = useMutation({
    mutationFn: (next: TenderStatus) => setTenderStatus(tenderId, next),
    onSuccess: async () => {
      await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: tenderKeys.list() })]);
      toast.success(t('overview.statusChanged'));
      setTarget(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const requiredUntil = tender.offer_validity_days != null ? addDays(T, tender.offer_validity_days + (tender.guarantee_margin_days ?? 30)) : null;
  const guaranteeShort = Boolean(requiredUntil && tender.guarantee_valid_until && tender.guarantee_valid_until < requiredUntil);
  const transitions = canManage ? STATUS_TRANSITIONS[tender.status] : [];
  const lots = tender.lots ?? [];
  const templateLabel = [tender.template_name, tender.template_version].filter(Boolean).join(' ');

  return (
    <>
      <PageHeader
        level={2}
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        actions={
          canManage &&
          canWrite && (
            <Button icon="edit" onClick={() => setEditing(true)}>
              {t('overview.edit')}
            </Button>
          )
        }
      />

      <div className="overview-grid">
        <Card title={t('overview.deadlines')} className="overview-grid__deadlines">
          <dl className="facts">
            <Fact label={t('form.t0')}>{tender.t0_published_at && <DateText value={tender.t0_published_at} withWeekday />}</Fact>
            <Fact label={t('form.questions')}>
              {tender.questions_deadline_at && (
                <>
                  <DateText value={tender.questions_deadline_at} withWeekday withTime />
                  {questionsIn !== null && questionsIn >= 0 && <span className="u-muted facts__note">{t('overview.inWorkingDays', { count: questionsIn })}</span>}
                  {questionsIn !== null && questionsIn < 0 && <span className="u-muted facts__note">{t('overview.passed')}</span>}
                </>
              )}
            </Fact>
            <Fact label={t('form.submission')} wide>
              <strong>
                <DateText value={tender.submission_deadline_at} withWeekday withTime />
              </strong>{' '}
              {isActive && <TMinus n={tMinus} />}
            </Fact>
          </dl>
          <div className="overview-grid__links">
            <LinkButton size="sm" to="../schedule" icon="calendar">
              {t('overview.openSchedule')}
            </LinkButton>
          </div>
        </Card>

        <Card title={t('overview.nextGate')} className="overview-grid__gate">
          {nextGate ? (
            <div className="next-gate">
              <Badge tone="info">{nextGate.key}</Badge>
              <div className="next-gate__body">
                <strong>{nextGate.name}</strong>
                <span>
                  <DateText value={nextGate.due_date} withWeekday /> <TMinus n={nextGate.tMinus} tone="neutral" />
                </span>
              </div>
              <LinkButton size="sm" to="../gates">
                {t('overview.openGates')}
              </LinkButton>
            </div>
          ) : (
            <p className="u-muted">{isActive ? t('overview.noNextGate') : t('overview.closedNoGate')}</p>
          )}
        </Card>

        <Card title={t('overview.facts')} className="overview-grid__facts">
          <dl className="facts">
            <Fact label={t('form.authority')} wide>
              {tender.authority}
            </Fact>
            <Fact label={t('form.adam')}>{tender.adam && <span className="u-mono">{tender.adam}</span>}</Fact>
            <Fact label={t('form.esidis')}>{tender.esidis_no && <span className="u-mono">{tender.esidis_no}</span>}</Fact>
            <Fact label={t('form.cpv')} wide>
              {tender.cpv.length > 0 && <span className="u-mono">{tender.cpv.join(' · ')}</span>}
            </Fact>
            <Fact label={t('form.budgetNet')}>{money(tender.budget_net)}</Fact>
            <Fact label={t('form.budgetGross')}>{money(tender.budget_gross)}</Fact>
            <Fact label={t('form.template')}>{templateLabel}</Fact>
            <Fact label={t('overview.flags')}>
              <span className="u-row">
                <Badge tone={tender.has_demo ? 'info' : 'neutral'}>{tender.has_demo ? t('overview.demoYes') : t('overview.demoNo')}</Badge>
                <Badge tone={tender.has_partners ? 'info' : 'neutral'}>{tender.has_partners ? t('overview.partnersYes') : t('overview.partnersNo')}</Badge>
              </span>
            </Fact>
            {tender.notes && (
              <Fact label={t('form.notes')} wide>
                <span className="facts__notes">{tender.notes}</span>
              </Fact>
            )}
          </dl>
        </Card>

        <Card title={t('overview.guarantee')} tone={guaranteeShort ? 'orange' : undefined} className="overview-grid__guarantee">
          <dl className="facts">
            <Fact label={t('form.guaranteeAmount')}>{money(tender.guarantee_amount)}</Fact>
            <Fact label={t('form.guaranteeValidUntil')}>
              {tender.guarantee_valid_until && <DateText value={tender.guarantee_valid_until} className={guaranteeShort ? 'u-text-orange' : undefined} />}
            </Fact>
            <Fact label={t('form.offerValidity')}>{tender.offer_validity_days != null && t('overview.days', { count: tender.offer_validity_days })}</Fact>
            <Fact label={t('form.guaranteeMargin')}>{t('overview.days', { count: tender.guarantee_margin_days })}</Fact>
            <Fact label={t('overview.requiredUntil')} wide>
              {requiredUntil && (
                <>
                  <DateText value={requiredUntil} /> <span className="u-muted facts__note">{t('overview.requiredUntilHint')}</span>
                </>
              )}
            </Fact>
          </dl>
        </Card>

        <Card title={t('overview.lots', { count: lots.length })} flush={lots.length > 0} className="overview-grid__lots">
          {lots.length === 0 ? (
            <p className="u-muted">{t('overview.noLots')}</p>
          ) : (
            <ul className="lot-list">
              {lots.map((lot, i) => (
                <li key={i}>
                  <span className="lot-list__no u-mono">{lot.no ?? i + 1}</span>
                  <span className="lot-list__title">{lot.title}</span>
                  <span className="lot-list__budget u-mono">{money(lot.budget_net) ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t('overview.status')} className="overview-grid__status">
          <div className="u-stack u-stack--sm">
            <div className="u-row">
              <StatusBadge kind="tender_status" value={tender.status} dot />
              {tender.closed_at && (
                <span className="u-muted">
                  {t('overview.closedAt')} <DateText value={tender.closed_at} withTime />
                </span>
              )}
            </div>
            <p className="u-muted">{t(`overview.statusHelp.${tender.status}`)}</p>
            {transitions.length > 0 && (
              <div className="u-row">
                {transitions.map((next) => (
                  <Button key={next} size="sm" variant={next === 'cancelled' ? 'danger' : next === 'submitted' ? 'primary' : 'secondary'} onClick={() => setTarget(next)}>
                    {t(`overview.statusAction.${tender.status}.${next}`)}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={target !== null}
        danger={target === 'cancelled'}
        title={target ? t(`overview.statusAction.${tender.status}.${target}`) : ''}
        message={target ? t(`overview.statusConfirm.${target}`) : ''}
        loading={status.isPending}
        onConfirm={() => target && status.mutate(target)}
        onCancel={() => setTarget(null)}
      />

      {editing && <EditTenderModal tender={tender} onClose={() => setEditing(false)} />}
    </>
  );
}

/** Basic fields only: the deadline changes through the schedule tab (R9), the flags and the template never. */
function EditTenderModal({ tender, onClose }: { tender: TenderRecord; onClose: () => void }) {
  const { t } = useTranslation('tenders');
  const { refetch } = useTender();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TenderFormState>(() => formFromTender(tender));
  const [errors, setErrors] = useState<TenderFormErrors>({});
  const set = <K extends keyof TenderFormState>(key: K, value: TenderFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const save = useMutation({
    mutationFn: (patch: TenderPatch) => updateTender(tender.id, patch),
    onSuccess: async () => {
      // the publication date can move milestones, so refresh everything of the tender
      await Promise.all([queryClient.invalidateQueries({ queryKey: tenderKeys.detail(tender.id) }), queryClient.invalidateQueries({ queryKey: tenderKeys.list() })]);
      await refetch();
      toast.success(t('common:state.saved'));
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = () => {
    const result = validateTenderForm(form, 'edit', t);
    setErrors(result.errors);
    if (!result.input) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { template_id, has_demo, has_partners, submission_deadline_at, members, ...patch } = result.input;
    save.mutate(patch);
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      onSubmit={submit}
      title={t('overview.editTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="edit-sections">
        <section>
          <h3>{t('form.sections.identity')}</h3>
          <IdentityFields form={form} errors={errors} set={set} />
        </section>
        <section>
          <h3>{t('form.sections.deadlines')}</h3>
          <DeadlineFields form={form} errors={errors} set={set} lockSubmission />
        </section>
        <section>
          <h3>{t('form.sections.budget')}</h3>
          <BudgetFields form={form} errors={errors} set={set} />
        </section>
        <section>
          <h3>{t('form.sections.guarantee')}</h3>
          <GuaranteeFields form={form} errors={errors} set={set} />
        </section>
        <section>
          <h3>{t('form.sections.notes')}</h3>
          <NotesField form={form} set={set} />
        </section>
      </div>
    </Modal>
  );
}
