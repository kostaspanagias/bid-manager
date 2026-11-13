import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { applyLesson, unapplyLesson, type LessonRow } from '@/features/lessons/lessonsApi';
import { tenderKeys } from '@/features/tenders/tenderApi';
import { formatDate } from '@/lib/dates';
import { Badge, Banner, Button, Card, EmptyState, PageSpinner, useToast } from '@/ui';
import { listAppliedLessons, listPendingLessons, templateKeys, type TemplateRecord } from './templatesApi';

function LessonLine({ lesson, action }: { lesson: LessonRow; action?: React.ReactNode }) {
  const { t } = useTranslation('templates');
  return (
    <div className="tpl-lesson">
      <div>
        <p className="tpl-lesson__text">{lesson.text}</p>
        <div className="tpl-row__meta">
          <Link to={`/tenders/${lesson.tender_id}/lessons`}>{lesson.tender_title}</Link>
          {lesson.tender_template_version && <span>{t('lessons.usedVersion', { version: lesson.tender_template_version })}</span>}
          {lesson.category && <Badge>{t(`lessons:categories.${lesson.category}`)}</Badge>}
          <span>
            {[lesson.created_by_name, formatDate(lesson.created_at)].filter(Boolean).join(' · ')}
          </span>
        </div>
      </div>
      {action}
    </div>
  );
}

/**
 * Lessons flagged «αλλάζει το template» that no version has absorbed yet (org-wide), and — inside a template —
 * the ones marked as applied in this version. Without `template` it is the read-only overview of the list page.
 */
export function LessonsPanel({ template }: { template?: TemplateRecord }) {
  const { t } = useTranslation('templates');
  const toast = useToast();
  const queryClient = useQueryClient();
  const pending = useQuery({ queryKey: templateKeys.pendingLessons, queryFn: listPendingLessons });
  const applied = useQuery({
    queryKey: templateKeys.lessons(template?.id ?? ''),
    queryFn: () => listAppliedLessons(template!.id),
    enabled: !!template,
  });

  const refresh = (lesson: LessonRow) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: templateKeys.pendingLessons }),
      template ? queryClient.invalidateQueries({ queryKey: templateKeys.lessons(template.id) }) : null,
      queryClient.invalidateQueries({ queryKey: tenderKeys.detail(lesson.tender_id) }),
    ]);
  const apply = useMutation({
    mutationFn: (l: LessonRow) => applyLesson(l.tender_id, l.id, template!.id),
    onSuccess: async (l) => {
      await refresh(l);
      toast.success(t('lessons.applied', { version: template!.version }));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const undo = useMutation({
    mutationFn: (l: LessonRow) => unapplyLesson(l.tender_id, l.id),
    onSuccess: async (l) => {
      await refresh(l);
      toast.info(t('lessons.undone'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (pending.isPending) return template ? <PageSpinner /> : null;
  if (pending.isError) return <Banner tone="red" title={t('common:errors.loadFailed')}>{errorMessage(pending.error)}</Banner>;
  const rows = pending.data;
  // On the list page the panel only appears when there is something to do.
  if (!template && rows.length === 0) return null;

  return (
    <div className="tpl-stack">
      <Card
        title={`${t('lessons.pendingTitle')}${rows.length ? ` (${rows.length})` : ''}`}
        subtitle={template ? t('lessons.pendingHint') : t('lessons.openDraftHint')}
        tone={rows.length ? 'orange' : undefined}
        flush
      >
        {rows.length === 0 ? (
          <EmptyState compact icon="checkCircle" title={t('lessons.pendingEmpty')} description={t('lessons.pendingEmptyHint')} />
        ) : (
          rows.map((l) => (
            <LessonLine
              key={l.id}
              lesson={l}
              action={
                template && (
                  <Button size="sm" icon="check" loading={apply.isPending && apply.variables?.id === l.id} onClick={() => apply.mutate(l)}>
                    {t('lessons.apply', { version: template.version })}
                  </Button>
                )
              }
            />
          ))
        )}
      </Card>
      {template && (
        <Card title={`${t('lessons.appliedTitle')}${applied.data?.length ? ` (${applied.data.length})` : ''}`} flush>
          {(applied.data ?? []).length === 0 ? (
            <p className="tpl-empty">{t('lessons.appliedEmpty')}</p>
          ) : (
            applied.data!.map((l) => (
              <LessonLine
                key={l.id}
                lesson={l}
                action={
                  <Button size="sm" variant="ghost" loading={undo.isPending && undo.variables?.id === l.id} onClick={() => undo.mutate(l)}>
                    {t('lessons.undo')}
                  </Button>
                }
              />
            ))
          )}
        </Card>
      )}
    </div>
  );
}
