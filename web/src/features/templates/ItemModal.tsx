import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, isApiError } from '@/api/client';
import {
  AUTO_RULES,
  CRITERION_TYPES,
  OFFSET_UNITS,
  TEMPLATE_CONDITIONS,
  type ID,
  type OffsetUnit,
  type TemplateCondition,
  type TemplateItemKind,
} from '@/api/types';
import { enumLabel, enumOptions } from '@/lib/enums';
import { Banner, Button, Checkbox, Field, Input, Modal, Select, Textarea, useToast, type SelectOption } from '@/ui';
import { formatOffset, isOffset } from './offset';
import { ProblemText } from './ProblemsPanel';
import { ANCHOR_KINDS, createItem, updateItem, type GroupedItems, type ItemInput, type OffsetValue, type Problem, type TplItem } from './templatesApi';

export type ItemTarget = { mode: 'add'; kind: TemplateItemKind; preset?: { gateKey?: string; ownerRole?: string } } | { mode: 'edit'; item: TplItem };

interface OffsetDraft {
  anchor: string;
  sign: '-' | '+';
  amount: string;
  unit: OffsetUnit;
}

const emptyOffset = (anchor = 'T', sign: '-' | '+' = '-'): OffsetDraft => ({ anchor, sign, amount: '', unit: 'working' });

function toDraft(o: { anchor: string | null; offset_value: number | null; offset_unit: OffsetUnit | null } | null | undefined): OffsetDraft {
  if (!o || !o.anchor) return emptyOffset();
  const n = o.offset_value ?? 0;
  return { anchor: o.anchor, sign: n > 0 ? '+' : '-', amount: String(Math.abs(n)), unit: o.offset_unit ?? 'working' };
}

function fromDraft(d: OffsetDraft): OffsetValue | null {
  if (!d.anchor || !/^\d{1,4}$/.test(d.amount.trim())) return null;
  const n = Number(d.amount);
  return { anchor: d.anchor, offset_value: n === 0 ? 0 : d.sign === '-' ? -n : n, offset_unit: d.unit };
}

interface OffsetFieldProps {
  legend: string;
  value: OffsetDraft;
  onChange: (next: OffsetDraft) => void;
  anchors: SelectOption[];
  error?: string;
}

/** Offset as a human expression: anchor + before/after + days + kind of days («T−8 εργάσιμες»). */
export function OffsetField({ legend, value, onChange, anchors, error }: OffsetFieldProps) {
  const { t } = useTranslation('templates');
  const parsed = fromDraft(value);
  return (
    <fieldset className="tpl-offset-field u-span-2">
      <legend className="u-sr-only">{legend}</legend>
      <div className="tpl-offset-field__legend" aria-hidden>
        {legend}
      </div>
      <div className="tpl-offset-field__grid">
        <Field label={t('offset.anchor')}>
          <Select value={value.anchor} options={anchors} onChange={(e) => onChange({ ...value, anchor: e.target.value })} />
        </Field>
        <Field label={t('offset.direction')}>
          <Select
            value={value.sign}
            options={[
              { value: '-', label: t('offset.before') },
              { value: '+', label: t('offset.after') },
            ]}
            onChange={(e) => onChange({ ...value, sign: e.target.value as '-' | '+' })}
          />
        </Field>
        <Field label={t('offset.amount')} error={error}>
          <Input type="number" inputMode="numeric" min={0} max={3650} step={1} value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} />
        </Field>
        <Field label={t('offset.unit')}>
          <Select value={value.unit} options={enumOptions('offset_unit', OFFSET_UNITS)} onChange={(e) => onChange({ ...value, unit: e.target.value as OffsetUnit })} />
        </Field>
      </div>
      {parsed && (
        <p className="tpl-offset-field__preview" aria-live="polite">
          {t('offset.preview', { expr: formatOffset(parsed) })}
        </p>
      )}
    </fieldset>
  );
}

