// GDPR actions (spec, non-functional row "GDPR"): erasure of one person's data in a single action, and the
// retention purge of files of closed tenders.
//
// Erasure and the audit log
//   audit_log is append-only (a trigger rejects UPDATE/DELETE) and stays that way. The data layer's automatic
//   audit would copy exactly what is being erased into NEW audit rows (db.update('user') stores the old name and
//   e-mail in `before`; db.remove() stores the full deleted row). So nothing here goes through the audited
//   insert/update/remove: every statement is raw, and ONE explicit audit entry records that an erasure happened —
//   ids and counts only, never a name, an e-mail, a title or a file name.
import { getStorage } from '../../core/storage.js';
import { logger } from '../../core/logger.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { shiftDays } from '../../domain/calendar.js';

export const ERASED_USER_NAME = 'Διαγραμμένος χρήστης';
export const erasedEmail = (userId: string): string => `erased-${userId}@erased.invalid`;
const CLOSED_STATUSES = ['submitted', 'no_go', 'cancelled'];

/** Names compare without case, accents or extra spaces ("Γιώργος  Παππάς" = "γιωργος παππας"). */
export function normalizeName(name: unknown): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ErasePlan {
  user: { id: string; name: string; email: string; org_role: string; active: boolean; already_anonymized: boolean } | null;
  /** The CV documents that match — the person's name is why they match, so it is shown to the admin (never stored). */
  documents: { id: string; title: string; person_name: string | null; has_file: boolean; tenders: { id: string; title: string }[] }[];
  counts: { documents: number; files: number; tender_links: number; sessions: number; invitations: number; emails: number };
  /**
   * Erasing by name only: active accounts with the same name, which this request will NOT touch — the admin can
   * repeat the action with the user_id. Empty when a user_id was given.
   */
  matching_users: { id: string; name: string; email: string }[];
}

interface Target {
  user: Row | null;
  docs: Row[];
  files: Row[];
  links: Row[];
}

async function resolveTarget(db: ScopedDb, userId: string | undefined, personName: string | undefined): Promise<Target> {
  const user = userId ? await db.get('user', userId) : null;
  // CVs of the person: the given name, and — for a user — the user's own name (unless already anonymised).
  const names = new Set<string>();
  if (personName && normalizeName(personName)) names.add(normalizeName(personName));
  if (user && !user.anonymized_at && normalizeName(user.name)) names.add(normalizeName(user.name));
  const docs = names.size === 0 ? [] : (await db.list('company_document', { type: 'cv' }, { orderBy: 'title, id' })).filter((d) => names.has(normalizeName(d.person_name)));
  const fileIds = docs.map((d) => d.file_id as string | null).filter((id): id is string => !!id);
  const files = fileIds.length ? await db.list('file', { id: fileIds, tender_id: null }) : [];
  const links = docs.length ? await db.list('tender_document', { company_document_id: docs.map((d) => d.id) }) : [];
  return { user, docs, files, links };
}

