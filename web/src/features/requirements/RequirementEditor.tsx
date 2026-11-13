import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, isApiError } from '@/api/client';
import type { ID, RequirementFolder, RequirementStatus, RequirementType } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { enumLabel, enumOptions } from '@/lib/enums';
import { Banner, Button, ConfirmDialog, DateText, Field, Input, Modal, Select, Textarea, useToast } from '@/ui';
import { REQUIREMENT_FOLDERS, REQUIREMENT_STATUSES, REQUIREMENT_TYPES, canonicalCode, isBlank } from './registerModel';
import { createRequirement, deleteRequirement, updateRequirement, type Owners, type RegisterRow, type RequirementBody } from './requirementsApi';

export interface EditorTarget {
  /** null = new row */
  row: RegisterRow | null;
  /** Preset when opened from the inline status select (e.g. «Απόκλιση» needs a note first) */
  status?: RequirementStatus;
}

interface Props {
  tenderId: ID;
  target: EditorTarget;
  owners: Owners | undefined;
  nextCode: string;
  /** Codes in use, to warn before the server does */
  codes: ReadonlySet<string>;
  canWrite: boolean;
  onClose: () => void;
  onSaved: (row: RegisterRow, created: boolean) => void;
  onDeleted: (id: ID) => void;
}

interface Form {
  code: string;
  type: RequirementType;
  folder: RequirementFolder | '';
  weight: string;
  source_ref: string;
  text: string;
  owner_role_key: string;
  owner_user_id: string;
  response_ref: string;
  evidence_ref: string;
  status: RequirementStatus;
  deviation_note: string;
}

const initial = (target: EditorTarget, nextCode: string): Form => {
  const r = target.row;
  return {
    code: r?.code ?? nextCode,
    type: r?.type ?? 'exclusion',
    folder: r?.folder ?? '',
    weight: r?.weight ?? '',
    source_ref: r?.source_ref ?? '',
    text: r?.text ?? '',
    owner_role_key: r?.owner_role_key ?? '',
    owner_user_id: r?.owner_user_id ?? '',
    response_ref: r?.response_ref ?? '',
    evidence_ref: r?.evidence_ref ?? '',
    status: target.status ?? r?.status ?? 'open',
    deviation_note: r?.deviation_note ?? '',
  };
};

