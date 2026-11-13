import { useTranslation } from 'react-i18next';
import type { DateString, ID, TenderLot, Timestamp } from '@/api/types';
import { athensDate } from '@/lib/dates';
import { Button, Checkbox, DateInput, DateTimeInput, Field, Input, Textarea } from '@/ui';
import type { TenderInput, TenderRecord } from './tenderApi';

/** The F1 fields as the form holds them (numbers as typed text). */
export interface TenderFormState {
  title: string;
  authority: string;
  adam: string;
  esidis_no: string;
  cpv: string;
  budget_net: string;
  budget_gross: string;
  lots: Array<{ no: string; title: string; budget_net: string }>;
  t0: DateString | null;
  questions: Timestamp | null;
  submission: Timestamp | null;
  guarantee_amount: string;
  guarantee_valid_until: DateString | null;
  guarantee_margin_days: string;
  offer_validity_days: string;
  has_demo: boolean;
  has_partners: boolean;
  notes: string;
  template_id: ID;
}
export type TenderFormErrors = Partial<Record<keyof TenderFormState, string>>;

export const emptyTenderForm = (): TenderFormState => ({
  title: '',
  authority: '',
  adam: '',
  esidis_no: '',
  cpv: '',
  budget_net: '',
  budget_gross: '',
  lots: [],
  t0: null,
  questions: null,
  submission: null,
  guarantee_amount: '',
  guarantee_valid_until: null,
  guarantee_margin_days: '30',
  offer_validity_days: '',
  has_demo: false,
  has_partners: false,
  notes: '',
  template_id: '',
});

const numText = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

export function formFromTender(t: TenderRecord): TenderFormState {
  return {
    title: t.title,
    authority: t.authority ?? '',
    adam: t.adam ?? '',
    esidis_no: t.esidis_no ?? '',
    cpv: (t.cpv ?? []).join(', '),
    budget_net: numText(t.budget_net),
    budget_gross: numText(t.budget_gross),
    lots: (t.lots ?? []).map((l: TenderLot) => ({ no: l.no == null ? '' : String(l.no), title: l.title ?? '', budget_net: numText(l.budget_net) })),
    t0: athensDate(t.t0_published_at),
    questions: t.questions_deadline_at,
    submission: t.submission_deadline_at,
    guarantee_amount: numText(t.guarantee_amount),
    guarantee_valid_until: t.guarantee_valid_until,
    guarantee_margin_days: String(t.guarantee_margin_days ?? 30),
    offer_validity_days: numText(t.offer_validity_days),
    has_demo: t.has_demo,
    has_partners: t.has_partners,
    notes: t.notes ?? '',
    template_id: t.template_id ?? '',
  };
}

