import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { CHANGE_KINDS, CHANGE_SOURCES, type ChangeKind, type ChangeSource, type ID } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { UserSelect } from '@/features/shared/UserSelect';
import { useUsers } from '@/features/shared/useUsers';
import { useTender } from '@/features/tenders/tenderContext';
import { tenderKeys } from '@/features/tenders/tenderApi';
import { formatDate, todayAthens } from '@/lib/dates';
import { enumLabel, enumOptions } from '@/lib/enums';
import { Badge, Banner, Button, Checkbox, ConfirmDialog, DateInput, DateText, EmptyState, Field, Input, Menu, Modal, PageHeader, PageSpinner, Select, Textarea, useToast } from '@/ui';
import { changesKeys, createChange, deleteChange, fetchRequirementOptions, listChanges, updateChange, type ChangeInput, type ChangeView, type RequirementRef } from './changesApi';
import './changes.css';

type Editing = { mode: 'add' } | { mode: 'edit'; entry: ChangeView } | null;
const MANUAL_KINDS = CHANGE_KINDS.filter((k) => k !== 'extension');

/** /tenders/:tenderId/changes — clarifications, amendments and extensions with the ΥΠ rows they affect. */
export function ChangesTab() {
  const { t } = useTranslation('changes');
  const { tenderId, canWrite } = useTender();
  const { hasRole } = useAuth();
  const { nameOf } = useUsers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<ChangeView | null>(null);
  const [kind, setKind] = useState<'' | ChangeKind>('');

  const query = useQuery({ queryKey: changesKeys.list(tenderId), queryFn: () => listChanges(tenderId) });
  const all = query.data ?? [];
  const entries = kind ? all.filter((e) => e.kind === kind) : all;

  const remove = useMutation({
    mutationFn: (e: ChangeView) => deleteChange(tenderId, e.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: changesKeys.list(tenderId) });
      toast.success(t('common:state.deleted'));
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => setRemoving(null),
  });

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
      ) : query.isPending ? (
        <PageSpinner />
      ) : all.length === 0 ? (
        <EmptyState icon="history" title={t('empty')} description={t('emptyHint')} />
      ) : (
        <>
          <div className="changes-toolbar">
            <Select className="changes-toolbar__kind" aria-label={t('fields.kind')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} placeholder={t('allKinds')} options={enumOptions('change_kind', CHANGE_KINDS)} />
            <span className="u-muted">{t('count', { count: entries.length })}</span>
          </div>
          {entries.length === 0 && <EmptyState compact title={t('common:state.emptyFiltered')} />}
          <ol className="changes-list">
            {entries.map((e) => {
              const oldT = typeof e.payload.oldT === 'string' ? e.payload.oldT : null;
              const newT = typeof e.payload.newT === 'string' ? e.payload.newT : null;
              return (
                <li key={e.id} className={`change change--${e.kind}`}>
                  <div className="change__date">
                    <DateText value={e.date} withWeekday />
                  </div>
                  <div className="change__body">
                    <div className="change__head">
                      <StatusBadge kind="change_kind" value={e.kind} />
                      <span className="u-muted">
                        {t('fields.source')}: {enumLabel('change_source', e.source)}
                        {e.reference ? ` · ${e.reference}` : ''}
                      </span>
                      {canWrite && (
                        <span className="change__menu">
                          <Menu
                            label={`${t('common:actions.more')}: ${formatDate(e.date)}`}
                            items={[
                              { label: t('common:actions.edit'), icon: 'edit', onSelect: () => setEditing({ mode: 'edit', entry: e }) },
                              (!e.kind_locked || hasRole('admin', 'bid_manager')) && { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => setRemoving(e) },
                            ]}
                          />
                        </span>
                      )}
                    </div>
                    <p className="change__text">{e.description || <span className="u-faint">—</span>}</p>
                    {oldT && newT && (
                      <p className="change__ext u-mono">
                        {t('extension', { from: formatDate(oldT), to: formatDate(newT) })}
                      </p>
                    )}
                    <div className="change__meta">
                      <span className="change__reqs">
                        <span className="u-muted">{t('affected')}:</span>
                        {e.requirements.length === 0 ? (
                          <span className="u-faint">{t('noneAffected')}</span>
                        ) : (
                          e.requirements.map((r) => (
                            <Badge key={r.id} title={r.text} className="u-mono">
                              {r.code}
                            </Badge>
                          ))
                        )}
                      </span>
                      <span className="u-muted">
                        {t('common:labels.owner')}: {nameOf(e.owner_user_id) || '—'}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <ChangeModal editing={editing} tenderId={tenderId} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('removeTitle')}
        message={removing ? t('removeMessage', { date: formatDate(removing.date) }) : null}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

interface Form {
  date: string | null;
  source: ChangeSource;
  kind: ChangeKind;
  description: string;
  reference: string;
  owner_user_id: ID | null;
  ids: ID[];
  reopen: boolean;
}

function ChangeModal({ editing, tenderId, onClose }: { editing: Editing; tenderId: string; onClose: () => void }) {
  const { t } = useTranslation('changes');
  const toast = useToast();
  const queryClient = useQueryClient();
  const entry = editing?.mode === 'edit' ? editing.entry : null;
  const blank = (): Form => ({
    date: entry?.date ?? todayAthens(),
    source: entry?.source ?? 'esidis',
    kind: entry?.kind ?? 'clarification',
    description: entry?.description ?? '',
    reference: entry?.reference ?? '',
    owner_user_id: entry?.owner_user_id ?? null,
    ids: entry?.requirement_ids ?? [],
    reopen: false,
  });
  const [form, setForm] = useState<Form>(blank);
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const target = editing ? (entry?.id ?? 'add') : null;
  if (target !== seededFor) {
    setSeededFor(target);
    setTouched(false);
    setForm(blank());
  }

  const options = useQuery({
    queryKey: changesKeys.requirementOptions(tenderId),
    queryFn: () => fetchRequirementOptions(tenderId),
    enabled: editing !== null,
    staleTime: 30_000,
    retry: false,
  });
  // Rows already linked stay selectable even when the register cannot be loaded.
  const known = useMemo<RequirementRef[]>(() => {
    const byId = new Map<ID, RequirementRef>((entry?.requirements ?? []).map((r) => [r.id, r]));
    for (const r of options.data ?? []) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code, 'el', { numeric: true }));
  }, [options.data, entry]);

  const save = useMutation({
    mutationFn: () => {
      const body: ChangeInput = {
        date: form.date ?? undefined,
        source: form.source,
        description: form.description.trim(),
        reference: form.reference.trim() || null,
        owner_user_id: form.owner_user_id,
        requirement_ids: form.ids,
      };
      if (!entry?.kind_locked) body.kind = form.kind;
      if (form.reopen && form.ids.length > 0) body.reopen_requirements = true;
      return entry ? updateChange(tenderId, entry.id, body) : createChange(tenderId, body);
    },
    onSuccess: async (saved) => {
      // The register changes too when rows were set back for a re-check.
      await queryClient.invalidateQueries({ queryKey: saved.reopened ? tenderKeys.detail(tenderId) : changesKeys.list(tenderId) });
      toast.success(saved.reopened ? t('toast.reopened', { count: saved.reopened }) : t('common:state.saved'));
      close();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  const errors = {
    date: !form.date ? t('common:errors.required') : undefined,
    description: !form.description.trim() ? t('common:errors.required') : undefined,
  };

  return (
    <Modal
      open={editing !== null}
      onClose={close}
      size="lg"
      title={entry ? t('form.editTitle') : t('form.addTitle')}
      onSubmit={() => {
        setTouched(true);
        if (!errors.date && !errors.description) save.mutate();
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
        <Field label={t('common:labels.date')} required error={touched ? errors.date : undefined}>
          <DateInput value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
        </Field>
        <Field label={t('fields.kind')} hint={entry?.kind_locked ? t('form.kindLocked') : t('form.kindHint')}>
          {entry?.kind_locked ? (
            <Select value="extension" disabled options={enumOptions('change_kind', ['extension'])} />
          ) : (
            <Select options={enumOptions('change_kind', MANUAL_KINDS)} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ChangeKind })} />
          )}
        </Field>
        <Field label={t('fields.source')}>
          <Select options={enumOptions('change_source', CHANGE_SOURCES)} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as ChangeSource })} />
        </Field>
        <Field label={t('fields.reference')} hint={t('form.referenceHint')}>
          <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={500} />
        </Field>
        <div className="u-span-2">
          <Field label={t('common:labels.description')} required error={touched ? errors.description : undefined}>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} maxLength={5000} />
          </Field>
        </div>
        <Field label={t('common:labels.owner')}>
          <UserSelect value={form.owner_user_id} onChange={(id) => setForm({ ...form, owner_user_id: id })} />
        </Field>
        <div className="u-span-2">
          <RequirementPicker
            options={known}
            loading={options.isPending}
            failed={options.isError}
            value={form.ids}
            onChange={(ids) => setForm((f) => ({ ...f, ids, reopen: ids.length > 0 && f.reopen }))}
          />
        </div>
        <div className="u-span-2">
          <Checkbox
            label={t('form.reopen')}
            hint={t('form.reopenHint')}
            checked={form.reopen}
            disabled={form.ids.length === 0}
            onChange={(e) => setForm({ ...form, reopen: e.target.checked })}
          />
        </div>
      </div>
    </Modal>
  );
}

