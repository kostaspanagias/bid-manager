import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, isApiError } from '@/api/client';
import type { TaskSection } from '@/api/types';
import { Banner, Button, DateInput, Field, Input, Modal, Select, Textarea, useToast } from '@/ui';
import { OwnerSelect, type OwnerValue } from './owner';
import type { RoleView, TaskInput, TaskView } from './tasksApi';
import { useTaskActions } from './useTaskActions';

export type TaskEditing = { mode: 'add'; section: TaskSection; roleKey?: string } | { mode: 'edit'; task: TaskView } | null;

interface Props {
  editing: TaskEditing;
  tenderId: string;
  roles: RoleView[];
  onClose: () => void;
}

/** Add / edit a task, a checklist line or a handoff. */
export function TaskModal({ editing, tenderId, roles, onClose }: Props) {
  const { t } = useTranslation('tasks');
  const toast = useToast();
  const { create, update } = useTaskActions(tenderId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<OwnerValue>({ owner_user_id: null, owner_role_key: null });
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const target = editing ? (editing.mode === 'edit' ? editing.task.id : `add-${editing.section}-${editing.roleKey ?? ''}`) : null;
  if (target !== seededFor) {
    setSeededFor(target);
    setTouched(false);
    const task = editing?.mode === 'edit' ? editing.task : null;
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setOwner({
      owner_user_id: task?.owner_user_id ?? null,
      owner_role_key: task?.owner_role_key ?? (editing?.mode === 'add' ? (editing.roleKey ?? null) : null),
    });
    setDueDate(task?.due_date ?? null);
    setFrom(task?.handoff_from_role ?? '');
    setTo(task?.handoff_to_role ?? '');
  }

  const task = editing?.mode === 'edit' ? editing.task : null;
  const section: TaskSection = task?.section ?? (editing?.mode === 'add' ? editing.section : 'task');
  const isHandoff = section === 'handoff';
  const received = task?.handoff?.state === 'received';
  // A template handoff mirrors its milestone: the date is changed in the schedule.
  const dateLocked = isHandoff && task?.milestone?.kind === 'handoff';
  const mutation = task ? update : create;
  const roleOptions = roles.map((r) => ({ value: r.key, label: r.name }));

  const errors = {
    title: !title.trim() ? t('common:errors.required') : undefined,
    from: isHandoff && !from ? t('common:errors.required') : undefined,
    to: isHandoff && !to ? t('common:errors.required') : isHandoff && to === from ? t('form.sameRole') : undefined,
  };
  const fieldErrors = isApiError(mutation.error) ? mutation.error.fieldErrors : {};

  const close = () => {
    create.reset();
    update.reset();
    onClose();
  };

  const submit = () => {
    setTouched(true);
    if (errors.title || errors.from || errors.to) return;
    const body: TaskInput = { title: title.trim(), description: description.trim() || null };
    if (!isHandoff) Object.assign(body, owner);
    if (!dateLocked) body.due_date = dueDate;
    if (isHandoff && !received) Object.assign(body, { handoff_from_role: from, handoff_to_role: to });
    const done = { onSuccess: () => { if (!task) toast.success(t('common:state.saved')); close(); } };
    if (task) update.mutate({ id: task.id, body }, done);
    else create.mutate({ body: { ...body, section } }, done);
  };

  return (
    <Modal
      open={editing !== null}
      onClose={close}
      title={t(`form.title.${task ? 'edit' : 'add'}.${section}`)}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={close} disabled={mutation.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-form-grid">
        {create.isError && (
          <div className="u-span-2">
            <Banner tone="red">{errorMessage(create.error)}</Banner>
          </div>
        )}
        <div className="u-span-2">
          <Field label={t(isHandoff ? 'form.what' : 'common:labels.title')} required error={(touched ? errors.title : undefined) ?? fieldErrors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
          </Field>
        </div>
        {isHandoff ? (
          <>
            <Field label={t('handoffs.from')} required error={touched ? errors.from : undefined}>
              <Select options={roleOptions} placeholder={t('form.pickRole')} value={from} onChange={(e) => setFrom(e.target.value)} disabled={received} />
            </Field>
            <Field label={t('handoffs.to')} required error={touched ? errors.to : undefined}>
              <Select options={roleOptions} placeholder={t('form.pickRole')} value={to} onChange={(e) => setTo(e.target.value)} disabled={received} />
            </Field>
          </>
        ) : (
          <Field label={t('common:labels.owner')} hint={section === 'checklist' ? t('form.checklistOwnerHint') : t('form.ownerHint')}>
            <OwnerSelect value={owner} onChange={setOwner} roles={roles} rolesOnly={section === 'checklist'} />
          </Field>
        )}
        <Field label={t(isHandoff ? 'handoffs.when' : 'common:labels.dueDate')} hint={dateLocked ? t('form.dateFromSchedule') : undefined}>
          <DateInput value={dueDate} onChange={setDueDate} disabled={dateLocked} />
        </Field>
        <div className="u-span-2">
          <Field label={t('common:labels.description')}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
