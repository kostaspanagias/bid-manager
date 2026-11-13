// Acceptance suite — docs/spec.md «Κριτήρια αποδοχής (ως αυτοματοποιημένα tests)».
// One test per criterion, named with the criterion's own Greek text. The behaviour under test is driven through
// the real HTTP API only (supertest against createApp()); the harness is used just to create organizations and
// users, to seed the «L v1.1» template, and — in the multi-tenant sweep — to enumerate what belongs to an org.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { countRoutes, listApiRoutes, type ApiRoute } from './app.js';
import { flushEvents } from './core/events.js';
import { seedTemplateL11 } from './db/seed.js';
import { orthodoxEaster } from './domain/calendar.js';
import { as, createOrg, createUser, dbFor, getApp, type Agent, type TestOrg, type TestUser } from './test/harness.js';

// The spec's scenarios are pinned to T = Friday 07/05/2027, so "today" is pinned as well: Friday 13/11/2026.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T10:00:00Z') });
});
afterAll(() => {
  vi.useRealTimers();
});

const T_DEADLINE = '2027-05-07T12:00:00Z'; // Fri 07/05/2027 15:00 Athens

interface World {
  org: TestOrg;
  admin: TestUser;
  bidManager: TestUser;
  /** role A (participation), B (technical), C (financial) members; MGMT approver; a viewer; all on the team */
  a: TestUser;
  b: TestUser;
  c: TestUser;
  mgmt: TestUser;
  viewer: TestUser;
  templateId: string;
}

/** An organization with its users, the Greek holidays of 2026–2027 (seeded through the API) and «L v1.1». */
async function world(marker = ''): Promise<World> {
  const org = await createOrg(marker ? { name: `${marker} Οργανισμός` } : {});
  const mk = (role: Parameters<typeof createUser>[1], name: string) => createUser(org, role, marker ? { name: `${marker} ${name}`, email: `${marker.toLowerCase()}-${name.toLowerCase()}@example.com` } : {});
  const admin = await mk('admin', 'Admin');
  const api = await as(admin);
  for (const year of [2026, 2027]) {
    const seeded = await api.post('/api/holidays/seed').send({ year });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  }
  const { template } = await seedTemplateL11(dbFor(org));
  return {
    org,
    admin,
    bidManager: await mk('bid_manager', 'Bid'),
    a: await mk('member', 'RoleA'),
    b: await mk('member', 'RoleB'),
    c: await mk('member', 'RoleC'),
    mgmt: await mk('approver', 'Mgmt'),
    viewer: await mk('viewer', 'Viewer'),
    templateId: template.id,
  };
}

const team = (w: World) => [
  { user_id: w.a.id, role_key: 'A' },
  { user_id: w.b.id, role_key: 'B' },
  { user_id: w.c.id, role_key: 'C' },
  { user_id: w.mgmt.id, role_key: 'MGMT' },
  { user_id: w.viewer.id, role_key: null },
];

