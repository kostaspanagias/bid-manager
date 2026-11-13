import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { startDownload } from '@/features/files/filesApi';
import { useTender } from '@/features/tenders/tenderContext';
import { formatDate } from '@/lib/dates';
import { enumLabel } from '@/lib/enums';
import { Badge, Banner, Button, CellActions, ConfirmDialog, DateText, EmptyState, Input, Modal, PageHeader, Spinner, Table, useToast, type Column } from '@/ui';
import { DocumentStatusBadge } from './DocumentStatus';
import { documentDownloadUrl, documentsKeys, getDocument, linkDocument, listSuggestions, listTenderDocuments, unlinkDocument, type LinkedDocument } from './documentsApi';
import './documents.css';

/** Tender → Έγγραφα: the company documents this tender uses, with the red "expires before T" flag (R15). */
export function TenderDocumentsTab() {
  const { t } = useTranslation('documents');
  const { tenderId, canWrite, isActive, T } = useTender();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<LinkedDocument | null>(null);

  const query = useQuery({ queryKey: documentsKeys.tender(tenderId), queryFn: () => listTenderDocuments(tenderId) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: documentsKeys.tender(tenderId) });
  const rows = query.data?.items ?? [];
  const tDate = query.data?.T ?? T;
  const expired = query.data?.expired_count ?? 0;

  const unlink = useMutation({
    mutationFn: (d: LinkedDocument) => unlinkDocument(tenderId, d.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('tender.unlinked'));
      setUnlinking(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const download = async (d: LinkedDocument) => {
    try {
      await getDocument(d.id);
      startDownload(documentDownloadUrl(d.id));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const columns: Column<LinkedDocument>[] = [
    { key: 'type', header: t('columns.type'), width: 150, render: (d) => <Badge tone={d.type === 'cv' ? 'info' : 'neutral'}>{enumLabel('company_document_type', d.type)}</Badge> },
    {
      key: 'title',
      header: t('columns.title'),
      wrap: true,
      render: (d) => (
        <span className="docs-title">
          <span className="docs-title__main">{d.title}</span>
          {d.person_name && <span className="docs-title__sub">{t('person', { name: d.person_name })}</span>}
        </span>
      ),
    },
    { key: 'expires_at', header: t('columns.expires'), mono: true, width: 110, render: (d) => <DateText value={d.expires_at} /> },
    {
      key: 'on_t',
      header: t('tender.tColumn', { date: formatDate(tDate) }),
      width: 170,
      render: (d) =>
        d.expires_before_T ? (
          <Badge tone="red" dot>
            {t('tender.expiresBeforeT')}
          </Badge>
        ) : (
          <Badge tone="green" dot>
            {t('tender.validOnT')}
          </Badge>
        ),
    },
    { key: 'status', header: t('columns.status'), width: 170, render: (d) => <DocumentStatusBadge doc={d} /> },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (d) => (
        <CellActions>
          {d.file && (
            <Button size="sm" variant="ghost" icon="download" iconOnly onClick={() => void download(d)}>
              {t('downloadFile', { name: d.file.filename })}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" variant="ghost" icon="close" iconOnly onClick={() => setUnlinking(d)}>
              {t('tender.unlinkName', { name: d.title })}
            </Button>
          )}
        </CellActions>
      ),
    },
  ];

  const linkButton = canWrite ? (
    <Button variant="primary" icon="plus" onClick={() => setPickerOpen(true)}>
      {t('tender.link')}
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader level={2} title={t('tender.title')} subtitle={t('tender.subtitle')} actions={linkButton} />
      {!isActive && <Banner tone="info">{t('tender.closedNote')}</Banner>}
      {expired > 0 && (
        <Banner tone="red" title={t('tender.bannerTitle', { count: expired, date: formatDate(tDate) })}>
          {t('tender.bannerText')}
        </Banner>
      )}
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
          caption={t('tender.title')}
          columns={columns}
          rows={rows}
          loading={query.isPending}
          rowTone={(d) => (d.expires_before_T ? 'red' : undefined)}
          empty={<EmptyState icon="file" title={t('tender.emptyTitle')} description={t('tender.emptyDescription')} action={linkButton} />}
        />
      )}

      {pickerOpen && <LinkPicker onClose={() => setPickerOpen(false)} />}
      <ConfirmDialog
        open={!!unlinking}
        title={t('tender.unlinkTitle')}
        message={unlinking ? t('tender.unlinkMessage', { name: unlinking.title }) : ''}
        confirmLabel={t('tender.unlink')}
        loading={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking)}
        onCancel={() => setUnlinking(null)}
      />
    </>
  );
}

/** Picker: the register's documents not linked yet, grouped by type; stays open so several can be linked. */
function LinkPicker({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('documents');
  const { tenderId } = useTender();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: documentsKeys.suggestions(tenderId), queryFn: () => listSuggestions(tenderId) });

  const link = useMutation({
    mutationFn: (documentId: string) => linkDocument(tenderId, documentId),
    onSuccess: async () => {
      toast.success(t('tender.linked'));
      await queryClient.invalidateQueries({ queryKey: documentsKeys.tender(tenderId) }); // also refreshes the suggestions
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const needle = search.trim().toLocaleLowerCase('el');
  const groups = (query.data ?? [])
    .map((g) => ({ ...g, documents: g.documents.filter((d) => !needle || `${d.title} ${d.person_name ?? ''}`.toLocaleLowerCase('el').includes(needle)) }))
    .filter((g) => g.documents.length > 0);

  return (
    <Modal open onClose={onClose} size="lg" title={t('tender.pickerTitle')} description={t('tender.pickerDescription')} footer={<Button onClick={onClose}>{t('common:actions.close')}</Button>}>
      <div className="docs-picker">
        <Input type="search" value={search} placeholder={t('tender.pickerSearch')} aria-label={t('tender.pickerSearch')} onChange={(e) => setSearch(e.target.value)} />
        {query.isPending ? (
          <Spinner />
        ) : query.isError ? (
          <Banner tone="red">{errorMessage(query.error)}</Banner>
        ) : groups.length === 0 ? (
          <EmptyState compact title={needle ? t('tender.pickerEmptyFiltered') : t('tender.pickerEmpty')} />
        ) : (
          groups.map((g) => (
            <section key={g.type} className="docs-picker__group">
              <h4>{enumLabel('company_document_type', g.type)}</h4>
              <ul className="docs-picker__list">
                {g.documents.map((d) => (
                  <li key={d.id}>
                    <span className="docs-title">
                      <span className="docs-title__main">{d.title}</span>
                      <span className="docs-picker__meta">
                        {d.person_name && <span>{d.person_name}</span>}
                        {d.expires_at && (
                          <span>
                            {t('columns.expires')}: <DateText value={d.expires_at} />
                          </span>
                        )}
                        {d.expires_before_T ? (
                          <Badge tone="red" dot>
                            {t('tender.expiresBeforeT')}
                          </Badge>
                        ) : (
                          <DocumentStatusBadge doc={d} />
                        )}
                      </span>
                    </span>
                    <Button size="sm" icon="plus" loading={link.isPending && link.variables === d.id} disabled={link.isPending} onClick={() => link.mutate(d.id)}>
                      {t('tender.linkAction')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </Modal>
  );
}
