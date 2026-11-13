import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import { FILE_FOLDERS, type FileFolder } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { useTender } from '@/features/tenders/tenderContext';
import { enumLabel } from '@/lib/enums';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DateText,
  Field,
  FileDropInput,
  formatFileSize,
  Icon,
  Input,
  Menu,
  Modal,
  PageHeader,
  PageSpinner,
  ProgressBar,
  Select,
  Table,
  CellActions,
  useToast,
  type Column,
} from '@/ui';
import { deleteFile, fileDownloadUrl, filesKeys, getFile, listFiles, patchFile, startDownload, uploadTenderFile, type TenderFile } from './filesApi';
import './files.css';

/** Display order: what arrives from the authority first, then the three offer folders, then the rest. */
const FOLDER_ORDER: FileFolder[] = ['tender_docs', 'clarifications', 'participation', 'technical', 'financial', 'other'];

interface QueueItem {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
  error?: string;
}

/** Tender → Αρχεία: folders as sections, drag-and-drop upload with progress, rename / move / delete (F1, R18). */
export function FilesTab() {
  const { t } = useTranslation('files');
  const { tenderId, canWrite, canSeeFinancial, isActive } = useTender();
  const { user, hasRole, canEdit } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Files stay writable after a tender is closed (receipts, the submitted offer) — only viewers are read-only.
  const mayWrite = canWrite || (!isActive && canEdit);
  const folders = FOLDER_ORDER.filter((f) => FILE_FOLDERS.includes(f) && (f !== 'financial' || canSeeFinancial));

  const [folder, setFolder] = useState<FileFolder>('tender_docs');
  const [label, setLabel] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [editing, setEditing] = useState<TenderFile | null>(null);
  const [removing, setRemoving] = useState<TenderFile | null>(null);

  const query = useQuery({ queryKey: filesKeys.list(tenderId), queryFn: () => listFiles(tenderId) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: filesKeys.list(tenderId) });
  const busy = queue.some((q) => q.state === 'waiting' || q.state === 'uploading');

  const patchQueue = (key: string, patch: Partial<QueueItem>) => setQueue((items) => items.map((q) => (q.key === key ? { ...q, ...patch } : q)));

  /** One request per file, one after the other: each gets its own progress bar and its own error. */
  const upload = async (files: File[]) => {
    const target = folder;
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, file: f }));
    setQueue((items) => [...items.filter((q) => q.state !== 'done'), ...batch.map(({ key, file }) => ({ key, name: file.name, size: file.size, progress: 0, state: 'waiting' as const }))]);
    let ok = 0;
    for (const { key, file } of batch) {
      patchQueue(key, { state: 'uploading' });
      try {
        await uploadTenderFile(tenderId, file, { folder: target, label: label.trim() || undefined }, (fraction) => patchQueue(key, { progress: fraction }));
        patchQueue(key, { state: 'done', progress: 1 });
        ok++;
      } catch (err) {
        const message = errorMessage(err);
        patchQueue(key, { state: 'failed', error: message });
        toast.error(`${file.name}: ${message}`);
      }
    }
    if (ok > 0) {
      toast.success(t('upload.success', { count: ok }));
      setLabel('');
      await invalidate();
    }
  };

  const remove = useMutation({
    mutationFn: (file: TenderFile) => deleteFile(tenderId, file.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('delete.done'));
      setRemoving(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  /** Ask the server first, so a refusal is a clear message instead of a broken download. */
  const download = async (file: TenderFile) => {
    try {
      await getFile(tenderId, file.id);
      startDownload(fileDownloadUrl(tenderId, file.id));
    } catch (err) {
      toast.error(errorMessage(err));
      void invalidate();
    }
  };

  const mayManage = (file: TenderFile) => mayWrite && (hasRole('admin', 'bid_manager') || file.uploaded_by === user?.id);

  const columns: Column<TenderFile>[] = [
    {
      key: 'filename',
      header: t('columns.name'),
      wrap: true,
      render: (f) => (
        <span className="files-name">
          <Icon name={f.confidentiality === 'financial' ? 'lock' : 'file'} />
          <span className="files-name__text">{f.filename}</span>
          {f.confidentiality === 'financial' && f.folder !== 'financial' && (
            <Badge tone="orange" title={t('confidentialHint')}>
              {t('confidential')}
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'label', header: t('columns.label'), render: (f) => (f.label ? <Badge>{f.label}</Badge> : <span className="u-faint">—</span>) },
    { key: 'size', header: t('columns.size'), align: 'right', mono: true, width: 100, render: (f) => formatFileSize(f.size) },
    { key: 'uploaded_by_name', header: t('columns.uploader'), render: (f) => f.uploaded_by_name ?? <span className="u-faint">—</span> },
    { key: 'created_at', header: t('columns.date'), mono: true, width: 150, render: (f) => <DateText value={f.created_at} withTime /> },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      width: 96,
      render: (f) => (
        <CellActions>
          <Button size="sm" variant="ghost" icon="download" iconOnly onClick={() => void download(f)}>
            {t('downloadFile', { name: f.filename })}
          </Button>
          {mayManage(f) && (
            <Menu
              label={t('actionsFor', { name: f.filename })}
              items={[
                { label: t('edit.action'), icon: 'edit', onSelect: () => setEditing(f) },
                { label: t('common:actions.delete'), icon: 'trash', danger: true, separatorBefore: true, onSelect: () => setRemoving(f) },
              ]}
            />
          )}
        </CellActions>
      ),
    },
  ];

  const files = query.data ?? [];

  return (
    <>
      <PageHeader level={2} title={t('title')} subtitle={t('subtitle')} />

      {mayWrite ? (
        <Card title={t('upload.title')}>
          <div className="files-upload">
            <Field label={t('upload.folder')}>
              <Select value={folder} onChange={(e) => setFolder(e.target.value as FileFolder)} options={folders.map((f) => ({ value: f, label: enumLabel('folder', f) }))} disabled={busy} />
            </Field>
            <Field label={t('upload.label')} hint={t('upload.labelHint')}>
              <Input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
            </Field>
            {folder === 'financial' && (
              <Banner tone="orange" className="files-upload__note">
                {t('upload.financialNote')}
              </Banner>
            )}
            <FileDropInput className="files-upload__drop" multiple disabled={busy} label={t('upload.title')} onFiles={(f) => void upload(f)} onReject={toast.error} />
            {queue.length > 0 && (
              <div className="files-upload__drop u-stack u-stack--sm">
                <ul className="files-queue" aria-label={t('upload.queue')}>
                  {queue.map((q) => (
                    <li key={q.key}>
                      <ProgressBar
                        label={`${q.name} · ${formatFileSize(q.size)}`}
                        value={Math.round(q.progress * 100)}
                        tone={q.state === 'failed' ? 'red' : q.state === 'done' ? 'green' : 'info'}
                        valueText={q.state === 'uploading' ? `${Math.round(q.progress * 100)}%` : t(`upload.${q.state === 'waiting' ? 'waiting' : q.state === 'done' ? 'done' : 'failed'}`)}
                      />
                      {q.error && (
                        <span className="files-queue__error" role="alert">
                          {q.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {!busy && (
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setQueue([])}>
                      {t('upload.clear')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      ) : (
        <Banner tone="info">{t('upload.readOnly')}</Banner>
      )}

      {query.isPending ? (
        <PageSpinner />
      ) : query.isError ? (
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
        <div className="files-sections">
          {folders.map((f) => {
            const rows = files.filter((file) => file.folder === f);
            return (
              <Card
                key={f}
                flush
                tone={f === 'financial' ? 'orange' : undefined}
                title={
                  <span className="files-section__title">
                    <Icon name={f === 'financial' ? 'lock' : 'folder'} />
                    {enumLabel('folder', f)}
                    {f === 'financial' && (
                      <Badge tone="orange" title={t('confidentialHint')}>
                        {t('confidential')}
                      </Badge>
                    )}
                  </span>
                }
                subtitle={t('count', { count: rows.length })}
              >
                {rows.length === 0 ? <p className="files-empty u-muted">{t('emptyFolder')}</p> : <Table caption={enumLabel('folder', f)} columns={columns} rows={rows} dense />}
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <EditFileModal
          file={editing}
          folders={folders}
          canSeeFinancial={canSeeFinancial}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await invalidate();
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        danger
        title={t('delete.title')}
        message={removing ? t('delete.message', { name: removing.filename }) : ''}
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}

function EditFileModal({
  file,
  folders,
  canSeeFinancial,
  onClose,
  onSaved,
}: {
  file: TenderFile;
  folders: FileFolder[];
  canSeeFinancial: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation('files');
  const { tenderId } = useTender();
  const toast = useToast();
  const [filename, setFilename] = useState(file.filename);
  const [label, setLabel] = useState(file.label ?? '');
  const [folder, setFolder] = useState<FileFolder>(file.folder);
  const [financial, setFinancial] = useState(file.confidentiality === 'financial');
  const forced = folder === 'financial';

  const save = useMutation({
    mutationFn: () =>
      patchFile(tenderId, file.id, {
        filename: filename.trim(),
        label: label.trim() || null,
        folder,
        ...(canSeeFinancial ? { confidentiality: forced || financial ? ('financial' as const) : ('normal' as const) } : {}),
      }),
    onSuccess: async () => {
      toast.success(t('common:state.saved'));
      await onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t('edit.title')}
      onSubmit={() => filename.trim() && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{t('common:actions.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!filename.trim()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        <Field label={t('edit.filename')} required>
          <Input value={filename} maxLength={200} onChange={(e) => setFilename(e.target.value)} />
        </Field>
        <Field label={t('upload.label')} hint={t('upload.labelHint')}>
          <Input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label={t('edit.folder')}>
          <Select value={folder} onChange={(e) => setFolder(e.target.value as FileFolder)} options={folders.map((f) => ({ value: f, label: enumLabel('folder', f) }))} />
        </Field>
        {canSeeFinancial && (
          <Checkbox
            label={t('edit.markFinancial')}
            hint={forced ? t('edit.forcedFinancial') : t('edit.markFinancialHint')}
            checked={forced || financial}
            disabled={forced}
            onChange={(e) => setFinancial(e.target.checked)}
          />
        )}
      </div>
    </Modal>
  );
}