/** Row editor (all fields). R17: «Απόκλιση» cannot be saved without a note. Delete only for bid_manager/admin. */
export function RequirementEditor({ tenderId, target, owners, nextCode, codes, canWrite, onClose, onSaved, onDeleted }: Props) {
  const { t } = useTranslation('requirements');
  const toast = useToast();
  const { hasRole } = useAuth();
  const row = target.row;
  const [form, setForm] = useState<Form>(() => initial(target, nextCode));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const body = (): RequirementBody => ({
    code: form.code,
    type: form.type,
    folder: form.folder || null,
    weight: form.weight,
    source_ref: form.source_ref,
    text: form.text.trim(),
    owner_role_key: form.owner_role_key || null,
    owner_user_id: form.owner_user_id || null,
    response_ref: form.response_ref,
    evidence_ref: form.evidence_ref,
    status: form.status,
    deviation_note: form.deviation_note,
  });

  const save = useMutation({
    mutationFn: () => (row ? updateRequirement(tenderId, row.id, body()) : createRequirement(tenderId, body())),
    onSuccess: (saved) => {
      toast.success(row ? t('common:state.saved') : t('editor.created', { code: saved.code }));
      onSaved(saved, !row);
    },
    onError: (err) => {
      if (isApiError(err) && err.code === 'requirement_code_exists') setErrors((e) => ({ ...e, code: err.message }));
      else if (isApiError(err) && err.code === 'requirement_code_invalid') setErrors((e) => ({ ...e, code: err.message }));
      else if (isApiError(err) && err.code === 'deviation_note_required') setErrors((e) => ({ ...e, deviation_note: err.message }));
      else toast.error(errorMessage(err));
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteRequirement(tenderId, (row as RegisterRow).id),
    onSuccess: () => {
      toast.success(t('common:state.deleted'));
      onDeleted((row as RegisterRow).id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = () => {
    if (!canWrite) return;
    const next: typeof errors = {};
    const code = canonicalCode(form.code);
    if (!code) next.code = t('editor.codeInvalid');
    else if (code !== row?.code && codes.has(code)) next.code = t('editor.codeExists', { code });
    if (form.text.trim() === '') next.text = t('editor.textRequired');
    if (form.status === 'deviation' && isBlank(form.deviation_note)) next.deviation_note = t('editor.deviationRequired');
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  const readOnly = !canWrite;
  const showNote = form.status === 'deviation' || !isBlank(form.deviation_note);
  const blocking = form.type === 'exclusion' && isBlank(form.evidence_ref);
  const canDelete = Boolean(row) && canWrite && hasRole('admin', 'bid_manager');
  const busy = save.isPending || remove.isPending;

  return (
    <>
      <Modal
        open
        size="lg"
        onClose={onClose}
        closeOnBackdrop={false}
        title={row ? t(readOnly ? 'editor.viewTitle' : 'editor.editTitle', { code: row.code }) : t('editor.newTitle')}
        onSubmit={submit}
        footer={
          <>
            {canDelete && (
              <Button variant="danger" icon="trash" className="reg-footer-split" disabled={busy} onClick={() => setConfirmDelete(true)}>
                {t('editor.delete')}
              </Button>
            )}
            <Button onClick={onClose} disabled={busy}>
              {readOnly ? t('common:actions.close') : t('common:actions.cancel')}
            </Button>
            {!readOnly && (
              <Button type="submit" variant="primary" loading={save.isPending} disabled={remove.isPending}>
                {t('common:actions.save')}
              </Button>
            )}
          </>
        }
      >
        <div className="u-form-grid">
          <Field label={t('columns.code')} required hint={t('editor.codeHint')} error={errors.code}>
            <Input value={form.code} onChange={(e) => set('code', e.target.value)} onBlur={() => set('code', canonicalCode(form.code) ?? form.code)} disabled={readOnly} className="u-mono" maxLength={40} />
          </Field>
          <Field label={t('columns.type')} required>
            <Select value={form.type} onChange={(e) => set('type', e.target.value as RequirementType)} options={enumOptions('requirement_type', REQUIREMENT_TYPES)} disabled={readOnly} />
          </Field>
          <Field label={t('columns.text')} required hint={t('editor.textHint')} error={errors.text} className="u-span-2">
            <Textarea value={form.text} onChange={(e) => set('text', e.target.value)} rows={4} disabled={readOnly} maxLength={20000} />
          </Field>
          <Field label={t('columns.source_ref')} hint={t('editor.sourceHint')} className={form.type === 'scored' ? undefined : 'u-span-2'}>
            <Input value={form.source_ref} onChange={(e) => set('source_ref', e.target.value)} disabled={readOnly} maxLength={500} />
          </Field>
          {form.type === 'scored' && (
            <Field label={t('columns.weight')} hint={t('editor.weightHint')}>
              <Input value={form.weight} onChange={(e) => set('weight', e.target.value)} disabled={readOnly} maxLength={500} />
            </Field>
          )}
          <Field label={t('columns.folder')}>
            <Select value={form.folder} onChange={(e) => set('folder', e.target.value as Form['folder'])} options={enumOptions('folder', REQUIREMENT_FOLDERS)} placeholder={t('editor.noFolder')} disabled={readOnly} />
          </Field>
          <Field label={t('columns.status')} required>
            <Select value={form.status} onChange={(e) => set('status', e.target.value as RequirementStatus)} options={enumOptions('requirement_status', REQUIREMENT_STATUSES)} disabled={readOnly} />
          </Field>
          {showNote && (
            <Field label={t('columns.deviation_note')} required={form.status === 'deviation'} hint={t('editor.deviationHint')} error={errors.deviation_note} className="u-span-2">
              <Textarea value={form.deviation_note} onChange={(e) => set('deviation_note', e.target.value)} rows={2} disabled={readOnly} maxLength={5000} />
            </Field>
          )}
          <Field label={t('editor.ownerRole')}>
            <Select value={form.owner_role_key} onChange={(e) => set('owner_role_key', e.target.value)} placeholder={t('editor.noRole')} disabled={readOnly}>
              {form.owner_role_key && !owners?.roles.some((r) => r.key === form.owner_role_key) && <option value={form.owner_role_key}>{form.owner_role_key}</option>}
              {owners?.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name && r.name !== r.key ? `${r.key} — ${r.name}` : r.key}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('editor.ownerUser')}>
            <Select value={form.owner_user_id} onChange={(e) => set('owner_user_id', e.target.value)} placeholder={t('common:labels.unassigned')} disabled={readOnly}>
              {form.owner_user_id && !owners?.users.some((u) => u.id === form.owner_user_id) && <option value={form.owner_user_id}>…</option>}
              {owners?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('columns.response_ref')} hint={t('editor.responseHint')}>
            <Input value={form.response_ref} onChange={(e) => set('response_ref', e.target.value)} disabled={readOnly} maxLength={1000} />
          </Field>
          <Field label={t('columns.evidence_ref')} hint={t('editor.evidenceHint')}>
            <Input value={form.evidence_ref} onChange={(e) => set('evidence_ref', e.target.value)} disabled={readOnly} maxLength={1000} />
          </Field>
          {blocking && (
            <div className="u-span-2">
              <Banner tone="red">{t('editor.evidenceBlocking')}</Banner>
            </div>
          )}
          {row && row.changes.length > 0 && (
            <div className="u-span-2">
              <Field label={t('editor.changes')}>
                <ul className="reg-changes">
                  {row.changes.map((c) => (
                    <li key={c.id}>
                      <DateText value={c.date} />
                      <StatusBadge kind="change_kind" value={c.kind} />
                      <span className="u-muted">{enumLabel('change_source', c.source)}</span>
                      <span className="reg-changes__desc">
                        {c.description}
                        {c.reference ? ` (${c.reference})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Field>
            </div>
          )}
          {row && (
            <p className="reg-editor__meta u-span-2">
              {t('common:labels.updatedAt')}: <DateText value={row.updated_at} withTime />
            </p>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        danger
        title={t('editor.deleteTitle', { code: row?.code ?? '' })}
        message={t('editor.deleteMessage', { code: row?.code ?? '' })}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
