import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/client';
import type { GateDecision, ID } from '@/api/types';
import { UserSelect } from '@/features/shared/UserSelect';
import { useUsers } from '@/features/shared/useUsers';
import { tenderKeys } from '@/features/tenders/tenderApi';
import { useTender } from '@/features/tenders/tenderContext';
import { cx } from '@/lib/cx';
import { enumLabel } from '@/lib/enums';
import { Banner, Button, Checkbox, Field, Modal, Textarea, useToast } from '@/ui';
import { decideGate, MIN_JUSTIFICATION, reopenGate, setApprover, setCriterion, type GateCriterionView, type GateView } from './gatesApi';

interface DialogProps {
  gate: GateView;
  onClose: () => void;
  onSaved: (gate: GateView) => void;
}

/** R11: bid_manager / admin pick who decides the gate. */
export function ApproverDialog({ gate, onClose, onSaved }: DialogProps) {
  const { t } = useTranslation('gates');
  const { tenderId } = useTender();
  const { users } = useUsers();
  const toast = useToast();
  const [userId, setUserId] = useState<ID | null>(gate.approver_user_id);

  const save = useMutation({
    mutationFn: () => setApprover(tenderId, gate.id, userId),
    onSuccess: (g) => {
      onSaved(g);
      toast.success(t('approver.saved'));
      onClose();
    },
  });
  const changed = userId !== gate.approver_user_id;

  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={t('approver.title', { name: gate.name })}
      description={t('approver.hint')}
      onSubmit={() => (changed ? save.mutate() : onClose())}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        {save.isError && <Banner tone="red">{errorMessage(save.error)}</Banner>}
        <Field label={t('approver.label')} hint={gate.approver_role_key ? t('approver.roleHint', { role: gate.approver_role_key }) : undefined}>
          <UserSelect value={userId} onChange={setUserId} emptyLabel={t('approver.none')} users={users.filter((u) => u.org_role !== 'viewer')} />
        </Field>
        {changed && gate.requested_at && <Banner tone="orange">{t('approver.clearsRequest')}</Banner>}
      </div>
    </Modal>
  );
}

/** Optional note on a manual criterion. */
export function NoteDialog({ gate, criterion, onClose, onSaved }: DialogProps & { criterion: GateCriterionView | undefined }) {
  const { t } = useTranslation('gates');
  const { tenderId } = useTender();
  const [note, setNote] = useState(criterion?.note ?? '');

  const save = useMutation({
    mutationFn: () => setCriterion(tenderId, gate.id, criterion!.id, { note: note.trim() || null }),
    onSuccess: (g) => {
      onSaved(g);
      onClose();
    },
  });
  if (!criterion) return null;

  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={t('criteria.noteTitle')}
      description={criterion.text}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        {save.isError && <Banner tone="red">{errorMessage(save.error)}</Banner>}
        <Field label={t('criteria.note')}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} placeholder={t('criteria.notePlaceholder')} />
        </Field>
      </div>
    </Modal>
  );
}

