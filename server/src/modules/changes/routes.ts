// Mounted at /api/tenders/:tenderId/changes — mergeParams; tender access already checked, tender row on req.tender.
// Change log (F7): clarifications, amendments and extensions, with the register rows (ΥΠ-nnn) they affect.
// Extensions are written by the deadline flow (R9, slice 1): shown here, never created or re-typed here.
import { Router } from 'express';
import { z } from 'zod';
import { forbidden, unprocessable } from '../../core/errors.js';
import { zDate, zUuid } from '../../core/http.js';
import type { Row, ScopedDb } from '../../db/scoped.js';
import { todayAthens } from '../../domain/time.js';
import { assertOwner, getInTender, isManager, readOnlyWhenClosed, zNullableUuid, zText } from '../tasks/common.js';

export const router: Router = Router({ mergeParams: true });
router.use(readOnlyWhenClosed);

const fields = {
  date: zDate,
  source: z.enum(['adam', 'esidis', 'email', 'other']),
  kind: z.enum(['clarification', 'amendment', 'extension']),
  description: z.string().trim().min(1).max(5000),
  reference: zText(500),
  owner_user_id: zNullableUuid,
  requirement_ids: z.array(zUuid).max(1000),
  /** Set the linked register rows that were covered/verified back to in_progress for a re-check. Default off. */
  reopen_requirements: z.boolean(),
};
const createBody = z.object(fields).partial().required({ description: true }).strict();
const patchBody = z.object(fields).partial().strict();

interface Link {
  change_entry_id: string;
  id: string;
  code: string;
  text: string;
  status: string;
}

async function linksOf(db: ScopedDb, tenderId: string, entryIds: string[]): Promise<Map<string, Link[]>> {
  const out = new Map<string, Link[]>();
  if (entryIds.length === 0) return out;
  const rows = await db.sql<Link>(
    `SELECT cer.change_entry_id, r.id, r.code, r.text, r.status
       FROM change_entry_requirement cer
       JOIN requirement r ON r.id = cer.requirement_id AND r.org_id = cer.org_id
      WHERE cer.org_id = :org_id AND cer.tender_id = :tenderId AND cer.change_entry_id = ANY(:entryIds)
      ORDER BY r.sort, r.code`,
    { tenderId, entryIds },
  );
  for (const r of rows) {
    const list = out.get(r.change_entry_id) ?? [];
    list.push(r);
    out.set(r.change_entry_id, list);
  }
  return out;
}

function view(entry: Row, links: Link[]) {
  return {
    id: entry.id,
    tender_id: entry.tender_id,
    date: entry.date,
    source: entry.source,
    kind: entry.kind,
    description: entry.description,
    reference: entry.reference,
    owner_user_id: entry.owner_user_id,
    payload: entry.payload ?? {},
    /** written by the deadline flow: its kind is fixed */
    kind_locked: entry.kind === 'extension',
    requirement_ids: links.map((l) => l.id),
    requirements: links.map((l) => ({ id: l.id, code: l.code, text: l.text, status: l.status })),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    created_by: entry.created_by,
  };
}

async function respond(db: ScopedDb, entry: Row, extra: Record<string, unknown> = {}) {
  const links = (await linksOf(db, entry.tender_id, [entry.id])).get(entry.id) ?? [];
  return { ...view(entry, links), ...extra };
}

/** Every id must be a register row of THIS tender. */
async function assertRequirements(db: ScopedDb, tenderId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const found = await db.list<{ id: string }>('requirement', { tender_id: tenderId, id: unique });
  if (found.length !== unique.length) {
    const have = new Set(found.map((r) => r.id));
    throw unprocessable(
      'Some requirements do not belong to this tender',
      { missing: unique.filter((id) => !have.has(id)) },
      'requirement_not_in_tender',
    );
  }
  return unique;
}

