import { useTranslation } from 'react-i18next';
import { Badge } from '@/ui';
import type { CompanyDocumentView } from './documentsApi';

/** σε ισχύ / λήγει σε n ημέρες / έληξε (R15) — green / orange / red, always with text. */
export function DocumentStatusBadge({ doc }: { doc: Pick<CompanyDocumentView, 'status' | 'days_to_expiry' | 'archived_at'> }) {
  const { t } = useTranslation('documents');
  if (doc.archived_at) return <Badge>{t('status.archived')}</Badge>;
  if (doc.status === 'expired') {
    return (
      <Badge tone="red" dot>
        {t('status.expired')}
      </Badge>
    );
  }
  if (doc.status === 'expiring') {
    return (
      <Badge tone="orange" dot>
        {doc.days_to_expiry === 0 ? t('status.expiringToday') : t('status.expiring', { count: doc.days_to_expiry ?? 0 })}
      </Badge>
    );
  }
  return (
    <Badge tone="green" dot>
      {doc.days_to_expiry === null ? t('status.noExpiry') : t('status.valid')}
    </Badge>
  );
}
