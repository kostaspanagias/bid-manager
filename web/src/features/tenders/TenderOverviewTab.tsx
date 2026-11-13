import { useTranslation } from 'react-i18next';
import { useTender } from '@/features/tenders/tenderContext';
import { EmptyState, PageHeader } from '@/ui';

/** STUB — owner: replace the body below. Rendered inside TenderLayout at /tenders/:tenderId/…; route already wired. */
export function TenderOverviewTab() {
  const { t } = useTranslation('tenders');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tender, tenderId, canWrite } = useTender();
  return (
    <>
      <PageHeader level={2} title={t('overview.title')} subtitle={t('overview.subtitle')} />
      <EmptyState title={t('common:stub.title')} description={t('common:stub.description')} />
    </>
  );
}