async function syncLinks(tx: ScopedDb, tenderId: string, entryId: string, ids: string[]): Promise<void> {
  const current = await tx.list<{ id: string; requirement_id: string }>('change_entry_requirement', { change_entry_id: entryId });
  const want = new Set(ids);
  for (const link of current) if (!want.has(link.requirement_id)) await tx.remove('change_entry_requirement', link.id);
  const have = new Set(current.map((l) => l.requirement_id));
  await tx.insertMany(
    'change_entry_requirement',
    ids.filter((id) => !have.has(id)).map((id) => ({ tender_id: tenderId, change_entry_id: entryId, requirement_id: id })),
  );
}

/** covered / verified → in_progress (open, in_progress and deviation rows are left alone). Returns how many moved. */
async function reopenRequirements(tx: ScopedDb, tenderId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx.list<{ id: string }>('requirement', { tender_id: tenderId, id: ids, status: ['covered', 'verified'] });
  for (const r of rows) await tx.update('requirement', r.id, { status: 'in_progress' });
  return rows.length;
}

router.get('/', async (req, res) => {
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const rows = await db.list('change_entry', { tender_id: tenderId }, { orderBy: 'date desc, created_at desc' });
  const links = await linksOf(db, tenderId, rows.map((r) => r.id as string));
  res.json({ items: rows.map((r) => view(r, links.get(r.id) ?? [])) });
});

router.post('/', async (req, res) => {
  const { requirement_ids, reopen_requirements, ...body } = createBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  if (body.kind === 'extension') {
    throw unprocessable('An extension is recorded by changing the submission deadline', undefined, 'extension_via_deadline');
  }
  await assertOwner(db, tenderId, body);
  const ids = await assertRequirements(db, tenderId, requirement_ids ?? []);
  const { entry, reopened } = await db.tx(async (tx) => {
    const entry = await tx.insert('change_entry', { ...body, date: body.date ?? todayAthens(), tender_id: tenderId });
    await syncLinks(tx, tenderId, entry.id, ids);
    return { entry, reopened: reopen_requirements ? await reopenRequirements(tx, tenderId, ids) : 0 };
  });
  res.status(201).json(await respond(db, entry, { reopened }));
});

router.patch('/:id', async (req, res) => {
  const { requirement_ids, reopen_requirements, ...body } = patchBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  const current = await getInTender(db, 'change_entry', String(req.params.id), tenderId, 'Change entry');
  if (body.kind !== undefined && body.kind !== current.kind) {
    if (current.kind === 'extension') {
      throw unprocessable('The kind of an extension entry cannot be changed', undefined, 'extension_kind_locked');
    }
    if (body.kind === 'extension') {
      throw unprocessable('An extension is recorded by changing the submission deadline', undefined, 'extension_via_deadline');
    }
  }
  await assertOwner(db, tenderId, body);
  const ids = requirement_ids === undefined ? undefined : await assertRequirements(db, tenderId, requirement_ids);
  const { entry, reopened } = await db.tx(async (tx) => {
    const entry = Object.keys(body).length > 0 ? ((await tx.update('change_entry', current.id, body)) ?? current) : current;
    if (ids) await syncLinks(tx, tenderId, current.id, ids);
    let reopened = 0;
    if (reopen_requirements) {
      const linked = ids ?? (await tx.list<{ requirement_id: string }>('change_entry_requirement', { change_entry_id: current.id })).map((l) => l.requirement_id);
      reopened = await reopenRequirements(tx, tenderId, linked);
    }
    return { entry, reopened };
  });
  res.json(await respond(db, entry, { reopened }));
});

/** The automatic extension record is part of the tender's history: only the bid manager removes it. */
router.delete('/:id', async (req, res) => {
  const { db } = req.ctx;
  const current = await getInTender(db, 'change_entry', String(req.params.id), req.tender.id, 'Change entry');
  if (current.kind === 'extension' && !isManager(req.ctx)) {
    throw forbidden('Only the bid manager can remove an extension entry', 'extension_manager_only');
  }
  await db.remove('change_entry', current.id);
  res.status(204).end();
});
