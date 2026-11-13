import { useTranslation } from 'react-i18next';
import type { RequirementType } from '@/api/types';
import { Card, Icon, ProgressBar } from '@/ui';
import type { RegisterCoverage } from './requirementsApi';

const TYPES: RequirementType[] = ['exclusion', 'scored', 'formal'];

/** R17 coverage per type. Exclusion requirements without evidence are called out in red: they block G1. */
export function CoverageHeader({ coverage, onShowMissingEvidence }: { coverage: RegisterCoverage; onShowMissingEvidence: () => void }) {
  const { t } = useTranslation('requirements');
  const missing = coverage.exclusionWithoutEvidence;
  return (
    <Card as="section" tone={missing > 0 ? 'red' : undefined}>
      <h3 className="reg-coverage__title">
        {t('coverage.title')} <span>{t('coverage.hint')}</span>
      </h3>
      <div className="reg-coverage">
        {TYPES.map((type) => {
          const c = coverage[type];
          const pct = c.total > 0 ? Math.floor((c.covered / c.total) * 100 + 1e-9) : 0;
          return (
            <div key={type} className="reg-coverage__item">
              <ProgressBar
                label={t(`coverage.${type}`)}
                value={c.covered}
                max={c.total || 1}
                tone={c.total === 0 ? 'neutral' : 'auto'}
                valueText={c.total === 0 ? t('coverage.noRows') : t('coverage.value', { covered: c.covered, total: c.total, pct })}
              />
              {type === 'exclusion' &&
                c.total > 0 &&
                (missing > 0 ? (
                  <button type="button" className="reg-coverage__alert" onClick={onShowMissingEvidence}>
                    <Icon name="block" />
                    {t('coverage.missingEvidence', { count: missing })} · {t('actions.showMissingEvidence')}
                  </button>
                ) : (
                  <p className="reg-coverage__note">{t('coverage.allEvidence')}</p>
                ))}
            </div>
          );
        })}
      </div>
      <p className="reg-coverage__facts">
        <span>
          {t('coverage.total')}: <strong>{coverage.all.total}</strong>
        </span>
        <span>
          {t('coverage.open')}: <strong>{coverage.open}</strong>
        </span>
        <span>
          {t('coverage.deviations')}: <strong>{coverage.deviations}</strong>
        </span>
      </p>
    </Card>
  );
}
