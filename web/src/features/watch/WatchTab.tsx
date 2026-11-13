import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { OFFSET_UNITS, type OffsetUnit } from '@/api/types';
import { OwnerSelect, useOwnerLabel, type OwnerValue } from '@/features/tasks/owner';
import { useTender } from '@/features/tenders/tenderContext';
import { formatDate, todayAthens } from '@/lib/dates';
import { enumOptions } from '@/lib/enums';
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
  Menu,
  Modal,
  PageHeader,
  Select,
  Table,
  Textarea,
  useToast,
  type Column,
  type Tone,
} from '@/ui';
import { createWatch, deleteWatch, listWatch, updateWatch, watchKeys, type WatchInput, type WatchList, type WatchView } from './watchApi';
import '@/features/tasks/tasks.css';
import './watch.css';

type Editing = { mode: 'add' } | { mode: 'edit'; item: WatchView } | null;

const STATE_TONE: Record<WatchView['state'], Tone> = { not_requested: 'neutral', requested: 'info', late: 'orange', arrived: 'green' };

/** Red = the last request day passed without a request (R6); orange = late or arriving after it is needed. */
export function watchTone(w: Pick<WatchView, 'request_overdue' | 'state' | 'arrives_after_needed'>): Tone | undefined {
  if (w.request_overdue) return 'red';
  if (w.state === 'late' || w.arrives_after_needed) return 'orange';
  return w.state === 'arrived' ? 'green' : undefined;
}