interface PickerProps {
  options: RequirementRef[];
  loading: boolean;
  failed: boolean;
  value: ID[];
  onChange: (ids: ID[]) => void;
}

/** Multi-select of register rows: search by code or text, tick to link. */
function RequirementPicker({ options, loading, failed, value, onChange }: PickerProps) {
  const { t } = useTranslation('changes');
  const [search, setSearch] = useState('');
  const selected = new Set(value);
  const q = search.trim().toLocaleLowerCase('el');
  const shown = q ? options.filter((r) => `${r.code} ${r.text}`.toLocaleLowerCase('el').includes(q)) : options;
  const toggle = (id: ID) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <fieldset className="req-picker">
      <legend className="ui-field__label">
        {t('affected')} <span className="u-muted">({t('picker.selected', { count: value.length })})</span>
      </legend>
      {value.length > 0 && (
        <div className="req-picker__chips">
          {options
            .filter((r) => selected.has(r.id))
            .map((r) => (
              <button key={r.id} type="button" className="req-picker__chip u-mono" onClick={() => toggle(r.id)} aria-label={t('picker.remove', { code: r.code })} title={r.text}>
                {r.code} <span aria-hidden="true">×</span>
              </button>
            ))}
        </div>
      )}
      <Input type="search" aria-label={t('picker.search')} placeholder={t('picker.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="req-picker__list" role="group" aria-label={t('affected')}>
        {failed && options.length === 0 ? (
          <p className="req-picker__empty">{t('picker.failed')}</p>
        ) : loading && options.length === 0 ? (
          <p className="req-picker__empty">{t('common:state.loading')}</p>
        ) : shown.length === 0 ? (
          <p className="req-picker__empty">{options.length === 0 ? t('picker.empty') : t('picker.noMatch')}</p>
        ) : (
          shown.map((r) => (
            <label key={r.id} className="req-picker__row">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
              <span className="u-mono req-picker__code">{r.code}</span>
              <span className="req-picker__text">{r.text}</span>
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}