/** bid_manager / admin put a decided gate back to pending, with a reason. */
export function ReopenDialog({ gate, onClose, onSaved }: DialogProps) {
  const { t } = useTranslation('gates');
  const { tenderId } = useTender();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = reason.trim().length >= 3;

  const save = useMutation({
    mutationFn: () => reopenGate(tenderId, gate.id, reason.trim()),
    onSuccess: (g) => {
      onSaved(g);
      toast.success(t('reopen.saved'));
      onClose();
    },
  });

  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={t('reopen.title', { name: gate.name })}
      description={t('reopen.hint', { decision: enumLabel('gate_decision', gate.decision) })}
      onSubmit={() => {
        setTouched(true);
        if (valid) save.mutate();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('actions.reopen')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        {save.isError && <Banner tone="red">{errorMessage(save.error)}</Banner>}
        <Field label={t('reopen.reason')} required error={touched && !valid ? t('common:errors.required') : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * The approver records the decision (R11–R14). Unmet criteria are shown first; while any is unmet a plain approval is
 * not offered, and the exception (or a Go at G0) needs a justification of at least 20 characters.
 */
export function DecisionDialog({ gate, onClose, onSaved }: DialogProps) {
  const { t } = useTranslation('gates');
  const { tender, tenderId, refetch } = useTender();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [decision, setDecision] = useState<GateDecision | null>(null);
  const [justification, setJustification] = useState('');
  const [noGoConfirmed, setNoGoConfirmed] = useState(false);
  const [touched, setTouched] = useState(false);

  const unmet = gate.criteria.filter((c) => !c.satisfied);
  const hasUnmet = unmet.length > 0;
  const goNoGo = gate.decision_mode === 'go_no_go';
  const length = justification.trim().length;
  const needsJustification = decision !== null && (decision === 'approved' ? false : decision === 'go' ? hasUnmet : true);
  const justificationOk = !needsJustification || length >= MIN_JUSTIFICATION;
  const noGo = decision === 'no_go';
  const valid = decision !== null && justificationOk && (!noGo || noGoConfirmed);

  const options: { value: GateDecision; hint: string; disabled?: boolean; tone: 'green' | 'orange' | 'red' }[] = goNoGo
    ? [
        { value: 'go', hint: t(hasUnmet ? 'decision.options.goExceptionHint' : 'decision.options.goHint'), tone: hasUnmet ? 'orange' : 'green' },
        { value: 'no_go', hint: t('decision.options.noGoHint'), tone: 'red' },
      ]
    : [
        { value: 'approved', hint: t(hasUnmet ? 'decision.options.approvedBlocked' : 'decision.options.approvedHint'), disabled: hasUnmet, tone: 'green' },
        { value: 'approved_with_exception', hint: t('decision.options.exceptionHint'), tone: 'orange' },
        { value: 'rejected', hint: t('decision.options.rejectedHint'), tone: 'red' },
      ];

  const save = useMutation({
    mutationFn: () => decideGate(tenderId, gate.id, { decision: decision!, justification: justification.trim() || null }),
    onSuccess: (res) => {
      onSaved(res.gate);
      // A decision completes the milestone; a No-Go also closes the tender and cancels tasks.
      void queryClient.invalidateQueries({ queryKey: tenderKeys.detail(tenderId) });
      if (res.tender_status !== tender.status) void refetch();
      toast.success(res.tender_status === 'no_go' ? t('decision.savedNoGo', { count: res.cancelled_tasks }) : t('decision.saved'));
      onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={false}
      title={t('decision.title', { name: gate.name })}
      onSubmit={() => {
        setTouched(true);
        if (valid) save.mutate();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant={noGo ? 'danger' : 'primary'} loading={save.isPending}>
            {t(noGo ? 'decision.submitNoGo' : 'decision.submit')}
          </Button>
        </>
      }
    >
      <div className="u-stack">
        {save.isError && <Banner tone="red">{errorMessage(save.error)}</Banner>}

        {hasUnmet ? (
          <Banner tone="red" title={t('decision.unmetTitle', { count: unmet.length })}>
            <ul className="decision__unmet">
              {unmet.map((c) => (
                <li key={c.id}>
                  {c.text}
                  {c.detail && (
                    <span className="decision__unmet-detail">
                      {' — '}
                      {t(`detail.${c.detail.code}`, { defaultValue: c.detail.message, total: c.detail.total, missing: c.detail.missing })}
                      {c.detail.items.length > 0 && ` ${c.detail.items.join(', ')}`}
                      {c.detail.missing > c.detail.items.length && ` ${t('criteria.more', { count: c.detail.missing - c.detail.items.length })}`}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="decision__rule">{t(goNoGo ? 'decision.unmetGo' : 'decision.unmetApproval', { min: MIN_JUSTIFICATION })}</p>
          </Banner>
        ) : (
          <Banner tone="green">{t('decision.allMet', { total: gate.progress.total })}</Banner>
        )}

        <fieldset className="decision__options">
          <legend className="decision__legend">{t('decision.choose')}</legend>
          {options.map((o) => (
            <label key={o.value} className={cx('decision__option', `ui-tone-${o.tone}`, decision === o.value && 'is-selected', o.disabled && 'is-disabled')}>
              <input
                type="radio"
                name="gate-decision"
                value={o.value}
                checked={decision === o.value}
                disabled={o.disabled}
                onChange={() => setDecision(o.value)}
              />
              <span>
                <span className="decision__option-label">{t(`decision.options.${o.value}`)}</span>
                <span className="decision__option-hint">{o.hint}</span>
              </span>
            </label>
          ))}
          {touched && decision === null && <p className="decision__error">{t('decision.pick')}</p>}
        </fieldset>

        {noGo && (
          <Banner tone="red" title={t('decision.noGoTitle')}>
            {t('decision.noGoWarning')}
          </Banner>
        )}

        {decision !== null && (
          <Field
            label={needsJustification ? t('decision.justificationLabel') : t('decision.justificationOptional')}
            required={needsJustification}
            hint={needsJustification ? t('decision.justificationHint', { min: MIN_JUSTIFICATION }) : undefined}
            error={touched && !justificationOk ? t('decision.tooShort', { min: MIN_JUSTIFICATION, count: length }) : undefined}
          >
            <Textarea value={justification} onChange={(e) => setJustification(e.target.value)} rows={4} maxLength={5000} />
          </Field>
        )}
        {decision !== null && needsJustification && (
          <div className={cx('decision__counter', length >= MIN_JUSTIFICATION ? 'is-ok' : 'is-short')} aria-live="polite">
            {length >= MIN_JUSTIFICATION ? t('decision.counterOk', { count: length }) : t('decision.counter', { count: length, min: MIN_JUSTIFICATION })}
          </div>
        )}

        {noGo && (
          <div>
            <Checkbox label={t('decision.noGoConfirm')} checked={noGoConfirmed} onChange={(e) => setNoGoConfirmed(e.target.checked)} />
            {touched && !noGoConfirmed && <p className="decision__error">{t('decision.noGoConfirmRequired')}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
