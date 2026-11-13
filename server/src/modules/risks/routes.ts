// Mounted at /api/tenders/:tenderId/risks — mergeParams; tender access already checked, tender row on req.tender.
// Risk register (F7): risk, early sign (trigger), reaction (mitigation), owner, status.
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../core/permissions.js';
import type { Row } from '../../db/scoped.js';
import { assertOwner, getInTender, nextSort, readOnlyWhenClosed, zNullableUuid, zText } from '../tasks/common.js';

export const router: Router = Router({ mergeParams: true });
router.use(readOnlyWhenClosed);

const STATUSES = ['open', 'mitigating', 'occurred', 'closed'] as const;

/** The usual risks of the blueprint ("Συνήθεις κίνδυνοι — αρχικό risk register"). Greek text is data, not UI. */
export const DEFAULT_RISKS: ReadonlyArray<{ key: string; title: string; trigger: string; mitigation: string }> = [
  {
    key: 'guarantee_late',
    title: 'Εγγυητική αργεί',
    trigger: 'Δεν έχει εκδοθεί στο T−3',
    mitigation: 'Κλιμάκωση στην τράπεζα, εναλλακτικός φορέας (π.χ. ΤΜΕΔΕ, αν γίνεται δεκτός)',
  },
  {
    key: 'tailored_spec',
    title: 'Φωτογραφική απαίτηση',
    trigger: 'Προδιαγραφή που ταιριάζει μόνο σε ένα προϊόν',
    mitigation: 'Ερώτημα στο WP2 πριν την προθεσμία ερωτημάτων',
  },
  {
    key: 'partner_fails',
    title: 'Εταίρος δεν παραδίδει',
    trigger: 'Έγγραφα δεν έχουν έρθει στο G1',
    mitigation: 'Εναλλακτικός εταίρος ή ανασχεδιασμός λύσης',
  },
  {
    key: 'abnormally_low',
    title: 'Ασυνήθιστα χαμηλή τιμή',
    trigger: 'Τιμή πολύ κάτω από προϋπολογισμό',
    mitigation: 'Αρχείο αιτιολόγησης έτοιμο από το G2',
  },
  {
    key: 'esidis_technical',
    title: 'Τεχνικό πρόβλημα ΕΣΗΔΗΣ',
    trigger: 'Αργό upload, όρια μεγέθους',
    mitigation: 'Ανέβασμα την T−1, αρχεία έτοιμα σε μέγεθος',
  },
  {
    key: 'late_amendment',
    title: 'Τροποποίηση διακήρυξης αργά',
    trigger: 'Νέα διευκρίνιση μετά το G1',
    mitigation: 'Change log, επανεξέταση επηρεαζόμενων γραμμών register',
  },
];

const fields = {
  title: z.string().trim().min(1).max(300),
  trigger: zText(2000),
  mitigation: zText(2000),
  owner_user_id: zNullableUuid,
  status: z.enum(STATUSES),
};
const createBody = z.object(fields).partial().required({ title: true }).strict();
const patchBody = z.object(fields).partial().strict();

const view = (r: Row) => ({
  id: r.id,
  tender_id: r.tender_id,
  title: r.title,
  trigger: r.trigger,
  mitigation: r.mitigation,
  owner_user_id: r.owner_user_id,
  status: r.status,
  sort: r.sort,
  is_default: typeof r.payload?.default_key === 'string',
  created_at: r.created_at,
  updated_at: r.updated_at,
});

router.get('/', async (req, res) => {
  const rows = await req.ctx.db.list('risk', { tender_id: req.tender.id }, { orderBy: 'sort, created_at' });
  res.json({ items: rows.map(view) });
});

/** Adds the six usual risks of the blueprint that the tender does not have yet (idempotent). */
router.post('/seed-defaults', requireRole('admin', 'bid_manager'), async (req, res) => {
  const tenderId: string = req.tender.id;
  const added = await req.ctx.db.tx(async (tx) => {
    const existing = await tx.list('risk', { tender_id: tenderId });
    const haveKeys = new Set(existing.map((r) => r.payload?.default_key).filter(Boolean));
    const haveTitles = new Set(existing.map((r) => String(r.title).trim().toLowerCase()));
    const missing = DEFAULT_RISKS.filter((d) => !haveKeys.has(d.key) && !haveTitles.has(d.title.toLowerCase()));
    let sort = await nextSort(tx, 'risk', tenderId);
    return tx.insertMany(
      'risk',
      missing.map((d) => ({
        tender_id: tenderId,
        title: d.title,
        trigger: d.trigger,
        mitigation: d.mitigation,
        status: 'open',
        sort: (sort += 10) - 10,
        payload: { default_key: d.key },
      })),
    );
  });
  res.json({ added: added.length, items: added.map(view) });
});

router.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const { db } = req.ctx;
  const tenderId: string = req.tender.id;
  await assertOwner(db, tenderId, body);
  const row = await db.insert('risk', { ...body, tender_id: tenderId, sort: await nextSort(db, 'risk', tenderId) });
  res.status(201).json(view(row));
});

router.patch('/:id', async (req, res) => {
  const body = patchBody.parse(req.body);
  const { db } = req.ctx;
  const current = await getInTender(db, 'risk', String(req.params.id), req.tender.id, 'Risk');
  await assertOwner(db, req.tender.id, body);
  const row = Object.keys(body).length > 0 ? ((await db.update('risk', current.id, body)) ?? current) : current;
  res.json(view(row));
});

router.delete('/:id', async (req, res) => {
  const { db } = req.ctx;
  const current = await getInTender(db, 'risk', String(req.params.id), req.tender.id, 'Risk');
  await db.remove('risk', current.id);
  res.status(204).end();
});
