import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { ID, TemplateItemKind } from '@/api/types';
import { enumLabel } from '@/lib/enums';
import { Banner, Card, EmptyState, PageSpinner } from '@/ui';
import { formatOffset, isOffset } from './offset';
import { getDiff, templateKeys, type TplItem } from './templatesApi';

const KIND_ORDER: TemplateItemKind[] = ['role', 'gate', 'gate_criterion', 'milestone', 'handoff', 'task', 'checklist_item', 'watch_item'];
const byKind = <T extends { kind: TemplateItemKind }>(rows: T[]) => [...rows].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

function ItemLine({ item }: { item: TplItem }) {
  const timing = formatOffset(item);
  return (
    <li className="tpl-row">
      <span className="tpl-key" title={item.key}>
        {item.key}
      </span>
      <div className="tpl-row__main">
        <div className="tpl-row__name">{item.name}</div>
        <div className="tpl-row__meta">
          <span>{enumLabel('template_item_kind', item.kind)}</span>
          {timing && <span className="tpl-offset">{timing}</span>}
          {item.owner_role_key && <span>{item.owner_role_key}</span>}
        </div>
      </div>
      <span />
    </li>
  );
}

/** Changes of a template relative to the version it was created from (GET /templates/:id/diff). */
export function DiffPanel({ templateId }: { templateId: ID }) {
  const { t } = useTranslation('templates');
  const query = useQuery({ queryKey: templateKeys.diff(templateId), queryFn: () => getDiff(templateId) });

  if (query.isPending) return <PageSpinner />;
  if (query.isError) return <Banner tone="red" title={t('common:errors.loadFailed')}>{errorMessage(query.error)}</Banner>;
  const diff = query.data;
  if (!diff.parent) return <EmptyState icon="history" title={t('diff.noParent')} />;
  const version = diff.parent.version;
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    return <EmptyState icon="history" title={t('diff.none', { version })} description={t('diff.noneHint')} />;
  }

  const show = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === '') return t('diff.empty');
    if (isOffset(v)) return formatOffset(v);
    if (typeof v === 'boolean') return t(v ? 'diff.yes' : 'diff.no');
    if (field === 'condition') return enumLabel('template_condition', String(v));
    if (field === 'lead_unit') return enumLabel('offset_unit', String(v));
    if (field === 'type') return enumLabel('criterion_type', String(v));
    if (field === 'auto_rule') return enumLabel('auto_rule', String(v));
    if (field === 'folder') return enumLabel('folder', String(v));
    if (field === 'decision_mode') return t(`decisionMode.${String(v)}`, { defaultValue: String(v) });
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };

  /** Field rows of one changed item: the three offset columns become one «Ημερομηνία» row, payload is opened up. */
  const rowsOf = (c: (typeof diff.changed)[number]) => {
    const rows: { field: string; before: string; after: string }[] = [];
    const timing = c.fields.some((f) => f === 'anchor' || f === 'offset_value' || f === 'offset_unit');
    if (timing) rows.push({ field: 'timing', before: formatOffset(c.before) || t('diff.empty'), after: formatOffset(c.after) || t('diff.empty') });
    for (const f of c.fields) {
      if (f === 'anchor' || f === 'offset_value' || f === 'offset_unit') continue;
      if (f === 'payload') {
        const keys = [...new Set([...Object.keys(c.before.payload), ...Object.keys(c.after.payload)])];
        for (const k of keys) {
          const [b, a] = [c.before.payload[k], c.after.payload[k]];
          if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) rows.push({ field: k, before: show(k, b), after: show(k, a) });
        }
      } else {
        const rec = (i: TplItem) => (i as unknown as Record<string, unknown>)[f];
        rows.push({ field: f, before: show(f, rec(c.before)), after: show(f, rec(c.after)) });
      }
    }
    return rows;
  };

  return (
    <div className="tpl-stack">
      <p className="tpl-hint">
        {t('diff.summary', { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, unchanged: diff.unchanged })}
      </p>
      {diff.added.length > 0 && (
        <Card title={`${t('diff.added')} (${diff.added.length})`} tone="green" flush>
          <ul className="tpl-list">{byKind(diff.added).map((i) => <ItemLine key={i.id} item={i} />)}</ul>
        </Card>
      )}
      {diff.changed.length > 0 && (
        <Card title={`${t('diff.changed')} (${diff.changed.length})`} tone="orange" flush>
          <ul className="tpl-list">
            {byKind(diff.changed).map((c) => (
              <li key={`${c.kind}-${c.key}`} className="tpl-row">
                <span className="tpl-key" title={c.key}>
                  {c.key}
                </span>
                <div className="tpl-row__main">
                  <div className="tpl-row__name">{c.after.name}</div>
                  <div className="tpl-row__meta">{enumLabel('template_item_kind', c.kind)}</div>
                  <table className="tpl-diff-table">
                    <thead className="u-sr-only">
                      <tr>
                        <th>{t('common:labels.name')}</th>
                        <th>{t('diff.before')}</th>
                        <th>{t('diff.after')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rowsOf(c).map((r) => (
                        <tr key={r.field}>
                          <th scope="row">{t(`diff.fields.${r.field}`, { defaultValue: r.field })}</th>
                          <td className="is-before">{r.before}</td>
                          <td className="is-after">{r.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {diff.removed.length > 0 && (
        <Card title={`${t('diff.removed')} (${diff.removed.length})`} tone="red" flush>
          <ul className="tpl-list">{byKind(diff.removed).map((i) => <ItemLine key={i.id} item={i} />)}</ul>
        </Card>
      )}
    </div>
  );
}
