import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { OrgRole } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import type { LoginLocationState } from '@/features/auth/LoginPage';
import { EmptyState, LinkButton, PageSpinner } from '@/ui';

/** Route guard: renders children only with a fully logged-in session, else redirects to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation('auth');
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <PageSpinner label={t('checking')} />;
  if (!auth.user) {
    // After a deliberate logout the next login starts at the dashboard, not where the previous user was.
    const state: LoginLocationState = auth.loggedOut
      ? { notice: 'loggedOut' }
      : { from: location.pathname + location.search, notice: auth.sessionExpired ? 'expired' : undefined };
    return <Navigate to="/login" replace state={state} />;
  }
  return <>{children}</>;
}

/** Layout route for role-restricted sections: <Route element={<RequireRole roles={['admin']} />}>…</Route>. */
export function RequireRole({ roles }: { roles: OrgRole[] }) {
  const { t } = useTranslation();
  const { hasRole } = useAuth();
  if (!hasRole(...roles)) {
    return (
      <EmptyState
        icon="lock"
        title={t('common:errors.forbiddenTitle')}
        description={t('common:errors.forbiddenDescription')}
        action={<LinkButton to="/">{t('common:errors.goHome')}</LinkButton>}
      />
    );
  }
  return <Outlet />;
}
