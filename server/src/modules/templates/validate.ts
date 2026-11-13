// validateTemplate(items): every structural rule a template must satisfy — pure, no database.
// Used on every item write of a draft, by publish, and exposed as GET /api/templates/:id/validate.
import { ANCHOR_KINDS, BASE_ANCHORS, ITEM_COLUMNS, parseItem, type Offset } from './shapes.js';

export interface ItemLike {
  id?: string | null;
  kind: string;
  key?: string | null;
  name?: string | null;
  owner_role_key?: string | null;
  offset_value?: number | null;
  offset_unit?: string | null;
  anchor?: string | null;
  condition?: string | null;
  sort?: number | null;
  payload?: unknown;
}

export type ProblemCode =
  | 'invalid_shape'
  | 'duplicate_key'
  | 'reserved_key'
  | 'unknown_anchor'
  | 'anchor_cycle'
  | 'unknown_gate'
  | 'unknown_role'
  | 'unknown_milestone'
  | 'condition_mismatch'
  | 'gate_without_approver'
  | 'gate_without_criteria'
  | 'no_roles';

export interface Problem {
  code: ProblemCode;
  severity: 'error' | 'warning';
  message: string;
  item_id: string | null;
  kind: string | null;
  key: string | null;
  /** The column or payload path the problem is about, e.g. `anchor`, `payload.gate_key`. */
  field: string | null;
}

const BASE: ReadonlySet<string> = new Set(BASE_ANCHORS);
const GATE_OFFSETS = ['target', 'warn_if_target_after', 'compressed'] as const;

function payloadOf(item: ItemLike): Record<string, unknown> {
  return item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? (item.payload as Record<string, unknown>) : {};
}

function pick(item: ItemLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of ITEM_COLUMNS) if ((item as unknown as Record<string, unknown>)[c] !== undefined) out[c] = (item as unknown as Record<string, unknown>)[c];
  return out;
}

/** Every anchor an item refers to: its own, and for a gate the anchors of the payload offsets. */
function anchorRefs(item: ItemLike): { field: string; anchor: string }[] {
  const refs: { field: string; anchor: string }[] = [];
  if (typeof item.anchor === 'string' && item.anchor !== '') refs.push({ field: 'anchor', anchor: item.anchor });
  if (item.kind === 'gate') {
    const p = payloadOf(item);
    for (const name of GATE_OFFSETS) {
      const o = p[name] as Partial<Offset> | undefined;
      if (o && typeof o === 'object' && typeof o.anchor === 'string') refs.push({ field: `payload.${name}.anchor`, anchor: o.anchor });
    }
  }
  return refs;
}

/**
 * Returns the problems of a set of template items (empty list = valid).
 * `severity: 'error'` blocks publishing; warnings are advice. Rules:
 *  - each item matches the shape of its kind (ARCHITECTURE.md);
 *  - keys are unique per kind, and unique across gate/milestone/handoff (they share the anchor namespace);
 *    `T` and `T0` are reserved;
 *  - anchors are `T`, `T0` or the key of a gate/milestone/handoff; anchors never form a cycle;
 *  - gate_criterion.payload.gate_key is an existing gate; role keys (owner_role_key, from_role, to_role) exist;
 *  - watch_item.payload.needed_milestone_key is an existing gate/milestone/handoff;
 *  - auto_rule is one of the allowed rules (part of the shape).
 */
