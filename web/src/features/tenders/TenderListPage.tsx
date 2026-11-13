import { useTranslation } from 'react-i18next';
import { useAuth } from '@/features/auth/AuthProvider';
import { EmptyState, LinkButton, PageHeader } from '@/ui';

/** STUB — owner: replace the body below. Route "/tenders" is already wired in src/app/router.tsx. */
export function TenderListPage() {
  const { t } = useTranslation('tenders');
  const { hasRole } = useAuth();
  const canCreate = hasRole('admin', 'bid_manager');
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canCreate && (
            <LinkButton to="/tenders/new" variant="primary" icon="plus">
              {t('new')}
            </LinkButton>
          )
        }
      />
      <EmptyState icon="folder" title={t('list.stub.title')} description={t('list.stub.description')} />
    </>
  );
}
