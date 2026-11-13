import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { CHANGE_SOURCES, type ChangeSource } from '@/api/types';
import { WarningBanner } from '@/features/tenders/TenderBanners';
import { changeDeadline, previewDeadline, tenderKeys, type DeadlineDiffRow } from '@/features/tenders/tenderApi';
import { useTender } from '@/features/tenders/tenderContext';
import { cx } from '@/lib/cx';
import { formatDateTime } from '@/lib/dates';
import { enumLabel, enumOptions } from '@/lib/enums';
import { Badge, Banner, Button, DateText, DateTimeInput, Field, Input, Modal, Select, Spinner, Textarea, TMinus, useToast } from '@/ui';

/**
 * R9: change of the submission deadline. The new schedule is shown as a diff (old → new per milestone) before
 * anything is saved; saving recomputes, flags manual milestones for review and writes the change-log entry.
 */
export function DeadlineDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('schedule');
  const { tender, tenderId, refetch } = useTender();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [deadline, setDeadline] = useState<string | null>(tender.submission_deadline_at);
  const [source, setSource] = useState<ChangeSource>('esidis');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');

  const changed = Boolean(deadline) && new Date(deadline as string).getTime() !== new Date(tender.submission_deadline_at).getTime();
  const preview = useQuery({
    // not under tenderKeys.detail: saving invalidates that subtree and must not re-run the preview
    queryKey: ['deadline-preview', tenderId, deadline],
    queryFn: () => previewDeadline(tenderId, deadline as string),
    enabled: changed,
    placeholderData: keepPreviousData,
    retry: false,
    gcTime: 0,
  });

  const save = useMutation({
    mutationFn: () => changeDeadline(tenderId, { submission_deadline_at: deadline as string, source, description: description.trim() || undefined, reference: reference.trim() || null }),
    onSuccess: async (res) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: tenderKeys.detail(tenderId) }), queryClient.invalidateQueries({ queryKey: tenderKeys.list() })]);
      await refetch();
      toast.success(t('deadline.saved', { count: res.diff.moved }));
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const data = changed && !preview.isError ? preview.data : undefined;
  const stale = preview.isFetching;
  const moved = data?.items.filter((i) => i.status === 'moved') ?? [];
  const manual = data?.items.filter((i) => i.status === 'manual') ?? [];
  const done = data?.items.filter((i) => i.status === 'done') ?? [];

  const statusBadge = (row: DeadlineDiffRow) => {
    if (row.status === 'moved') return <Badge tone="info">{t('deadline.status.moved')}</Badge>;
    if (row.status === 'manual') return <Badge tone="orange">{t('deadline.status.manual')}</Badge>;
    if (row.status === 'done') return <Badge tone="green">{t('deadline.status.done')}</Badge>;
    return <Badge tone="neutral">{t('deadline.status.unchanged')}</Badge>;
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      onSubmit={() => data && !stale && save.mutate()}
      title={t('deadline.title')}
      description={t('deadline.description')}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!data || stale}>
            {t('deadline.save')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        <div className="u-form-grid">
          <Field label={t('deadline.new')} required hint={t('deadline.current', { date: formatDateTime(tender.submission_deadline_at) })} className="u-span-2">
            <DateTimeInput value={deadline} onChange={setDeadline} autoFocus />
          </Field>
          <Field label={t('deadline.source')}>
            <Select value={source} onChange={(e) => setSource(e.target.value as ChangeSource)} options={enumOptions('change_source', CHANGE_SOURCES)} />
          </Field>
          <Field label={t('deadline.reference')} hint={t('deadline.referenceHint')}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={500} autoComplete="off" />
          </Field>
          <Field label={t('deadline.note')} hint={t('deadline.noteHint')} className="u-span-2">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} />
          </Field>
        </div>

        <section className="diff" aria-live="polite" aria-busy={stale}>
          <h3 className="diff__title">
            {t('deadline.diffTitle')} {stale && <Spinner />}
          </h3>
          {!changed && <p className="u-muted">{t('deadline.pick')}</p>}
          {changed && preview.isError && <Banner tone="red">{errorMessage(preview.error)}</Banner>}
          {data && (
            <div className={cx('u-stack', stale && 'diff--stale')}>
              <p className="diff__summary">
                <strong>
                  <DateText value={data.oldT} withWeekday /> → <DateText value={data.newT} withWeekday />
                </strong>{' '}
                <span className="u-muted">
                  {data.shiftWorkingDays === 0
                    ? t('deadline.shiftNone')
                    : data.shiftWorkingDays > 0
                      ? t('deadline.shiftLater', { count: data.shiftWorkingDays })
                      : t('deadline.shiftEarlier', { count: -data.shiftWorkingDays })}
                </span>
              </p>
              <p className="diff__counts">
                {t('deadline.counts.moved', { count: moved.length })} · {t('deadline.counts.manual', { count: manual.length })} · {t('deadline.counts.done', { count: done.length })}
              </p>
              {data.compressed.old !== data.compressed.new && (
                <Banner tone={data.compressed.new ? 'orange' : 'info'} title={data.compressed.new ? t('deadline.compressedOn') : t('deadline.compressedOff')}>
                  {t('deadline.compressedBody', { count: data.workingDays })}
                </Banner>
              )}
              {data.warnings
                .filter((w) => w.code !== 'compressed_mode')
                .map((w, i) => (
                  <WarningBanner key={`${w.code}-${i}`} warning={w} />
                ))}
              <div className="diff__scroll">
                <table className="diff__table">
                  <thead>
                    <tr>
                      <th scope="col">{t('deadline.columns.item')}</th>
                      <th scope="col">{t('deadline.columns.old')}</th>
                      <th scope="col">{t('deadline.columns.new')}</th>
                      <th scope="col">{t('deadline.columns.result')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row) => (
                      <tr key={row.key} className={cx(row.changed && 'is-changed')}>
                        <th scope="row">
                          <span className="diff__kind">{enumLabel('milestone_kind', row.kind)}</span> {row.name}
                        </th>
                        <td className="u-mono">
                          <DateText value={row.old_date} withWeekday className={row.changed ? 'diff__old' : undefined} />
                        </td>
                        <td className="u-mono">
                          {row.changed ? (
                            <strong>
                              <DateText value={row.new_date} withWeekday />
                            </strong>
                          ) : (
                            <span className="u-faint">=</span>
                          )}{' '}
                          {row.changed && <TMinus n={row.tMinus} tone="neutral" plain />}
                        </td>
                        <td>
                          {statusBadge(row)}
                          {row.status === 'manual' && row.computed_date && (
                            <span className="diff__hint u-muted">
                              {t('deadline.wouldBe')} <DateText value={row.computed_date} />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="u-muted diff__foot">{t('deadline.foot')}</p>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