async function planOf(db: ScopedDb, target: Target, personName: string | undefined): Promise<ErasePlan> {
  const { user, docs, files, links } = target;
  const wanted = normalizeName(personName);
  const matchingUsers =
    user || !wanted
      ? []
      : (await db.list<{ id: string; name: string; email: string }>('user', { anonymized_at: null }, { orderBy: 'name, id' })).filter((u) => normalizeName(u.name) === wanted);
  const tenderIds = [...new Set(links.map((l) => l.tender_id as string))];
  const tenders = tenderIds.length ? await db.list<{ id: string; title: string }>('tender', { id: tenderIds }) : [];
  const titleOf = new Map(tenders.map((t) => [t.id, t.title]));
  let sessions = 0;
  let invitations = 0;
  let emails = 0;
  if (user) {
    sessions = await db.count('session', { user_id: user.id });
    [{ n: invitations }] = (await db.sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM invitation WHERE org_id = :org_id AND (email = :email OR accepted_user_id = :id)',
      { id: user.id, email: user.email },
    )) as [{ n: number }];
    [{ n: emails }] = (await db.sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM email_log WHERE org_id = :org_id AND (user_id = :id OR to_email = :email)',
      { id: user.id, email: user.email },
    )) as [{ n: number }];
  }
  return {
    user: user
      ? { id: user.id, name: user.name, email: user.email, org_role: user.org_role, active: user.active, already_anonymized: user.anonymized_at != null }
      : null,
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title,
      person_name: d.person_name ?? null,
      has_file: files.some((f) => f.id === d.file_id),
      tenders: links.filter((l) => l.company_document_id === d.id).map((l) => ({ id: l.tender_id as string, title: titleOf.get(l.tender_id as string) ?? '' })),
    })),
    counts: { documents: docs.length, files: files.length, tender_links: links.length, sessions, invitations, emails },
    matching_users: matchingUsers.map((u) => ({ id: u.id, name: u.name, email: u.email })),
  };
}

export async function planErasure(db: ScopedDb, userId: string | undefined, personName: string | undefined): Promise<{ plan: ErasePlan; target: Target }> {
  const target = await resolveTarget(db, userId, personName);
  return { plan: await planOf(db, target, personName), target };
}

/**
 * Executes a plan. Blobs go first (a failure after that leaves rows pointing at nothing — loud and retryable —
 * instead of personal data on disk without a row), then everything else in one transaction. Idempotent: running
 * it again for the same person finds nothing left to remove.
 */
