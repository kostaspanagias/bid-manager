import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '@/app/BrandMark';
import './auth.css';

export interface AuthLayoutProps {
  title: string;
  subtitle?: ReactNode;
  /** Small line above the title (e.g. «Βήμα 2 από 2») */
  eyebrow?: string;
  children: ReactNode;
  /** Text/links under the card */
  footer?: ReactNode;
}

/** Centered card used by the pre-login screens. */
export function AuthLayout({ title, subtitle, eyebrow, children, footer }: AuthLayoutProps) {
  const { t } = useTranslation('auth');
  return (
    <div className="auth">
      <main className="auth__panel">
        <div className="auth__brand">
          <BrandMark size={32} />
          <div>
            <p className="auth__brand-name">{t('common:appName')}</p>
            <p className="auth__brand-tag">{t('tagline')}</p>
          </div>
        </div>
        <div className="auth__card">
          {eyebrow && <p className="auth__eyebrow">{eyebrow}</p>}
          <h1 className="auth__title">{title}</h1>
          {subtitle && <p className="auth__subtitle">{subtitle}</p>}
          <div className="auth__body">{children}</div>
        </div>
        {footer && <div className="auth__footer">{footer}</div>}
      </main>
    </div>
  );
}
