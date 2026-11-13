import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icons';

export type BannerTone = 'red' | 'orange' | 'info' | 'green';

export interface BannerProps {
  /** red = blocking (role=alert), orange = warning, info, green = confirmation */
  tone?: BannerTone;
  /** Bold first line */
  title?: ReactNode;
  /** Explanation / details */
  children?: ReactNode;
  /** Buttons or links on the right (below on phones) */
  actions?: ReactNode;
  /** Shows a close button */
  onDismiss?: () => void;
  className?: string;
}

const ICONS: Record<BannerTone, IconName> = { red: 'block', orange: 'alert', info: 'info', green: 'checkCircle' };

/** Page- or section-level message (compressed mode, expired documents, session notices…). */
export function Banner({ tone = 'info', title, children, actions, onDismiss, className }: BannerProps) {
  const { t } = useTranslation();
  return (
    <div className={cx('ui-banner', `ui-tone-${tone}`, className)} role={tone === 'red' ? 'alert' : 'status'}>
      <Icon name={ICONS[tone]} size={18} className="ui-banner__icon" />
      <div className="ui-banner__body">
        {title && <p className="ui-banner__title">{title}</p>}
        {children && <div className="ui-banner__text">{children}</div>}
      </div>
      {actions && <div className="ui-banner__actions">{actions}</div>}
      {onDismiss && (
        <button type="button" className="ui-banner__close" onClick={onDismiss} aria-label={t('common:actions.close')}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
