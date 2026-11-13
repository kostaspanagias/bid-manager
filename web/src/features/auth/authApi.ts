/**
 * Auth API adapter — the ONLY file that knows the request/response shapes of /api/auth/*.
 * The server was written in parallel; if a shape differs, fix it here and nothing else changes.
 *
 * Assumed contract:
 *   POST /api/auth/login          { email, password }        → { next: 'totp' | 'totp_setup' }
 *   POST /api/auth/totp           { code }                   → { ok: true }
 *   GET  /api/auth/totp/setup                                → { secret, otpauthUrl, qrDataUrl }
 *   POST /api/auth/totp/enable    { code }                   → { ok: true }
 *   POST /api/auth/accept-invite  { token, name, password }  → { ok: true }
 *   POST /api/auth/logout                                    → { ok: true } | 204
 *   GET  /api/auth/me   → { user: { id, email, name, org_role }, org: { id, name, timezone }, csrfToken } | 401
 *
 * Pre-session POSTs (login, totp, totp/enable, accept-invite) are sent without X-CSRF-Token because the token
 * only becomes available from /me after full login; logout sends it.
 */
import { api, isApiError } from '@/api/client';
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
  csrfToken: string;
}

export type LoginNext = 'totp' | 'totp_setup';

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  /** data:image/png;base64,… of the QR code */
  qrDataUrl: string;
}

/** Minimum password length shown/validated on the accept-invite form (server validates too). */
export const PASSWORD_MIN_LENGTH = 12;

const noRedirect = { skipAuthRedirect: true } as const;

export const authApi = {
  /** null when there is no (fully verified) session. */
  async me(): Promise<Me | null> {
    try {
      return await api.get<Me>('/auth/me', noRedirect);
    } catch (err) {
      if (isApiError(err) && err.status === 401) return null;
      throw err;
    }
  },

  async login(email: string, password: string): Promise<LoginNext> {
    const res = await api.post<{ next: LoginNext }>('/auth/login', { email, password }, noRedirect);
    return res.next === 'totp_setup' ? 'totp_setup' : 'totp';
  },

  async verifyTotp(code: string): Promise<void> {
    await api.post<{ ok: true }>('/auth/totp', { code }, noRedirect);
  },

  getTotpSetup(): Promise<TotpSetup> {
    return api.get<TotpSetup>('/auth/totp/setup', noRedirect);
  },

  async enableTotp(code: string): Promise<void> {
    await api.post<{ ok: true }>('/auth/totp/enable', { code }, noRedirect);
  },

  async acceptInvite(input: { token: string; name: string; password: string }): Promise<void> {
    await api.post<{ ok: true }>('/auth/accept-invite', input, noRedirect);
  },

  async logout(): Promise<void> {
    await api.post('/auth/logout', {}, noRedirect);
  },
};
