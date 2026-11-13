import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessage } from '@/api/client';
import type { ID } from '@/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { StatusBadge } from '@/features/shared/StatusBadge';
import { useUsers } from '@/features/shared/useUsers';
import { useTender } from '@/features/tenders/tenderContext';
import { cx } from '@/lib/cx';
import { formatDateTime, todayAthens } from '@/lib/dates';
import { enumLabel, enumTone } from '@/lib/enums';
import { Badge, Banner, Button, Checkbox, DateText, EmptyState, Icon, PageHeader, PageSpinner, TMinus, useToast } from '@/ui';
import { ApproverDialog, DecisionDialog, NoteDialog, ReopenDialog } from './GateDialogs';
import { gatesKeys, listGates, requestApproval, setCriterion, type GateCriterionView, type GateView } from './gatesApi';
import './gates.css';

type Dialog = { kind: 'approver' | 'decision' | 'reopen'; gateId: ID } | { kind: 'note'; gateId: ID; criterionId: ID } | null;

/** Which tender tab explains / fixes an automatic rule. */
const RULE_TAB: Record<string, 'register' | 'tasks' | 'watch' | 'documents'> = {
  exclusion_evidence_100: 'register',
  register_no_open: 'register',
  handoffs_received: 'tasks',
  guarantee_arrived: 'watch',
  docs_valid_on_T: 'documents',
};

