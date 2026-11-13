import { useTranslation } from 'react-i18next';
import { enumLabel } from '@/lib/enums';
import { Badge, Button, Card } from '@/ui';
import type { Problem } from './templatesApi';

/** Greek text of one validation problem (by code), prefixed with the item it is about. */
export function ProblemText({ problem, withRef = true }: { problem: Problem; withRef?: boolean }) {
  const { t } = useTranslation('templates');
  const field = (problem.field ?? '').replace(/^payload\./, '');
  const text = t(`problems.${problem.code}`, { key: problem.key ?? '', field, defaultValue: problem.message });
  if (!withRef) return <>{text}</>;
  const ref = problem.kind ? `${enumLabel('template_item_kind', problem.kind)}${problem.key ? ` ${problem.key}` : ''}` : t('problems.general');
  return (
    <>
      <strong>{ref}:</strong> {text}
    </>
  );
}

interface ProblemsPanelProps {
  problems: Problem[];
  /** Opens the item a problem is about */
  onOpen?: (itemId: string) => void;
}

/** Result of GET /templates/:id/validate for a draft: errors block publishing, warnings do not. */
export function ProblemsPanel({ problems, onOpen }: ProblemsPanelProps) {
  const { t } = useTranslation('templates');
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;
  if (problems.length === 0) return null;
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return (
    <Card title={t('problems.title')} subtitle={t('problems.summary', { errors, warnings })} tone={errors > 0 ? 'red' : 'orange'} flush>
      <div>
        {sorted.map((p, i) => (
          <div key={i} className="tpl-problem">
            <Badge tone={p.severity === 'error' ? 'red' : 'orange'}>{t(`problems.${p.severity}`)}</Badge>
            <span>
              <ProblemText problem={p} />
            </span>
            {p.item_id && onOpen ? (
              <Button size="sm" variant="ghost" icon="edit" onClick={() => onOpen(p.item_id!)}>
                {t('problems.open')}
              </Button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
