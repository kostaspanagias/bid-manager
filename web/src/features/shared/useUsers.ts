import { useQuery } from '@tanstack/react-query';
import { api, type ListResponse } from '@/api/client';
import type { ID, UserRef } from '@/api/types';

export const usersKeys = { all: ['users'] as const };

/** Assumed: GET /api/users → { items: [{ id, name, email, org_role }] } (active users of the org, any role may call). */
export function fetchUsers(): Promise<UserRef[]> {
  return api.get<ListResponse<UserRef>>('/users').then((r) => r.items);
}

/**
 * Org users for owner pickers and for showing names next to ids.
 *
 *   const { users, byId, nameOf } = useUsers();
 *   nameOf(task.owner_user_id)   // '' while loading / unknown
 */
export function useUsers() {
  const query = useQuery({ queryKey: usersKeys.all, queryFn: fetchUsers, staleTime: 5 * 60_000 });
  const users = query.data ?? [];
  const byId = new Map<ID, UserRef>(users.map((u) => [u.id, u]));
  const nameOf = (id: ID | null | undefined): string => (id ? (byId.get(id)?.name ?? '') : '');
  return { ...query, users, byId, nameOf };
}