/** '1250000', '1.250.000,50' or '1250000.5' → number; '' → null; anything else → NaN. */
export function parseAmount(text: string): number | null {
  const s = text.trim().replace(/\s|€/g, '');
  if (s === '') return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  return /^\d+(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : Number.NaN;
}
function parseDays(text: string): number | null {
  const s = text.trim();
  if (s === '') return null;
  return /^\d{1,4}$/.test(s) ? Number(s) : Number.NaN;
}

/** Validates the form and builds the request body. `mode: 'edit'` skips what cannot change after creation. */
export function validateTenderForm(
  f: TenderFormState,
  mode: 'create' | 'edit',
  t: (key: string) => string,
): { errors: TenderFormErrors; input: TenderInput | null } {
  const errors: TenderFormErrors = {};
  const required = t('common:errors.required');
  if (!f.title.trim()) errors.title = required;
  if (!f.authority.trim()) errors.authority = required;
  if (!f.submission) errors.submission = required;
  if (mode === 'create' && !f.t0) errors.t0 = required;
  if (mode === 'create' && !f.template_id) errors.template_id = required;

  const amount = (key: 'budget_net' | 'budget_gross' | 'guarantee_amount') => {
    const v = parseAmount(f[key]);
    if (Number.isNaN(v)) errors[key] = t('tenders:form.errors.amount');
    return Number.isNaN(v) ? null : v;
  };
  const budget_net = amount('budget_net');
  const budget_gross = amount('budget_gross');
  const guarantee_amount = amount('guarantee_amount');
  if (budget_net !== null && budget_gross !== null && budget_gross < budget_net) errors.budget_gross = t('tenders:errorCodes.budget_gross_below_net');

  const offer = parseDays(f.offer_validity_days);
  if (Number.isNaN(offer)) errors.offer_validity_days = t('tenders:form.errors.days');
  const margin = parseDays(f.guarantee_margin_days);
  if (margin === null || Number.isNaN(margin)) errors.guarantee_margin_days = t('tenders:form.errors.days');

  const T = athensDate(f.submission);
  if (f.t0 && T && f.t0 > T) errors.t0 = t('tenders:errorCodes.t0_after_deadline');
  if (f.questions && f.submission && f.questions > f.submission) errors.questions = t('tenders:errorCodes.questions_after_deadline');

  const lots: TenderLot[] = [];
  f.lots.forEach((lot, i) => {
    const empty = !lot.no.trim() && !lot.title.trim() && !lot.budget_net.trim();
    if (empty) return;
    const lotBudget = parseAmount(lot.budget_net);
    if (!lot.title.trim() || Number.isNaN(lotBudget)) errors.lots = t('tenders:form.errors.lots');
    lots.push({ no: lot.no.trim() || String(i + 1), title: lot.title.trim(), budget_net: Number.isNaN(lotBudget) ? null : lotBudget });
  });

  if (Object.keys(errors).length > 0) return { errors, input: null };
  return {
    errors,
    input: {
      title: f.title.trim(),
      authority: f.authority.trim(),
      adam: f.adam.trim() || null,
      esidis_no: f.esidis_no.trim() || null,
      cpv: f.cpv
        .split(/[,;\s]+/)
        .map((c) => c.trim())
        .filter(Boolean),
      budget_net,
      budget_gross,
      lots,
      t0_published_at: f.t0,
      questions_deadline_at: f.questions,
      submission_deadline_at: f.submission as Timestamp,
      guarantee_amount,
      guarantee_valid_until: f.guarantee_valid_until,
      guarantee_margin_days: margin as number,
      offer_validity_days: offer,
      has_demo: f.has_demo,
      has_partners: f.has_partners,
      notes: f.notes.trim() || null,
      template_id: f.template_id,
    },
  };
}

interface SectionProps {
  form: TenderFormState;
  errors: TenderFormErrors;
  set: <K extends keyof TenderFormState>(key: K, value: TenderFormState[K]) => void;
}

/** Τίτλος, αναθέτουσα αρχή, ΑΔΑΜ, α/α ΕΣΗΔΗΣ, CPV. */
export function IdentityFields({ form, errors, set }: SectionProps) {
  const { t } = useTranslation('tenders');
  return (
    <div className="u-form-grid">
      <Field label={t('form.title')} required error={errors.title} className="u-span-2">
        <Input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={500} autoComplete="off" />
      </Field>
      <Field label={t('form.authority')} required error={errors.authority} className="u-span-2">
        <Input value={form.authority} onChange={(e) => set('authority', e.target.value)} maxLength={500} autoComplete="off" />
      </Field>
      <Field label={t('form.adam')} hint={t('form.adamHint')}>
        <Input className="u-mono" value={form.adam} onChange={(e) => set('adam', e.target.value)} maxLength={60} autoComplete="off" />
      </Field>
      <Field label={t('form.esidis')}>
        <Input className="u-mono" value={form.esidis_no} onChange={(e) => set('esidis_no', e.target.value)} maxLength={60} inputMode="numeric" autoComplete="off" />
      </Field>
      <Field label={t('form.cpv')} hint={t('form.cpvHint')} className="u-span-2">
        <Input className="u-mono" value={form.cpv} onChange={(e) => set('cpv', e.target.value)} autoComplete="off" />
      </Field>
    </div>
  );
}

/** T0, προθεσμία ερωτημάτων, προθεσμία υποβολής (T). In edit mode T is shown read-only: it changes through the deadline flow. */
export function DeadlineFields({ form, errors, set, lockSubmission }: SectionProps & { lockSubmission?: boolean }) {
  const { t } = useTranslation('tenders');
  return (
    <div className="u-form-grid">
      <Field label={t('form.t0')} required error={errors.t0} hint={t('form.t0Hint')}>
        <DateInput value={form.t0} onChange={(v) => set('t0', v)} />
      </Field>
      <Field label={t('form.questions')} error={errors.questions}>
        <DateTimeInput value={form.questions} onChange={(v) => set('questions', v)} />
      </Field>
      <Field
        label={t('form.submission')}
        required
        error={errors.submission}
        hint={lockSubmission ? t('form.submissionLocked') : t('form.submissionHint')}
        className="u-span-2"
      >
        <DateTimeInput value={form.submission} onChange={(v) => set('submission', v)} disabled={lockSubmission} />
      </Field>
    </div>
  );
}

/** Προϋπολογισμός χωρίς/με ΦΠΑ και τμήματα. */
export function BudgetFields({ form, errors, set }: SectionProps) {
  const { t } = useTranslation('tenders');
  const setLot = (index: number, patch: Partial<TenderFormState['lots'][number]>) =>
    set(
      'lots',
      form.lots.map((lot, i) => (i === index ? { ...lot, ...patch } : lot)),
    );
  return (
    <div className="u-stack">
      <div className="u-form-grid">
        <Field label={t('form.budgetNet')} error={errors.budget_net}>
          <Input value={form.budget_net} onChange={(e) => set('budget_net', e.target.value)} inputMode="decimal" placeholder="0,00" autoComplete="off" />
        </Field>
        <Field label={t('form.budgetGross')} error={errors.budget_gross}>
          <Input value={form.budget_gross} onChange={(e) => set('budget_gross', e.target.value)} inputMode="decimal" placeholder="0,00" autoComplete="off" />
        </Field>
      </div>
      <fieldset className="lots">
        <legend className="lots__legend">{t('form.lots')}</legend>
        {form.lots.length === 0 && <p className="u-muted lots__empty">{t('form.lotsEmpty')}</p>}
        {form.lots.map((lot, i) => (
          <div className="lots__row" key={i}>
            <Field label={t('form.lotNo')} className="lots__no">
              <Input value={lot.no} onChange={(e) => setLot(i, { no: e.target.value })} maxLength={40} placeholder={String(i + 1)} />
            </Field>
            <Field label={t('form.lotTitle')} className="lots__title">
              <Input value={lot.title} onChange={(e) => setLot(i, { title: e.target.value })} maxLength={500} />
            </Field>
            <Field label={t('form.lotBudget')} className="lots__budget">
              <Input value={lot.budget_net} onChange={(e) => setLot(i, { budget_net: e.target.value })} inputMode="decimal" placeholder="0,00" />
            </Field>
            <Button
              className="lots__remove"
              variant="ghost"
              icon="trash"
              iconOnly
              onClick={() =>
                set(
                  'lots',
                  form.lots.filter((_, j) => j !== i),
                )
              }
            >
              {t('form.lotRemove', { n: i + 1 })}
            </Button>
          </div>
        ))}
        {errors.lots && (
          <p className="ui-field__error" role="alert">
            {errors.lots}
          </p>
        )}
        <div>
          <Button size="sm" icon="plus" onClick={() => set('lots', [...form.lots, { no: '', title: '', budget_net: '' }])}>
            {t('form.lotAdd')}
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

/** Εγγυητική συμμετοχής και ισχύς προσφοράς (R16). */
export function GuaranteeFields({ form, errors, set }: SectionProps) {
  const { t } = useTranslation('tenders');
  return (
    <div className="u-form-grid">
      <Field label={t('form.guaranteeAmount')} error={errors.guarantee_amount}>
        <Input value={form.guarantee_amount} onChange={(e) => set('guarantee_amount', e.target.value)} inputMode="decimal" placeholder="0,00" autoComplete="off" />
      </Field>
      <Field label={t('form.guaranteeValidUntil')} hint={t('form.guaranteeValidHint')}>
        <DateInput value={form.guarantee_valid_until} onChange={(v) => set('guarantee_valid_until', v)} />
      </Field>
      <Field label={t('form.offerValidity')} error={errors.offer_validity_days} hint={t('form.offerValidityHint')}>
        <Input value={form.offer_validity_days} onChange={(e) => set('offer_validity_days', e.target.value)} inputMode="numeric" autoComplete="off" />
      </Field>
      <Field label={t('form.guaranteeMargin')} required error={errors.guarantee_margin_days} hint={t('form.guaranteeMarginHint')}>
        <Input value={form.guarantee_margin_days} onChange={(e) => set('guarantee_margin_days', e.target.value)} inputMode="numeric" autoComplete="off" />
      </Field>
    </div>
  );
}

/** Flags «ζητείται demo» / «υπάρχουν εταίροι» — fixed after creation (they decide which template items exist). */
export function FlagFields({ form, set, disabled }: Pick<SectionProps, 'form' | 'set'> & { disabled?: boolean }) {
  const { t } = useTranslation('tenders');
  return (
    <div className="u-stack u-stack--sm">
      <Checkbox label={t('form.hasDemo')} hint={t('form.hasDemoHint')} checked={form.has_demo} disabled={disabled} onChange={(e) => set('has_demo', e.target.checked)} />
      <Checkbox
        label={t('form.hasPartners')}
        hint={t('form.hasPartnersHint')}
        checked={form.has_partners}
        disabled={disabled}
        onChange={(e) => set('has_partners', e.target.checked)}
      />
    </div>
  );
}

export function NotesField({ form, set }: Pick<SectionProps, 'form' | 'set'>) {
  const { t } = useTranslation('tenders');
  return (
    <Field label={t('form.notes')}>
      <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} maxLength={10000} />
    </Field>
  );
}
