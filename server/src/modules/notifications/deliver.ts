// One place that sends an e-mail and records it in email_log. The unique (org_id, dedupe_key) makes every
// notification idempotent: a key that was already sent is never sent again.
import { logger } from '../../core/logger.js';
import { sendMail } from '../../core/mailer.js';
import type { ScopedDb } from '../../db/scoped.js';
import type { RenderedMail } from './render.js';

export type DeliveryResult = 'sent' | 'duplicate' | 'failed';
/** A "pending" row older than this is an interrupted send (crash between claim and SMTP) and may be retried. */
const STALE_PENDING_MINUTES = 10;

export interface Delivery {
  userId: string;
  to: string;
  /** digest | gate_approval_requested | gate_decided | tender_extended | handoff_delivered */
  kind: string;
  dedupeKey: string;
  mail: RenderedMail;
}

/**
 * Claim → send → mark. The claim is atomic (INSERT … ON CONFLICT), so two runs can never both send the same key.
 * A failed send stays in the log as `failed` and is retried by the next attempt with the same key.
 */
export async function deliver(db: ScopedDb, d: Delivery): Promise<DeliveryResult> {
  const [claim] = await db.sql<{ id: string }>(
    `INSERT INTO email_log (org_id, user_id, to_email, kind, dedupe_key, subject, body, status)
     VALUES (:org_id, :user_id, :to_email, :kind, :dedupe_key, :subject, :body, 'pending')
     ON CONFLICT (org_id, dedupe_key) DO UPDATE
        SET status = 'pending', to_email = EXCLUDED.to_email, subject = EXCLUDED.subject, body = EXCLUDED.body, error = NULL
      WHERE email_log.status = 'failed'
         OR (email_log.status = 'pending' AND email_log.updated_at < now() - make_interval(mins => :stale))
     RETURNING id`,
    { user_id: d.userId, to_email: d.to, kind: d.kind, dedupe_key: d.dedupeKey, subject: d.mail.subject, body: d.mail.text, stale: STALE_PENDING_MINUTES },
  );
  if (!claim) return 'duplicate';
  try {
    await sendMail({ to: d.to, subject: d.mail.subject, text: d.mail.text, html: d.mail.html });
  } catch (err) {
    logger.error({ err, kind: d.kind, userId: d.userId }, 'e-mail delivery failed');
    await db.sql("UPDATE email_log SET status = 'failed', error = :error WHERE org_id = :org_id AND id = :id", {
      id: claim.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    return 'failed';
  }
  await db.sql("UPDATE email_log SET status = 'sent', sent_at = now() WHERE org_id = :org_id AND id = :id", { id: claim.id });
  return 'sent';
}
