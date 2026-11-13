import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { COMPANY_DOCUMENT_TYPES, type CompanyDocumentType } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { startDownload, useIsNarrow } from '@/features/files/filesApi';
import { formatDate } from '@/lib/dates';
import { enumLabel, enumOptions } from '@/lib/enums';
import {
  Badge,
  Banner,
  Button,
  CellActions,
  Checkbox,
  ConfirmDialog,
  DateInput,
  DateText,
  EmptyState,
  Field,
  FileDropInput,
  FilterBar,
  formatFileSize,
  Input,
  Menu,
  Modal,
  PageHeader,
  ProgressBar,
  Select,
  Table,
  Textarea,
  useToast,
  type Column,
} from '@/ui';
import { DocumentStatusBadge } from './DocumentStatus';
import {
  archiveDocument,
  createDocument,
  deleteDocument,
  DOCUMENT_STATUSES,
  documentDownloadUrl,
  documentsKeys,
  getDocument,
  listDocuments,
  removeDocumentFile,
  updateDocument,
  uploadDocumentFile,
  type CompanyDocumentView,
  type DocumentInput,
  type DocumentStatus,
} from './documentsApi';
import { GdprModal } from './GdprModal';
import './documents.css';

type Editing = { mode: 'add' } | { mode: 'edit'; doc: CompanyDocumentView } | null;

