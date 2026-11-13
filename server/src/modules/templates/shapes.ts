// Template item shapes — the shared contract of ARCHITECTURE.md ("Template item shapes"), as zod schemas per kind.
// Other slices may import the *types* for reference, but the contract is the table in ARCHITECTURE.md.
// Offsets are signed: anchor 'T' + offset_value −8 = T−8; 'T0' + 3 = T0+3; 'G0' + 2 = G0+2.
import { z } from 'zod';

export const ITEM_KINDS = ['role', 'gate', 'gate_criterion', 'milestone', 'handoff', 'task', 'checklist_item', 'watch_item'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const OFFSET_UNITS = ['working', 'calendar'] as const;
export const CONDITIONS = ['always', 'demo', 'partners'] as const;
export const DECISION_MODES = ['approval', 'go_no_go'] as const;
export const CRITERION_TYPES = ['manual', 'auto'] as const;
export const AUTO_RULES = ['exclusion_evidence_100', 'register_no_open', 'handoffs_received', 'guarantee_arrived', 'docs_valid_on_T'] as const;
export const ROLE_FOLDERS = ['participation', 'technical', 'financial'] as const;

/** Anchors that are not item keys. */
export const BASE_ANCHORS = ['T', 'T0'] as const;
/** Kinds that get a date of their own (they become `milestone` rows) and can therefore be anchors. */
export const ANCHOR_KINDS: ReadonlySet<string> = new Set(['gate', 'milestone', 'handoff']);

/** Item keys: short identifiers such as A, MGMT, G0, UPLOAD, guarantee, chk_3. */
export const zKey = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u, 'Keys start with a letter or digit and contain only letters, digits, "_", "-" and "."');
const zName = z.string().trim().min(1).max(500);
const zOffsetValue = z.number().int().min(-3650).max(3650);
const zOffsetUnit = z.enum(OFFSET_UNITS);

/** A relative date: anchor + signed offset. */
export const zOffset = z.object({ anchor: zKey, offset_value: zOffsetValue, offset_unit: zOffsetUnit });
export type Offset = z.infer<typeof zOffset>;

const common = {
  key: zKey,
  name: zName,
  condition: z.enum(CONDITIONS).default('always'),
  sort: z.number().int().min(-1_000_000).max(1_000_000).default(0),
};
const noOwner = { owner_role_key: z.null().default(null) };
const owner = { owner_role_key: zKey.nullable().default(null) };
const noOffset = { anchor: z.null().default(null), offset_value: z.null().default(null), offset_unit: z.null().default(null) };
const withOffset = { anchor: zKey, offset_value: zOffsetValue, offset_unit: zOffsetUnit };
const optionalOffset = {
  anchor: zKey.nullable().default(null),
  offset_value: zOffsetValue.nullable().default(null),
  offset_unit: zOffsetUnit.nullable().default(null),
};

// Payloads are loose objects: the documented fields are validated, unknown extras are kept (payload is the
// documented place for feature-specific extras).
const emptyPayload = z.looseObject({}).default({});

export const rolePayload = z
  .looseObject({ folder: z.enum(ROLE_FOLDERS).optional(), financial: z.boolean().optional(), management: z.boolean().optional() })
  .default({});

export const gatePayload = z.looseObject({
  decision_mode: z.enum(DECISION_MODES),
  target: zOffset.optional(),
  warn_if_target_after: zOffset.optional(),
  compressed: zOffset.optional(),
});

export const criterionPayload = z
  .looseObject({ gate_key: zKey, type: z.enum(CRITERION_TYPES), auto_rule: z.enum(AUTO_RULES).nullish() })
  .superRefine((p, ctx) => {
    if (p.type === 'auto' && !p.auto_rule) ctx.addIssue({ code: 'custom', path: ['auto_rule'], message: 'An automatic criterion needs auto_rule' });
    if (p.type === 'manual' && p.auto_rule) ctx.addIssue({ code: 'custom', path: ['auto_rule'], message: 'A manual criterion has no auto_rule' });
  });

