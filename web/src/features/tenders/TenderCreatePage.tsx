import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { useHolidaySet } from '@/features/shared/useHolidays';
import { addDays, athensDate, todayAthens, workingDaysBetween } from '@/lib/dates';
import { Banner, Button, Card, EmptyState, Field, LinkButton, PageHeader, Select, useToast } from '@/ui';
import { createTender, listPublishedTemplates, tenderKeys } from './tenderApi';
import {
  BudgetFields,
  DeadlineFields,
  emptyTenderForm,
  FlagFields,
  GuaranteeFields,
  IdentityFields,
  NotesField,
  validateTenderForm,
  type TenderFormErrors,
  type TenderFormState,
} from './TenderFields';
import './tenders.css';

/** Display-only estimate of R8 while typing: working days from max(T0, today) to T. The server decides. */
function useWorkingDaysEstimate(t0: string | null, submission: string | null): number | null {
  const T = athensDate(submission);
  const today = todayAthens();
  const from = t0 && t0 > today ? t0 : today;
  const years = T && T >= from ? [...new Set([Number(from.slice(0, 4)), Number(T.slice(0, 4))])] : [];
  const { holidays, ready } = useHolidaySet(years);
  if (!T || T < from || !ready) return null;
  // the same count as the server: working days in (from, T]
  return workingDaysBetween(addDays(from, 1), addDays(T, 1), holidays);
}

/** /tenders/new — F1 fields + template (F2). The schedule is computed by the server on save. */
export function TenderCreatePage() {
  const { t } = useTranslation('tenders');
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TenderFormState>(emptyTenderForm);
  const [errors, setErrors] = useState<TenderFormErrors>({});
  const set = <K extends keyof TenderFormState>(key: K, value: TenderFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const templates = useQuery({ queryKey: tenderKeys.templates, queryFn: listPublishedTemplates });
  const options = templates.data ?? [];
  useEffect(() => {
    // one published template: preselect it
    if (!form.template_id && options.length === 1 && options[0]) setForm((f) => ({ ...f, template_id: options[0]!.id }));
  }, [options, form.template_id]);

  const estimate = useWorkingDaysEstimate(form.t0, form.submission);

  const create = useMutation({
    mutationFn: createTender,
    onSuccess: async (detail) => {
      await queryClient.invalidateQueries({ queryKey: tenderKeys.all });
      toast.success(t('create.created'));
      navigate(`/tenders/${detail.tender.id}/schedule`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!hasRole('admin', 'bid_manager')) {
    return (
      <EmptyState
        icon="lock"
        title={t('create.forbidden.title')}
        description={t('create.forbidden.description')}
        action={
          <LinkButton to="/tenders" variant="primary">
            {t('notFound.back')}
          </LinkButton>
        }
      />
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateTenderForm(form, 'create', t);
    setErrors(result.errors);
    if (!result.input) {
      toast.error(t('form.errors.fix'));
      return;
    }
    create.mutate(result.input);
  };

  const selected = options.find((o) => o.id === form.template_id);

  return (
    <form onSubmit={submit} noValidate className="tender-form">
      <PageHeader title={t('create.title')} subtitle={t('create.subtitle')} back={{ to: '/tenders', label: t('title') }} />

      <Card title={t('form.sections.identity')}>
        <IdentityFields form={form} errors={errors} set={set} />
      </Card>

      <Card title={t('form.sections.deadlines')} subtitle={t('form.sections.deadlinesHint')}>
        <DeadlineFields form={form} errors={errors} set={set} />
        {estimate !== null && estimate < 10 && (
          <Banner tone="red" className="tender-form__hint" title={t('create.estimate.redTitle', { count: estimate })}>
            {t('create.estimate.red')}
          </Banner>
        )}
        {estimate !== null && estimate >= 10 && estimate < 15 && (
          <Banner tone="orange" className="tender-form__hint" title={t('create.estimate.orangeTitle', { count: estimate })}>
            {t('create.estimate.orange')}
          </Banner>
        )}
        {estimate !== null && estimate >= 15 && <p className="u-muted tender-form__hint">{t('create.estimate.ok', { count: estimate })}</p>}
      </Card>

      <Card title={t('form.sections.budget')}>
        <BudgetFields form={form} errors={errors} set={set} />
      </Card>

      <Card title={t('form.sections.guarantee')}>
        <GuaranteeFields form={form} errors={errors} set={set} />
      </Card>

      <Card title={t('form.sections.template')} subtitle={t('form.sections.templateHint')}>
        <div className="u-stack">
          {templates.isError ? (
            <Banner
              tone="red"
              title={t('form.templateLoadFailed')}
              actions={
                <Button size="sm" onClick={() => void templates.refetch()}>
                  {t('common:actions.retry')}
                </Button>
              }
            >
              {errorMessage(templates.error)}
            </Banner>
          ) : !templates.isPending && options.length === 0 ? (
            <Banner tone="orange" title={t('form.noTemplates.title')}>
              {t('form.noTemplates.description')}
            </Banner>
          ) : (
            <Field label={t('form.template')} required error={errors.template_id} hint={selected?.description ?? undefined}>
              <Select
                value={form.template_id}
                onChange={(e) => set('template_id', e.target.value)}
                placeholder={templates.isPending ? t('common:state.loading') : t('form.templatePlaceholder')}
                options={options.map((o) => ({ value: o.id, label: `${o.name} ${o.version}` }))}
              />
            </Field>
          )}
          <FlagFields form={form} set={set} />
          <p className="u-muted">{t('form.flagsFixed')}</p>
        </div>
      </Card>

      <Card title={t('form.sections.notes')}>
        <NotesField form={form} set={set} />
      </Card>

      <div className="tender-form__actions">
        <LinkButton to="/tenders">{t('common:actions.cancel')}</LinkButton>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t('create.submit')}
        </Button>
      </div>
    </form>
  );
}
