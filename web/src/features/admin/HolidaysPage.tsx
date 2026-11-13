import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, isApiError } from '@/api/client';
import type { Holiday } from '@/api/types';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { formatDate, isWeekend, todayAthens, weekdayLong } from '@/lib/dates';
import {
  Badge,
  Banner,
  Button,
  CellActions,
  ConfirmDialog,
  DateInput,
  DateText,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Table,
  useToast,
  type Column,
} from '@/ui';
import { createHoliday, deleteHoliday, fetchHolidays, holidaysKeys, seedHolidays, updateHoliday } from './holidaysApi';
import './admin.css';

type Editing = { mode: 'add' } | { mode: 'edit'; holiday: Holiday } | null;

/** /admin/holidays — the org's holiday calendar per year (R1–R2): seed, add, move, remove. */
export function HolidaysPage() {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [year, setYear] = useState(() => Number(todayAthens().slice(0, 4)));
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);

  const query = useQuery({ queryKey: holidaysKeys.year(year), queryFn: () => fetchHolidays(year) });
  const rows = [...(query.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const onWeekdays = rows.filter((h) => !isWeekend(h.date)).length;

  // A moved holiday can change year, so refresh every cached year.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: holidaysKeys.all });

  const seed = useMutation({
    mutationFn: () => seedHolidays(year),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('holidays.seeded', { year }));
      setSeedOpen(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (h: Holiday) => deleteHoliday(h.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('holidays.removed'));
      setRemoving(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: Column<Holiday>[] = [
    { key: 'date', header: t('holidays.columns.date'), mono: true, width: 130, render: (h) => <DateText value={h.date} /> },
    {
      key: 'weekday',
      header: t('holidays.columns.weekday'),
      render: (h) => (
        <>
          {weekdayLong(h.date)}
          {isWeekend(h.date) && <Badge className="admin-you">{t('holidays.weekend')}</Badge>}
        </>
      ),
    },
    { key: 'name', header: t('holidays.columns.name'), render: (h) => <strong>{h.name}</strong> },
    { key: 'source', header: t('holidays.columns.source'), render: (h) => <StatusBadge kind="holiday_source" value={h.source} /> },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (h) => (
        <CellActions>
          <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing({ mode: 'edit', holiday: h })}>
            {t('holidays.move')}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" iconOnly onClick={() => setRemoving(h)}>
            {`${t('common:actions.remove')}: ${h.name}`}
          </Button>
        </CellActions>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('holidays.title')}
        subtitle={t('holidays.subtitle')}
        actions={
          <>
            <Button icon="download" onClick={() => setSeedOpen(true)}>
              {t('holidays.seed', { year })}
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
              {t('holidays.add')}
            </Button>
          </>
        }
      />

      <div className="holidays-toolbar">
        <div className="year-stepper" role="group" aria-label={t('holidays.year')}>
          <Button size="sm" icon="chevronLeft" iconOnly onClick={() => setYear((y) => y - 1)}>
            {t('holidays.prevYear')}
          </Button>
          <span className="year-stepper__value" aria-live="polite">
            {year}
          </span>
          <Button size="sm" icon="chevronRight" iconOnly onClick={() => setYear((y) => y + 1)}>
            {t('holidays.nextYear')}
          </Button>
        </div>
        {rows.length > 0 && (
          <span className="holidays-toolbar__summary">
            {t('holidays.count', { count: rows.length })} · {t('holidays.onWeekdays', { count: onWeekdays })}
          </span>
        )}
      </div>

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
      ) : (
        <Table
          caption={`${t('holidays.title')} ${year}`}
          columns={columns}
          rows={rows}
          loading={query.isPending}
          empty={
            <EmptyState
              icon="calendar"
              compact
              title={t('holidays.empty', { year })}
              description={t('holidays.emptyHint')}
              action={
                <Button variant="primary" icon="download" onClick={() => setSeedOpen(true)}>
                  {t('holidays.seed', { year })}
                </Button>
              }
            />
          }
        />
      )}

      <HolidayModal
        editing={editing}
        year={year}
        onClose={() => setEditing(null)}
        onSaved={async (date) => {
          await invalidate();
          const savedYear = Number(date.slice(0, 4));
          if (savedYear !== year) setYear(savedYear);
        }}
      />
      <ConfirmDialog
        open={seedOpen}
        title={t('holidays.seedTitle', { year })}
        message={t('holidays.seedMessage', { year })}
        confirmLabel={t('holidays.seed', { year })}
        loading={seed.isPending}
        onCancel={() => setSeedOpen(false)}
        onConfirm={() => seed.mutate()}
      />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('holidays.removeTitle')}
        message={removing ? t('holidays.removeMessage', { date: formatDate(removing.date), name: removing.name }) : null}
        confirmLabel={t('common:actions.remove')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

interface HolidayModalProps {
  editing: Editing;
  year: number;
  onClose: () => void;
  onSaved: (date: string) => Promise<void>;
}

function HolidayModal({ editing, year, onClose, onSaved }: HolidayModalProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const [date, setDate] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Reset the form each time the modal opens for a different target.
  const target = editing ? (editing.mode === 'edit' ? editing.holiday.id : `add-${year}`) : null;
  if (target !== seededFor) {
    setSeededFor(target);
    setTouched(false);
    setDate(editing?.mode === 'edit' ? editing.holiday.date : null);
    setName(editing?.mode === 'edit' ? editing.holiday.name : '');
  }

  const isEdit = editing?.mode === 'edit';
  const save = useMutation({
    mutationFn: async () => {
      const payload = { date: date!, name: name.trim() };
      if (editing?.mode === 'edit') await updateHoliday(editing.holiday.id, payload);
      else await createHoliday(payload);
      return payload.date;
    },
    onSuccess: async (savedDate) => {
      await onSaved(savedDate);
      toast.success(t(isEdit ? 'holidays.updated' : 'holidays.added'));
      onClose();
    },
  });

  const close = () => {
    save.reset();
    onClose();
  };

  const errors = {
    date: !date ? t('common:errors.required') : undefined,
    name: !name.trim() ? t('common:errors.required') : undefined,
  };
  const fieldErrors = isApiError(save.error) ? save.error.fieldErrors : {};

  return (
    <Modal
      open={editing !== null}
      onClose={close}
      size="sm"
      title={isEdit ? t('holidays.editTitle') : t('holidays.addTitle')}
      description={isEdit ? t('holidays.editHint') : undefined}
      onSubmit={() => {
        setTouched(true);
        if (!errors.date && !errors.name) save.mutate();
      }}
      footer={
        <>
          <Button onClick={close} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        {save.isError && <Banner tone="red">{errorMessage(save.error)}</Banner>}
        <Field label={t('holidays.date')} required error={(touched ? errors.date : undefined) ?? fieldErrors.date}>
          <DateInput value={date} onChange={setDate} min={isEdit ? undefined : `${year}-01-01`} max={isEdit ? undefined : `${year}-12-31`} />
        </Field>
        <Field label={t('holidays.name')} required error={(touched ? errors.name : undefined) ?? fieldErrors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
      </div>
    </Modal>
  );
}
