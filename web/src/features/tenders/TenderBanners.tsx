import { useTranslation } from 'react-i18next';
import { formatDate } from '@/lib/dates';
import { Banner, LinkButton } from '@/ui';
import type { TenderWarning } from './tenderApi';
import { useTender } from './tenderContext';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** One server warning as a Banner. Texts come from `tenders:warnings.<code>`; unknown codes show the server message. */
export function WarningBanner({ warning, tenderId }: { warning: TenderWarning; tenderId?: string }) {
  const { t } = useTranslation('tenders');
  const d = warning.data ?? {};
  const link = (to: string, label: string) =>
    tenderId ? (
      <LinkButton size="sm" to={`/tenders/${tenderId}/${to}`}>
        {label}
      </LinkButton>
    ) : undefined;

  switch (warning.code) {
    case 'compressed_mode':
      return (
        <Banner tone="orange" title={t('warnings.compressed_mode.title')} actions={link('schedule', t('warnings.openSchedule'))}>
          {t('warnings.compressed_mode.body', { count: num(d.workingDays) })}
        </Banner>
      );
    case 'guarantee_at_risk':
      return (
        <Banner tone="red" title={t('warnings.guarantee_at_risk.title')} actions={link('watch', t('warnings.openWatch'))}>
          {t('warnings.guarantee_at_risk.body', { count: num(d.workingDays) })}
        </Banner>
      );
    case 'gate_target_late':
      return (
        <Banner tone="orange" title={t('warnings.gate_target_late.title', { key: str(d.key) })} actions={link('schedule', t('warnings.openSchedule'))}>
          {t('warnings.gate_target_late.body', {
            key: str(d.key),
            target: formatDate(str(d.target)),
            recommended: formatDate(str(d.recommended)),
            latest: formatDate(str(d.latest)),
          })}
        </Banner>
      );
    case 'guarantee_validity_short':
      return (
        <Banner tone="orange" title={t('warnings.guarantee_validity_short.title')}>
          {t('warnings.guarantee_validity_short.body', {
            validUntil: formatDate(str(d.validUntil)),
            requiredUntil: formatDate(str(d.requiredUntil)),
            count: num(d.shortByDays),
          })}
        </Banner>
      );
    case 'documents_expired_on_T': {
      const docs = Array.isArray(d.documents) ? (d.documents as Array<{ id: string; title: string; expires_at: string }>) : [];
      return (
        <Banner tone="red" title={t('warnings.documents_expired_on_T.title', { count: num(d.count) })} actions={link('documents', t('warnings.openDocuments'))}>
          {docs.map((doc) => `${doc.title} (${formatDate(doc.expires_at)})`).join(' · ')}
        </Banner>
      );
    }
    default:
      return <Banner tone={warning.severity === 'red' ? 'red' : 'orange'}>{warning.message}</Banner>;
  }
}

/**
 * Slot between the tender header and the tabs, on every tab: the server-computed warnings of the tender —
 * red first (R8 guarantee, R15 documents), then orange (R8 compressed mode, R7 late G0 target, R16 guarantee validity).
 */
export function TenderBanners() {
  const { warnings, tenderId } = useTender();
  if (warnings.length === 0) return null;
  const ordered = [...warnings].sort((a, b) => Number(b.severity === 'red') - Number(a.severity === 'red'));
  return (
    <>
      {ordered.map((w, i) => (
        <WarningBanner key={`${w.code}-${i}`} warning={w} tenderId={tenderId} />
      ))}
    </>
  );
}
