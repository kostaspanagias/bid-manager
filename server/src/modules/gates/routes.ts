// Mounted at /api/tenders/:tenderId/gates — mergeParams; tender access already checked, tender row on req.tender.
//
//   GET    /                                  → { items: GateView[] }  (date order, live evaluation of auto criteria)
//   GET    /:gateId                           → GateView
//   PATCH  /:gateId            { approver_user_id }            → GateView   (bid_manager / admin, R11)
//   PATCH  /:gateId/criteria/:criterionId  { checked?, note? } → GateView   (manual criteria, tender writers)
//   POST   /:gateId/request                                    → GateView   (emits gate.approval_requested)
//   POST   /:gateId/decision   { decision, justification? }    → { gate, tender_status, cancelled_tasks }  (approver only)
//   POST   /:gateId/reopen     { reason }                      → GateView   (bid_manager / admin)
import { Router } from 'express';
import { z } from 'zod';
import { emit } from '../../core/events.js';
import { zUuid } from '../../core/http.js';
import { decideGate, getGate, listGates, reopenGate, requestApproval, setApprover, setCriterion } from './service.js';

export const router: Router = Router({ mergeParams: true });

const approverBody = z.object({ approver_user_id: zUuid.nullable() }).strict();
const criterionBody = z
  .object({ checked: z.boolean().optional(), note: z.string().max(2000).nullable().optional() })
  .strict()
  .refine((b) => b.checked !== undefined || b.note !== undefined, { message: 'Nothing to change' });
const decisionBody = z
  .object({
    decision: z.enum(['approved', 'approved_with_exception', 'rejected', 'go', 'no_go']),
    justification: z.string().max(5000).nullable().optional(),
  })
  .strict();
const reopenBody = z.object({ reason: z.string().trim().min(3).max(2000) }).strict();

router.get('/', async (req, res) => {
  res.json({ items: await listGates(req.ctx, req.tender) });
});

router.get('/:gateId', async (req, res) => {
  res.json(await getGate(req.ctx, req.tender, String(req.params.gateId)));
});

router.patch('/:gateId', async (req, res) => {
  const body = approverBody.parse(req.body);
  res.json(await setApprover(req.ctx, req.tender, String(req.params.gateId), body.approver_user_id));
});

router.patch('/:gateId/criteria/:criterionId', async (req, res) => {
  const body = criterionBody.parse(req.body);
  res.json(await setCriterion(req.ctx, req.tender, String(req.params.gateId), String(req.params.criterionId), body));
});

router.post('/:gateId/request', async (req, res) => {
  const gate = await requestApproval(req.ctx, req.tender, String(req.params.gateId));
  emit(req.ctx, 'gate.approval_requested', { tenderId: gate.tender_id, gateId: gate.id, approverUserId: gate.approver_user_id! });
  res.json(gate);
});

router.post('/:gateId/decision', async (req, res) => {
  const body = decisionBody.parse(req.body);
  const result = await decideGate(req.ctx, req.tender, String(req.params.gateId), body);
  emit(req.ctx, 'gate.decided', { tenderId: result.gate.tender_id, gateId: result.gate.id, decision: result.gate.decision });
  res.json({ gate: result.gate, tender_status: result.tenderStatus, cancelled_tasks: result.cancelledTasks });
});

router.post('/:gateId/reopen', async (req, res) => {
  const body = reopenBody.parse(req.body);
  res.json(await reopenGate(req.ctx, req.tender, String(req.params.gateId), body.reason));
});