export async function executeErasure(db: ScopedDb, target: Target, plan: ErasePlan): Promise<void> {
  const storage = getStorage();
  for (const file of target.files) await storage.delete(file.storage_key as string);

  await db.tx(async (tx) => {
    const docIds = target.docs.map((d) => d.id as string);
    const fileIds = target.files.map((f) => f.id as string);
    if (docIds.length) {
      // tender_document rows go with the document (FK cascade) = the CVs are unlinked from every tender.
      await tx.sql('DELETE FROM company_document WHERE org_id = :org_id AND id = ANY(:ids)', { ids: docIds });
    }
    if (fileIds.length) {
      await tx.sql('DELETE FROM file WHERE org_id = :org_id AND tender_id IS NULL AND id = ANY(:ids)', { ids: fileIds });
    }
    const user = target.user;
    let anonymized = false;
    if (user && !user.anonymized_at) {
      await tx.sql(
        `UPDATE "user"
            SET name = :name, email = :email, active = false, password_hash = NULL, totp_secret = NULL,
                totp_enabled_at = NULL, totp_last_step = NULL, failed_login_count = 0, locked_until = NULL,
                totp_failed_count = 0, totp_locked_until = NULL,
                last_login_at = NULL, settings = '{}'::jsonb, anonymized_at = now()
          WHERE org_id = :org_id AND id = :id`,
        { id: user.id, name: ERASED_USER_NAME, email: erasedEmail(user.id) },
      );
      anonymized = true;
    }
    if (user) {
      // Whether or not the row was already anonymised: no session, invitation or stored e-mail text may remain.
      await tx.sql('DELETE FROM session WHERE org_id = :org_id AND user_id = :id', { id: user.id });
      await tx.sql('DELETE FROM invitation WHERE org_id = :org_id AND (email = :email OR accepted_user_id = :id)', { id: user.id, email: user.email });
      await tx.sql('DELETE FROM password_reset WHERE org_id = :org_id AND user_id = :id', { id: user.id });
      await tx.sql('DELETE FROM login_throttle WHERE org_id = :org_id AND user_id = :id', { id: user.id });
      await tx.sql(`UPDATE email_log SET to_email = NULL, subject = '', body = '' WHERE org_id = :org_id AND (user_id = :id OR to_email = :email)`, {
        id: user.id,
        email: user.email,
      });
    }
    // The one audit entry of the erasure: ids and counts, no personal values (see the header).
    await tx.audit('gdpr', user ? user.id : null, 'erase_person', {
      after: {
        user_id: user ? user.id : null,
        user_anonymized: anonymized,
        document_ids: docIds,
        file_ids: fileIds,
        counts: plan.counts,
      },
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------

export interface RetentionResult {
  retention_days: number | null;
  /** Latest closing date (Athens) that is purged on this run; null when no retention period is set. */
  cutoff: string | null;
  /** Tenders whose files were removed on this run. */
  tenders: number;
  files: number;
  /** Blobs of soft-deleted files that were still on disk (a delete whose blob removal had failed). */
  swept_blobs: number;
}

/** Tenders closed before the cutoff that still have file rows. */
export async function retentionCandidates(db: ScopedDb, retentionDays: number, today: string): Promise<{ id: string; files: number }[]> {
  return db.sql<{ id: string; files: number }>(
    `SELECT t.id, count(f.id)::int AS files
       FROM tender t
       JOIN file f ON f.org_id = t.org_id AND f.tender_id = t.id
      WHERE t.org_id = :org_id
        AND t.status = ANY(:closed)
        AND t.closed_at IS NOT NULL
        AND (t.closed_at AT TIME ZONE 'Europe/Athens')::date < CAST(:cutoff AS date)
      GROUP BY t.id
      ORDER BY t.id`,
    { closed: CLOSED_STATUSES, cutoff: shiftDays(today, -retentionDays) },
  );
}

/**
 * The retention purge for one organization on `today` (Athens date):
 *  1. removes blobs of soft-deleted files that are still on disk;
 *  2. when organization.retention_days is set: for every tender in a closed status whose closed_at (Athens date)
 *     is more than retention_days days before `today`, deletes the blobs and the `file` rows of the tender
 *     (the tender itself and its other data stay). A closed tender without closed_at is never purged.
 * Safe to repeat: blob deletion is idempotent, and a purged tender has no file rows left.
 */
export async function purgeExpiredFiles(db: ScopedDb, today: string): Promise<RetentionResult> {
  const storage = getStorage();
  const org = await db.get<{ retention_days: number | null }>('organization', db.orgId);
  const retentionDays = org?.retention_days ?? null;

  let swept = 0;
  const leftovers = await db.sql<{ id: string; storage_key: string }>(
    'SELECT id, storage_key FROM file WHERE org_id = :org_id AND deleted_at IS NOT NULL AND enc IS NOT NULL',
  );
  for (const f of leftovers) {
    await storage.delete(f.storage_key);
    await db.sql('UPDATE file SET enc = NULL WHERE org_id = :org_id AND id = :id', { id: f.id });
    swept++;
  }

  const result: RetentionResult = { retention_days: retentionDays, cutoff: null, tenders: 0, files: 0, swept_blobs: swept };
  if (retentionDays === null) return result;
  result.cutoff = shiftDays(today, -retentionDays);

  for (const tender of await retentionCandidates(db, retentionDays, today)) {
    const files = await db.list<{ id: string; storage_key: string }>('file', { tender_id: tender.id });
    for (const f of files) await storage.delete(f.storage_key);
    await db.tx(async (tx) => {
      const gone = await tx.sql('DELETE FROM file WHERE org_id = :org_id AND tender_id = :tender_id AND id = ANY(:ids) RETURNING id', {
        tender_id: tender.id,
        ids: files.map((f) => f.id),
      });
      // One audit entry per tender; file names are deliberately not copied into the log.
      await tx.audit('tender', tender.id, 'retention_purge', { after: { files: gone.length, retention_days: retentionDays, cutoff: result.cutoff }, tenderId: tender.id });
      result.files += gone.length;
    });
    result.tenders++;
    logger.info({ orgId: db.orgId, tenderId: tender.id, files: files.length }, 'retention: files of a closed tender purged');
  }
  return result;
}
