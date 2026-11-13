import { useTranslation } from 'react-i18next';
import type { ID, OrgRole, UserRef } from '@/api/types';
import { Select, type SelectProps } from '@/ui';
import { useUsers } from './useUsers';

export interface UserSelectProps extends Omit<SelectProps, 'value' | 'onChange' | 'options' | 'children'> {
  value: ID | null | undefined;
  /** null when the empty option is chosen */
  onChange: (userId: ID | null) => void;
  /** Label of the empty option. Default «Χωρίς υπεύθυνο». Pass `false` to remove the empty option. */
  emptyLabel?: string | false;
  /** Limit to these org roles (e.g. ['approver', 'admin'] for gate approvers) */
  roles?: ReadonlyArray<OrgRole>;
  /** Limit to an explicit list (e.g. tender members) instead of all org users */
  users?: ReadonlyArray<UserRef>;
}

/** Dropdown of org users. Use inside <Field label=…>. */
export function UserSelect({ value, onChange, emptyLabel, roles, users: explicit, disabled, ...rest }: UserSelectProps) {
  const { t } = useTranslation();
  const { users: all, isLoading } = useUsers();
  let list: ReadonlyArray<UserRef> = explicit ?? all;
  if (roles) list = list.filter((u) => roles.includes(u.org_role));
  // Keep a selected user visible even if filtered out (e.g. deactivated since).
  const missing = value && !list.some((u) => u.id === value) ? value : null;
  return (
    <Select
      {...rest}
      value={value ?? ''}
      disabled={disabled || (isLoading && !explicit)}
      placeholder={emptyLabel === false ? undefined : (emptyLabel ?? t('common:labels.unassigned'))}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {missing && <option value={missing}>{all.find((u) => u.id === missing)?.name ?? '…'}</option>}
      {list.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </Select>
  );
}