/** /tenders/:tenderId/watch — items that depend on third parties, with lead time and the last day to request them. */
export function WatchTab() {
  const { t } = useTranslation('watch');
  const { tenderId, canWrite } = useTender();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<WatchView | null>(null);

  const query = useQuery({ queryKey: watchKeys.list(tenderId), queryFn: () => listWatch(tenderId) });
  const data = query.data;
  const rows = data?.items ?? [];
  const ownerLabel = useOwnerLabel(data?.roles ?? []);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: watchKeys.list(tenderId) }), queryClient.invalidateQueries({ queryKey: ['my'] })]);

  const quick = useMutation({
    mutationFn: (v: { item: WatchView; body: WatchInput; done: string }) => updateWatch(tenderId, v.item.id, v.body),
    onSuccess: async (saved, v) => {
      await refresh();
      toast.success(saved.expected_proposed && saved.expected_at ? t('toast.requestedExpected', { date: formatDate(saved.expected_at) }) : v.done);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (w: WatchView) => deleteWatch(tenderId, w.id),
    onSuccess: async () => {
      await refresh();
      toast.success(t('common:state.deleted'));
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => setRemoving(null),
  });

  const overdue = rows.filter((w) => w.request_overdue);
  const late = rows.filter((w) => !w.request_overdue && (w.state === 'late' || (w.arrives_after_needed && w.state !== 'arrived')));
  const today = todayAthens();

  const columns: Column<WatchView>[] = [
    {
      key: 'name',
      header: t('columns.name'),
      wrap: true,
      className: 'watch-col-name',
      render: (w) => (
        <>
          <strong>{w.name}</strong>
          {w.checks && <div className="tasks-desc">{w.checks}</div>}
          {w.notes && <div className="tasks-desc watch-notes">{w.notes}</div>}
        </>
      ),
    },
    { key: 'owner', header: t('common:labels.owner'), render: (w) => ownerLabel(w) || <span className="u-faint">—</span> },
    {
      key: 'lead',
      header: t('columns.lead'),
      render: (w) =>
        w.lead_value == null ? (
          <span className="u-muted">{t('leadOpen')}</span>
        ) : (
          t(w.lead_unit === 'calendar' ? 'common:labels.calendarDays' : 'common:labels.workingDays', { count: w.lead_value })
        ),
    },
    {
      key: 'needed_at',
      header: t('columns.needed'),
      mono: true,
      render: (w) => (
        <>
          <DateText value={w.needed_at} />
          {w.needed_milestone_key && <Badge className="tasks-chip" title={w.needed_milestone_name ?? undefined}>{w.needed_milestone_key}</Badge>}
        </>
      ),
    },
    {
      key: 'last_request_date',
      header: t('columns.lastRequest'),
      mono: true,
      render: (w) =>
        w.request_overdue ? (
          <span className="tasks-overdue">
            <DateText value={w.last_request_date} />
            <Badge tone="red">{t('requestOverdue')}</Badge>
          </span>
        ) : (
          <span className={w.requested_at || w.arrived_at ? 'u-faint' : undefined}>
            <DateText value={w.last_request_date} />
          </span>
        ),
    },
    { key: 'requested_at', header: t('columns.requested'), mono: true, render: (w) => <DateText value={w.requested_at} /> },
    {
      key: 'expected_at',
      header: t('columns.expected'),
      mono: true,
      render: (w) => (
        <span className={w.state === 'late' || (w.arrives_after_needed && !w.arrived_at) ? 'watch-late' : undefined}>
          <DateText value={w.expected_at} />
        </span>
      ),
    },
    { key: 'arrived_at', header: t('columns.arrived'), mono: true, render: (w) => <DateText value={w.arrived_at} /> },
    {
      key: 'state',
      header: t('common:labels.status'),
      render: (w) => (
        <span className="watch-state">
          <Badge tone={STATE_TONE[w.state]} dot>
            {t(`state.${w.state}`)}
          </Badge>
          {w.arrives_after_needed && <Badge tone="orange">{t('afterNeeded')}</Badge>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (w) =>
        canWrite && (
          <CellActions>
            {!w.requested_at && !w.arrived_at && (
              <Button size="sm" variant={w.request_overdue ? 'primary' : 'secondary'} onClick={() => quick.mutate({ item: w, body: { requested_at: today }, done: t('toast.requested') })}>
                {t('requestedToday')}
              </Button>
            )}
            {w.requested_at && !w.arrived_at && (
              <Button size="sm" icon="check" onClick={() => quick.mutate({ item: w, body: { arrived_at: today }, done: t('toast.arrived') })}>
                {t('arrivedToday')}
              </Button>
            )}
            <Menu
              label={`${t('common:actions.more')}: ${w.name}`}
              items={[
                { label: t('common:actions.edit'), icon: 'edit', onSelect: () => setEditing({ mode: 'edit', item: w }) },
                !w.requested_at && !w.arrived_at && { label: t('arrivedToday'), icon: 'check', onSelect: () => quick.mutate({ item: w, body: { arrived_at: today }, done: t('toast.arrived') }) },
                (!w.from_template || data?.can_manage) && { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => setRemoving(w) },
              ]}
            />
          </CellActions>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        level={2}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite && (
            <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
              {t('add')}
            </Button>
          )
        }
      />
      <div className="u-stack u-stack--sm watch-banners">
        {overdue.length > 0 && (
          <Banner tone="red" title={t('banner.overdue', { count: overdue.length })}>
            {overdue.map((w) => `${w.name} (${formatDate(w.last_request_date)})`).join(' · ')}
          </Banner>
        )}
        {late.length > 0 && (
          <Banner tone="orange" title={t('banner.late', { count: late.length })}>
            {late.map((w) => w.name).join(' · ')}
          </Banner>
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
          caption={t('title')}
          columns={columns}
          rows={rows}
          loading={query.isPending}
          rowTone={watchTone}
          empty={<EmptyState compact icon="calendar" title={t('empty')} description={t('emptyHint')} />}
        />
      )}
      <p className="watch-legend u-muted">{t('legend')}</p>

      {data && <WatchModal editing={editing} tenderId={tenderId} data={data} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('removeTitle')}
        message={removing ? t('removeMessage', { name: removing.name }) : null}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

interface ModalProps {
  editing: Editing;
  tenderId: string;
  data: WatchList;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

interface Form {
  name: string;
  owner: OwnerValue;
  leadOpen: boolean;
  leadValue: string;
  leadUnit: OffsetUnit;
  neededMode: 'milestone' | 'date';
  neededKey: string;
  neededAt: string | null;
  requestedAt: string | null;
  expectedAt: string | null;
  arrivedAt: string | null;
  checks: string;
  notes: string;
}

function initial(item: WatchView | null): Form {
  return {
    name: item?.name ?? '',
    owner: { owner_user_id: item?.owner_user_id ?? null, owner_role_key: item?.owner_role_key ?? null },
    leadOpen: item ? item.lead_value == null : true,
    leadValue: item?.lead_value != null ? String(item.lead_value) : '',
    leadUnit: item?.lead_unit ?? 'working',
    neededMode: item?.needed_milestone_key ? 'milestone' : 'date',
    neededKey: item?.needed_milestone_key ?? '',
    neededAt: item?.needed_at ?? null,
    requestedAt: item?.requested_at ?? null,
    expectedAt: item?.expected_at ?? null,
    arrivedAt: item?.arrived_at ?? null,
    checks: item?.checks ?? '',
    notes: item?.notes ?? '',
  };
}

function WatchModal({ editing, tenderId, data, onClose, onSaved }: ModalProps) {
  const { t } = useTranslation('watch');
  const toast = useToast();
  const item = editing?.mode === 'edit' ? editing.item : null;
  const [form, setForm] = useState<Form>(() => initial(null));
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const target = editing ? (item?.id ?? 'add') : null;
  if (target !== seededFor) {
    setSeededFor(target);
    setTouched(false);
    setForm(initial(item));
  }
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const lead = form.leadOpen ? null : Number(form.leadValue);
  const errors = {
    name: !form.name.trim() ? t('common:errors.required') : undefined,
    lead: !form.leadOpen && (form.leadValue.trim() === '' || !Number.isInteger(lead) || (lead ?? 0) < 0) ? t('form.leadInvalid') : undefined,
    expected: form.requestedAt && form.expectedAt && form.expectedAt < form.requestedAt ? t('form.expectedBeforeRequested') : undefined,
  };

  const save = useMutation({
    mutationFn: () => {
      const body: WatchInput = {
        name: form.name.trim(),
        ...form.owner,
        lead_value: lead,
        lead_unit: form.leadOpen ? null : form.leadUnit,
        requested_at: form.requestedAt,
        arrived_at: form.arrivedAt,
        checks: form.checks.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (form.neededMode === 'milestone' && form.neededKey) body.needed_milestone_key = form.neededKey;
      else Object.assign(body, { needed_milestone_key: null, needed_at: form.neededAt });
      // Leave expected_at out when the request date changed and the user did not touch it: the server proposes it.
      const requestChanged = form.requestedAt !== (item?.requested_at ?? null);
      const expectedTouched = form.expectedAt !== (item?.expected_at ?? null);
      if (!requestChanged || expectedTouched) body.expected_at = form.expectedAt;
      return item ? updateWatch(tenderId, item.id, body) : createWatch(tenderId, body);
    },
    onSuccess: async (saved) => {
      await onSaved();
      toast.success(saved.expected_proposed && saved.expected_at ? t('toast.requestedExpected', { date: formatDate(saved.expected_at) }) : t('common:state.saved'));
      close();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  const milestone = data.milestones.find((m) => m.key === form.neededKey);

  return (
    <Modal
      open={editing !== null}
      onClose={close}
      size="lg"
      title={item ? t('form.editTitle') : t('form.addTitle')}
      onSubmit={() => {
        setTouched(true);
        if (!errors.name && !errors.lead && !errors.expected) save.mutate();
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
      <div className="u-form-grid">
        {save.isError && (
          <div className="u-span-2">
            <Banner tone="red">{errorMessage(save.error)}</Banner>
          </div>
        )}
        <Field label={t('columns.name')} required error={touched ? errors.name : undefined}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={300} />
        </Field>
        <Field label={t('common:labels.owner')}>
          <OwnerSelect value={form.owner} onChange={(v) => set('owner', v)} roles={data.roles} />
        </Field>

        <Field label={t('columns.lead')} error={touched ? errors.lead : undefined} hint={t('form.leadHint')}>
          <div className="watch-lead">
            <Select value={form.leadOpen ? 'open' : form.leadUnit} onChange={(e) => (e.target.value === 'open' ? set('leadOpen', true) : setForm((f) => ({ ...f, leadOpen: false, leadUnit: e.target.value as OffsetUnit })))}>
              <option value="open">{t('leadOpen')}</option>
              {enumOptions('offset_unit', OFFSET_UNITS).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {!form.leadOpen && <Input type="number" min={0} step={1} inputMode="numeric" aria-label={t('form.leadDays')} value={form.leadValue} onChange={(e) => set('leadValue', e.target.value)} />}
          </div>
        </Field>
        <Field label={t('columns.needed')} hint={form.neededMode === 'milestone' && milestone?.due_date ? t('form.neededFromMilestone', { date: formatDate(milestone.due_date) }) : undefined}>
          <div className="watch-lead">
            <Select value={form.neededMode === 'milestone' ? form.neededKey : ''} onChange={(e) => setForm((f) => ({ ...f, neededMode: e.target.value ? 'milestone' : 'date', neededKey: e.target.value }))} placeholder={t('form.neededDate')}>
              {data.milestones.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.key === m.name ? m.key : `${m.key} · ${m.name}`}
                </option>
              ))}
            </Select>
            {form.neededMode === 'date' && <DateInput aria-label={t('columns.needed')} value={form.neededAt} onChange={(v) => set('neededAt', v)} />}
          </div>
        </Field>

        <Field label={t('columns.requested')}>
          <DateInput value={form.requestedAt} onChange={(v) => set('requestedAt', v)} />
        </Field>
        <Field label={t('columns.expected')} error={touched ? errors.expected : undefined} hint={t('form.expectedHint')}>
          <DateInput value={form.expectedAt} onChange={(v) => set('expectedAt', v)} />
        </Field>
        <Field label={t('columns.arrived')}>
          <DateInput value={form.arrivedAt} onChange={(v) => set('arrivedAt', v)} />
        </Field>
        <div className="u-span-2">
          <Field label={t('form.checks')}>
            <Textarea value={form.checks} onChange={(e) => set('checks', e.target.value)} rows={2} maxLength={2000} />
          </Field>
        </div>
        <div className="u-span-2">
          <Field label={t('common:labels.notes')}>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={5000} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