export function validateTemplate(items: readonly ItemLike[]): Problem[] {
  const problems: Problem[] = [];
  const add = (item: ItemLike | null, code: ProblemCode, message: string, field: string | null = null, severity: Problem['severity'] = 'error') =>
    problems.push({ code, severity, message, item_id: item?.id ?? null, kind: item?.kind ?? null, key: item?.key ?? null, field });

  // 1. shapes
  for (const item of items) {
    const parsed = parseItem(pick(item));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) add(item, 'invalid_shape', issue.message, issue.path.join('.') || null);
    }
  }

  // 2. keys
  const byKindKey = new Map<string, ItemLike[]>();
  const anchorable = new Map<string, ItemLike[]>();
  for (const item of items) {
    if (typeof item.key !== 'string' || item.key === '') continue;
    const k = `${item.kind}\u0000${item.key}`;
    byKindKey.set(k, [...(byKindKey.get(k) ?? []), item]);
    if (ANCHOR_KINDS.has(item.kind)) {
      anchorable.set(item.key, [...(anchorable.get(item.key) ?? []), item]);
      if (BASE.has(item.key)) add(item, 'reserved_key', `"${item.key}" is reserved for the tender dates`, 'key');
    }
  }
  const reported = new Set<ItemLike>();
  for (const group of byKindKey.values()) {
    if (group.length < 2) continue;
    for (const item of group.slice(1)) {
      reported.add(item);
      add(item, 'duplicate_key', `Key "${item.key}" is used more than once in ${item.kind}`, 'key');
    }
  }
  for (const group of anchorable.values()) {
    if (group.length < 2) continue;
    for (const item of group.slice(1)) {
      if (!reported.has(item)) add(item, 'duplicate_key', `Key "${item.key}" is already used by another gate, milestone or handoff`, 'key');
    }
  }

  const roles = new Set(items.filter((i) => i.kind === 'role' && i.key).map((i) => i.key as string));
  const gates = new Map(items.filter((i) => i.kind === 'gate' && i.key).map((i) => [i.key as string, i]));
  const dated = new Map<string, ItemLike>();
  for (const [key, group] of anchorable) dated.set(key, group[0]!);

  // 3. references
  for (const item of items) {
    const p = payloadOf(item);
    for (const ref of anchorRefs(item)) {
      if (BASE.has(ref.anchor)) continue;
      const target = dated.get(ref.anchor);
      if (!target) {
        add(item, 'unknown_anchor', `Anchor "${ref.anchor}" is not T, T0 or the key of a gate, milestone or handoff`, ref.field);
      } else if (target !== item && target.condition && target.condition !== 'always' && target.condition !== (item.condition ?? 'always')) {
        add(item, 'condition_mismatch', `Anchor "${ref.anchor}" exists only under the condition "${target.condition}"`, ref.field, 'warning');
      }
    }
    if (item.owner_role_key && !roles.has(item.owner_role_key)) {
      add(item, 'unknown_role', `Role "${item.owner_role_key}" does not exist in this template`, 'owner_role_key');
    }
    if (item.kind === 'handoff') {
      for (const f of ['from_role', 'to_role'] as const) {
        const v = p[f];
        if (typeof v === 'string' && !roles.has(v)) add(item, 'unknown_role', `Role "${v}" does not exist in this template`, `payload.${f}`);
      }
    }
    if (item.kind === 'gate_criterion') {
      const g = p.gate_key;
      if (typeof g === 'string') {
        const gate = gates.get(g);
        if (!gate) add(item, 'unknown_gate', `Gate "${g}" does not exist in this template`, 'payload.gate_key');
        else if (gate.condition && gate.condition !== 'always' && gate.condition !== (item.condition ?? 'always')) {
          add(item, 'condition_mismatch', `Gate "${g}" exists only under the condition "${gate.condition}"`, 'payload.gate_key', 'warning');
        }
      }
    }
    if (item.kind === 'watch_item') {
      const m = p.needed_milestone_key;
      if (typeof m === 'string' && !BASE.has(m) && !dated.has(m)) {
        add(item, 'unknown_milestone', `"${m}" is not the key of a gate, milestone or handoff`, 'payload.needed_milestone_key');
      }
    }
    if (item.kind === 'gate') {
      if (!item.owner_role_key) add(item, 'gate_without_approver', 'The gate has no approver role', 'owner_role_key', 'warning');
      if (!items.some((c) => c.kind === 'gate_criterion' && payloadOf(c).gate_key === item.key)) {
        add(item, 'gate_without_criteria', 'The gate has no exit criteria', null, 'warning');
      }
    }
  }

  // 4. cycles among dated items (a gate's own payload offsets may refer to the gate itself: "2 days before my date")
  const edges = new Map<string, string[]>();
  for (const [key, item] of dated) {
    edges.set(
      key,
      anchorRefs(item)
        .filter((r) => dated.has(r.anchor) && !(r.field !== 'anchor' && r.anchor === key))
        .map((r) => r.anchor),
    );
  }
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = finished
  const inCycle = new Set<string>();
  const visit = (key: string, stack: string[]) => {
    state.set(key, 1);
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      if (state.get(next) === 1) for (const k of stack.slice(stack.indexOf(next))) inCycle.add(k);
      else if (!state.has(next)) visit(next, stack);
    }
    stack.pop();
    state.set(key, 2);
  };
  for (const key of dated.keys()) if (!state.has(key)) visit(key, []);
  for (const key of inCycle) add(dated.get(key)!, 'anchor_cycle', `The date of "${key}" depends on itself through its anchors`, 'anchor');

  if (roles.size === 0 && items.length > 0) add(null, 'no_roles', 'The template has no roles', null, 'warning');
  return problems;
}

export const errorsOf = (problems: readonly Problem[]) => problems.filter((p) => p.severity === 'error');

/** Identity of a problem, to tell which problems a change introduced. */
export const problemId = (p: Problem) => [p.code, p.kind, p.key, p.item_id, p.field, p.message].join('|');

/** "1.1" → "1.2", "v1.9" → "v1.10", "L v2" → "L v3", "beta" → "beta.1". */
export function bumpVersion(version: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(version);
  if (!m) return `${version}.1`;
  return `${m[1]}${Number(m[2]) + 1}${m[3]}`;
}

export interface ItemDiff {
  added: ItemLike[];
  removed: ItemLike[];
  changed: { kind: string; key: string; fields: string[]; before: ItemLike; after: ItemLike }[];
  unchanged: number;
}

function canonical(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const DIFF_FIELDS = ['name', 'owner_role_key', 'anchor', 'offset_value', 'offset_unit', 'condition', 'sort', 'payload'] as const;

/** Compares two item sets by (kind, key): what `current` added, removed or changed relative to `parent`. */
export function diffItems(parent: readonly ItemLike[], current: readonly ItemLike[]): ItemDiff {
  const id = (i: ItemLike) => `${i.kind}\u0000${i.key ?? ''}`;
  const before = new Map(parent.map((i) => [id(i), i]));
  const out: ItemDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const item of current) {
    const k = id(item);
    seen.add(k);
    const old = before.get(k);
    if (!old) {
      out.added.push(item);
      continue;
    }
    const fields = DIFF_FIELDS.filter(
      (f) => canonical((old as unknown as Record<string, unknown>)[f]) !== canonical((item as unknown as Record<string, unknown>)[f]),
    );
    if (fields.length > 0) out.changed.push({ kind: item.kind, key: item.key ?? '', fields: [...fields], before: old, after: item });
    else out.unchanged += 1;
  }
  for (const item of parent) if (!seen.has(id(item))) out.removed.push(item);
  return out;
}
