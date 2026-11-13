import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { RISK_STATUSES, type RiskStatus } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { UserSelect } from '@/features/shared/UserSelect';
import { useUsers } from '@/features/shared/useUsers';
import { useTender } from '@/features/tenders/tenderContext';
import { enumOptions, enumTone } from '@/lib/enums';
import { Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Menu, Modal, PageHeader, PageSpinner, Select, Textarea, useToast } from '@/ui';
import { createRisk, deleteRisk, listRisks, risksKeys, seedDefaultRisks, updateRisk, type RiskInput, type RiskView } from './risksApi';
import './risks.css';

type Editing = { mode: 'add' } | { mode: 'edit'; risk: RiskView } | null;
const ORDER: Record<RiskStatus, number> = { occurred: 0, open: 1, mitigating: 2, closed: 3 };

/** /tenders/:tenderId/risks — risk register: risk, early sign, reaction, owner, status. */
export function RisksTab() {
  const { t } = useTranslation('risks');
  const { tenderId, canWrite } = useTender();
  const { hasRole } = useAuth();
  const { nameOf } = useUsers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<RiskView | null>(null);
  const canSeed = canWrite && hasRole('admin', 'bid_manager');

  const query = useQuery({ queryKey: risksKeys.list(tenderId), queryFn: () => listRisks(tenderId) });
  const risks = [...(query.data ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: risksKeys.list(tenderId) });
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const seed = useMutation({
    mutationFn: () => seedDefaultRisks(tenderId),
    onSuccess: async (res) => {
      await refresh();
      toast[res.added > 0 ? 'success' : 'info'](res.added > 0 ? t('seeded', { count: res.added }) : t('seededNone'));
    },
    onError,
  });
  const setStatus = useMutation({
    mutationFn: (v: { risk: RiskView; status: RiskStatus }) => updateRisk(tenderId, v.risk.id, { status: v.status }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (r: RiskView) => deleteRisk(tenderId, r.id),
    onSuccess: async () => {
      await refresh();
      toast.success(t('common:state.deleted'));
    },
    onError,
    onSettled: () => setRemoving(null),
  });

  const seedButton = canSeed && (
    <Button icon="layers" loading={seed.isPending} onClick={() => seed.mutate()}>
      {t('seed')}
    </Button>
  );
  const active = risks.filter((r) => r.status !== 'closed').length;

  return (
    <>
      <PageHeader
        level={2}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite && (
            <>
              {seedButton}
              <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
                {t('add')}
              </Button>
            </>
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
      ) : risks.length === 0 ? (
        <EmptyState icon="shield" title={t('empty')} description={t(canSeed ? 'emptyHintSeed' : 'emptyHint')} action={seedButton || undefined} />
      ) : (
        <>
          <p className="risks-summary u-muted">{t('summary', { count: risks.length, active })}</p>
          <div className="risks-grid">
            {risks.map((r) => (
              <Card
                key={r.id}
                as="article"
                className={r.status === 'closed' ? 'risk-card is-closed' : 'risk-card'}
                tone={r.status === 'closed' ? undefined : enumTone('risk_status', r.status)}
                title={r.title}
                actions={
                  canWrite && (
                    <Menu
                      label={`${t('common:actions.more')}: ${r.title}`}
                      items={[
                        { label: t('common:actions.edit'), icon: 'edit', onSelect: () => setEditing({ mode: 'edit', risk: r }) },
                        { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => setRemoving(r) },
                      ]}
                    />
                  )
                }
                footer={
                  <div className="risk-card__footer">
                    <span className="u-muted u-truncate">
                      {t('common:labels.owner')}: {nameOf(r.owner_user_id) || t('common:labels.unassigned')}
                    </span>
                    {canWrite ? (
                      <Select
                        className="risk-card__status"
                        aria-label={`${t('common:labels.status')}: ${r.title}`}
                        options={enumOptions('risk_status', RISK_STATUSES)}
                        value={r.status}
                        onChange={(e) => setStatus.mutate({ risk: r, status: e.target.value as RiskStatus })}
                      />
                    ) : (
                      <StatusBadge kind="risk_status" value={r.status} dot />
                    )}
                  </div>
                }
              >
                <dl className="risk-card__body">
                  <dt>{t('fields.trigger')}</dt>
                  <dd>{r.trigger || <span className="u-faint">—</span>}</dd>
                  <dt>{t('fields.mitigation')}</dt>
                  <dd>{r.mitigation || <span className="u-faint">—</span>}</dd>
                </dl>
              </Card>
            ))}
          </div>
        </>
      )}

      <RiskModal editing={editing} tenderId={tenderId} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('removeTitle')}
        message={removing ? t('removeMessage', { title: removing.title }) : null}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

function RiskModal({ editing, tenderId, onClose, onSaved }: { editing: Editing; tenderId: string; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation('risks');
  const toast = useToast();
  const risk = editing?.mode === 'edit' ? editing.risk : null;
  const [form, setForm] = useState<Required<RiskInput>>({ title: '', trigger: '', mitigation: '', owner_user_id: null, status: 'open' });
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const target = editing ? (risk?.id ?? 'add') : null;
  if (target !== seededFor) {
    setSeededFor(target);
    setTouched(false);
    setForm({ title: risk?.title ?? '', trigger: risk?.trigger ?? '', mitigation: risk?.mitigation ?? '', owner_user_id: risk?.owner_user_id ?? null, status: risk?.status ?? 'open' });
  }
  const save = useMutation({
    mutationFn: () => {
      const body: RiskInput = { ...form, title: form.title.trim(), trigger: form.trigger?.trim() || null, mitigation: form.mitigation?.trim() || null };
      return risk ? updateRisk(tenderId, risk.id, body) : createRisk(tenderId, body);
    },
    onSuccess: async () => {
      await onSaved();
      toast.success(t('common:state.saved'));
      close();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  const titleError = !form.title.trim() ? t('common:errors.required') : undefined;

  return (
    <Modal
      open={editing !== null}
      onClose={close}
      title={risk ? t('form.editTitle') : t('form.addTitle')}
      onSubmit={() => {
        setTouched(true);
        if (!titleError) save.mutate();
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
        <div className="u-span-2">
          <Field label={t('fields.title')} required error={touched ? titleError : undefined}>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={300} />
          </Field>
        </div>
        <div className="u-span-2">
          <Field label={t('fields.trigger')} hint={t('form.triggerHint')}>
            <Textarea value={form.trigger ?? ''} onChange={(e) => setForm({ ...form, trigger: e.target.value })} rows={2} maxLength={2000} />
          </Field>
        </div>
        <div className="u-span-2">
          <Field label={t('fields.mitigation')} hint={t('form.mitigationHint')}>
            <Textarea value={form.mitigation ?? ''} onChange={(e) => setForm({ ...form, mitigation: e.target.value })} rows={2} maxLength={2000} />
          </Field>
        </div>
        <Field label={t('common:labels.owner')}>
          <UserSelect value={form.owner_user_id} onChange={(id) => setForm({ ...form, owner_user_id: id })} />
        </Field>
        <Field label={t('common:labels.status')}>
          <Select options={enumOptions('risk_status', RISK_STATUSES)} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as RiskStatus })} />
        </Field>
      </div>
    </Modal>
  );
}
