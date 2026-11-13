import { useTranslation } from 'react-i18next';
import { EmptyState, PageHeader } from '@/ui';

/** STUB — owner: replace the body below. Route is already wired in src/app/router.tsx. */
export function TemplateEditPage() {
  const { t } = useTranslation('templates');
  return (
    <>
      <PageHeader title={t('edit.title')} subtitle={t('edit.subtitle')} back={{ to: '/admin/templates', label: t('edit.back') }} />
      <EmptyState title={t('common:stub.title')} description={t('common:stub.description')} />
    </>
  );
}
