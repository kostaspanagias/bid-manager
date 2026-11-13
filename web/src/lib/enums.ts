/**
 * Enum → Greek label and enum → status tone, in one place so every screen shows the same wording and colour.
 * Labels live in i18n (`common:enums.<group>.<value>`).
 */
import i18n from '@/i18n';
import type { Tone } from '@/ui/types';

export type EnumGroup =
  | 'org_role'
  | 'tender_status'
  | 'holiday_source'
  | 'template_status'
  | 'template_item_kind'
  | 'offset_unit'
  | 'template_condition'
  | 'milestone_kind'
  | 'gate_decision'
  | 'criterion_type'
  | 'auto_rule'
  | 'requirement_type'
  | 'folder'
  | 'requirement_status'
  | 'task_status'
  | 'task_section'
  | 'risk_status'
  | 'change_source'
  | 'change_kind'
  | 'company_document_type'
  | 'file_confidentiality';

/** enumLabel('requirement_status', 'covered') → «Καλύφθηκε». Unknown values are returned as-is. */
export function enumLabel(group: EnumGroup, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return i18n.t(`common:enums.${group}.${value}`, { defaultValue: value });
}

/** Options for <Select options={enumOptions('requirement_type', REQUIREMENT_TYPES)} />. */
export function enumOptions<V extends string>(group: EnumGroup, values: ReadonlyArray<V>): Array<{ value: V; label: string }> {
  return values.map((value) => ({ value, label: enumLabel(group, value) }));
}

const TONES: Partial<Record<EnumGroup, Record<string, Tone>>> = {
  tender_status: { evaluation: 'neutral', in_progress: 'info', submitted: 'green', no_go: 'neutral', cancelled: 'neutral' },
  gate_decision: {
    pending: 'neutral',
    approved: 'green',
    approved_with_exception: 'orange',
    rejected: 'red',
    go: 'green',
    no_go: 'red',
  },
  requirement_status: { open: 'neutral', in_progress: 'info', covered: 'green', verified: 'green', deviation: 'orange' },
  requirement_type: { exclusion: 'red', scored: 'info', formal: 'neutral' },
  task_status: { open: 'neutral', in_progress: 'info', done: 'green', na: 'neutral', cancelled: 'neutral' },
  risk_status: { open: 'orange', mitigating: 'info', occurred: 'red', closed: 'neutral' },
  template_status: { draft: 'neutral', published: 'green' },
  holiday_source: { national: 'neutral', movable: 'neutral', manual: 'info' },
  change_kind: { clarification: 'neutral', amendment: 'info', extension: 'orange' },
  file_confidentiality: { normal: 'neutral', financial: 'orange' },
};

/** Badge tone for a status value (neutral when the group has no colour semantics). */
export function enumTone(group: EnumGroup, value: string | null | undefined): Tone {
  return (value && TONES[group]?.[value]) || 'neutral';
}
