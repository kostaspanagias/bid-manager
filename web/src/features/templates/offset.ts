/** Offsets as people write them: «T−8 εργάσιμες», «G0+2 εργάσιμες», «T0+3 ημερολογιακές», «T» (offset 0). */
import i18n from '@/i18n';
import type { OffsetValue } from './templatesApi';

/** «T−8», «G0+2», «T» — the compact expression, with a real minus sign. */
export function offsetExpr(o: { anchor: string | null; offset_value: number | null }): string {
  if (!o.anchor) return '';
  const n = o.offset_value ?? 0;
  if (n === 0) return o.anchor;
  return `${o.anchor}${n < 0 ? '−' : '+'}${Math.abs(n)}`;
}

/** «T−8 εργάσιμες» — expression plus unit (no unit for offset 0). */
export function formatOffset(o: { anchor: string | null; offset_value: number | null; offset_unit: string | null } | null | undefined): string {
  if (!o || !o.anchor) return '';
  const expr = offsetExpr(o);
  const n = Math.abs(o.offset_value ?? 0);
  if (n === 0 || !o.offset_unit) return expr;
  return `${expr} ${i18n.t(`templates:unit.${o.offset_unit}`, { count: n })}`;
}

export function isOffset(v: unknown): v is OffsetValue {
  return !!v && typeof v === 'object' && typeof (v as OffsetValue).anchor === 'string' && typeof (v as OffsetValue).offset_value === 'number';
}
