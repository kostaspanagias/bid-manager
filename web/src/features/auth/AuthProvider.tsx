import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setCsrfToken, setUnauthorizedHandler } from '@/api/client';
import type { OrgRole } from '@/api/types';
import { authApi, type AuthOrg, type AuthUser, type Me } from './authApi';

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
    queryFn: async () => {
      const me = await authApi.me();
      setCsrfToken(me?.csrfToken ?? null); // before any dependent query/mutation can run
      return me;
    },
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
      const wasLoggedIn = Boolean(queryClient.getQueryData<Me | null>(ME_KEY));
      setCsrfToken(null);
      queryClient.setQueryData(ME_KEY, null);
      if (wasLoggedIn) setSessionExpired(true);
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  const refresh = useCallback(async () => {
    const me = await queryClient.fetchQuery({
      queryKey: ME_KEY,
      queryFn: async () => {
        const res = await authApi.me();
        setCsrfToken(res?.csrfToken ?? null);
        return res;
      },
      staleTime: 0,
    });
    if (me) {
      setSessionExpired(false);
      dropData();
    }
    return me;
  }, [queryClient, dropData]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setCsrfToken(null);
      setSessionExpired(false);
      queryClient.setQueryData(ME_KEY, null);
      dropData();
    }
  }, [queryClient, dropData]);

  const me = query.data ?? null;
  const value = useMemo<AuthContextValue>(() => {
    const role = me?.user.org_role;
    return {
      status: query.isPending ? 'loading' : me ? 'authenticated' : 'anonymous',
      user: me?.user ?? null,
      org: me?.org ?? null,
      hasRole: (...roles) => Boolean(role && roles.includes(role)),
      isAdmin: role === 'admin',
      canEdit: Boolean(role && role !== 'viewer'),
      sessionExpired,
      refresh,
      logout,
    };
  }, [me, query.isPending, sessionExpired, refresh, logout]);

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
