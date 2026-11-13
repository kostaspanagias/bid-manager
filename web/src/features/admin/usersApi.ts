/**
 * Admin → users & invitations. API shape assumptions live here only (reconciled with server/src/modules/admin).
 *
 *   GET    /api/admin/users                 → { items: [{ id, email, name, org_role, active, totp_enabled, last_login_at, created_at }] }
 *   PATCH  /api/admin/users/:id             { org_role?, active?, name? } → the user. "deactivate" = { active: false }
 *                                           422 self_change / last_admin
 *   POST   /api/admin/users/:id/reset-totp  → the user (2FA cleared, sessions ended)
 *   POST   /api/admin/users/:id/reset-password → 201 { user, resetUrl, expiresInHours, emailSent } (link shown once;
 *                                           password dead and sessions ended at once; 422 user_inactive)
 *   GET    /api/admin/invitations           → { items: [{ id, email, org_role, status, expires_at, accepted_at, created_at }] }
 *   POST   /api/admin/invitations           { email, org_role } → 201 { invitation, token, acceptUrl, emailSent }
 *                                           (token in clear only here; 409 user_exists)
 *   DELETE /api/admin/invitations/:id       → 204 (409 invitation_accepted)
 */
import { api, type ListResponse } from '@/api/client';
import type { ID, Invitation, OrgRole, Timestamp } from '@/api/types';

export interface AdminUser {
  id: ID;
  email: string;
  name: string;
  org_role: OrgRole;
  active: boolean;
  totp_enabled: boolean;
  last_login_at: Timestamp | null;
  created_at?: Timestamp;
}

export const adminUsersKeys = {
  users: ['admin', 'users'] as const,
  invitations: ['admin', 'invitations'] as const,
};

type RawAdminUser = Omit<AdminUser, 'totp_enabled'> & { totp_enabled?: boolean; totp_enabled_at?: Timestamp | null };

export async function listAdminUsers(): Promise<AdminUser[]> {
  const res = await api.get<ListResponse<RawAdminUser>>('/admin/users');
  // Accept either the boolean or the raw timestamp column.
  return res.items.map((u) => ({ ...u, totp_enabled: u.totp_enabled ?? Boolean(u.totp_enabled_at) }));
}

/** Lost authenticator: the user enrols TOTP again at the next login. */
export function resetUserTotp(id: ID): Promise<unknown> {
  return api.post(`/admin/users/${id}/reset-totp`);
}

export interface PasswordResetLink {
  email: string;
  /** Single-use link on the origin the admin is using right now */
  resetUrl: string;
  expiresInHours: number;
  emailSent: boolean;
}

/** Forgotten password: issues a single-use set-password link. No password is ever shown or e-mailed. */
export async function resetUserPassword(user: AdminUser): Promise<PasswordResetLink> {
  const raw = await api.post<{ resetUrl: string; expiresInHours: number; emailSent: boolean }>(`/admin/users/${user.id}/reset-password`);
  const token = raw.resetUrl.split('/reset/')[1] ?? '';
  return {
    email: user.email,
    resetUrl: token ? `${window.location.origin}/reset/${token}` : raw.resetUrl,
    expiresInHours: raw.expiresInHours,
    emailSent: raw.emailSent,
  };
}

export function updateAdminUser(id: ID, patch: { org_role?: OrgRole; active?: boolean }): Promise<unknown> {
  return api.patch(`/admin/users/${id}`, patch);
}

export function listInvitations(): Promise<Invitation[]> {
  return api.get<ListResponse<Invitation>>('/admin/invitations').then((r) => r.items);
}

export interface CreatedInvitation {
  email: string;
  /** Full link to give to the invitee; null if the server did not return a token/URL */
  inviteUrl: string | null;
  /** Whether the server e-mailed the link (null = it did not say) */
  emailSent: boolean | null;
}

export async function createInvitation(input: { email: string; org_role: OrgRole }): Promise<CreatedInvitation> {
  const raw = await api.post<Record<string, unknown>>('/admin/invitations', input);
  const nested = (raw.invitation ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const token = str(raw.token) ?? str(nested.token);
  const url = str(raw.acceptUrl) ?? str(raw.inviteUrl) ?? str(raw.invite_url) ?? str(raw.url);
  // Prefer a link on the origin the admin is using right now (the server's APP_URL may differ in dev).
  let inviteUrl: string | null = null;
  if (token) inviteUrl = `${window.location.origin}/invite/${encodeURIComponent(token)}`;
  else if (url) inviteUrl = new URL(url, window.location.origin).toString();
  return { email: input.email, inviteUrl, emailSent: typeof raw.emailSent === 'boolean' ? raw.emailSent : null };
}

export function deleteInvitation(id: ID): Promise<void> {
  return api.del(`/admin/invitations/${id}`);
}

export type InvitationState = 'pending' | 'accepted' | 'expired';

export function invitationState(inv: Invitation, now = Date.now()): InvitationState {
  if (inv.accepted_at) return 'accepted';
  return new Date(inv.expires_at).getTime() < now ? 'expired' : 'pending';
}
