import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { cx } from '@/lib/cx';
import { enumLabel } from '@/lib/enums';
import { Icon, Menu, useToast } from '@/ui';
import { BrandMark } from './BrandMark';
import { ErrorBoundary } from './ErrorBoundary';
import { NAV } from './nav';
import './app.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

/** Authenticated shell: sidebar navigation (drawer on small screens), user menu, page outlet. */
export function AppLayout() {
  const { t } = useTranslation('nav');
  const { user, org, hasRole, logout } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer after navigating, and on Esc.
  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (!user) return null;

  // The session query is cleared either way; the route guard then redirects to /login.
  const doLogout = () => logout().catch((err) => toast.error(errorMessage(err)));

  const userMenu = (variant: 'sidebar' | 'topbar') => (
    <Menu
      label={t('userMenu')}
      align={variant === 'sidebar' ? 'start' : 'end'}
      side={variant === 'sidebar' ? 'top' : 'bottom'}
      triggerClassName={variant === 'sidebar' ? 'app-user' : 'app-user app-user--compact'}
      trigger={
        <>
          <span className="app-user__avatar" aria-hidden>
            {initials(user.name)}
          </span>
          {variant === 'sidebar' && (
            <>
              <span className="app-user__text">
                <span className="app-user__name">{user.name}</span>
                <span className="app-user__role">{enumLabel('org_role', user.org_role)}</span>
              </span>
              <Icon name="chevronDown" size={14} />
            </>
          )}
        </>
      }
      header={
        <div className="app-user__card">
          <strong>{user.name}</strong>
          <span>{user.email}</span>
          <span>
            {enumLabel('org_role', user.org_role)}
            {org ? ` · ${org.name}` : ''}
          </span>
        </div>
      }
      items={[
        { label: t('my'), icon: 'inbox', to: '/my' },
        { label: t('auth:logout'), icon: 'logout', onSelect: doLogout, separatorBefore: true },
      ]}
    />
  );

  return (
    <div className="app">
      <a className="app-skip" href="#main">
        {t('skipToContent')}
      </a>

      <header className="app-topbar">
        <button
          type="button"
          className="app-topbar__btn"
          aria-label={navOpen ? t('closeMenu') : t('openMenu')}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((o) => !o)}
        >
          <Icon name={navOpen ? 'close' : 'menu'} size={20} />
        </button>
        <Link to="/" className="app-brand">
          <BrandMark size={24} />
          <span>{t('common:appName')}</span>
        </Link>
        {userMenu('topbar')}
      </header>

      {navOpen && <div className="app-scrim" onClick={() => setNavOpen(false)} aria-hidden />}

      <aside id="app-sidebar" className={cx('app-sidebar', navOpen && 'is-open')}>
        <Link to="/" className="app-brand app-sidebar__brand">
          <BrandMark />
          <span>
            {t('common:appName')}
            {org && <small>{org.name}</small>}
          </span>
        </Link>
        <nav className="app-nav" aria-label={t('main')}>
          {NAV.filter((g) => !g.roles || hasRole(...g.roles)).map((group, i) => (
            <div key={group.labelKey ?? i} className="app-nav__group">
              {group.labelKey && <p className="app-nav__heading">{t(group.labelKey)}</p>}
              <ul>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} className={({ isActive }) => cx('app-nav__link', isActive && 'is-active')}>
                      <Icon name={item.icon} />
                      <span>{t(item.labelKey)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="app-sidebar__user">{userMenu('sidebar')}</div>
      </aside>

      <main id="main" className="app-content" tabIndex={-1}>
        <div className="app-content__inner">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