/** POST /api/tenders from «L v1.1» as the bid manager. */
async function createTender(w: World, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await as(w.bidManager)
    .post('/api/tenders')
    .send({
      title: 'Προμήθεια εξοπλισμού πληροφορικής',
      authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης',
      adam: '27PROC012345678',
      esidis_no: '345678',
      t0_published_at: '2027-03-01',
      submission_deadline_at: T_DEADLINE,
      offer_validity_days: 180,
      has_demo: true,
      has_partners: true,
      template_id: w.templateId,
      members: team(w),
      ...overrides,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.tender.template_version).toBe('v1.1');
  return res.body.tender.id as string;
}

type Item = Record<string, any>;
const byKey = (items: Item[]) => Object.fromEntries(items.map((i) => [i.key, i])) as Record<string, Item>;

async function milestones(api: Agent, tenderId: string): Promise<Record<string, Item>> {
  const res = await api.get(`/api/tenders/${tenderId}/milestones`);
  expect(res.status).toBe(200);
  return byKey(res.body.items);
}
async function gates(api: Agent, tenderId: string): Promise<Record<string, Item>> {
  const res = await api.get(`/api/tenders/${tenderId}/gates`);
  expect(res.status).toBe(200);
  return byKey(res.body.items);
}

const REGISTER_CSV = [
  'Κωδικός,Πηγή,Κείμενο,Τύπος,Φάκελος,Συντελεστής,Υπεύθυνος',
  'ΥΠ-001,"Διακήρυξη §2.2.7, σελ. 31","Ο οικονομικός φορέας διαθέτει πιστοποίηση ISO 9001:2015 σε ισχύ.",Αποκλεισμού,Συμμετοχής,,A',
  'ΥΠ-002,"Παράρτημα Ι, §3.1.4, σελ. 58","Κάθε εξυπηρετητής διαθέτει τουλάχιστον 2 επεξεργαστές και 256 GB μνήμης.",Αποκλεισμού,Τεχνική,,B',
  'ΥΠ-003,"Διακήρυξη §2.3.1, Κ2, σελ. 40","Χρόνος αποκατάστασης βλάβης: βαθμολογείται ο χρόνος κάτω από τις ""8 ώρες"".",Βαθμολογούμενη,Τεχνική,Κ2 – 15%,B',
  'ΥΠ-004,"Διακήρυξη §2.4.4, σελ. 47","Η οικονομική προσφορά υπογράφεται ψηφιακά από τον νόμιμο εκπρόσωπο.",Τυπική,Οικονομική,,C',
  '',
].join('\n');

const importRegister = (api: Agent, tenderId: string, step: 'preview' | 'commit', csv = REGISTER_CSV) =>
  api.post(`/api/tenders/${tenderId}/requirements/import/${step}`).attach('file', Buffer.from(csv, 'utf8'), { filename: 'register.csv', contentType: 'text/csv' });

describe('Κριτήρια αποδοχής (docs/spec.md)', () => {
  it('Ορθόδοξο Πάσχα: 2026 → 12/04, 2027 → 02/05.', async () => {
    expect(orthodoxEaster(2026)).toBe('2026-04-12');
    expect(orthodoxEaster(2027)).toBe('2027-05-02');
    // … and as the API serves it: the movable holidays hang on Π (Π−48, Π−2, Π+1, Π+50)
    const w = await world();
    const api = await as(w.admin);
    const movable = async (year: number) => {
      const res = await api.get('/api/holidays').query({ year });
      expect(res.status).toBe(200);
      return (res.body.items as Item[]).filter((h) => h.source === 'movable').map((h) => h.date);
    };
    expect(await movable(2026)).toEqual(['2026-02-23', '2026-04-10', '2026-04-13', '2026-06-01']);
    expect(await movable(2027)).toEqual(['2027-03-15', '2027-04-30', '2027-05-03', '2027-06-21']);
  });

  it('Για T = Παρασκευή 07/05/2027: G4 = 05/05, G3 = 04/05, G2 = 29/04, G1 = 23/04, G0 αργότερο = 21/04 (παραλείπονται Μ. Παρασκευή 30/04 και Δευτέρα του Πάσχα 03/05).', async () => {
    const w = await world();
    const api = await as(w.bidManager);
    const id = await createTender(w);
    const detail = await api.get(`/api/tenders/${id}`);
    expect(detail.body).toMatchObject({ T: '2027-05-07', tender: { compressed_mode: false } });

    const m = await milestones(api, id);
    expect([m.G4!.due_date, m.G3!.due_date, m.G2!.due_date, m.G1!.due_date]).toEqual(['2027-05-05', '2027-05-04', '2027-04-29', '2027-04-23']);
    expect([m.G4!.tMinus, m.G3!.tMinus, m.G2!.tMinus, m.G1!.tMinus]).toEqual([2, 3, 4, 8]);
    // G0 has a target (T0+3) and a binding latest date (T−10 = 21/04): with T0 = 01/03 the target is what is planned
    expect(m.G0!.computed_from).toMatchObject({ latest_date: '2027-04-21', target_date: '2027-03-04' });
    expect(m.G0!.due_date <= '2027-04-21').toBe(true);
    // with a publication so late that T0+3 is past T−10, G0 sits on its latest date
    const late = await createTender(w, { t0_published_at: '2027-04-19' });
    expect((await milestones(api, late)).G0!.due_date).toBe('2027-04-21');
    // the gates endpoint agrees with the schedule
    const g = await gates(api, id);
    expect([g.G4!.due_date, g.G3!.due_date, g.G2!.due_date, g.G1!.due_date]).toEqual(['2027-05-05', '2027-05-04', '2027-04-29', '2027-04-23']);
    expect([g.G4!.t_minus, g.G1!.t_minus]).toEqual([2, 8]);
  });

  it('Ίδιο σενάριο: τελευταία ημέρα αίτησης εγγυητικής = G4 − 10 ημερολογιακές = Κυριακή 25/04 → Παρασκευή 23/04.', async () => {
    const w = await world();
    const id = await createTender(w);
    const res = await as(w.a).get(`/api/tenders/${id}/watch`);
    expect(res.status).toBe(200);
    const guarantee = (res.body.items as Item[]).find((i) => i.key === 'guarantee')!;
    expect(guarantee).toMatchObject({
      needed_milestone_key: 'G4',
      needed_at: '2027-05-05',
      lead_value: 10,
      lead_unit: 'calendar',
      last_request_date: '2027-04-23',
      request_overdue: false,
      state: 'not_requested',
    });
  });

  it('Διαγωνισμός με 12 εργάσιμες από T0 έως T → compressed_mode = true, G1 και G2 στο T−5.', async () => {
    const w = await world();
    const api = await as(w.bidManager);
    const id = await createTender(w, { t0_published_at: '2027-04-19' }); // 12 working days to Fri 07/05/2027
    const detail = await api.get(`/api/tenders/${id}`);
    expect(detail.body.tender.compressed_mode).toBe(true);
    const warning = (detail.body.warnings as Item[]).find((x) => x.code === 'compressed_mode');
    expect(warning).toMatchObject({ severity: 'orange', data: { workingDays: 12 } });
    const m = await milestones(api, id);
    expect([m.G1!.due_date, m.G2!.due_date]).toEqual(['2027-04-28', '2027-04-28']);
    expect([m.G1!.tMinus, m.G2!.tMinus]).toEqual([5, 5]);
    // with 15 working days (T0 = 14/04) the mode is not compressed
    expect((await api.get(`/api/tenders/${await createTender(w, { t0_published_at: '2027-04-14' })}`)).body.tender.compressed_mode).toBe(false);
    // the dashboard shows the orange warning
    const dash = await api.get('/api/dashboard');
    expect((dash.body.tenders as Item[]).find((t) => t.id === id)).toMatchObject({ compressedMode: true });
    expect((dash.body.attention as Item[]).some((x) => x.tenderId === id && x.code === 'compressed' && x.tone === 'orange')).toBe(true);
  });

  it('Παράταση +5 εργάσιμες: μετακινούνται μόνο τα μη χειροκίνητα και μη ολοκληρωμένα milestones · δημιουργείται change_entry.', async () => {
    const w = await world();
    const api = await as(w.bidManager);
    const id = await createTender(w);
    const before = await milestones(api, id);
    // G2 is pinned by hand; the upload milestone is completed
    expect((await api.patch(`/api/tenders/${id}/milestones/${before.G2!.id}`).send({ due_date: '2027-04-27' })).status).toBe(200);
    expect((await api.patch(`/api/tenders/${id}/milestones/${before.UPLOAD!.id}`).send({ done: true })).status).toBe(200);
    const pinned = await milestones(api, id);

    const NEW = '2027-05-14T12:00:00Z'; // Fri 14/05/2027 = +5 working days
    const preview = await api.post(`/api/tenders/${id}/deadline/preview`).send({ submission_deadline_at: NEW });
    expect(preview.body).toMatchObject({ oldT: '2027-05-07', newT: '2027-05-14', shiftWorkingDays: 5 });
    expect(await milestones(api, id)).toEqual(pinned); // the preview saves nothing
    expect((await api.get(`/api/tenders/${id}/changes`)).body.items).toEqual([]);

    const ext = await api.post(`/api/tenders/${id}/deadline`).send({ submission_deadline_at: NEW, source: 'esidis' });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    await flushEvents();
    const after = await milestones(api, id);
    const moved = Object.keys(after).filter((k) => after[k]!.due_date !== pinned[k]!.due_date).sort();
    // every T-anchored milestone that is neither manual nor done moved by 5 working days …
    expect(after).toMatchObject({ G1: { due_date: '2027-05-04' }, G3: { due_date: '2027-05-11' }, G4: { due_date: '2027-05-12' } });
    for (const key of ['G1', 'G3', 'G4']) expect(moved).toContain(key);
    // … the manual one stayed and is flagged for review, the completed one stayed and is not
    expect(after.G2).toMatchObject({ due_date: '2027-04-27', is_manual: true, needs_review: true });
    expect(after.UPLOAD).toMatchObject({ due_date: pinned.UPLOAD!.due_date, needs_review: false });
    expect(after.UPLOAD!.done_at).not.toBeNull();
    for (const key of moved) expect([key, after[key]!.is_manual, after[key]!.done_at]).toEqual([key, false, null]);
    // what mirrors a milestone follows it (R6 input)
    const guarantee = ((await api.get(`/api/tenders/${id}/watch`)).body.items as Item[]).find((i) => i.key === 'guarantee')!;
    expect(guarantee).toMatchObject({ needed_at: '2027-05-12', last_request_date: '2027-04-29' });

    const changes = (await api.get(`/api/tenders/${id}/changes`)).body.items as Item[];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'extension', source: 'esidis', date: '2026-11-13', owner_user_id: w.bidManager.id });
    expect((await api.get(`/api/tenders/${id}`)).body).toMatchObject({ T: '2027-05-14' });
  });

  it('Απόφαση πύλης με ανεκπλήρωτο κριτήριο χωρίς αιτιολόγηση → απορρίπτεται από το API.', async () => {
    const w = await world();
    const id = await createTender(w);
    const approver = await as(w.mgmt);
    const g = await gates(approver, id);
    const g2 = g.G2!;
    expect(g2).toMatchObject({ approver_user_id: w.mgmt.id, decision: 'pending', all_met: false, permissions: { can_decide: true } });
    const decide = (gateId: string, body: Record<string, unknown>, api: Agent = approver) => api.post(`/api/tenders/${id}/gates/${gateId}/decision`).send(body);

    const plain = await decide(g2.id, { decision: 'approved' });
    expect([plain.status, plain.body.error.code]).toEqual([422, 'criteria_unmet']);
    expect(plain.body.error.details.unmet.length).toBeGreaterThan(0);
    for (const justification of [undefined, '', '   ', 'πολύ σύντομη']) {
      const res = await decide(g2.id, { decision: 'approved_with_exception', justification });
      expect([justification, res.status, res.body.error.code]).toEqual([justification, 422, 'justification_too_short']);
    }
    // G0 (Go / No-Go): a Go over unmet criteria without a justification is refused as well
    const go = await decide(g.G0!.id, { decision: 'go' });
    expect([go.status, go.body.error.code]).toEqual([422, 'criteria_unmet']);
    // nobody but the approver decides (R11) — not even the bid manager
    const other = await decide(g2.id, { decision: 'approved_with_exception', justification: 'Αιτιολόγηση με αρκετούς χαρακτήρες.' }, await as(w.bidManager));
    expect([other.status, other.body.error.code]).toEqual([403, 'not_gate_approver']);
    expect((await gates(approver, id)).G2).toMatchObject({ decision: 'pending', decided_at: null });

    // with a justification of ≥ 20 characters the exception passes and is written to the audit log (R12)
    const justification = 'Η τιμή εγκρίνεται· εκκρεμεί μόνο η τελική προσφορά υπεργολάβου.';
    const ok = await decide(g2.id, { decision: 'approved_with_exception', justification });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.gate).toMatchObject({ decision: 'approved_with_exception', exception: true, justification });
    const audit = await as(w.admin).get('/api/audit').query({ entity: 'gate', entity_id: g2.id });
    const entry = (audit.body.items as Item[]).find((x) => x.action === 'exception');
    expect(entry).toMatchObject({ user_id: w.mgmt.id, after: { decision: 'approved_with_exception', justification } });
  });

  it('Viewer ή υπεύθυνος τεχνικής που ζητά οικονομικό αρχείο με απευθείας URL → 403.', async () => {
    const w = await world();
    const id = await createTender(w);
    const upload = await as(w.c)
      .post(`/api/tenders/${id}/files`)
      .field('folder', 'financial')
      .attach('files', Buffer.from('ΤΙΜΕΣ: 1.234.567,89 €'), { filename: 'oikonomiki-prosfora.xlsx', contentType: 'application/vnd.ms-excel' });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const file = upload.body.items[0] as Item;
    expect(file).toMatchObject({ folder: 'financial', confidentiality: 'financial' });
    const url = `/api/tenders/${id}/files/${file.id}`;

    for (const [who, user] of [['viewer', w.viewer], ['technical (B)', w.b], ['participation (A)', w.a]] as const) {
      const api = await as(user);
      for (const path of [`${url}/download`, url]) {
        const res = await api.get(path);
        expect([who, path, res.status, res.body.error?.code]).toEqual([who, path, 403, 'financial_restricted']);
        expect(res.text).not.toContain('1.234.567');
      }
      // … and it is not in their listing, nor can they change or delete it
      const list = await api.get(`/api/tenders/${id}/files`);
      expect([who, list.body.can_see_financial, (list.body.items as Item[]).map((f) => f.id)]).toEqual([who, false, []]);
      expect((await api.get(`/api/tenders/${id}`)).body.permissions.canSeeFinancial).toBe(false);
      expect([403]).toContain((await api.patch(url).send({ folder: 'other' })).status);
      expect([403]).toContain((await api.delete(url)).status);
    }
    // the financial-role holder, the approver on the team, the bid manager and the admin do get it (R18)
    for (const user of [w.c, w.mgmt, w.bidManager, w.admin]) {
      const res = await as(user).get(`${url}/download`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect((res.body as Buffer).toString('utf8')).toBe('ΤΙΜΕΣ: 1.234.567,89 €');
    }
    // a user of the organization who is not on the team cannot even reach the tender
    expect((await as(await createUser(w.org, 'approver')).get(`${url}/download`)).status).toBe(403);
  });

  it('Import register δύο φορές με το ίδιο αρχείο → καμία διπλή γραμμή.', async () => {
    const w = await world();
    const id = await createTender(w);
    const api = await as(w.b);
    const preview = await importRegister(api, id, 'preview');
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect((await api.get(`/api/tenders/${id}/requirements`)).body.items).toEqual([]); // the preview writes nothing

    const first = await importRegister(api, id, 'commit');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ created: 4, updated: 0, unchanged: 0, total: 4 });
    const rows = (await api.get(`/api/tenders/${id}/requirements`)).body.items as Item[];
    expect(rows.map((r) => r.code)).toEqual(['ΥΠ-001', 'ΥΠ-002', 'ΥΠ-003', 'ΥΠ-004']);

    const second = await importRegister(api, id, 'commit');
    expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: 4, total: 4 });
    const again = (await api.get(`/api/tenders/${id}/requirements`)).body.items as Item[];
    expect(again.map((r) => [r.id, r.code, r.updated_at])).toEqual(rows.map((r) => [r.id, r.code, r.updated_at]));
    // the same codes written differently are still the same rows (R17: code unique per tender, upsert by code)
    const variant = REGISTER_CSV.replace('ΥΠ-001', 'υπ 1').replace('ΥΠ-002', 'YP-2');
    expect((await importRegister(api, id, 'commit', variant)).body).toMatchObject({ created: 0, total: 4 });
    expect(((await api.get(`/api/tenders/${id}/requirements`)).body.items as Item[]).length).toBe(4);
    const dup = await api.post(`/api/tenders/${id}/requirements`).send({ code: 'ΥΠ-001', text: 'διπλή', type: 'formal' });
    expect(dup.status).toBe(409);
  });

  it('Έγγραφο με λήξη πριν το T, συνδεδεμένο με διαγωνισμό → κόκκινο στο dashboard και αποτυχία του `docs_valid_on_T`.', async () => {
    const w = await world();
    const id = await createTender(w);
    const manager = await as(w.bidManager);
    const doc = async (title: string, expires_at: string) => {
      const res = await manager.post('/api/company-documents').send({ type: 'iso', title, issued_at: '2024-05-06', expires_at });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as Item;
    };
    const valid = await doc('ISO 27001', '2027-05-07'); // expires on T itself: still valid on submission day
    const expiring = await doc('ISO 9001', '2027-05-06'); // the day before T

    const docsRule = async () => ((await gates(manager, id)).G4!.criteria as Item[]).find((c) => c.auto_rule === 'docs_valid_on_T')!;
    const redOnDashboard = async (user: TestUser) => {
      const dash = await as(user).get('/api/dashboard');
      return {
        attention: (dash.body.attention as Item[]).filter((x) => x.tenderId === id && x.code === 'documents_expiring'),
        card: ((dash.body.tenders as Item[]).find((t) => t.id === id)?.warnings as Item[]).filter((x) => x.code === 'documents_expiring'),
      };
    };

    expect((await manager.post(`/api/tenders/${id}/documents`).send({ company_document_id: valid.id })).status).toBe(201);
    expect((await docsRule()).satisfied).toBe(true);
    expect((await redOnDashboard(w.bidManager)).attention).toEqual([]);

    const link = await manager.post(`/api/tenders/${id}/documents`).send({ company_document_id: expiring.id });
    expect(link.status).toBe(201);
    expect(link.body.expires_before_T).toBe(true);

    // red on the dashboard — for the bid manager and for a member of the team
    for (const user of [w.bidManager, w.a]) {
      const red = await redOnDashboard(user);
      expect(red.attention).toHaveLength(1);
      expect(red.attention[0]).toMatchObject({ tone: 'red', tab: 'documents', params: { count: 1, titles: ['ISO 9001'], firstExpiry: '2027-05-06', T: '2027-05-07' } });
      expect(red.card).toHaveLength(1);
    }
    // red on the tender itself and in its documents tab
    const detail = await manager.get(`/api/tenders/${id}`);
    expect((detail.body.warnings as Item[]).find((x) => x.code === 'documents_expired_on_T')).toMatchObject({ severity: 'red', data: { count: 1 } });
    const tab = await manager.get(`/api/tenders/${id}/documents`);
    expect(tab.body.expired_count).toBe(1);
    expect((tab.body.items as Item[]).filter((d) => d.expires_before_T).map((d) => d.id)).toEqual([expiring.id]);

    // the automatic G4 criterion fails, and with it a plain approval of G4
    const rule = await docsRule();
    expect(rule).toMatchObject({ type: 'auto', satisfied: false });
    expect(rule.detail).toMatchObject({ missing: 1 });
    const g4 = (await gates(manager, id)).G4!;
    const decision = await as(w.mgmt).post(`/api/tenders/${id}/gates/${g4.id}/decision`).send({ decision: 'approved' });
    expect([decision.status, decision.body.error.code]).toEqual([422, 'criteria_unmet']);
    expect((decision.body.error.details.unmet as Item[]).map((u) => u.auto_rule)).toContain('docs_valid_on_T');

    // renewing the document (or unlinking it) clears both
    expect((await manager.patch(`/api/company-documents/${expiring.id}`).send({ expires_at: '2028-05-06' })).status).toBe(200);
    expect((await docsRule()).satisfied).toBe(true);
    expect((await redOnDashboard(w.bidManager)).attention).toEqual([]);
  });

  describe('Κάθε query περνά από το scoped data layer: test με δεύτερο org στη βάση δείχνει ότι κανένα endpoint δεν επιστρέφει δεδομένα του.', () => {
    /** Ids of one organization's resources, by the route parameter they are used for. */
    interface Ids {
      tender: string;
      gate: string;
      criterion: string;
      milestone: string;
      requirement: string;
      task: string;
      watch: string;
      risk: string;
      change: string;
      lesson: string;
      file: string;
      companyDocument: string;
      template: string;
      templateItem: string;
      user: string;
      invitation: string;
      holiday: string;
    }

    /** Fills an organization with at least one row behind every route, all through the API. */
    async function populate(w: World, marker: string): Promise<Ids> {
      const admin = await as(w.admin);
      const manager = await as(w.bidManager);
      const ok = (res: { status: number; body: unknown }, ...statuses: number[]) => {
        expect(statuses.length ? statuses : [200, 201], JSON.stringify(res.body)).toContain(res.status);
        return res.body as Item;
      };
      const tender = await createTender(w, { title: `${marker} Διαγωνισμός`, authority: `${marker} Αναθέτουσα`, notes: `${marker} σημειώσεις`, adam: `${marker}-ADAM` });
      const base = `/api/tenders/${tender}`;

      ok(await importRegister(manager, tender, 'commit', REGISTER_CSV.replaceAll('σελ.', `${marker} σελ.`)));
      const requirement = (ok(await manager.get(`${base}/requirements`)).items as Item[])[0]!;
      ok(await manager.patch(`${base}/requirements/${requirement.id}`).send({ evidence_ref: `${marker} Παράρτημα Β`, status: 'covered' }));
      const task = ok(await manager.post(`${base}/tasks`).send({ title: `${marker} task`, owner_user_id: w.b.id, due_date: '2026-11-10' }));
      const watch = ok(await manager.post(`${base}/watch`).send({ name: `${marker} watch`, lead_value: 3, lead_unit: 'working', needed_at: '2026-11-12' }));
      const risk = ok(await manager.post(`${base}/risks`).send({ title: `${marker} risk`, trigger: `${marker} trigger` }));
      const change = ok(await manager.post(`${base}/changes`).send({ description: `${marker} διευκρίνιση`, kind: 'clarification', source: 'esidis', requirement_ids: [requirement.id] }));
      const lesson = ok(await manager.post(`${base}/lessons`).send({ text: `${marker} μάθημα`, changes_template: true }));
      const files = ok(
        await manager.post(`${base}/files`).field('folder', 'financial').field('label', `${marker} label`).attach('files', Buffer.from(`${marker} τιμές`), `${marker}-times.txt`),
      );
      ok(await manager.post(`${base}/files`).field('folder', 'tender_docs').attach('files', Buffer.from(`${marker} διακήρυξη`), `${marker}-diakiryxi.txt`));
      const doc = ok(await manager.post('/api/company-documents').send({ type: 'iso', title: `${marker} ISO 9001`, expires_at: '2026-11-20', notes: `${marker} notes` }));
      ok(await manager.put(`/api/company-documents/${doc.id}/file`).attach('file', Buffer.from(`${marker} πιστοποιητικό`), `${marker}-iso.txt`));
      const cv = ok(await manager.post('/api/company-documents').send({ type: 'cv', title: `${marker} CV`, person_name: `${marker} Πρόσωπο` }));
      ok(await manager.post(`${base}/documents`).send({ company_document_id: doc.id }));
      ok(await manager.post(`${base}/documents`).send({ company_document_id: cv.id }));

      const gateList = await gates(manager, tender);
      const g0 = gateList.G0!;
      const criterion = (g0.criteria as Item[]).find((c) => c.type === 'manual')!;
      ok(await manager.patch(`${base}/gates/${g0.id}/criteria/${criterion.id}`).send({ checked: true, note: `${marker} σημείωση` }));
      ok(await manager.post(`${base}/gates/${g0.id}/request`));
      ok(await as(w.mgmt).post(`${base}/gates/${g0.id}/decision`).send({ decision: 'go', justification: `${marker} προχωράμε παρά τις εκκρεμότητες` }));
      const handoff = (ok(await manager.get(`${base}/tasks`)).items as Item[]).find((t) => t.section === 'handoff' && t.handoff_from_role === 'B');
      if (handoff) ok(await as(w.b).post(`${base}/tasks/${handoff.id}/deliver`).send({ note: `${marker} παράδοση` }));
      ok(await manager.post(`${base}/deadline`).send({ submission_deadline_at: '2027-05-14T12:00:00Z', description: `${marker} παράταση` }));
      const milestone = (await milestones(manager, tender)).G3!;

      const template = ok(await admin.post(`/api/templates/${w.templateId}/new-version`).send({ description: `${marker} νέα έκδοση` }));
      const templateItem = ok(await admin.post(`/api/templates/${template.id}/items`).send({ kind: 'checklist_item', key: 'ZZ1', name: `${marker} έλεγχος`, owner_role_key: 'A' }));
      const invitation = ok(await admin.post('/api/admin/invitations').send({ email: `${marker.toLowerCase()}-invited@example.com`, org_role: 'member' })).invitation as Item;
      const holiday = ok(await admin.post('/api/holidays').send({ date: '2027-06-01', name: `${marker} αργία` }));
      ok(await admin.put('/api/notifications/preferences').send({ digest: true }), 200, 400);
      ok(await admin.post('/api/notifications/digest/run'));
      ok(await admin.post(`/api/admin/users/${w.viewer.id}/reset-password`));
      await flushEvents();
      return {
        tender,
        gate: g0.id,
        criterion: criterion.id,
        milestone: milestone.id,
        requirement: requirement.id,
        task: task.id,
        watch: watch.id,
        risk: risk.id,
        change: change.id,
        lesson: lesson.id,
        file: (files.items as Item[])[0]!.id,
        companyDocument: doc.id,
        template: template.id,
        templateItem: templateItem.id,
        user: w.b.id,
        invitation: invitation.id,
        holiday: holiday.id,
      };
    }

    /** Which resource a route parameter names — by the route it appears in. A new parameter must be added here. */
    function paramKind(route: ApiRoute, param: string): keyof Ids {
      const p = route.path;
      if (param === 'tenderId') return 'tender';
      if (param === 'gateId') return 'gate';
      if (param === 'criterionId') return 'criterion';
      if (param === 'milestoneId') return 'milestone';
      if (param === 'fileId') return 'file';
      if (param === 'documentId') return 'companyDocument';
      if (param === 'itemId') return 'templateItem';
      if (param === 'id') {
        const tenderModule = /^\/api\/tenders\/:tenderId\/([a-z-]+)\//.exec(p)?.[1];
        const byModule: Record<string, keyof Ids> = { requirements: 'requirement', tasks: 'task', watch: 'watch', risks: 'risk', changes: 'change', lessons: 'lesson' };
        if (tenderModule && byModule[tenderModule]) return byModule[tenderModule];
        if (p.startsWith('/api/tenders/:id')) return 'tender';
        if (p.startsWith('/api/templates/:id')) return 'template';
        if (p.startsWith('/api/company-documents/:id')) return 'companyDocument';
        if (p.startsWith('/api/admin/users/:id')) return 'user';
        if (p.startsWith('/api/admin/invitations/:id')) return 'invitation';
        if (p.startsWith('/api/holidays/:id')) return 'holiday';
      }
      throw new Error(`acceptance sweep: unknown route parameter :${param} in ${route.method} ${p} — teach paramKind() about it`);
    }
    const paramsOf = (route: ApiRoute) => [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
    const fill = (route: ApiRoute, pick: (param: string, index: number) => string) => {
      let i = 0;
      return route.path.replace(/:(\w+)/g, (_m, param: string) => pick(param, i++));
    };
    const send = (api: Agent, route: ApiRoute, url: string) => {
      const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const req = api[method](url).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      return method === 'get' ? req : req.send({});
    };
    const bodyText = (res: { body: unknown; headers: Record<string, string> }) =>
      `${JSON.stringify(res.headers)}\n${Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body)}`;
    const jsonOf = (res: { body: unknown }) => JSON.parse(Buffer.isBuffer(res.body) && res.body.length ? res.body.toString('utf8') : '{}') as Item;

    /** Every uuid and every marker string that belongs to org A, read straight from the database. */
    async function fingerprints(org: TestOrg, marker: string): Promise<{ needles: string[]; rowCount: number }> {
      const db = dbFor(org);
      const tables = await db.sql<{ table_name: string }>(
        `SELECT c.table_name FROM information_schema.columns c
          WHERE c.table_schema = current_schema() AND c.column_name = 'org_id' AND CAST(:org_id AS text) IS NOT NULL
          ORDER BY c.table_name`,
      );
      const ids = new Set<string>([org.id]);
      let rowCount = 0;
      for (const { table_name } of tables) {
        if (!/^[a-z_]+$/.test(table_name)) continue;
        const rows = await db.sql<{ id: string }>(`SELECT CAST(id AS text) AS id FROM "${table_name}" WHERE org_id = :org_id`);
        rowCount += rows.length;
        for (const r of rows) if (/^[0-9a-f-]{36}$/.test(r.id)) ids.add(r.id);
      }
      expect(tables.length).toBeGreaterThan(25);
      return { needles: [...ids, marker, marker.toLowerCase(), org.name], rowCount };
    }

    it('σάρωση όλων των routes του express app: κανένα GET δεν επιστρέφει id ή κείμενο του org A, και κάθε id του org A σε αίτημα του org B δίνει 404/403', async () => {
      const A = await world('ZZALPHA');
      const B = await world('QQBETA');
      const a = await populate(A, 'ZZALPHA');
      const b = await populate(B, 'QQBETA');
      const { needles, rowCount } = await fingerprints(A.org, 'ZZALPHA');
      expect(needles.length).toBeGreaterThan(300);
      const auditBefore = await dbFor(A.org).count('audit_log', {});

      // the route list really is every route of the app (walks the express router stack)
      const routes = listApiRoutes();
      const stack = (getApp() as unknown as { router: { stack: Parameters<typeof countRoutes>[0] } }).router.stack;
      expect(routes.length).toBe(countRoutes(stack));
      const getRoutes = routes.filter((r) => r.method === 'GET');
      expect(getRoutes.length).toBeGreaterThan(40);

      const leaks: string[] = [];
      const check = (who: string, route: ApiRoute, url: string, res: { status: number; body: unknown; headers: Record<string, string> }) => {
        const text = bodyText(res);
        for (const needle of needles) if (text.includes(needle)) leaks.push(`${who}: ${route.method} ${url} → ${res.status} contains "${needle}"`);
      };

      const users: [string, Agent][] = [
        ['admin of B', await as(B.admin)],
        ['bid manager of B', await as(B.bidManager)],
        ['member of B', await as(B.b)],
      ];

      // 1. B's own view: every GET with B's own ids. For B's admin each one must actually return data (200) — so the
      //    sweep cannot pass by hitting nothing — and no response may carry anything of A.
      for (const [who, api] of users) {
        for (const route of getRoutes) {
          const url = fill(route, (param) => b[paramKind(route, param)]);
          const res = await send(api, route, url);
          check(who, route, url, res);
          if (who === 'admin of B') expect([route.path, res.status], bodyText(res).slice(0, 400)).toEqual([route.path, 200]);
          else expect([200, 403, 404], `${who} ${route.path}`).toContain(res.status);
        }
        // list endpoints filtered by A's ids return nothing of A either
        for (const url of [
          `/api/audit?tender_id=${a.tender}`,
          `/api/audit?entity_id=${a.requirement}`,
          `/api/audit?user_id=${A.admin.id}`,
          `/api/tenders?q=ZZALPHA`,
          `/api/company-documents?type=iso&include_archived=true`,
          `/api/notifications/log`,
        ]) {
          const res = await send(api, { method: 'GET', path: url }, url);
          check(who, { method: 'GET', path: url }, url, res);
          if (res.status === 200 && url.startsWith('/api/audit?')) expect(jsonOf(res).items, url).toEqual([]);
        }
      }

      // 2. A's ids in B's requests, on every route that takes an id (all methods):
      //    (a) every parameter is A's; (b) B's own parent with A's child (the confused-deputy case).
      const parametrised = routes.filter((r) => paramsOf(r).length > 0);
      expect(parametrised.length).toBeGreaterThan(70);
      for (const [who, api] of users) {
        for (const route of parametrised) {
          const variants = new Set<string>([fill(route, (param) => a[paramKind(route, param)])]);
          if (paramsOf(route).length > 1) {
            variants.add(fill(route, (param, i) => (i === 0 ? b : a)[paramKind(route, param)]));
            variants.add(fill(route, (param, i) => (i === paramsOf(route).length - 1 ? a : b)[paramKind(route, param)]));
          }
          for (const url of variants) {
            const res = await send(api, route, url);
            check(who, route, url, res);
            // a GET never finds it; a write may also be stopped earlier by a role check, CSRF-free validation (400)
            // or a state rule of B's OWN parent (409/422) — but it is never served
            const allowed = route.method === 'GET' ? [404, 403] : [404, 403, 400, 409, 422];
            expect(allowed, `${who}: ${route.method} ${url} → ${res.status} ${bodyText(res).slice(0, 300)}`).toContain(res.status);
            if (who === 'admin of B' && route.method === 'GET') expect([route.method, url, res.status]).toEqual([route.method, url, 404]);
          }
        }
      }
      // linking A's company document to B's tender, by id in the body
      const link = await users[0]![1].post(`/api/tenders/${b.tender}/documents`).send({ company_document_id: a.companyDocument });
      expect(link.status).toBe(404);
      const members = await users[0]![1].put(`/api/tenders/${b.tender}/members`).send({ members: [{ user_id: A.b.id, role_key: 'B' }] });
      expect([members.status, members.body.error?.code]).toEqual([422, 'unknown_user']);
      const approver = await users[0]![1].patch(`/api/tenders/${b.tender}/gates/${b.gate}`).send({ approver_user_id: A.mgmt.id });
      expect([404, 409, 422]).toContain(approver.status);
      const createFromForeignTemplate = await users[0]![1].post('/api/tenders').send({ title: 'x', authority: 'y', submission_deadline_at: T_DEADLINE, template_id: A.templateId });
      expect([createFromForeignTemplate.status, createFromForeignTemplate.body.error?.code]).toEqual([422, 'template_not_found']);

      expect(leaks).toEqual([]);
      // nothing of A changed while B was hammering at it
      await flushEvents();
      expect(await dbFor(A.org).count('audit_log', {})).toBe(auditBefore);
      expect((await fingerprints(A.org, 'ZZALPHA')).rowCount).toBe(rowCount);
      // sanity: A itself does see its own data through the same routes
      const own = await (await as(A.admin)).get(`/api/tenders/${a.tender}`);
      expect(JSON.stringify(own.body)).toContain('ZZALPHA');
    }, 180_000);
  });
});
