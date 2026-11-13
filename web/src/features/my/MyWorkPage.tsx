import { useTranslation } from 'react-i18next';
import { EmptyState, PageHeader } from '@/ui';

/** STUB — owner: replace the body below. Route is already wired in src/app/router.tsx. */
export function MyWorkPage() {
  const { t } = useTranslation('my');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <EmptyState title={t('common:stub.title')} description={t('common:stub.description')} />
    </>
  );
}
