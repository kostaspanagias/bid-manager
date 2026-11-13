import { useTranslation } from 'react-i18next';
import type { ID } from '@/api/types';
import { useUsers } from '@/features/shared/useUsers';
import { Select, type SelectProps } from '@/ui';
import type { RoleView } from './tasksApi';

/** An owner is a tender role OR a person — never both. */
export interface OwnerValue {
  owner_user_id: ID | null;
  owner_role_key: string | null;
}

export function roleName(roles: ReadonlyArray<RoleView>, key: string | null | undefined): string {
  if (!key) return '';
  return roles.find((r) => r.key === key)?.name ?? key;
}

/** «Τεχνική» for a role, the person's name for a user, '' when unassigned. */
export function useOwnerLabel(roles: ReadonlyArray<RoleView>) {
  const { nameOf } = useUsers();
  return (o: OwnerValue): string => (o.owner_user_id ? nameOf(o.owner_user_id) || '…' : roleName(roles, o.owner_role_key));
}

const encode = (o: OwnerValue) => (o.owner_user_id ? `user:${o.owner_user_id}` : o.owner_role_key ? `role:${o.owner_role_key}` : '');
const decode = (v: string): OwnerValue => ({
  owner_user_id: v.startsWith('user:') ? v.slice(5) : null,
  owner_role_key: v.startsWith('role:') ? v.slice(5) : null,
});

export interface OwnerSelectProps extends Omit<SelectProps, 'value' | 'onChange' | 'options' | 'children'> {
  value: OwnerValue;
  onChange: (value: OwnerValue) => void;
  roles: ReadonlyArray<RoleView>;
  /** Hide the people group (e.g. checklist lines are grouped by role) */
  rolesOnly?: boolean;
  emptyLabel?: string;
}

/** One dropdown with two groups: the tender's roles and the org's people. Use inside <Field>. */
export function OwnerSelect({ value, onChange, roles, rolesOnly, emptyLabel, ...rest }: OwnerSelectProps) {
  const { t } = useTranslation('tasks');
  const { users } = useUsers();
  const current = encode(value);
  const known = current === '' || roles.some((r) => `role:${r.key}` === current) || (!rolesOnly && users.some((u) => `user:${u.id}` === current));
  return (
    <Select {...rest} value={current} placeholder={emptyLabel ?? t('common:labels.unassigned')} onChange={(e) => onChange(decode(e.target.value))}>
      {!known && <option value={current}>{value.owner_role_key ?? '…'}</option>}
      {roles.length > 0 && (
        <optgroup label={t('owner.roles')}>
          {roles.map((r) => (
            <option key={r.key} value={`role:${r.key}`}>
              {r.name}
            </option>
          ))}
        </optgroup>
      )}
      {!rolesOnly && users.length > 0 && (
        <optgroup label={t('owner.people')}>
          {users.map((u) => (
            <option key={u.id} value={`user:${u.id}`}>
              {u.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}
