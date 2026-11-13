import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { ID, RequirementFolder, RequirementStatus } from '@/api/types';
import { enumOptions } from '@/lib/enums';
import { Banner, Button, Field, Modal, Select, Textarea, useToast } from '@/ui';
import { REQUIREMENT_FOLDERS, REQUIREMENT_STATUSES } from './registerModel';
import { bulkUpdateRequirements, type BulkPatch, type Owners } from './requirementsApi';

interface Props {
  tenderId: ID;
  ids: ID[];
  owners: Owners | undefined;
  onClose: () => void;
  onDone: () => void;
}

/** One change of status / owner / folder on the selected rows (all or nothing on the server). */
export function BulkDialog({ tenderId, ids, owners, onClose, onDone }: Props) {
  const { t } = useTranslation('requirements');
  const toast = useToast();
  const [status, setStatus] = useState<RequirementStatus | ''>('');
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState(''); // '' | 'none' | 'role:<key>' | user id
  const [folder, setFolder] = useState<RequirementFolder | 'none' | ''>('');
  const [error, setError] = useState<string | null>(null);

  const patch = (): BulkPatch => {
    const p: BulkPatch = {};
    if (status) p.status = status;
    if (status === 'deviation') p.deviation_note = note.trim();
    if (owner === 'none') Object.assign(p, { owner_user_id: null, owner_role_key: null });
    else if (owner.startsWith('role:')) Object.assign(p, { owner_role_key: owner.slice(5), owner_user_id: null });
    else if (owner) Object.assign(p, { owner_user_id: owner, owner_role_key: null });
    if (folder) p.folder = folder === 'none' ? null : folder;
    return p;
  };
  const apply = useMutation({
    mutationFn: () => bulkUpdateRequirements(tenderId, ids, patch()),
    onSuccess: (res) => {
      toast.success(t('bulk.done', { count: res.updated }));
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = () => {
    if (!status && !owner && !folder) return setError(t('bulk.nothing'));
    if (status === 'deviation' && note.trim() === '') return setError(t('editor.deviationRequired'));
    setError(null);
    apply.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('bulk.title', { count: ids.length })}
      description={t('bulk.description')}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={apply.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={apply.isPending}>
            {t('bulk.apply')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        <Field label={t('columns.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value as RequirementStatus | '')} options={enumOptions('requirement_status', REQUIREMENT_STATUSES)} placeholder={t('bulk.noChange')} />
        </Field>
        {status === 'deviation' && (
          <Field label={t('columns.deviation_note')} required hint={t('bulk.deviationHint')}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={5000} />
          </Field>
        )}
        <Field label={t('columns.owner')}>
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={t('bulk.noChange')}>
            <option value="none">{t('bulk.clearOwner')}</option>
            <optgroup label={t('filters.roles')}>
              {owners?.roles.map((r) => (
                <option key={r.key} value={`role:${r.key}`}>
                  {r.name && r.name !== r.key ? `${r.key} — ${r.name}` : r.key}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('filters.users')}>
              {owners?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <Field label={t('columns.folder')}>
          <Select value={folder} onChange={(e) => setFolder(e.target.value as typeof folder)} placeholder={t('bulk.noChange')}>
            {enumOptions('folder', REQUIREMENT_FOLDERS).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            <option value="none">{t('bulk.clearFolder')}</option>
          </Select>
        </Field>
        {error && <Banner tone="red">{error}</Banner>}
      </div>
    </Modal>
  );
}
