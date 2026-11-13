import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { useTender } from '@/features/tenders/tenderContext';
import { formatDate } from '@/lib/dates';
import { Badge, Banner, Button, Card, Checkbox, ConfirmDialog, EmptyState, Field, Modal, PageHeader, PageSpinner, Select, Tabs, Textarea, useToast } from '@/ui';
import { createLesson, deleteLesson, LESSON_CATEGORIES, lessonsKeys, listLessons, updateLesson, type LessonCategory, type LessonInput, type LessonRow } from './lessonsApi';
import './lessons.css';

type Editing = { mode: 'add' } | { mode: 'edit'; lesson: LessonRow } | null;

/** Lessons learned of a tender (F10). Stays writable after the tender is closed — the review happens then. */
export function LessonsTab() {
  const { t } = useTranslation('lessons');
  const { tender, tenderId } = useTender();
  const { user, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<LessonRow | null>(null);

  // Not useTender().canWrite: that is false on closed tenders, where lessons are still allowed.
  const canAdd = !!user && user.org_role !== 'viewer';
  const canChange = (l: LessonRow) => canAdd && (hasRole('admin', 'bid_manager') || l.created_by === user?.id);

  const query = useQuery({ queryKey: lessonsKeys.list(tenderId), queryFn: () => listLessons(tenderId) });
  const invalidate = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: lessonsKeys.list(tenderId) }), queryClient.invalidateQueries({ queryKey: ['templates', 'lessons'] })]);
  const remove = useMutation({
    mutationFn: (l: LessonRow) => deleteLesson(tenderId, l.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('deleted'));
      setRemoving(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const all = query.data ?? [];
  const flagged = all.filter((l) => l.changes_template);
  const pending = flagged.filter((l) => !l.applied_in_version).length;
  const rows = filter === 'template' ? flagged : all;
  const addButton = canAdd && (
    <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
      {t('add')}
    </Button>
  );

  return (
    <>
      <PageHeader
        level={2}
        title={t('title')}
        subtitle={tender.template_version ? `${t('subtitle')} ${t('usedTemplate', { version: tender.template_version })}` : t('subtitle')}
        actions={addButton}
      />

      {query.isPending ? (
        <PageSpinner />
      ) : query.isError ? (
        <Banner tone="red" title={t('common:errors.loadFailed')}>
          {errorMessage(query.error)}
        </Banner>
      ) : all.length === 0 ? (
        <EmptyState icon="history" title={t('empty')} description={t('emptyHint')} action={addButton || undefined} />
      ) : (
        <>
          <Tabs
            className="lessons-filter"
            label={t('filterLabel')}
            value={filter}
            onChange={setFilter}
            items={[
              { key: 'all', label: t('filterAll'), count: all.length },
              { key: 'template', label: t('filterTemplate'), count: flagged.length, countTone: pending > 0 ? 'orange' : 'neutral' },
            ]}
          />
          {rows.length === 0 ? (
            <EmptyState compact title={t('emptyFiltered')} />
          ) : (
            <Card flush>
              <ul className="lessons-list">
                {rows.map((l) => (
                  <li key={l.id} className="lessons-item">
                    <div className="lessons-item__main">
                      <p className="lessons-item__text">{l.text}</p>
                      <div className="lessons-item__meta">
                        {l.category && <Badge>{t(`categories.${l.category}`)}</Badge>}
                        {l.changes_template &&
                          (l.applied_in_version ? (
                            <Badge tone="green" dot>
                              {t('badge.applied', { version: l.applied_in_version })}
                            </Badge>
                          ) : (
                            <Badge tone="orange" dot>
                              {t('badge.pending')}
                            </Badge>
                          ))}
                        <span>{t('by', { name: l.created_by_name ?? '—', date: formatDate(l.created_at) })}</span>
                      </div>
                    </div>
                    {canChange(l) && (
                      <div className="lessons-item__actions">
                        <Button size="sm" variant="ghost" icon="edit" iconOnly onClick={() => setEditing({ mode: 'edit', lesson: l })}>
                          {t('editAction')}
                        </Button>
                        <Button size="sm" variant="ghost" icon="trash" iconOnly onClick={() => setRemoving(l)}>
                          {t('deleteAction')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <LessonModal editing={editing} tenderId={tenderId} onClose={() => setEditing(null)} onSaved={invalidate} />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('deleteTitle')}
        message={t('deleteMessage')}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

function LessonModal({ editing, tenderId, onClose, onSaved }: { editing: Editing; tenderId: string; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation('lessons');
  const toast = useToast();
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [changes, setChanges] = useState(false);
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<Editing>(null);
  if (editing !== seededFor) {
    setSeededFor(editing);
    setTouched(false);
    const l = editing?.mode === 'edit' ? editing.lesson : null;
    setText(l?.text ?? '');
    setCategory(l?.category ?? '');
    setChanges(l?.changes_template ?? false);
  }
  const lesson = editing?.mode === 'edit' ? editing.lesson : null;
  const applied = !!lesson?.applied_in_version;

  const save = useMutation({
    mutationFn: () => {
      const body: LessonInput = { text: text.trim(), category: (category || null) as LessonCategory | null };
      if (!applied) body.changes_template = changes;
      return lesson ? updateLesson(tenderId, lesson.id, body) : createLesson(tenderId, body);
    },
    onSuccess: async () => {
      await onSaved();
      toast.success(t(lesson ? 'updated' : 'added'));
      onClose();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  const error = text.trim() ? undefined : t('common:errors.required');

  return (
    <Modal
      open={editing !== null}
      onClose={close}
      title={lesson ? t('editTitle') : t('addTitle')}
      onSubmit={() => {
        setTouched(true);
        if (!error) save.mutate();
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
        <Field label={t('text')} required hint={t('textHint')} error={touched ? error : undefined}>
          <Textarea rows={5} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label={t('category')}>
          <Select
            value={category}
            placeholder={t('noCategory')}
            options={LESSON_CATEGORIES.map((c) => ({ value: c, label: t(`categories.${c}`) }))}
            onChange={(e) => setCategory(e.target.value)}
          />
        </Field>
        <Checkbox
          label={t('changesTemplate')}
          hint={applied ? t('appliedLocked') : t('changesTemplateHint')}
          checked={changes}
          disabled={applied}
          onChange={(e) => setChanges(e.target.checked)}
        />
      </div>
    </Modal>
  );
}
