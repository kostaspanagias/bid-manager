import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { errorMessage, isApiError } from '@/api/client';
import type { ID, TemplateItemKind } from '@/api/types';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { cx } from '@/lib/cx';
import { formatDate } from '@/lib/dates';
import { enumLabel } from '@/lib/enums';
import { Badge, Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Modal, PageHeader, PageSpinner, Tabs, Textarea, useToast } from '@/ui';
import { DiffPanel } from './DiffPanel';
import { ItemModal, type ItemTarget } from './ItemModal';
import { LessonsPanel } from './LessonsPanel';
import { formatOffset, isOffset, offsetExpr } from './offset';
import { ProblemsPanel } from './ProblemsPanel';
import {
  deleteItem,
  deleteTemplate,
  getTemplate,
  listPendingLessons,
  newVersion,
  publishTemplate,
  reorderItems,
  templateKeys,
  updateTemplate,
  validateTemplate,
  type GroupedItems,
  type Problem,
  type TemplateRecord,
  type TplItem,
} from './templatesApi';
import './templates.css';

/** «T−8 εργάσιμες» with the unit in lighter type. */
function Offset({ value }: { value: { anchor: string | null; offset_value: number | null; offset_unit: string | null } }) {
  if (!value.anchor) return null;
  const expr = offsetExpr(value);
  const full = formatOffset(value);
  return (
    <span className="tpl-offset">
      {expr}
      {full.length > expr.length && <small>{full.slice(expr.length)}</small>}
    </span>
  );
}

