import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { useUsers, usersKeys } from '@/features/shared/useUsers';
import { Banner, Button, Checkbox, Field, Input, Modal, Select, Spinner, Tabs, useToast } from '@/ui';
import { documentsKeys, erasePerson, getRetention, setRetention, type ErasePlan } from './documentsApi';

/** Admin only: erase one person's data (dry-run preview + typed confirmation) and the retention period. */
export function GdprModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation('documents');
  const [tab, setTab] = useState('erase');
  return (
    <Modal open onClose={onClose} size="lg" closeOnBackdrop={false} title={t('gdpr.title')} description={t('gdpr.description')} footer={<Button onClick={onClose}>{t('common:actions.close')}</Button>}>
      <div className="u-stack">
        <Tabs
          label={t('gdpr.title')}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'erase', label: t('gdpr.tabs.erase') },
            { key: 'retention', label: t('gdpr.tabs.retention') },
          ]}
        />
        {tab === 'erase' ? <ErasePanel onChanged={onChanged} /> : <RetentionPanel />}
      </div>
    </Modal>
  );
}

function ErasePanel({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation('documents');
  const { user: me } = useAuth();
  const { users } = useUsers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [personName, setPersonName] = useState('');
  const [plan, setPlan] = useState<ErasePlan | null>(null);
  const [typed, setTyped] = useState('');
  const word = t('gdpr.erase.confirmWord');

  const target = () => ({ ...(userId ? { user_id: userId } : {}), ...(personName.trim() ? { person_name: personName.trim() } : {}) });
  const hasTarget = !!userId || personName.trim().length >= 2;
  // Any change of the target invalidates the preview: what is confirmed is exactly what was shown.
  const reset = () => {
    setPlan(null);
    setTyped('');
  };

  const preview = useMutation({
    mutationFn: () => erasePerson({ ...target(), dry_run: true }),
    onSuccess: (p) => {
      setPlan(p);
      setTyped('');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const erase = useMutation({
    mutationFn: () => erasePerson({ ...target(), dry_run: false }),
    onSuccess: async () => {
      toast.success(t('gdpr.erase.done'));
      setUserId('');
      setPersonName('');
      reset();
      await Promise.all([onChanged(), queryClient.invalidateQueries({ queryKey: usersKeys.all })]);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const nothing = plan !== null && plan.counts.documents === 0 && (!plan.user || plan.user.already_anonymized);

  return (
    <div className="u-stack">
      <Banner tone="red">{t('gdpr.erase.intro')}</Banner>
      <div className="u-form-grid">
        <Field label={t('gdpr.erase.user')}>
          <Select
            value={userId}
            placeholder={t('gdpr.erase.userNone')}
            onChange={(e) => {
              setUserId(e.target.value);
              reset();
            }}
            options={users.filter((u) => u.id !== me?.id).map((u) => ({ value: u.id, label: `${u.name} · ${u.email}` }))}
          />
        </Field>
        <Field label={t('gdpr.erase.personName')} hint={t('gdpr.erase.personHint')}>
          <Input
            value={personName}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => {
              setPersonName(e.target.value);
              reset();
            }}
          />
        </Field>
      </div>
      <div>
        <Button icon="search" loading={preview.isPending} disabled={!hasTarget} onClick={() => preview.mutate()}>
          {t('gdpr.erase.preview')}
        </Button>
      </div>

      {plan && (
        <div className="gdpr-plan" aria-live="polite">
          <h4>{t('gdpr.erase.previewTitle')}</h4>
          {nothing ? (
            <p className="gdpr-plan__sub">{plan.user?.already_anonymized ? t('gdpr.erase.userAlready') : t('gdpr.erase.nothing')}</p>
          ) : (
            <ul>
              {plan.user && !plan.user.already_anonymized && <li>{t('gdpr.erase.userLine', { name: plan.user.name, email: plan.user.email, sessions: plan.counts.sessions })}</li>}
              {plan.counts.documents > 0 && (
                <li>
                  {t('gdpr.erase.docsLine', { count: plan.counts.documents, files: plan.counts.files, links: plan.counts.tender_links })}
                  <ul>
                    {plan.documents.map((d) => (
                      <li key={d.id}>
                        {d.title}
                        {d.person_name ? ` — ${d.person_name}` : ''}
                        {d.tenders.length > 0 && <span className="gdpr-plan__sub"> · {t('gdpr.erase.docTenders', { titles: d.tenders.map((x) => x.title).join(', ') })}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          )}
          {plan.matching_users.length > 0 && <Banner tone="orange">{t('gdpr.erase.matchingUsers', { names: plan.matching_users.map((u) => `${u.name}, ${u.email}`).join(' · ') })}</Banner>}
          {!nothing && (
            <>
              <Field label={t('gdpr.erase.confirmLabel', { word })}>
                <Input value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
              </Field>
              <div>
                <Button variant="danger" icon="trash" loading={erase.isPending} disabled={typed.trim() !== word} onClick={() => erase.mutate()}>
                  {t('gdpr.erase.submit')}
                </Button>
              </div>
              <p className="gdpr-plan__sub">{t('gdpr.erase.auditNote')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RetentionPanel() {
  const { t } = useTranslation('documents');
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: documentsKeys.retention, queryFn: getRetention });
  const [forever, setForever] = useState(true);
  const [days, setDays] = useState('365');

  useEffect(() => {
    if (!query.data) return;
    setForever(query.data.retention_days === null);
    if (query.data.retention_days !== null) setDays(String(query.data.retention_days));
  }, [query.data]);

  const parsed = Number(days);
  const valid = forever || (/^\d{1,5}$/.test(days.trim()) && parsed >= 0 && parsed <= 36500);
  const save = useMutation({
    mutationFn: () => setRetention(forever ? null : parsed),
    onSuccess: (data) => {
      queryClient.setQueryData(documentsKeys.retention, data);
      toast.success(t('gdpr.retention.saved'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isPending) return <Spinner />;
  if (query.isError) return <Banner tone="red">{errorMessage(query.error)}</Banner>;
  const pending = query.data.pending;

  return (
    <div className="u-stack">
      <p className="gdpr-plan__sub">{t('gdpr.retention.intro')}</p>
      <Checkbox label={t('gdpr.retention.keepForever')} checked={forever} onChange={(e) => setForever(e.target.checked)} />
      {!forever && (
        <Field label={t('gdpr.retention.days')}>
          <Input type="number" inputMode="numeric" min={0} max={36500} value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: '10rem' }} />
        </Field>
      )}
      {query.data.retention_days !== null && (
        <Banner tone={pending.files > 0 ? 'orange' : 'info'}>{pending.files > 0 ? t('gdpr.retention.pending', { files: pending.files, tenders: pending.tenders }) : t('gdpr.retention.pendingNone')}</Banner>
      )}
      <div>
        <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
          {t('common:actions.save')}
        </Button>
      </div>
    </div>
  );
}
