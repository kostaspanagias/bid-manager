import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { Banner, Button, CellActions, ConfirmDialog, DateText, EmptyState, Field, Input, Modal, PageHeader, Table, Textarea, useToast, type Column } from '@/ui';
import { LessonsPanel } from './LessonsPanel';
import { createTemplate, deleteTemplate, listTemplates, newVersion, templateKeys, type TemplateSummary } from './templatesApi';
import './templates.css';

/** /admin/templates — every template version of the organization (F10). */
export function TemplateListPage() {
  const { t } = useTranslation('templates');
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [removing, setRemoving] = useState<TemplateSummary | null>(null);

  const query = useQuery({ queryKey: templateKeys.list(), queryFn: () => listTemplates() });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['templates', 'list'] });

  const version = useMutation({
    mutationFn: (tpl: TemplateSummary) => newVersion(tpl.id),
    onSuccess: async (draft) => {
      await invalidate();
      toast.success(t('versionCreated', { version: draft.version }));
      navigate(`/admin/templates/${draft.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (tpl: TemplateSummary) => deleteTemplate(tpl.id),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('deleted'));
      setRemoving(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const open = (tpl: TemplateSummary) => navigate(`/admin/templates/${tpl.id}`);
  const columns: Column<TemplateSummary>[] = [
    { key: 'name', header: t('list.columns.name'), render: (r) => <strong>{r.name}</strong> },
    { key: 'version', header: t('list.columns.version'), mono: true },
    { key: 'status', header: t('list.columns.status'), render: (r) => <StatusBadge kind="template_status" value={r.status} /> },
    { key: 'parent', header: t('list.columns.parent'), mono: true, render: (r) => (r.parent_version ? t('list.parent', { version: r.parent_version }) : <span className="u-faint">—</span>) },
    { key: 'published_at', header: t('list.columns.published'), mono: true, render: (r) => (r.published_at ? <DateText value={r.published_at} /> : <span className="u-faint">—</span>) },
    { key: 'item_count', header: t('list.columns.items'), align: 'right', mono: true },
    { key: 'tender_count', header: t('list.columns.tenders'), align: 'right', mono: true },
    {
      key: 'actions',
      header: t('common:labels.actions'),
      srOnlyHeader: true,
      align: 'right',
      render: (r) => (
        <CellActions>
          {r.status === 'published' ? (
            <Button size="sm" variant="ghost" icon="copy" loading={version.isPending && version.variables?.id === r.id} onClick={() => version.mutate(r)} aria-label={t('list.newVersionOf', { name: r.name, version: r.version })}>
              {t('list.newVersion')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon="trash" iconOnly onClick={() => setRemoving(r)}>
              {t('list.deleteDraft', { name: r.name, version: r.version })}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={r.status === 'draft' ? 'edit' : 'chevronRight'} onClick={() => open(r)} aria-label={`${t(r.status === 'draft' ? 'list.edit' : 'list.open')}: ${r.name} ${r.version}`}>
            {t(r.status === 'draft' ? 'list.edit' : 'list.open')}
          </Button>
        </CellActions>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            {t('list.new')}
          </Button>
        }
      />
      <div className="tpl-stack">
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
            caption={t('list.caption')}
            columns={columns}
            rows={query.data}
            loading={query.isPending}
            onRowClick={open}
            empty={
              <EmptyState
                icon="layers"
                compact
                title={t('list.empty')}
                description={t('list.emptyHint')}
                action={
                  <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                    {t('list.new')}
                  </Button>
                }
              />
            }
          />
        )}
        <LessonsPanel />
      </div>

      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={async (id) => { await invalidate(); navigate(`/admin/templates/${id}`); }} />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('delete.title')}
        message={removing ? t('delete.message', { name: removing.name, version: removing.version }) : null}
        confirmLabel={t('common:actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { t } = useTranslation('templates');
  const [form, setForm] = useState({ name: '', version: '1.0', description: '' });
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: () => createTemplate({ name: form.name.trim(), version: form.version.trim(), description: form.description.trim() || null }),
    onSuccess: async (tpl) => {
      setForm({ name: '', version: '1.0', description: '' });
      setTouched(false);
      onClose();
      await onCreated(tpl.id);
    },
  });
  const close = () => {
    create.reset();
    onClose();
  };
  const required = t('common:errors.required');
  const errors = { name: form.name.trim() ? undefined : required, version: form.version.trim() ? undefined : required };
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('create.title')}
      description={t('create.hint')}
      onSubmit={() => {
        setTouched(true);
        if (!errors.name && !errors.version) create.mutate();
      }}
      footer={
        <>
          <Button onClick={close} disabled={create.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            {t('create.submit')}
          </Button>
        </>
      }
    >
      <div className="u-form-grid">
        {create.isError && (
          <Banner tone="red" className="u-span-2">
            {errorMessage(create.error)}
          </Banner>
        )}
        <Field label={t('create.name')} required error={touched ? errors.name : undefined}>
          <Input value={form.name} maxLength={200} placeholder={t('create.namePlaceholder')} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t('create.version')} required error={touched ? errors.version : undefined}>
          <Input className="u-mono" value={form.version} maxLength={40} onChange={(e) => setForm({ ...form, version: e.target.value })} />
        </Field>
        <Field label={t('create.description')} className="u-span-2">
          <Textarea rows={3} value={form.description} maxLength={2000} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