interface RowProps {
  item: TplItem;
  showKey?: boolean;
  meta?: ReactNode;
  children?: ReactNode;
  editable: boolean;
  severity?: 'error' | 'warning';
  canUp: boolean;
  canDown: boolean;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function Row({ item, showKey = true, meta, children, editable, severity, canUp, canDown, busy, onEdit, onRemove, onMove }: RowProps) {
  const { t } = useTranslation('templates');
  return (
    <li className={cx('tpl-row', !showKey && 'tpl-row--nokey', severity === 'error' && 'is-flagged', severity === 'warning' && 'is-warned')}>
      {showKey && (
        <span className="tpl-key" title={item.key}>
          {item.key}
        </span>
      )}
      <div className="tpl-row__main">
        <div className="tpl-row__name">{item.name}</div>
        <div className="tpl-row__meta">
          {meta}
          {item.condition !== 'always' && <Badge tone="info">{enumLabel('template_condition', item.condition)}</Badge>}
        </div>
      </div>
      {editable ? (
        <div className="tpl-row__actions">
          <Button size="sm" variant="ghost" icon="chevronDown" iconOnly className="tpl-up" disabled={!canUp || busy} onClick={() => onMove(-1)}>
            {t('row.up', { name: item.name })}
          </Button>
          <Button size="sm" variant="ghost" icon="chevronDown" iconOnly disabled={!canDown || busy} onClick={() => onMove(1)}>
            {t('row.down', { name: item.name })}
          </Button>
          <Button size="sm" variant="ghost" icon="edit" iconOnly onClick={onEdit}>
            {t('row.edit', { name: item.name })}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" iconOnly onClick={onRemove}>
            {t('row.remove', { name: item.name })}
          </Button>
        </div>
      ) : (
        <span />
      )}
      {children}
    </li>
  );
}

/** /admin/templates/:templateId — editor of a draft, read-only view of a published template. */
export function TemplateEditPage() {
  const { t } = useTranslation('templates');
  const { templateId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('content');
  const [target, setTarget] = useState<ItemTarget | null>(null);
  const [removing, setRemoving] = useState<TplItem | null>(null);
  const [confirm, setConfirm] = useState<'publish' | 'delete' | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const query = useQuery({ queryKey: templateKeys.record(templateId), queryFn: () => getTemplate(templateId) });
  const template = query.data?.template;
  const isDraft = template?.status === 'draft';
  const validation = useQuery({ queryKey: templateKeys.validate(templateId), queryFn: () => validateTemplate(templateId), enabled: isDraft });
  const pending = useQuery({ queryKey: templateKeys.pendingLessons, queryFn: listPendingLessons, enabled: !!template });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: templateKeys.detail(templateId) }),
      queryClient.invalidateQueries({ queryKey: ['templates', 'list'] }),
    ]);
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const remove = useMutation({
    mutationFn: (item: TplItem) => deleteItem(templateId, item.id),
    onSuccess: async () => {
      await refresh();
      toast.success(t('form.removed'));
      setRemoving(null);
    },
  });
  const reorder = useMutation({
    mutationFn: ({ kind, ids }: { kind: TemplateItemKind; ids: ID[] }) => reorderItems(templateId, kind, ids),
    onSuccess: () => refresh(),
    onError,
  });
  const publish = useMutation({
    mutationFn: () => publishTemplate(templateId),
    onSuccess: async () => {
      await refresh();
      toast.success(t('publish.done'));
      setConfirm(null);
    },
    onError: async (err) => {
      setConfirm(null);
      await refresh();
      onError(err);
    },
  });
  const discard = useMutation({
    mutationFn: () => deleteTemplate(templateId),
    onSuccess: async () => {
      toast.success(t('deleted'));
      navigate('/admin/templates');
      await queryClient.invalidateQueries({ queryKey: ['templates', 'list'] });
    },
    onError,
  });
  const version = useMutation({
    mutationFn: () => newVersion(templateId),
    onSuccess: async (draft) => {
      await queryClient.invalidateQueries({ queryKey: ['templates', 'list'] });
      toast.success(t('versionCreated', { version: draft.version }));
      navigate(`/admin/templates/${draft.id}`);
    },
    onError,
  });

  const back = { to: '/admin/templates', label: t('edit.back') };
  if (query.isPending) return <PageSpinner />;
  if (query.isError || !template) {
    return (
      <>
        <PageHeader title={t('edit.title')} back={back} />
        <Banner tone="red" title={t('common:errors.loadFailed')}>
          {errorMessage(query.error)}
        </Banner>
      </>
    );
  }

  const items: GroupedItems = query.data.items;
  const problems: Problem[] = isDraft ? (validation.data?.problems ?? []) : [];
  const errorCount = problems.filter((p) => p.severity === 'error').length;
  const severityOf = (item: TplItem) => {
    const own = problems.filter((p) => p.item_id === item.id);
    return own.some((p) => p.severity === 'error') ? 'error' : own.length ? 'warning' : undefined;
  };
  const roleName = (key: string | null) => (key ? (items.role.find((r) => r.key === key)?.name ?? key) : null);
  const allItems = Object.values(items).flat();

  /** Moves an item one place inside its group (the gate of a criterion, the role of a checklist item). */
  const move = (item: TplItem, group: TplItem[], dir: -1 | 1) => {
    const all = items[item.kind];
    const other = group[group.indexOf(item) + dir];
    if (!other) return;
    const ids = all.map((i) => i.id);
    const [a, b] = [ids.indexOf(item.id), ids.indexOf(other.id)];
    [ids[a], ids[b]] = [ids[b]!, ids[a]!];
    reorder.mutate({ kind: item.kind, ids });
  };

  const rowProps = (item: TplItem, group: TplItem[]) => ({
    item,
    editable: !!isDraft,
    severity: severityOf(item) as 'error' | 'warning' | undefined,
    canUp: group.indexOf(item) > 0,
    canDown: group.indexOf(item) < group.length - 1,
    busy: reorder.isPending,
    onEdit: () => setTarget({ mode: 'edit', item }),
    onRemove: () => {
      remove.reset();
      setRemoving(item);
    },
    onMove: (dir: -1 | 1) => move(item, group, dir),
  });

  const addButton = (kind: TemplateItemKind, preset?: { gateKey?: string; ownerRole?: string }, ghost = false) =>
    isDraft && (
      <Button size="sm" variant={ghost ? 'ghost' : 'secondary'} icon="plus" onClick={() => setTarget({ mode: 'add', kind, preset })}>
        {t(`add.${kind}`)}
      </Button>
    );

  const section = (kind: Exclude<TemplateItemKind, 'gate_criterion'>, body: ReactNode) => (
    <Card key={kind} title={`${t(`sections.${kind}`)} (${items[kind].length})`} subtitle={t(`sections.${kind}Hint`)} actions={addButton(kind)} flush>
      {items[kind].length === 0 ? <p className="tpl-empty">{t('sections.empty')}</p> : body}
    </Card>
  );

  const list = (kind: Exclude<TemplateItemKind, 'gate_criterion'>, meta: (item: TplItem) => ReactNode) =>
    section(
      kind,
      <ul className="tpl-list">
        {items[kind].map((item) => (
          <Row key={item.id} {...rowProps(item, items[kind])} meta={meta(item)} />
        ))}
      </ul>,
    );

  const checklistGroups = [...items.role.map((r) => r.key), ...new Set(items.checklist_item.map((c) => c.owner_role_key ?? '').filter((k) => !items.role.some((r) => r.key === k)))]
    .map((key) => ({ key, rows: items.checklist_item.filter((c) => (c.owner_role_key ?? '') === key) }))
    .filter((g) => g.rows.length > 0 || (isDraft && g.key !== ''));

  const content = (
    <div className="tpl-stack">
      {isDraft && <ProblemsPanel problems={problems} onOpen={(id) => { const item = allItems.find((i) => i.id === id); if (item) setTarget({ mode: 'edit', item }); }} />}

      {list('role', (r) => (
        <>
          {typeof r.payload.folder === 'string' && <Badge>{enumLabel('folder', r.payload.folder)}</Badge>}
          {r.payload.financial === true && <Badge tone="orange">{t('row.financial')}</Badge>}
          {r.payload.management === true && <Badge>{t('row.management')}</Badge>}
        </>
      ))}

      {section(
        'gate',
        <ul className="tpl-list">
          {items.gate.map((gate) => {
            const criteria = items.gate_criterion.filter((c) => c.payload.gate_key === gate.key);
            const p = gate.payload;
            return (
              <Row
                key={gate.id}
                {...rowProps(gate, items.gate)}
                meta={
                  <>
                    <Offset value={gate} />
                    <Badge>{t(`decisionMode.${String(p.decision_mode)}`, { defaultValue: String(p.decision_mode ?? '') })}</Badge>
                    {gate.owner_role_key && <span>{t('row.approver', { role: roleName(gate.owner_role_key) })}</span>}
                    {isOffset(p.target) && <span>{t('row.target', { offset: formatOffset(p.target) })}</span>}
                    {isOffset(p.warn_if_target_after) && <span>{t('row.warnAfter', { offset: formatOffset(p.warn_if_target_after) })}</span>}
                    {isOffset(p.compressed) && <span>{t('row.compressed', { offset: formatOffset(p.compressed) })}</span>}
                  </>
                }
              >
                <div className="tpl-criteria">
                  <div className="tpl-subhead">
                    <span>
                      {t('sections.criteria')} ({criteria.length})
                    </span>
                    {addButton('gate_criterion', { gateKey: gate.key }, true)}
                  </div>
                  {criteria.length === 0 ? (
                    <p className="tpl-empty">{t('sections.noCriteria')}</p>
                  ) : (
                    <ul className="tpl-list">
                      {criteria.map((c) => (
                        <Row
                          key={c.id}
                          {...rowProps(c, criteria)}
                          showKey={false}
                          meta={
                            c.payload.type === 'auto' ? (
                              <>
                                <Badge tone="info">{enumLabel('criterion_type', 'auto')}</Badge>
                                <span>{enumLabel('auto_rule', String(c.payload.auto_rule ?? ''))}</span>
                              </>
                            ) : null
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </Row>
            );
          })}
        </ul>,
      )}

      {list('milestone', (m) => (
        <Offset value={m} />
      ))}

      {list('handoff', (h) => (
        <>
          <Offset value={h} />
          <span>
            {String(h.payload.from_role ?? '?')} → {String(h.payload.to_role ?? '?')}
          </span>
        </>
      ))}

      {list('task', (task) => (
        <>
          {task.anchor ? <Offset value={task} /> : <span className="u-faint">{t('row.noDate')}</span>}
          {task.owner_role_key && <span>{roleName(task.owner_role_key)}</span>}
        </>
      ))}

      <Card
        title={`${t('sections.checklist_item')} (${items.checklist_item.length})`}
        subtitle={t('sections.checklist_itemHint')}
        actions={items.role.length === 0 ? addButton('checklist_item') : undefined}
        flush
      >
        {checklistGroups.length === 0 ? (
          <p className="tpl-empty">{t('sections.empty')}</p>
        ) : (
          checklistGroups.map((g) => (
            <div key={g.key || '-'}>
              <div className="tpl-subhead">
                <span>
                  {g.key ? roleName(g.key) : t('sections.noRole')} ({g.rows.length})
                </span>
                {g.key && addButton('checklist_item', { ownerRole: g.key }, true)}
              </div>
              <ul className="tpl-list">
                {g.rows.map((c) => (
                  <Row key={c.id} {...rowProps(c, g.rows)} showKey={false} />
                ))}
              </ul>
            </div>
          ))
        )}
      </Card>

      {list('watch_item', (w) => {
        const lead = typeof w.payload.lead_value === 'number' ? `${w.payload.lead_value} ${t(`unit.${String(w.payload.lead_unit ?? 'working')}`, { count: w.payload.lead_value })}` : null;
        return (
          <>
            <span>{lead ? t('row.lead', { lead }) : t('row.leadUnknown')}</span>
            {typeof w.payload.needed_milestone_key === 'string' && <span>{t('row.neededAt', { key: w.payload.needed_milestone_key })}</span>}
            {w.owner_role_key && <span>{roleName(w.owner_role_key)}</span>}
          </>
        );
      })}
    </div>
  );

  const pendingCount = pending.data?.length ?? 0;
  const tabs = [
    { key: 'content', label: t('tabs.content'), count: isDraft && problems.length ? problems.length : undefined, countTone: errorCount ? ('red' as const) : ('orange' as const) },
    ...(template.parent_template_id ? [{ key: 'diff', label: t('tabs.diff', { version: template.parent_version ?? '' }) }] : []),
    { key: 'lessons', label: t('tabs.lessons'), count: pendingCount || undefined, countTone: 'orange' as const },
  ];

  return (
    <>
      <PageHeader
        title={`${template.name} ${template.version}`}
        subtitle={template.description ?? undefined}
        back={back}
        meta={
          <>
            <StatusBadge kind="template_status" value={template.status} />
            {template.parent_version && <Badge>{t('meta.from', { version: template.parent_version })}</Badge>}
          </>
        }
        actions={
          isDraft ? (
            <>
              <Button icon="edit" onClick={() => setDetailsOpen(true)}>
                {t('details.edit')}
              </Button>
              <Button variant="danger" icon="trash" onClick={() => setConfirm('delete')}>
                {t('delete.action')}
              </Button>
              <Button variant="primary" icon="check" disabled={errorCount > 0 || validation.isPending || allItems.length === 0} title={errorCount > 0 ? t('publish.blocked') : undefined} onClick={() => setConfirm('publish')}>
                {t('publish.action')}
              </Button>
            </>
          ) : (
            <Button variant="primary" icon="copy" loading={version.isPending} onClick={() => version.mutate()}>
              {t('list.newVersion')}
            </Button>
          )
        }
      />

      <Banner tone={isDraft ? 'info' : 'green'} className="tpl-tabs">
        {isDraft ? t('meta.draftHint') : `${t('meta.publishedAt', { date: formatDate(template.published_at) })}. ${t('meta.readOnly')}`}
      </Banner>

      <Tabs className="tpl-tabs" label={t('tabs.label')} items={tabs} value={tab} onChange={setTab} />
      {tab === 'content' && (allItems.length === 0 && !isDraft ? <EmptyState title={t('sections.empty')} /> : content)}
      {tab === 'diff' && <DiffPanel templateId={templateId} />}
      {tab === 'lessons' && <LessonsPanel template={template} />}

      <ItemModal templateId={templateId} target={target} items={items} onClose={() => setTarget(null)} onSaved={refresh} />
      <DetailsModal open={detailsOpen} template={template} onClose={() => setDetailsOpen(false)} onSaved={refresh} />
      <ConfirmDialog
        open={removing !== null}
        danger
        title={t('form.removeTitle')}
        message={
          removing && (
            <>
              {t(removing.kind === 'gate' ? 'form.removeGateMessage' : 'form.removeMessage', { name: removing.name })}
              {remove.isError && (
                <span className="tpl-inline-error" role="alert">
                  {errorMessage(remove.error)}{' '}
                  {isApiError(remove.error) &&
                    (((remove.error.details as { problems?: Problem[] } | null)?.problems ?? []) as Problem[])
                      .map((p) => `${p.kind ? enumLabel('template_item_kind', p.kind) : ''} ${p.key ?? ''}`.trim())
                      .filter((v, i, arr) => arr.indexOf(v) === i)
                      .join(' · ')}
                </span>
              )}
            </>
          )
        }
        confirmLabel={t('common:actions.remove')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
      <ConfirmDialog
        open={confirm === 'publish'}
        title={t('publish.title', { name: template.name, version: template.version })}
        message={
          <>
            {t('publish.message')}
            {problems.length > 0 && <> {t('publish.warnings', { count: problems.length })}</>}
          </>
        }
        confirmLabel={t('publish.action')}
        loading={publish.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => publish.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        danger
        title={t('delete.title')}
        message={t('delete.message', { name: template.name, version: template.version })}
        confirmLabel={t('common:actions.delete')}
        loading={discard.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => discard.mutate()}
      />
    </>
  );
}

interface DetailsModalProps {
  open: boolean;
  template: TemplateRecord;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

/** Name, version and description of a draft. */
function DetailsModal({ open, template, onClose, onSaved }: DetailsModalProps) {
  const { t } = useTranslation('templates');
  const toast = useToast();
  const [form, setForm] = useState({ name: '', version: '', description: '' });
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setForm({ name: template.name, version: template.version, description: template.description ?? '' });
  }
  const save = useMutation({
    mutationFn: () => updateTemplate(template.id, { name: form.name.trim(), version: form.version.trim(), description: form.description.trim() || null }),
    onSuccess: async () => {
      await onSaved();
      toast.success(t('details.saved'));
      onClose();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  const valid = form.name.trim() !== '' && form.version.trim() !== '';
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('details.title')}
      onSubmit={() => valid && save.mutate()}
      footer={
        <>
          <Button onClick={close} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-form-grid">
        {save.isError && (
          <Banner tone="red" className="u-span-2">
            {errorMessage(save.error)}
          </Banner>
        )}
        <Field label={t('create.name')} required>
          <Input value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t('create.version')} required>
          <Input className="u-mono" value={form.version} maxLength={40} onChange={(e) => setForm({ ...form, version: e.target.value })} />
        </Field>
        <Field label={t('create.description')} className="u-span-2">
          <Textarea rows={3} value={form.description} maxLength={2000} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
