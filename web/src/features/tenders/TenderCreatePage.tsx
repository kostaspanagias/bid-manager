import { useTranslation } from 'react-i18next';
import { EmptyState, PageHeader } from '@/ui';

/** STUB — owner: replace the body below. Route is already wired in src/app/router.tsx. */
export function TenderCreatePage() {
  const { t } = useTranslation('tenders');
  return (
    <>
      <PageHeader title={t('create.title')} subtitle={t('create.subtitle')} back={{ to: '/tenders', label: t('title') }} />
      <EmptyState title={t('common:stub.title')} description={t('common:stub.description')} />
    </>
  );
}
