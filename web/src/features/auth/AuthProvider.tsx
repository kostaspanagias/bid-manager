import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setUnauthorizedHandler } from '@/api/client';
import type { OrgRole } from '@/api/types';
import { authApi, type AuthOrg, type AuthUser, type LoginNext, type Me, type Session } from './authApi';

export const ME_KEY = ['auth', 'me'] as const;

export interface AuthContextValue {
  /** 'loading' until the first GET /api/auth/me settles */
  status: 'loading' | 'authenticated' | 'anonymous';
  user: AuthUser | null;
  org: AuthOrg | null;
  /** hasRole('admin', 'bid_manager') — true if the user's org role is one of the given */
  hasRole: (...roles: OrgRole[]) => boolean;
  /** Shorthand for hasRole('admin') */
  isAdmin: boolean;
  /** Not a viewer (UI hint only — the server enforces permissions) */
  canEdit: boolean;
  /** Password accepted but the TOTP step is still open (e.g. the page was reloaded mid-login) */
  pendingStep: LoginNext | null;
  /** True after the session ended on its own (401 while logged in), until the next login */
  sessionExpired: boolean;
  /** Re-reads /api/auth/me (call after completing login) */
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [sessionExpired, setSessionExpired] = useState(false);

  const query = useQuery({
    queryKey: ME_KEY,
    queryFn: authApi.session, // also hands the CSRF token to the API client before dependent queries run
    staleTime: 5 * 60_000,
    retry: false,
  });

  const dropData = useCallback(() => {
    // Everything except the session query — the next user must not see cached data.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  }, [queryClient]);

  // Any 401 from a non-auth endpoint means the session ended (inactivity timeout, logout elsewhere).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const wasLoggedIn = queryClient.getQueryData<Session>(ME_KEY)?.status === 'ready';
      queryClient.setQueryData<Session>(ME_KEY, { status: 'none' });
      if (wasLoggedIn) setSessionExpired(true);
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  const refresh = useCallback(async () => {
    const session = await queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: authApi.session, staleTime: 0 });
    if (session.status === 'ready') {
      setSessionExpired(false);
      dropData();
      return session.me;
    }
    return null;
  }, [queryClient, dropData]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setSessionExpired(false);
      queryClient.setQueryData<Session>(ME_KEY, { status: 'none' });
      dropData();
    }
  }, [queryClient, dropData]);

  const session = query.data;
  const me = session?.status === 'ready' ? session.me : null;
  const pendingStep = session?.status === 'pending' ? session.next : null;
  const value = useMemo<AuthContextValue>(() => {
    const role = me?.user.org_role;
    return {
      status: query.isPending ? 'loading' : me ? 'authenticated' : 'anonymous',
      user: me?.user ?? null,
      org: me?.org ?? null,
      hasRole: (...roles) => Boolean(role && roles.includes(role)),
      isAdmin: role === 'admin',
      canEdit: Boolean(role && role !== 'viewer'),
      pendingStep,
      sessionExpired,
      refresh,
      logout,
    };
  }, [me, pendingStep, query.isPending, sessionExpired, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * const { user, org, hasRole, isAdmin, logout } = useAuth();
 * Inside the app shell `user` and `org` are always set (the route guard redirects otherwise).
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For pages behind the route guard: user/org typed as non-null. */
export function useCurrentUser(): { user: AuthUser; org: AuthOrg } {
  const { user, org } = useAuth();
  if (!user || !org) throw new Error('useCurrentUser used outside the authenticated shell');
  return { user, org };
}
