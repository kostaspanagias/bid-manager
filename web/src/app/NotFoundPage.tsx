import { useTranslation } from 'react-i18next';
import { EmptyState, LinkButton } from '@/ui';

/** 404 inside the shell (or standalone when rendered by the router's errorElement). */
export function NotFoundPage({ standalone }: { standalone?: boolean }) {
  const { t } = useTranslation();
  const body = (
    <EmptyState
      icon="search"
      title={t('common:errors.notFoundTitle')}
      description={t('common:errors.notFoundDescription')}
      action={
        <LinkButton to="/" variant="primary">
          {t('common:errors.goHome')}
        </LinkButton>
      }
    />
  );
  return standalone ? <div style={{ padding: 'var(--sp-8) var(--sp-4)' }}>{body}</div> : body;
}