/** /company-documents — the organization's register of certificates, CVs and reference projects (F8, R15). */
export function CompanyDocumentsPage() {
  const { t } = useTranslation('documents');
  const { hasRole, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isManager = hasRole('admin', 'bid_manager');
  const narrow = useIsNarrow();

  const [search, setSearch] = useState('');
  const [type, setType] = useState<CompanyDocumentType | ''>('');
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<CompanyDocumentView | null>(null);
  const [removingFile, setRemovingFile] = useState<CompanyDocumentView | null>(null);
  const [gdprOpen, setGdprOpen] = useState(false);

  const includeArchived = isManager && showArchived;
  const query = useQuery({ queryKey: documentsKeys.list(includeArchived), queryFn: () => listDocuments(includeArchived) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: documentsKeys.all });
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const all = query.data ?? [];
  const needle = search.trim().toLocaleLowerCase('el');
  const rows = all.filter(
    (d) =>
      (!type || d.type === type) &&
      (!status || (d.status === status && !d.archived_at)) &&
      (!needle || `${d.title} ${d.person_name ?? ''} ${d.file?.filename ?? ''}`.toLocaleLowerCase('el').includes(needle)),
  );
  const live = all.filter((d) => !d.archived_at);
  const expired = live.filter((d) => d.status === 'expired').length;
  const expiring = live.filter((d) => d.status === 'expiring').length;

  const remove = useMutation({
    mutationFn: (d: CompanyDocumentView) => deleteDocument(d.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('delete.done'));
      setRemoving(null);
    },
    onError,
  });
  const removeFile = useMutation({
    mutationFn: (d: CompanyDocumentView) => removeDocumentFile(d.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('common:state.saved'));
      setRemovingFile(null);
    },
    onError,
  });
  const archive = useMutation({
    mutationFn: (d: CompanyDocumentView) => archiveDocument(d.id, !d.archived_at),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('common:state.saved'));
    },
    onError,
  });

  const download = async (d: CompanyDocumentView) => {
    try {
      await getDocument(d.id); // a refusal becomes a message, not a broken download
      startDownload(documentDownloadUrl(d.id));
    } catch (err) {
      onError(err);
      void invalidate();
    }
  };

  const allColumns: Column<CompanyDocumentView>[] = [
    { key: 'type', header: t('columns.type'), width: 150, render: (d) => <Badge tone={d.type === 'cv' ? 'info' : 'neutral'}>{enumLabel('company_document_type', d.type)}</Badge> },
    {
      key: 'title',
      header: t('columns.title'),
      wrap: true,
      render: (d) => (
        <span className="docs-title">
          <span className="docs-title__main">{d.title}</span>
          {narrow && <span className="docs-title__sub">{[enumLabel('company_document_type', d.type), d.expires_at && `${t('columns.expires')} ${formatDate(d.expires_at)}`].filter(Boolean).join(' · ')}</span>}
          {d.person_name && <span className="docs-title__sub">{t('person', { name: d.person_name })}</span>}
          {d.notes && !narrow && <span className="docs-title__sub">{d.notes}</span>}
          {narrow && (
            <span>
              <DocumentStatusBadge doc={d} />
            </span>
          )}
        </span>
      ),
    },
    { key: 'issued_at', header: t('columns.issued'), mono: true, width: 110, render: (d) => <DateText value={d.issued_at} /> },
    { key: 'expires_at', header: t('columns.expires'), mono: true, width: 110, render: (d) => <DateText value={d.expires_at} /> },
    { key: 'status', header: t('columns.status'), width: 170, render: (d) => <DocumentStatusBadge doc={d} /> },
    {
      key: 'file',
      header: t('columns.file'),
      render: (d) =>
        d.file ? (
          <Button size="sm" variant="ghost" icon="download" onClick={() => void download(d)} title={`${d.file.filename} · ${formatFileSize(d.file.size)}`} aria-label={t('downloadFile', { name: d.file.filename })}>
            {formatFileSize(d.file.size)}
          </Button>
        ) : (
          <span className="u-faint">{t('noFile')}</span>
        ),
    },
    ...(isManager
      ? [
          {
            key: 'actions',
            header: t('common:labels.actions'),
            srOnlyHeader: true,
            align: 'right',
            width: 56,
            render: (d) => (
              <CellActions>
                <Menu
                  label={t('actionsFor', { name: d.title })}
                  items={[
                    { label: t('common:actions.edit'), icon: 'edit', onSelect: () => setEditing({ mode: 'edit', doc: d }) },
                    d.file && { label: t('actions.removeFile'), icon: 'close', onSelect: () => setRemovingFile(d) },
                    isAdmin && { label: d.archived_at ? t('actions.unarchive') : t('actions.archive'), icon: 'inbox', separatorBefore: true, onSelect: () => archive.mutate(d) },
                    isAdmin && { label: t('common:actions.delete'), icon: 'trash', danger: true, onSelect: () => setRemoving(d) },
                  ]}
                />
              </CellActions>
            ),
          } satisfies Column<CompanyDocumentView>,
        ]
      : []),
  ];

  const columns = narrow ? allColumns.filter((c) => ['title', 'file', 'actions'].includes(c.key)) : allColumns;
  const filtered = !!(needle || type || status);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            {isAdmin && (
              <Button icon="shield" onClick={() => setGdprOpen(true)}>
                {t('gdprButton')}
              </Button>
            )}
            {isManager && (
              <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
                {t('add')}
              </Button>
            )}
          </>
        }
      />

      {(expired > 0 || expiring > 0) && (
        <Banner className="docs-attention" tone={expired > 0 ? 'red' : 'orange'} title={t('attention', { expired, expiring })} />
      )}

      <FilterBar
        search={{ value: search, onChange: setSearch, placeholder: t('filters.search'), label: t('filters.search') }}
        active={filtered}
        onReset={() => {
          setSearch('');
          setType('');
          setStatus('');
        }}
        summary={t('summary', { count: rows.length })}
      >
        <Field label={t('columns.type')}>
          <Select value={type} onChange={(e) => setType(e.target.value as CompanyDocumentType | '')} placeholder={t('common:labels.all')} options={enumOptions('company_document_type', COMPANY_DOCUMENT_TYPES)} />
        </Field>
        <Field label={t('columns.status')}>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as DocumentStatus | '')}
            placeholder={t('common:labels.all')}
            options={DOCUMENT_STATUSES.map((s) => ({ value: s, label: t(`statusFilter.${s}`) }))}
          />
        </Field>
        {isManager && <Checkbox label={t('filters.showArchived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />}
      </FilterBar>

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
          caption={t('title')}
          columns={columns}
          rows={rows}
          loading={query.isPending}
          rowTone={(d) => (d.archived_at ? undefined : d.status === 'expired' ? 'red' : d.status === 'expiring' ? 'orange' : undefined)}
          rowClassName={(d) => (d.archived_at ? 'is-muted' : undefined)}
          empty={
            filtered ? (
              <EmptyState compact title={t('common:state.emptyFiltered')} />
            ) : (
              <EmptyState
                icon="file"
                title={t('empty.title')}
                description={isManager ? t('empty.description') : t('empty.readOnly')}
                action={
                  isManager ? (
                    <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
                      {t('add')}
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />
      )}
      <p className="docs-note">{t('cvNote')}</p>

      {editing && <DocumentModal editing={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}

      <ConfirmDialog
        open={!!removing}
        danger
        title={t('delete.title')}
        message={removing ? t('delete.message', { name: removing.title }) : ''}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog
        open={!!removingFile}
        danger
        title={t('removeFile.title')}
        message={removingFile ? t('removeFile.message', { name: removingFile.title }) : ''}
        confirmLabel={t('common:actions.remove')}
        loading={removeFile.isPending}
        onConfirm={() => removingFile && removeFile.mutate(removingFile)}
        onCancel={() => setRemovingFile(null)}
      />
      {gdprOpen && <GdprModal onClose={() => setGdprOpen(false)} onChanged={invalidate} />}
    </>
  );
}

function DocumentModal({ editing, onClose, onSaved }: { editing: Exclude<Editing, null>; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation('documents');
  const toast = useToast();
  const doc = editing.mode === 'edit' ? editing.doc : null;
  const [form, setForm] = useState<DocumentInput>({
    type: doc?.type ?? 'iso',
    title: doc?.title ?? '',
    issued_at: doc?.issued_at ?? null,
    expires_at: doc?.expires_at ?? null,
    person_name: doc?.person_name ?? null,
    notes: doc?.notes ?? null,
  });
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const set = <K extends keyof DocumentInput>(key: K, value: DocumentInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const isCv = form.type === 'cv';
  const datesWrong = !!(form.issued_at && form.expires_at && form.expires_at < form.issued_at);
  const valid = form.title.trim() !== '' && (!isCv || !!form.person_name?.trim()) && !datesWrong;

  const save = useMutation({
    mutationFn: async () => {
      const body: DocumentInput = { ...form, title: form.title.trim(), person_name: isCv ? (form.person_name?.trim() ?? null) : null, notes: form.notes?.trim() || null };
      const saved = doc ? await updateDocument(doc.id, body) : await createDocument(body);
      if (file) {
        setProgress(0);
        await uploadDocumentFile(saved.id, file, setProgress);
      }
    },
    onSuccess: async () => {
      await onSaved();
      toast.success(t('common:state.saved'));
      onClose();
    },
    onError: async (err) => {
      setProgress(null);
      toast.error(errorMessage(err));
      await onSaved(); // the record may have been saved even though the file was refused
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={false}
      size="lg"
      title={doc ? t('form.editTitle') : t('form.addTitle')}
      onSubmit={() => valid && !save.isPending && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-form-grid">
        <Field label={t('form.type')} required>
          <Select value={form.type} onChange={(e) => set('type', e.target.value as CompanyDocumentType)} options={enumOptions('company_document_type', COMPANY_DOCUMENT_TYPES)} />
        </Field>
        <Field label={t('form.title')} required>
          <Input value={form.title} maxLength={300} onChange={(e) => set('title', e.target.value)} />
        </Field>
        {isCv && (
          <Field label={t('form.personName')} required hint={t('form.personHint')} className="u-span-2">
            <Input value={form.person_name ?? ''} maxLength={200} autoComplete="off" onChange={(e) => set('person_name', e.target.value)} />
          </Field>
        )}
        <Field label={t('form.issuedAt')}>
          <DateInput value={form.issued_at} onChange={(v) => set('issued_at', v)} />
        </Field>
        <Field label={t('form.expiresAt')} error={datesWrong ? t('form.expiryBeforeIssue') : undefined}>
          <DateInput value={form.expires_at} onChange={(v) => set('expires_at', v)} />
        </Field>
        <Field label={t('form.notes')} className="u-span-2">
          <Textarea rows={2} maxLength={4000} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <div className="u-span-2 u-stack u-stack--sm">
          <Field label={t('form.file')} hint={doc?.file ? `${t('form.currentFile', { name: doc.file.filename })} — ${t('form.replaceHint')}` : undefined}>
            <FileDropInput label={t('form.file')} files={file ? [file] : []} onFiles={(f) => setFile(f[0] ?? null)} onRemove={() => setFile(null)} onReject={toast.error} disabled={save.isPending} />
          </Field>
          {progress !== null && <ProgressBar label={t('form.uploading')} value={Math.round(progress * 100)} tone="info" />}
        </div>
      </div>
    </Modal>
  );
}
