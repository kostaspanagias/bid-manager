/**
 * Admin → users & invitations. API shape assumptions live here only.
 *
 *   GET    /api/admin/users            → { items: AdminUser[] }
 *   PATCH  /api/admin/users/:id        { org_role?, active? } → the updated user (body ignored by the UI)
 *                                      "deactivate" = PATCH { active: false }
 *   GET    /api/admin/invitations      → { items: Invitation[] }  (id, email, org_role, expires_at, accepted_at, created_at)
 *   POST   /api/admin/invitations      { email, org_role } → { invitation, inviteUrl } — the token exists in clear
 *                                      only in this response; also accepted: { token } / { invite_url } / { url }
 *   DELETE /api/admin/invitations/:id  → 204
 */
import { api, type ListResponse } from '@/api/client';
import type { ID, Invitation, OrgRole, Timestamp } from '@/api/types';

export interface AdminUser {
  id: ID;
  email: string;
  name: string;
  org_role: OrgRole;
  active: boolean;
  totp_enabled_at: Timestamp | null;
  last_login_at: Timestamp | null;
  created_at?: Timestamp;
}

export const adminUsersKeys = {
  users: ['admin', 'users'] as const,
  invitations: ['admin', 'invitations'] as const,
};

export function listAdminUsers(): Promise<AdminUser[]> {
  return api.get<ListResponse<AdminUser>>('/admin/users').then((r) => r.items);
}

export function updateAdminUser(id: ID, patch: { org_role?: OrgRole; active?: boolean }): Promise<unknown> {
  return api.patch(`/admin/users/${id}`, patch);
}

export function listInvitations(): Promise<Invitation[]> {
  return api.get<ListResponse<Invitation>>('/admin/invitations').then((r) => r.items);
}

export interface CreatedInvitation {
  email: string;
  /** Full link to send to the invitee; null if the server did not return a token/URL */
  inviteUrl: string | null;
}

export async function createInvitation(input: { email: string; org_role: OrgRole }): Promise<CreatedInvitation> {
  const raw = await api.post<Record<string, unknown>>('/admin/invitations', input);
  const nested = (raw.invitation ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const url = str(raw.inviteUrl) ?? str(raw.invite_url) ?? str(raw.url) ?? str(nested.inviteUrl) ?? str(nested.invite_url);
  const token = str(raw.token) ?? str(nested.token);
  let inviteUrl: string | null = null;
  if (url) inviteUrl = new URL(url, window.location.origin).toString();
  else if (token) inviteUrl = `${window.location.origin}/invite/${encodeURIComponent(token)}`;
  return { email: input.email, inviteUrl };
}

export function deleteInvitation(id: ID): Promise<void> {
  return api.del(`/admin/invitations/${id}`);
}

export type InvitationState = 'pending' | 'accepted' | 'expired';

export function invitationState(inv: Invitation, now = Date.now()): InvitationState {
  if (inv.accepted_at) return 'accepted';
  return new Date(inv.expires_at).getTime() < now ? 'expired' : 'pending';
}
