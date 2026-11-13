import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Banner } from '@/ui';
import type { AttentionItem, WarningCode } from './dashboardApi';
import { warningDetail } from './warnings';

/**
 * Red / orange banners aggregated across tenders: one banner per kind of warning, listing the tenders it
 * concerns, each linking straight to the tab where it is resolved.
 */
export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation('dashboard');
  if (items.length === 0) return null;
  // The server sends red first; keep that order while grouping by code.
  const groups = new Map<WarningCode, AttentionItem[]>();
  for (const item of items) groups.set(item.code, [...(groups.get(item.code) ?? []), item]);

  return (
    <section className="dash-attention" aria-label={t('attention.title')}>
      {[...groups.entries()].map(([code, group]) => (
        <Banner key={code} tone={group[0]!.tone} title={t(`warnings.${code}.title`)}>
          <ul className="dash-attention__list">
            {group.map((item) => {
              const detail = warningDetail(t, item);
              return (
                <li key={item.tenderId}>
                  <Link to={`/tenders/${item.tenderId}/${item.tab}`} className="dash-attention__link">
                    {item.tenderTitle}
                  </Link>
                  {detail && <span className="dash-attention__detail"> — {detail}</span>}
                </li>
              );
            })}
          </ul>
        </Banner>
      ))}
    </section>
  );
}
