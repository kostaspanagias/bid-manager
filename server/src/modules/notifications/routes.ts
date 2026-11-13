// Mounted at /api/notifications — behind requireAuth (req.ctx = { orgId, user, db }).
// Preferences, the caller's e-mail log, digest preview / manual run, and the event → e-mail subscriptions.
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../core/errors.js';
import { on } from '../../core/events.js';
import { zPage } from '../../core/http.js';
import { hasRole, requireRole } from '../../core/permissions.js';
import { runJob } from '../../jobs/index.js';
import { todayAthens } from '../../domain/time.js';
import { readPrefs } from './digest.js';
import { ensureDigestJob } from './jobs.js';
import { DIGEST_JOB, onApprovalRequested, onGateDecided, onHandoffDelivered, onTenderExtended, previewDigest } from './service.js';

export const router: Router = Router();

// Immediate e-mails. Handlers run after the response path; failures are logged by the bus.
on('gate.approval_requested', onApprovalRequested);
on('gate.decided', onGateDecided);
on('tender.extended', onTenderExtended);
on('handoff.delivered', onHandoffDelivered);

const prefsBody = z.object({ digest: z.boolean().optional(), immediate: z.boolean().optional() }).strict();
const logQuery = zPage.extend({ scope: z.enum(['mine', 'all']).default('mine') });

router.get('/preferences', async (req, res) => {
  const user = await req.ctx.db.get('user', req.ctx.user.id);
  if (!user) throw notFound('User not found');
  res.json({ ...readPrefs(user.settings), email: user.email });
});

router.put('/preferences', async (req, res) => {
  const body = prefsBody.parse(req.body);
  const { db } = req.ctx;
  const user = await db.get('user', req.ctx.user.id);
  if (!user) throw notFound('User not found');
  const settings = (user.settings ?? {}) as Record<string, unknown>;
  const next = { ...readPrefs(settings), ...body };
  await db.update('user', user.id, { settings: { ...settings, notifications: next } });
  res.json({ ...next, email: user.email });
});

/** The caller's recent e-mails; an admin may ask for everybody's with ?scope=all. */
router.get('/log', async (req, res) => {
  const { limit, offset, scope } = logQuery.parse(req.query);
  const all = scope === 'all' && hasRole(req.ctx, 'admin');
  const params = { user_id: req.ctx.user.id, limit, offset };
  const filter = all ? '' : 'AND l.user_id = :user_id';
  const [items, [count]] = await Promise.all([
    req.ctx.db.sql(
      `SELECT l.id, l.user_id, u.name AS user_name, l.to_email, l.kind, l.subject, l.body, l.status, l.error, l.sent_at, l.created_at
         FROM email_log l
         LEFT JOIN "user" u ON u.id = l.user_id AND u.org_id = l.org_id
        WHERE l.org_id = :org_id ${filter}
        ORDER BY l.created_at DESC, l.id
        LIMIT :limit OFFSET :offset`,
      all ? { limit, offset } : params,
    ),
    req.ctx.db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM email_log l WHERE l.org_id = :org_id ${filter}`, all ? {} : { user_id: params.user_id }),
  ]);
  res.json({ items, total: count?.n ?? 0 });
});

/** What the caller's digest would contain today. Nothing is sent or logged. */
router.post('/digest/preview', async (req, res) => {
  const preview = await previewDigest(req.ctx.db, req.ctx.user.id);
  if (!preview) throw notFound('User not found');
  const { mail, digest, ...rest } = preview;
  res.json({ ...rest, subject: mail.subject, text: mail.text, html: mail.html, totals: digest.totals, tenders: digest.tenders, orgDocuments: digest.orgDocuments });
});

/**
 * Admin: run today's digest now for this organization. Idempotent — the job runs at most once per date (a failed
 * run is retried) and a user who already got today's digest never gets a second one.
 */
router.post('/digest/run', requireRole('admin'), async (req, res) => {
  ensureDigestJob();
  const date = todayAthens();
  const [result] = await runJob(DIGEST_JOB, { date, orgId: req.ctx.orgId });
  if (result && result.status !== 'skipped') {
    res.json({ date, status: result.status, alreadyRan: false, detail: result.detail ?? null });
    return;
  }
  // Already ran (or is running) for today: report that run instead of sending anything again.
  const run = await req.ctx.db.findOne('job_run', { job: DIGEST_JOB, run_date: date });
  res.json({ date, status: run?.status ?? 'skipped', alreadyRan: true, detail: run?.detail ?? null });
});