export const handoffPayload = z.looseObject({ from_role: zKey, to_role: zKey });
export const taskPayload = z.looseObject({ description: z.string().max(5000).optional() }).default({});
export const watchPayload = z.looseObject({
  lead_value: z.number().int().min(0).max(3650).nullable(),
  lead_unit: zOffsetUnit,
  needed_milestone_key: zKey.optional(),
  checks: z.string().max(2000).optional(),
});

const allOrNothingOffset = (v: { anchor: unknown; offset_value: unknown; offset_unit: unknown }, ctx: z.RefinementCtx) => {
  const set = [v.anchor, v.offset_value, v.offset_unit].filter((x) => x !== null).length;
  if (set !== 0 && set !== 3) ctx.addIssue({ code: 'custom', path: ['anchor'], message: 'anchor, offset_value and offset_unit go together' });
};

/** One schema per kind: the full item (columns + payload) as stored in `template_item`. */
export const itemSchemas = {
  role: z.object({ kind: z.literal('role'), ...common, ...noOwner, ...noOffset, payload: rolePayload }),
  gate: z.object({ kind: z.literal('gate'), ...common, ...owner, ...withOffset, payload: gatePayload }),
  gate_criterion: z.object({ kind: z.literal('gate_criterion'), ...common, ...noOwner, ...noOffset, payload: criterionPayload }),
  milestone: z.object({ kind: z.literal('milestone'), ...common, ...noOwner, ...withOffset, payload: emptyPayload }),
  handoff: z.object({ kind: z.literal('handoff'), ...common, ...noOwner, ...withOffset, payload: handoffPayload }),
  task: z.object({ kind: z.literal('task'), ...common, ...owner, ...optionalOffset, payload: taskPayload }).superRefine(allOrNothingOffset),
  checklist_item: z.object({ kind: z.literal('checklist_item'), ...common, owner_role_key: zKey, ...noOffset, payload: emptyPayload }),
  watch_item: z.object({ kind: z.literal('watch_item'), ...common, ...owner, ...noOffset, payload: watchPayload }),
} as const;

export type RoleItem = z.infer<typeof itemSchemas.role>;
export type GateItem = z.infer<typeof itemSchemas.gate>;
export type GateCriterionItem = z.infer<typeof itemSchemas.gate_criterion>;
export type MilestoneItem = z.infer<typeof itemSchemas.milestone>;
export type HandoffItem = z.infer<typeof itemSchemas.handoff>;
export type TaskItem = z.infer<typeof itemSchemas.task>;
export type ChecklistItem = z.infer<typeof itemSchemas.checklist_item>;
export type WatchItem = z.infer<typeof itemSchemas.watch_item>;
export type TemplateItemShape = RoleItem | GateItem | GateCriterionItem | MilestoneItem | HandoffItem | TaskItem | ChecklistItem | WatchItem;

/** The columns of an item that the shapes cover (everything except ids and timestamps). */
export const ITEM_COLUMNS = ['kind', 'key', 'name', 'owner_role_key', 'offset_value', 'offset_unit', 'anchor', 'condition', 'sort', 'payload'] as const;

export function isItemKind(kind: unknown): kind is ItemKind {
  return typeof kind === 'string' && (ITEM_KINDS as readonly string[]).includes(kind);
}

/** Parses one item against the schema of its kind. */
export function parseItem(input: unknown) {
  const kind = (input as { kind?: unknown } | null)?.kind;
  if (!isItemKind(kind)) {
    return z.object({ kind: z.enum(ITEM_KINDS) }).safeParse(input) as unknown as z.ZodSafeParseResult<TemplateItemShape>;
  }
  return itemSchemas[kind].safeParse(input) as z.ZodSafeParseResult<TemplateItemShape>;
}