interface Draft {
  key: string;
  name: string;
  condition: TemplateCondition;
  owner: string;
  hasDate: boolean;
  offset: OffsetDraft;
  folder: string;
  financial: boolean;
  management: boolean;
  decisionMode: string;
  hasTarget: boolean;
  target: OffsetDraft;
  hasCompressed: boolean;
  compressed: OffsetDraft;
  hasWarn: boolean;
  warn: OffsetDraft;
  gateKey: string;
  type: string;
  autoRule: string;
  fromRole: string;
  toRole: string;
  description: string;
  leadValue: string;
  leadUnit: OffsetUnit;
  neededKey: string;
  checks: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function initialDraft(target: ItemTarget): Draft {
  const item = target.mode === 'edit' ? target.item : null;
  const p = item?.payload ?? {};
  const preset = target.mode === 'add' ? target.preset : undefined;
  return {
    key: item?.key ?? '',
    name: item?.name ?? '',
    condition: item?.condition ?? 'always',
    owner: item?.owner_role_key ?? preset?.ownerRole ?? '',
    hasDate: item ? item.anchor !== null : false,
    offset: toDraft(item),
    folder: str(p.folder),
    financial: p.financial === true,
    management: p.management === true,
    decisionMode: str(p.decision_mode) || 'approval',
    hasTarget: isOffset(p.target),
    target: isOffset(p.target) ? toDraft(p.target) : emptyOffset(),
    hasCompressed: isOffset(p.compressed),
    compressed: isOffset(p.compressed) ? toDraft(p.compressed) : emptyOffset(),
    hasWarn: isOffset(p.warn_if_target_after),
    warn: isOffset(p.warn_if_target_after) ? toDraft(p.warn_if_target_after) : emptyOffset(),
    gateKey: str(p.gate_key) || preset?.gateKey || '',
    type: str(p.type) || 'manual',
    autoRule: str(p.auto_rule),
    fromRole: str(p.from_role),
    toRole: str(p.to_role),
    description: str(p.description),
    leadValue: typeof p.lead_value === 'number' ? String(p.lead_value) : '',
    leadUnit: p.lead_unit === 'calendar' ? 'calendar' : 'working',
    neededKey: str(p.needed_milestone_key),
    checks: str(p.checks),
  };
}

const KEY_EXAMPLE: Record<TemplateItemKind, string> = {
  role: 'A',
  gate: 'G1',
  milestone: 'UPLOAD',
  handoff: 'tech_to_pack',
  task: 'demo_prep',
  checklist_item: 'chk_gemi',
  watch_item: 'guarantee',
  gate_criterion: 'g1_bom',
};
/** Kinds other items refer to by key: the key is asked for. For the rest it may be left to the server. */
const KEY_REQUIRED: ReadonlySet<TemplateItemKind> = new Set(['role', 'gate', 'milestone', 'handoff']);
const HAS_OWNER: ReadonlySet<TemplateItemKind> = new Set(['gate', 'task', 'checklist_item', 'watch_item']);
const HAS_REQUIRED_DATE: ReadonlySet<TemplateItemKind> = new Set(['gate', 'milestone', 'handoff']);

interface ItemModalProps {
  templateId: ID;
  target: ItemTarget | null;
  items: GroupedItems;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

/** Add/edit form of one template item; the fields depend on the kind (shapes of ARCHITECTURE.md). */
export function ItemModal({ templateId, target, items, onClose, onSaved }: ItemModalProps) {
  const { t } = useTranslation('templates');
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [touched, setTouched] = useState(false);
  const [seededFor, setSeededFor] = useState<ItemTarget | null>(null);

  if (target !== seededFor) {
    setSeededFor(target);
    setTouched(false);
    setDraft(target ? initialDraft(target) : null);
  }

  const kind: TemplateItemKind | null = target ? (target.mode === 'edit' ? target.item.kind : target.kind) : null;
  const editing = target?.mode === 'edit' ? target.item : null;

  const save = useMutation({
    mutationFn: (body: ItemInput) => (editing ? updateItem(templateId, editing.id, body) : createItem(templateId, body)),
    onSuccess: async () => {
      await onSaved();
      toast.success(t(editing ? 'common:state.saved' : 'form.added'));
      onClose();
    },
  });

  const close = () => {
    save.reset();
    onClose();
  };

  if (!target || !kind || !draft) return <Modal open={false} onClose={close} title="" />;

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [field]: value } : d));

  const roleOptions: SelectOption[] = items.role.map((r) => ({ value: r.key, label: `${r.key} · ${r.name}` }));
  const gateOptions: SelectOption[] = items.gate.map((g) => ({ value: g.key, label: `${g.key} · ${g.name}` }));
  const dated = ANCHOR_KINDS.flatMap((k) => items[k]);
  const datedOptions: SelectOption[] = dated.map((d) => ({ value: d.key, label: `${d.key} · ${d.name}` }));
  const anchors: SelectOption[] = [
    { value: 'T', label: t('offset.anchorT') },
    { value: 'T0', label: t('offset.anchorT0') },
    ...datedOptions.filter((o) => o.value !== editing?.key || kind === 'gate'),
  ];
  // The item's own main date cannot be relative to itself.
  const mainAnchors = anchors.filter((o) => o.value !== editing?.key);

  const needsDate = HAS_REQUIRED_DATE.has(kind) || (kind === 'task' && draft.hasDate);
  const required = t('form.required');
  const errors: Record<string, string | undefined> = {
    name: draft.name.trim() ? undefined : required,
    key: KEY_REQUIRED.has(kind) && !draft.key.trim() ? required : undefined,
    owner: kind === 'checklist_item' && !draft.owner ? required : undefined,
    offset: needsDate && !fromDraft(draft.offset) ? required : undefined,
    target: kind === 'gate' && draft.hasTarget && !fromDraft(draft.target) ? required : undefined,
    compressed: kind === 'gate' && draft.hasCompressed && !fromDraft(draft.compressed) ? required : undefined,
    warn: kind === 'gate' && draft.hasWarn && !fromDraft(draft.warn) ? required : undefined,
    gateKey: kind === 'gate_criterion' && !draft.gateKey ? required : undefined,
    autoRule: kind === 'gate_criterion' && draft.type === 'auto' && !draft.autoRule ? required : undefined,
    fromRole: kind === 'handoff' && !draft.fromRole ? required : undefined,
    toRole: kind === 'handoff' && !draft.toRole ? required : undefined,
    leadValue: kind === 'watch_item' && draft.leadValue.trim() !== '' && !/^\d{1,4}$/.test(draft.leadValue.trim()) ? required : undefined,
  };
  const show = (field: string) => (touched ? errors[field] : undefined);

  function buildBody(d: Draft): ItemInput {
    // Unknown payload fields (extras written by a seed) are kept as they are.
    const payload: Record<string, unknown> = { ...(editing?.payload ?? {}) };
    const put = (name: string, value: unknown) => {
      if (value === undefined || value === '' || value === false) delete payload[name];
      else payload[name] = value;
    };
    const body: ItemInput = { name: d.name.trim(), condition: d.condition };
    if (d.key.trim()) body.key = d.key.trim();
    if (HAS_OWNER.has(kind!)) body.owner_role_key = d.owner || null;
    if (needsDate) Object.assign(body, fromDraft(d.offset));
    else if (kind === 'task') Object.assign(body, { anchor: null, offset_value: null, offset_unit: null });

    if (kind === 'role') {
      put('folder', d.folder);
      put('financial', d.financial);
      put('management', d.management);
    } else if (kind === 'gate') {
      payload.decision_mode = d.decisionMode;
      put('target', d.hasTarget ? fromDraft(d.target) : undefined);
      put('compressed', d.hasCompressed ? fromDraft(d.compressed) : undefined);
      put('warn_if_target_after', d.hasWarn ? fromDraft(d.warn) : undefined);
    } else if (kind === 'gate_criterion') {
      payload.gate_key = d.gateKey;
      payload.type = d.type;
      put('auto_rule', d.type === 'auto' ? d.autoRule : undefined);
    } else if (kind === 'handoff') {
      payload.from_role = d.fromRole;
      payload.to_role = d.toRole;
    } else if (kind === 'task') {
      put('description', d.description.trim());
    } else if (kind === 'watch_item') {
      payload.lead_value = d.leadValue.trim() === '' ? null : Number(d.leadValue);
      payload.lead_unit = d.leadUnit;
      put('needed_milestone_key', d.neededKey);
      put('checks', d.checks.trim());
    }
    body.payload = payload;
    if (!editing) body.kind = kind!;
    return body;
  }

  const problems: Problem[] = isApiError(save.error) ? (((save.error.details as { problems?: Problem[] } | null)?.problems ?? []) as Problem[]) : [];
  const kindLabel = enumLabel('template_item_kind', kind);
  const nameLabel = kind === 'gate_criterion' ? t('form.criterionText') : kind === 'handoff' ? t('form.handoffName') : t('form.name');
  const longName = kind === 'gate_criterion' || kind === 'checklist_item';

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={t(editing ? 'form.editTitle' : 'form.addTitle', { kind: kindLabel })}
      onSubmit={() => {
        setTouched(true);
        if (Object.values(errors).every((e) => !e)) save.mutate(buildBody(draft));
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
      <div className="u-form-grid">
        {save.isError && (
          <Banner tone="red" className="u-span-2" title={errorMessage(save.error)}>
            {problems.length > 0 && (
              <ul className="tpl-problem-list">
                {problems.map((p, i) => (
                  <li key={i}>
                    <ProblemText problem={p} />
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}

        <Field label={nameLabel} required error={show('name')} className={longName ? 'u-span-2' : undefined}>
          {longName ? (
            <Textarea rows={2} value={draft.name} maxLength={500} onChange={(e) => set('name', e.target.value)} />
          ) : (
            <Input value={draft.name} maxLength={500} onChange={(e) => set('name', e.target.value)} />
          )}
        </Field>
        <Field
          label={t('form.key')}
          required={KEY_REQUIRED.has(kind)}
          error={show('key')}
          hint={KEY_REQUIRED.has(kind) ? t('form.keyHint', { example: KEY_EXAMPLE[kind] }) : t('form.keyAutoHint')}
        >
          <Input className="u-mono" value={draft.key} maxLength={60} autoCapitalize="off" spellCheck={false} onChange={(e) => set('key', e.target.value)} />
        </Field>

        {kind === 'role' && (
          <>
            <Field label={t('form.folder')}>
              <Select
                value={draft.folder}
                placeholder={t('form.noFolder')}
                options={enumOptions('folder', ['participation', 'technical', 'financial'])}
                onChange={(e) => set('folder', e.target.value)}
              />
            </Field>
            <Checkbox label={t('form.financial')} hint={t('form.financialHint')} checked={draft.financial} onChange={(e) => set('financial', e.target.checked)} />
            <Checkbox label={t('form.management')} checked={draft.management} onChange={(e) => set('management', e.target.checked)} />
          </>
        )}

        {kind === 'gate_criterion' && (
          <>
            <Field label={t('form.gate')} required error={show('gateKey')}>
              <Select value={draft.gateKey} placeholder={t('common:actions.select')} options={gateOptions} onChange={(e) => set('gateKey', e.target.value)} />
            </Field>
            <Field label={t('form.criterionType')}>
              <Select value={draft.type} options={enumOptions('criterion_type', CRITERION_TYPES)} onChange={(e) => set('type', e.target.value)} />
            </Field>
            {draft.type === 'auto' && (
              <Field label={t('form.autoRule')} required error={show('autoRule')} className="u-span-2">
                <Select value={draft.autoRule} placeholder={t('form.selectRule')} options={enumOptions('auto_rule', AUTO_RULES)} onChange={(e) => set('autoRule', e.target.value)} />
              </Field>
            )}
          </>
        )}

        {kind === 'handoff' && (
          <>
            <Field label={t('form.fromRole')} required error={show('fromRole')}>
              <Select value={draft.fromRole} placeholder={t('form.selectRole')} options={roleOptions} onChange={(e) => set('fromRole', e.target.value)} />
            </Field>
            <Field label={t('form.toRole')} required error={show('toRole')}>
              <Select value={draft.toRole} placeholder={t('form.selectRole')} options={roleOptions} onChange={(e) => set('toRole', e.target.value)} />
            </Field>
          </>
        )}

        {HAS_OWNER.has(kind) && (
          <Field label={kind === 'gate' ? t('form.approverRole') : t('form.ownerRole')} required={kind === 'checklist_item'} error={show('owner')}>
            <Select
              value={draft.owner}
              placeholder={kind === 'checklist_item' ? t('form.selectRole') : t('form.noRole')}
              options={roleOptions}
              onChange={(e) => set('owner', e.target.value)}
            />
          </Field>
        )}

        {kind === 'gate' && (
          <Field label={t('form.decisionMode')}>
            <Select
              value={draft.decisionMode}
              options={[
                { value: 'approval', label: t('decisionMode.approval') },
                { value: 'go_no_go', label: t('decisionMode.go_no_go') },
              ]}
              onChange={(e) => set('decisionMode', e.target.value)}
            />
          </Field>
        )}

        <Field label={t('form.condition')}>
          <Select
            value={draft.condition}
            options={enumOptions('template_condition', TEMPLATE_CONDITIONS)}
            onChange={(e) => set('condition', e.target.value as TemplateCondition)}
          />
        </Field>

        {kind === 'task' && <Checkbox className="u-span-2" label={t('form.hasDate')} checked={draft.hasDate} onChange={(e) => set('hasDate', e.target.checked)} />}
        {needsDate && (
          <OffsetField
            legend={kind === 'gate' ? t('form.bindingDate') : t('form.date')}
            value={draft.offset}
            anchors={mainAnchors}
            error={show('offset')}
            onChange={(v) => set('offset', v)}
          />
        )}

        {kind === 'gate' && (
          <>
            <Checkbox className="u-span-2" label={t('form.hasTarget')} checked={draft.hasTarget} onChange={(e) => set('hasTarget', e.target.checked)} />
            {draft.hasTarget && <OffsetField legend={t('form.target')} value={draft.target} anchors={anchors} error={show('target')} onChange={(v) => set('target', v)} />}
            {draft.hasTarget && (
              <Checkbox className="u-span-2" label={t('form.hasWarn')} checked={draft.hasWarn} onChange={(e) => set('hasWarn', e.target.checked)} />
            )}
            {draft.hasTarget && draft.hasWarn && (
              <OffsetField legend={t('form.warn')} value={draft.warn} anchors={anchors} error={show('warn')} onChange={(v) => set('warn', v)} />
            )}
            <Checkbox className="u-span-2" label={t('form.hasCompressed')} checked={draft.hasCompressed} onChange={(e) => set('hasCompressed', e.target.checked)} />
            {draft.hasCompressed && (
              <OffsetField legend={t('form.compressed')} value={draft.compressed} anchors={anchors} error={show('compressed')} onChange={(v) => set('compressed', v)} />
            )}
          </>
        )}

        {kind === 'task' && (
          <Field label={t('form.description')} className="u-span-2">
            <Textarea rows={3} value={draft.description} maxLength={5000} onChange={(e) => set('description', e.target.value)} />
          </Field>
        )}

        {kind === 'watch_item' && (
          <>
            <Field label={t('form.leadValue')} hint={t('form.leadHint')} error={show('leadValue')}>
              <Input type="number" inputMode="numeric" min={0} max={3650} value={draft.leadValue} onChange={(e) => set('leadValue', e.target.value)} />
            </Field>
            <Field label={t('form.leadUnit')}>
              <Select value={draft.leadUnit} options={enumOptions('offset_unit', OFFSET_UNITS)} onChange={(e) => set('leadUnit', e.target.value as OffsetUnit)} />
            </Field>
            <Field label={t('form.neededAt')}>
              <Select value={draft.neededKey} placeholder={t('form.neededNone')} options={datedOptions} onChange={(e) => set('neededKey', e.target.value)} />
            </Field>
            <Field label={t('form.checks')} className="u-span-2">
              <Textarea rows={2} value={draft.checks} maxLength={2000} onChange={(e) => set('checks', e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