/** Tender tab «Πύλες»: G0–G4 with exit criteria, approver and decision (F4, R11–R14). */
export function GatesTab() {
  const { t } = useTranslation('gates');
  const { tenderId, isActive } = useTender();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Record<ID, boolean>>({});
  const [dialog, setDialog] = useState<Dialog>(null);

  const query = useQuery({ queryKey: gatesKeys.list(tenderId), queryFn: () => listGates(tenderId) });
  const gates = query.data ?? [];
  // Open by default: the gate that needs attention next (first pending one).
  const nextId = gates.find((g) => g.decision === 'pending')?.id;
  const isOpen = (g: GateView) => expanded[g.id] ?? g.id === nextId;

  /** Put the fresh gate into the cache right away, then refetch (auto criteria depend on other tabs' data). */
  const applyGate = (gate: GateView) => {
    queryClient.setQueryData<GateView[]>(gatesKeys.list(tenderId), (old) => old?.map((g) => (g.id === gate.id ? gate : g)));
    void queryClient.invalidateQueries({ queryKey: gatesKeys.list(tenderId) });
  };

  const dialogGate = dialog ? gates.find((g) => g.id === dialog.gateId) : undefined;
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader level={2} title={t('title')} subtitle={t('rule')} />

      {query.isPending ? (
        <PageSpinner />
      ) : query.isError ? (
        <Banner
          tone="red"
          title={t('common:errors.loadFailed')}
          actions={
            <Button size="sm" onClick={() => void query.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        >
          {errorMessage(query.error)}
        </Banner>
      ) : gates.length === 0 ? (
        <EmptyState icon="shield" title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <div className="gates">
          {!isActive && <Banner tone="info">{t('closedBanner')}</Banner>}
          <ol className="gates__list">
            {gates.map((gate) => (
              <li key={gate.id}>
                <GateCard
                  gate={gate}
                  open={isOpen(gate)}
                  onToggle={() => setExpanded((s) => ({ ...s, [gate.id]: !isOpen(gate) }))}
                  onDialog={setDialog}
                  onChanged={applyGate}
                />
              </li>
            ))}
          </ol>
        </div>
      )}

      {dialogGate && dialog?.kind === 'approver' && <ApproverDialog gate={dialogGate} onClose={close} onSaved={applyGate} />}
      {dialogGate && dialog?.kind === 'decision' && <DecisionDialog gate={dialogGate} onClose={close} onSaved={applyGate} />}
      {dialogGate && dialog?.kind === 'reopen' && <ReopenDialog gate={dialogGate} onClose={close} onSaved={applyGate} />}
      {dialogGate && dialog?.kind === 'note' && (
        <NoteDialog gate={dialogGate} criterion={dialogGate.criteria.find((c) => c.id === dialog.criterionId)} onClose={close} onSaved={applyGate} />
      )}
    </>
  );
}

/** «G1 Solution freeze» → «Solution freeze» when the key is shown separately. */
function shortName(gate: GateView): string {
  const { key, name } = gate;
  if (key && name.startsWith(key) && name.length > key.length) return name.slice(key.length).replace(/^[\s:·–-]+/, '');
  return name;
}

interface GateCardProps {
  gate: GateView;
  open: boolean;
  onToggle: () => void;
  onDialog: (d: Dialog) => void;
  onChanged: (gate: GateView) => void;
}

function GateCard({ gate, open, onToggle, onDialog, onChanged }: GateCardProps) {
  const { t } = useTranslation('gates');
  const { tenderId, isActive } = useTender();
  const { user } = useAuth();
  const { nameOf } = useUsers();
  const toast = useToast();
  const who = (id: ID | null) => nameOf(id) || t('unknownUser');

  const pending = gate.decision === 'pending';
  const today = todayAthens();
  const overdue = pending && isActive && gate.due_date !== null && gate.due_date < today;
  const dueToday = pending && isActive && gate.due_date === today;
  const tone = pending ? (overdue ? 'red' : 'neutral') : enumTone('gate_decision', gate.decision);
  const { met, total } = gate.progress;
  const isApprover = Boolean(user && gate.approver_user_id === user.id);
  const perms = gate.permissions;
  const bodyId = `gate-body-${gate.id}`;

  const request = useMutation({
    mutationFn: () => requestApproval(tenderId, gate.id),
    onSuccess: (g) => {
      onChanged(g);
      toast.success(t('request.sent'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const shown = !pending && gate.snapshot ? gate.snapshot.criteria : gate.criteria;
  const isSnapshot = !pending && gate.snapshot !== null;

  return (
    <article className={cx('gate', `ui-tone-${tone}`, open && 'is-open')}>
      <button
        type="button"
        className="gate__head"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={t(open ? 'card.collapse' : 'card.expand', { name: gate.name })}
        onClick={onToggle}
      >
        <span className="gate__key">{gate.key ?? '—'}</span>
        <span className="gate__main">
          <span className="gate__name">{shortName(gate)}</span>
          <span className="gate__meta">
            <span className="gate__meta-item">
              <Icon name="calendar" size={14} />
              {gate.due_date ? <DateText value={gate.due_date} withWeekday /> : t('card.noDate')}
              <TMinus n={gate.t_minus} tone="neutral" />
              {overdue && <Badge tone="red">{t('card.overdue')}</Badge>}
              {dueToday && <Badge tone="orange">{t('card.today')}</Badge>}
            </span>
            <span className="gate__meta-item">
              <Icon name="user" size={14} />
              {gate.approver ? gate.approver.name : <span className="gate__warn">{t('card.noApprover')}</span>}
              {gate.approver && !gate.approver.active && <span className="gate__warn">({t('card.inactiveApprover')})</span>}
            </span>
          </span>
        </span>
        <span className="gate__status">
          <StatusBadge kind="gate_decision" value={gate.decision} dot />
          {gate.exception && gate.decision === 'go' && <Badge tone="orange">{t('card.exception')}</Badge>}
          {pending && gate.requested_at && <Badge tone="info">{t('card.requested')}</Badge>}
          <span className={cx('gate__progress', met === total ? 'is-complete' : 'is-partial')} title={t('card.progressLabel')}>
            <span className="gate__progress-track" aria-hidden>
              <span className="gate__progress-fill" style={{ width: `${total > 0 ? (met / total) * 100 : 0}%` }} />
            </span>
            <span className="gate__progress-text">
              <span className="u-sr-only">{t('card.progressLabel')}: </span>
              {t('card.progress', { met, total })}
            </span>
          </span>
        </span>
        <Icon name="chevronDown" size={18} className="gate__chevron" />
      </button>

      {open && (
        <div className="gate__body" id={bodyId}>
          {!pending && (
            <div className="gate__decision">
              <div className="gate__decision-head">
                <StatusBadge kind="gate_decision" value={gate.decision} />
                <span>{t('decision.by', { name: who(gate.decided_by), at: formatDateTime(gate.decided_at) })}</span>
              </div>
              {gate.justification && (
                <div>
                  <div className="gate__label">{t('decision.justification')}</div>
                  <p className="gate__justification">{gate.justification}</p>
                </div>
              )}
              {gate.exception && <p className="gate__exception-note">{t('decision.exceptionNote')}</p>}
            </div>
          )}

          {pending && perms.can_decide && <Banner tone="info">{t('card.youDecide')}</Banner>}
          {pending && gate.requested_at && (
            <p className="gate__info">
              {gate.requested_by
                ? t('card.requestedBy', { name: who(gate.requested_by), at: formatDateTime(gate.requested_at) })
                : t('card.requestedAt', { at: formatDateTime(gate.requested_at) })}
            </p>
          )}

          <section aria-label={t('criteria.title')}>
            <div className="gate__section-head">
              <h4 className="gate__section-title">{isSnapshot ? t('criteria.snapshotTitle') : t('criteria.title')}</h4>
              {isSnapshot && gate.snapshot && <span className="gate__info">{t('criteria.snapshotAt', { at: formatDateTime(gate.snapshot.at) })}</span>}
            </div>
            {shown.length === 0 ? (
              <p className="gate__info">{t('criteria.none')}</p>
            ) : (
              <ul className="criteria">
                {shown.map((c) => (
                  <CriterionRow
                    key={c.id}
                    gate={gate}
                    criterion={c}
                    editable={pending && perms.can_check}
                    showLinks={pending}
                    onChanged={onChanged}
                    onNote={() => onDialog({ kind: 'note', gateId: gate.id, criterionId: c.id })}
                  />
                ))}
              </ul>
            )}
          </section>

          {gate.history.length > 0 && (
            <section>
              <h4 className="gate__section-title">{t('history.title')}</h4>
              <ul className="gate__history">
                {gate.history.map((h) => (
                  <li key={h.reopened_at}>
                    <div>
                      {t('history.entry', { decision: enumLabel('gate_decision', h.decision), by: who(h.decided_by), at: formatDateTime(h.decided_at) })}
                      {h.justification && <span className="u-muted"> — {h.justification}</span>}
                    </div>
                    <div className="u-muted">{t('history.reopened', { by: who(h.reopened_by), at: formatDateTime(h.reopened_at), reason: h.reason })}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(perms.can_change_approver || perms.can_request || perms.can_decide || perms.can_reopen || (pending && isActive && !isApprover && gate.approver)) && (
            <div className="gate__actions">
              {pending && isActive && !perms.can_decide && gate.approver && (
                <span className="gate__info gate__actions-note">{t('card.onlyApprover', { name: gate.approver.name })}</span>
              )}
              {perms.can_change_approver && (
                <Button size="sm" icon="user" onClick={() => onDialog({ kind: 'approver', gateId: gate.id })}>
                  {t(gate.approver_user_id ? 'actions.changeApprover' : 'actions.setApprover')}
                </Button>
              )}
              {perms.can_request && !perms.can_decide && (
                <Button size="sm" variant={gate.requested_at ? 'secondary' : 'primary'} loading={request.isPending} onClick={() => request.mutate()}>
                  {t(gate.requested_at ? 'actions.requestAgain' : 'actions.request')}
                </Button>
              )}
              {perms.can_decide && (
                <Button size="sm" variant="primary" icon="check" onClick={() => onDialog({ kind: 'decision', gateId: gate.id })}>
                  {t('actions.decide')}
                </Button>
              )}
              {perms.can_reopen && (
                <Button size="sm" icon="history" onClick={() => onDialog({ kind: 'reopen', gateId: gate.id })}>
                  {t('actions.reopen')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

interface CriterionRowProps {
  gate: GateView;
  criterion: GateCriterionView;
  editable: boolean;
  showLinks: boolean;
  onChanged: (gate: GateView) => void;
  onNote: () => void;
}

function CriterionRow({ gate, criterion: c, editable, showLinks, onChanged, onNote }: CriterionRowProps) {
  const { t } = useTranslation('gates');
  const { tenderId } = useTender();
  const { nameOf } = useUsers();
  const toast = useToast();

  // The box shows the clicked value at once (set in the same event), then follows the server again.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const toggle = useMutation({
    mutationFn: (checked: boolean) => setCriterion(tenderId, gate.id, c.id, { checked }),
    onSuccess: onChanged,
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => setOptimistic(null),
  });

  const checkedLine = c.checked_at
    ? nameOf(c.checked_by)
      ? t('criteria.checkedBy', { name: nameOf(c.checked_by), at: formatDateTime(c.checked_at) })
      : t('criteria.checkedAt', { at: formatDateTime(c.checked_at) })
    : null;

  if (c.type === 'manual') {
    const extra = (checkedLine || c.note) && (
      <>
        {checkedLine && <span className="criterion__who">{checkedLine}</span>}
        {c.note && (
          <span className="criterion__note">
            {t('criteria.note')}: {c.note}
          </span>
        )}
      </>
    );
    return (
      <li className={cx('criterion', c.satisfied ? 'is-met' : 'is-unmet')}>
        {editable ? (
          <Checkbox
            className="criterion__check"
            label={c.text}
            hint={extra || undefined}
            checked={optimistic ?? c.satisfied}
            disabled={toggle.isPending}
            onChange={(e) => {
              setOptimistic(e.target.checked);
              toggle.mutate(e.target.checked);
            }}
          />
        ) : (
          <div className="criterion__static">
            <StatusIcon met={c.satisfied} />
            <div className="criterion__content">
              <span className="criterion__text">{c.text}</span>
              {extra && <span className="criterion__extra">{extra}</span>}
            </div>
          </div>
        )}
        {editable && (
          <Button size="sm" variant="ghost" icon="edit" className="criterion__note-btn" onClick={onNote}>
            {t(c.note ? 'criteria.editNote' : 'criteria.addNote')}
          </Button>
        )}
      </li>
    );
  }

  const detail = c.detail;
  const tab = c.auto_rule ? RULE_TAB[c.auto_rule] : undefined;
  const more = detail ? detail.missing - detail.items.length : 0;
  return (
    <li className={cx('criterion', c.satisfied ? 'is-met' : 'is-unmet')}>
      <div className="criterion__static">
        <StatusIcon met={c.satisfied} />
        <div className="criterion__content">
          <span className="criterion__text">
            {c.text} <Badge className="criterion__auto">{t('criteria.auto')}</Badge>
          </span>
          {detail && (
            <span className={cx('criterion__detail', !c.satisfied && 'is-unmet')}>
              {t(`detail.${detail.code}`, { defaultValue: detail.message, total: detail.total, missing: detail.missing })}
              {detail.items.length > 0 && (
                <span className="criterion__items">
                  {detail.items.map((item) => (
                    <span key={item} className="criterion__item">
                      {item}
                    </span>
                  ))}
                  {more > 0 && <span className="criterion__more">{t('criteria.more', { count: more })}</span>}
                </span>
              )}
            </span>
          )}
          {showLinks && tab && !c.satisfied && (
            <Link className="criterion__link" to={`/tenders/${tenderId}/${tab}`}>
              {t(`criteria.links.${tab}`)}
              <Icon name="chevronRight" size={14} />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

function StatusIcon({ met }: { met: boolean }) {
  const { t } = useTranslation('gates');
  return (
    <span className={cx('criterion__icon', met ? 'is-met' : 'is-unmet')}>
      <Icon name={met ? 'checkCircle' : 'alert'} size={18} />
      <span className="u-sr-only">{t(met ? 'criteria.met' : 'criteria.unmet')}</span>
    </span>
  );
}
