/**
 * Auth API adapter — the ONLY file that knows the request/response shapes of /api/auth/*.
 * Reconciled with server/src/core/authRoutes.ts; the older `next` field name is still accepted.
 *
 *   POST /api/auth/login          { email, password }        → { stage: 'totp' | 'totp_setup', csrfToken }   (401 invalid_credentials)
 *   POST /api/auth/totp           { code }                   → the /me body (new csrfToken)                  (401 invalid_code)
 *   GET  /api/auth/totp/setup                                → { secret, otpauthUrl, qrDataUrl }
 *   POST /api/auth/totp/enable    { code }                   → the /me body (new csrfToken)
 *   POST /api/auth/invite-info    { token }                  → { email, org_role, org_name }                 (404 invitation_invalid)
 *   POST /api/auth/accept-invite  { token, name, password }  → 201 { ok: true, email }
 *   POST /api/auth/logout         (X-CSRF-Token)             → 204
 *   GET  /api/auth/me   → { stage: 'ready', user: { id, email, name, org_role }, org: { id, name, timezone }, csrfToken }
 *                       | { stage: 'totp' | 'totp_setup', csrfToken }   (password ok, second step pending)
 *                       | 401 (no session)
 *
 * Every response that carries a csrfToken updates the client's token, so the pre-login POSTs and logout send it.
 */
import { api, isApiError, setCsrfToken } from '@/api/client';
import type { ID, OrgRole } from '@/api/types';

export interface AuthUser {
  id: ID;
  email: string;
  name: string;
  org_role: OrgRole;
}

export interface AuthOrg {
  id: ID;
  name: string;
  timezone: string;
}

export interface Me {
  user: AuthUser;
  org: AuthOrg;
}

export type LoginNext = 'totp' | 'totp_setup';

/** What GET /api/auth/me says about the browser's session. */
export type Session = { status: 'ready'; me: Me } | { status: 'pending'; next: LoginNext } | { status: 'none' };

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  /** data: URL of the QR code image */
  qrDataUrl: string;
}

export interface InviteInfo {
  email: string;
  org_role: OrgRole;
  org_name: string;
}

/** Minimum password length shown/validated on the accept-invite form (server: MIN_PASSWORD_LENGTH). */
export const PASSWORD_MIN_LENGTH = 12;

interface RawSession {
  stage?: string;
  next?: string;
  user?: AuthUser;
  org?: AuthOrg;
  csrfToken?: string;
}

const noRedirect = { skipAuthRedirect: true } as const;

function readSession(raw: RawSession | undefined): Session {
  if (raw?.csrfToken) setCsrfToken(raw.csrfToken);
  if (raw?.user && raw.org) return { status: 'ready', me: { user: raw.user, org: raw.org } };
  const next = raw?.stage ?? raw?.next;
  if (next === 'totp' || next === 'totp_setup') return { status: 'pending', next };
  return { status: 'none' };
}

export const authApi = {
  async session(): Promise<Session> {
    try {
      return readSession(await api.get<RawSession>('/auth/me', noRedirect));
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        setCsrfToken(null);
        return { status: 'none' };
      }
      throw err;
    }
  },

  async login(email: string, password: string): Promise<LoginNext> {
    const session = readSession(await api.post<RawSession>('/auth/login', { email, password }, noRedirect));
    return session.status === 'pending' ? session.next : 'totp';
  },

  async verifyTotp(code: string): Promise<void> {
    readSession(await api.post<RawSession>('/auth/totp', { code }, noRedirect));
  },

  getTotpSetup(): Promise<TotpSetup> {
    return api.get<TotpSetup>('/auth/totp/setup', noRedirect);
  },

  async enableTotp(code: string): Promise<void> {
    readSession(await api.post<RawSession>('/auth/totp/enable', { code }, noRedirect));
  },

  inviteInfo(token: string): Promise<InviteInfo> {
    return api.post<InviteInfo>('/auth/invite-info', { token }, noRedirect);
  },

  /** Returns the invited e-mail when the server reports it (to prefill the login form). */
  async acceptInvite(input: { token: string; name: string; password: string }): Promise<{ email: string | null }> {
    const res = await api.post<{ ok?: boolean; email?: string } | undefined>('/auth/accept-invite', input, noRedirect);
    return { email: res?.email ?? null };
  },

  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout', {}, noRedirect);
    } finally {
      setCsrfToken(null);
    }
  },
};
