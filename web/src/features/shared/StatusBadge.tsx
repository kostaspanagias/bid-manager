import { enumLabel, enumTone, type EnumGroup } from '@/lib/enums';
import { Badge } from '@/ui';

export interface StatusBadgeProps {
  /** Enum group, e.g. 'tender_status', 'requirement_status', 'gate_decision' */
  kind: EnumGroup;
  value: string | null | undefined;
  dot?: boolean;
}

/** Badge with the Greek label and the standard tone of an enum value. */
export function StatusBadge({ kind, value, dot }: StatusBadgeProps) {
  if (!value) return null;
  return (
    <Badge tone={enumTone(kind, value)} dot={dot}>
      {enumLabel(kind, value)}
    </Badge>
  );
}
