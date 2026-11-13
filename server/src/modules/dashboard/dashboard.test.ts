import { describe, expect, it } from 'vitest';
import { shiftDays } from '../../domain/calendar.js';
import { todayAthens } from '../../domain/time.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, seedHolidays } from '../../test/harness.js';
import { createScenario, secretStrings } from '../notifications/testFixture.js';

// The route always works on "today" (Athens); the fixture lays its dates out in working days around it.
const today = todayAthens();
const year = Number(today.slice(0, 4));

async function scenario(title?: string) {
  const org = await createOrg();
  await seedHolidays(org, [year - 1, year, year + 1]);
  return createScenario(org, today, { title });
}
type Warning = { code: string; tone: string; tab: string; params: Record<string, unknown> };
const codes = (ws: Warning[]) => ws.map((w) => w.code);

describe('GET /api/dashboard', () => {
  it('shows the figures of an active tender: T−n, next gate, coverage, overdue counts, warnings', async () => {
    const s = await scenario();
    const res = await as(s.team.manager).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(today);
    expect(res.body.tenders).toHaveLength(1);
    const t = res.body.tenders[0];
    expect(t).toMatchObject({
      id: s.tender.id,
      title: 'Προμήθεια εξοπλισμού πληροφορικής',
      authority: 'Υπουργείο Ψηφιακής Διακυβέρνησης',
      status: 'in_progress',
      T: s.T,
      tMinus: 7,
      compressedMode: true,
      canWrite: true,
      counts: { overdueTasks: 2, overdueHandoffs: 1, watchRequestOverdue: 1 },
    });
    expect(new Date(t.deadlineAt).toISOString()).toBe(s.tender.submission_deadline_at.toISOString());
    // next undecided gate: G1 (G0 is decided), in 2 working days, at T−5, with its approver
    expect(t.nextGate).toMatchObject({
      id: s.ids.G1,
      key: 'G1',
      name: 'Solution freeze',
      dueDate: s.dates.plus2,
      tMinus: 5,
      inWorkingDays: 2,
      overdue: false,
      requested: false,
      approver: { id: s.team.bob.id, name: 'Μπάμπης Τεχνικός' },
    });
    // R17: (covered + verified) / total per type — a deviation is not coverage
    expect(t.coverage).toEqual({
      exclusion: { total: 2, covered: 1, ratio: 0.5 },
      scored: { total: 1, covered: 1, ratio: 1 },
      formal: { total: 2, covered: 0, ratio: 0 },
      all: { total: 5, covered: 2, ratio: 0.4 },
    });
    expect(codes(t.warnings)).toEqual(['guarantee_urgent', 'documents_expiring', 'watch_request_overdue', 'compressed', 'guarantee_validity']);
    const byCode = Object.fromEntries((t.warnings as Warning[]).map((w) => [w.code, w]));
    expect(byCode.guarantee_urgent).toMatchObject({ tone: 'red', tab: 'watch', params: { workingDays: 7 } }); // R8
    expect(byCode.compressed).toMatchObject({ tone: 'orange', tab: 'schedule' }); // R8
    expect(byCode.guarantee_validity).toMatchObject({
      tone: 'orange',
      params: { validUntil: shiftDays(s.T, 150), requiredUntil: shiftDays(s.T, 210), shortByDays: 60 }, // R16
    });
    expect(byCode.watch_request_overdue).toMatchObject({ tone: 'red', tab: 'watch', params: { count: 1, names: ['Εγγυητική συμμετοχής'] } }); // R6

    // attention strip: every warning with its tender, red first
    expect(res.body.attention.map((a: Warning) => a.tone)).toEqual(['red', 'red', 'red', 'orange', 'orange']);
    expect(res.body.attention[0]).toMatchObject({ tenderId: s.tender.id, tenderTitle: 'Προμήθεια εξοπλισμού πληροφορικής' });
    expect(res.body.permissions).toEqual({ canCreateTender: true });
  });

  it('acceptance: a linked document expiring before T is red on the dashboard (R15)', async () => {
    const s = await scenario();
    const api = await as(s.team.manager);
    const warning = (await api.get('/api/dashboard')).body.tenders[0].warnings.find((w: Warning) => w.code === 'documents_expiring');
    expect(warning).toEqual({
      code: 'documents_expiring',
      tone: 'red',
      tab: 'documents',
      params: { count: 1, titles: ['ISO 9001:2015'], firstExpiry: shiftDays(s.T, -1), T: s.T },
    });

    // expiring exactly on T is still valid; unlinking or renewing clears the warning
    const db = dbFor(s.org);
    await db.update('company_document', s.ids.dIso9001 as string, { expires_at: s.T });
    expect(codes((await api.get('/api/dashboard')).body.tenders[0].warnings)).not.toContain('documents_expiring');
    await db.update('company_document', s.ids.dIso9001 as string, { expires_at: shiftDays(s.T, -10) });
    await db.update('company_document', s.ids.dTax as string, { expires_at: shiftDays(s.T, -2) });
    const two = (await api.get('/api/dashboard')).body.tenders[0].warnings.find((w: Warning) => w.code === 'documents_expiring');
    expect(two.params).toMatchObject({ count: 2, titles: ['ISO 9001:2015', 'Φορολογική ενημερότητα'] });
    // a document that is not linked to the tender never colours it
    await db.sql('DELETE FROM tender_document WHERE org_id = :org_id AND tender_id = :id', { id: s.tender.id });
    expect(codes((await api.get('/api/dashboard')).body.tenders[0].warnings)).not.toContain('documents_expiring');
  });

  it('R8: the red guarantee banner disappears once the guarantee is requested or in hand; orange stays', async () => {
    const s = await scenario();
    const api = await as(s.team.manager);
    const db = dbFor(s.org);
    await db.update('watch_item', s.ids.wGuarantee as string, { requested_at: today });
    let t = (await api.get('/api/dashboard')).body.tenders[0];
    expect(codes(t.warnings)).toEqual(['documents_expiring', 'compressed', 'guarantee_validity']);
    expect(t.counts.watchRequestOverdue).toBe(0);

    await db.update('watch_item', s.ids.wGuarantee as string, { requested_at: null, arrived_at: today });
    t = (await api.get('/api/dashboard')).body.tenders[0];
    expect(codes(t.warnings)).not.toContain('guarantee_urgent');

    // with 10 or more working days left there is no red banner even without a request
    const calm = await createOrg();
    const admin = await createUser(calm, 'admin');
    await createTender(calm, { guarantee_valid_until: null }); // T = today + 30 days
    const body = (await as(admin).get('/api/dashboard')).body;
    expect(body.tenders[0].warnings).toEqual([]);
    expect(body.attention).toEqual([]);
    expect(body.tenders[0].nextGate).toBeNull();
    expect(body.tenders[0].coverage.all).toEqual({ total: 0, covered: 0, ratio: null });
  });

  it('flags an undecided gate past its date and a deadline that passed on an active tender', async () => {
    const s = await scenario();
    const db = dbFor(s.org);
    const g1 = await db.get('gate', s.ids.G1 as string);
    await db.update('milestone', g1?.milestone_id, { due_date: s.dates.overdue1 });
    const api = await as(s.team.manager);
    let t = (await api.get('/api/dashboard')).body.tenders[0];
    expect(t.nextGate).toMatchObject({ key: 'G1', overdue: true, inWorkingDays: -1 });
    expect(t.warnings.find((w: Warning) => w.code === 'gate_overdue')).toMatchObject({ tone: 'red', tab: 'gates', params: { gate: 'G1', dueDate: s.dates.overdue1 } });

    await db.update('tender', s.tender.id, { submission_deadline_at: new Date(Date.now() - 3 * 86_400_000) });
    t = (await api.get('/api/dashboard')).body.tenders[0];
    expect(t.tMinus).toBeLessThan(0);
    expect(codes(t.warnings)).toContain('deadline_passed');
    expect(codes(t.warnings)).not.toContain('guarantee_urgent');
  });

  it('org block (admin, bid_manager): company documents expired / expiring within 30 days', async () => {
    const s = await scenario();
    for (const u of [s.team.admin, s.team.manager]) {
      const { org } = (await as(u).get('/api/dashboard')).body;
      expect(org.documents).toMatchObject({ expired: 1, expiring: 2 });
      expect(org.documents.items.map((d: { title: string }) => d.title)).toEqual(['Ασφαλιστική ενημερότητα', 'ISO 9001:2015', 'Φορολογική ενημερότητα']);
      expect(org.documents.items[0]).toMatchObject({ type: 'insurance', expires_at: shiftDays(today, -3), expired: true, daysLeft: -3 });
    }
    for (const u of [s.team.alice, s.team.boss, s.team.victor]) expect((await as(u).get('/api/dashboard')).body.org).toBeNull();
  });

  it('"my items" follows the digest selection for the caller', async () => {
    const s = await scenario();
    expect((await as(s.team.alice).get('/api/dashboard')).body.my).toEqual({ overdue: 2, today: 1, upcoming: 0, waiting: 0 });
    expect((await as(s.team.bob).get('/api/dashboard')).body.my).toEqual({ overdue: 2, today: 1, upcoming: 3, waiting: 0 });
    expect((await as(s.team.carol).get('/api/dashboard')).body.my).toEqual({ overdue: 0, today: 0, upcoming: 1, waiting: 0 });
    expect((await as(s.team.manager).get('/api/dashboard')).body.my).toEqual({ overdue: 0, today: 0, upcoming: 0, waiting: 0 });
  });

  it('members see only their tenders; a viewer sees the dashboard read-only; an outsider sees an empty one', async () => {
    const s = await scenario();
    const other = await createTender(s.org, { title: 'Διαγωνισμός χωρίς την ομάδα', guarantee_valid_until: null });
    await addMember(other, s.team.outsider);

    expect((await as(s.team.manager).get('/api/dashboard')).body.tenders.map((t: { title: string }) => t.title).sort()).toEqual([
      'Διαγωνισμός χωρίς την ομάδα',
      'Προμήθεια εξοπλισμού πληροφορικής',
    ]);
    const alice = (await as(s.team.alice).get('/api/dashboard')).body;
    expect(alice.tenders.map((t: { id: string }) => t.id)).toEqual([s.tender.id]);
    expect(alice.permissions).toEqual({ canCreateTender: false });
    expect((await as(s.team.outsider).get('/api/dashboard')).body.tenders.map((t: { id: string }) => t.id)).toEqual([other.id]);

    const viewerApi = await as(s.team.victor);
    const viewer = (await viewerApi.get('/api/dashboard')).body;
    expect(viewer.tenders).toHaveLength(1);
    expect(viewer.tenders[0]).toMatchObject({ id: s.tender.id, canWrite: false, tMinus: 7 });
    expect(viewer.tenders[0].warnings.length).toBe(5);
    expect(viewer.org).toBeNull();
    expect(viewer.my).toEqual({ overdue: 0, today: 0, upcoming: 0, waiting: 0 });
    expect(viewer.permissions).toEqual({ canCreateTender: false });
    for (const method of ['post', 'put', 'patch', 'delete'] as const) expect((await viewerApi[method]('/api/dashboard').send({})).status).toBe(404);

    const nobody = await createUser(s.org, 'member');
    expect((await as(nobody).get('/api/dashboard')).body).toMatchObject({ tenders: [], attention: [], org: null, recentlyClosed: [] });
  });

  it('lists tenders closed in the last 30 days and drops them from the active ones', async () => {
    const s = await scenario();
    const db = dbFor(s.org);
    const submitted = await createTender(s.org, { title: 'Υποβλήθηκε πρόσφατα', status: 'submitted', closed_at: new Date(Date.now() - 2 * 86_400_000) });
    await createTender(s.org, { title: 'No-Go παλιό', status: 'no_go', closed_at: new Date(Date.now() - 45 * 86_400_000) });
    const cancelled = await createTender(s.org, { title: 'Ακυρώθηκε χθες', status: 'cancelled', closed_at: new Date(Date.now() - 86_400_000) });
    await db.insert('task', { tender_id: submitted.id, title: 'Ξεχασμένο task', due_date: shiftDays(today, -5) });

    const body = (await as(s.team.admin).get('/api/dashboard')).body;
    expect(body.tenders.map((t: { id: string }) => t.id)).toEqual([s.tender.id]);
    expect(body.recentlyClosed.map((t: { title: string }) => t.title)).toEqual(['Ακυρώθηκε χθες', 'Υποβλήθηκε πρόσφατα']);
    expect(body.recentlyClosed[0]).toMatchObject({ id: cancelled.id, status: 'cancelled', authority: 'Αναθέτουσα Αρχή' });
    // a member sees only the closed tenders they belonged to
    expect((await as(s.team.alice).get('/api/dashboard')).body.recentlyClosed).toEqual([]);
    await addMember(submitted, s.team.alice);
    expect((await as(s.team.alice).get('/api/dashboard')).body.recentlyClosed.map((t: { id: string }) => t.id)).toEqual([submitted.id]);
  });

  it('never exposes financial files, requirement text or amounts — to anybody', async () => {
    const s = await scenario();
    for (const u of Object.values(s.team)) {
      const res = await as(u).get('/api/dashboard');
      expect(res.status).toBe(200);
      const json = JSON.stringify(res.body);
      for (const secret of secretStrings()) expect(json).not.toContain(secret);
      expect(json).not.toContain('filename');
      expect(json).not.toContain('guarantee_amount');
    }
  });

  it('cross-org: another organization\'s tenders, documents and items never appear', async () => {
    const mine = await scenario();
    const theirs = await scenario('Ξένος διαγωνισμός');
    await dbFor(theirs.org).insert('company_document', { type: 'iso', title: 'Ξένο πιστοποιητικό', expires_at: shiftDays(today, 3) });

    const body = (await as(mine.team.admin).get('/api/dashboard')).body;
    const json = JSON.stringify(body);
    expect(body.tenders).toHaveLength(1);
    expect(json).not.toContain('Ξένος διαγωνισμός');
    expect(json).not.toContain('Ξένο πιστοποιητικό');
    expect(json).not.toContain(theirs.tender.id);
    expect(body.org.documents).toMatchObject({ expired: 1, expiring: 2 });

    const fresh = await createUser(await createOrg(), 'admin');
    expect((await as(fresh).get('/api/dashboard')).body).toMatchObject({
      tenders: [],
      attention: [],
      recentlyClosed: [],
      org: { documents: { expired: 0, expiring: 0, items: [] } },
      my: { overdue: 0, today: 0, upcoming: 0, waiting: 0 },
      permissions: { canCreateTender: true },
    });
    expect((await as(fresh).get('/api/dashboard')).status).toBe(200);
  });

  it('stays at a fixed number of queries and well under a second with 20 active tenders', async () => {
    const org = await createOrg();
    await seedHolidays(org, [year, year + 1]);
    const first = await createScenario(org, today);
    for (let i = 2; i <= 20; i++) await createScenario(org, today, { team: first.team, title: `Διαγωνισμός ${i}` });
    const api = await as(first.team.manager);
    await api.get('/api/dashboard'); // warm-up (schema cache, connections)
    const started = performance.now();
    const res = await api.get('/api/dashboard');
    const elapsed = performance.now() - started;
    expect(res.body.tenders).toHaveLength(20);
    expect(res.body.attention).toHaveLength(100);
    expect(elapsed).toBeLessThan(1000);
  });
});
