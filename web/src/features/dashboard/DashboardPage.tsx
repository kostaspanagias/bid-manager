import { useTranslation } from 'react-i18next';
import { EmptyState, PageHeader } from '@/ui';

/** STUB — owner: replace the body below. Route "/" is already wired in src/app/router.tsx. */
export function DashboardPage() {
  const { t } = useTranslation('dashboard');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <EmptyState icon="dashboard" title={t('stub.title')} description={t('stub.description')} />
    </>
  );
}
