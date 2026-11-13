import { beforeEach, describe, expect, it, vi } from 'vitest';

// A switch to make delivery fail for chosen addresses (SMTP down) — everything else goes to the real test outbox.
const smtp = vi.hoisted(() => ({ failFor: new Set<string>() }));
vi.mock('../../core/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/mailer.js')>();
  return {
    ...actual,
    sendMail: async (mail: import('../../core/mailer.js').Mail) => {
      if (smtp.failFor.has(mail.to)) throw new Error('SMTP down');
      return actual.sendMail(mail);
    },
  };
});

import { emit, flushEvents } from '../../core/events.js';
import { type Mail, testOutbox } from '../../core/mailer.js';
import type { CtxUser } from '../../core/types.js';
import { todayAthens } from '../../domain/time.js';
import { runJob } from '../../jobs/index.js';
import { addMember, as, createOrg, createTender, createUser, dbFor, seedHolidays, type TestUser } from '../../test/harness.js';
import { ensureDigestJob } from './jobs.js';
import { DIGEST_JOB } from './service.js';
import { createScenario, type Scenario, secretStrings } from './testFixture.js';

const WED = '2027-06-09'; // T = Fri 18/06/2027, T−7
const mailsTo = (user: { email: string }): Mail[] => testOutbox.filter((m) => m.to === user.email);
const everything = (m: Mail): string => `${m.subject}\n${m.text}\n${m.html ?? ''}`;
const ctxOf = (user: TestUser) => ({ orgId: user.org_id, user: user as unknown as CtxUser, db: dbFor({ id: user.org_id }, user) });

async function scenario(today = WED): Promise<Scenario> {
  const org = await createOrg();
  await seedHolidays(org, [2026, 2027]);
  return createScenario(org, today);
}
const runDigestJob = async (s: { org: { id: string } }, date: string) => (await runJob(DIGEST_JOB, { date, orgId: s.org.id }))[0];

beforeEach(() => {
  smtp.failFor.clear();
  ensureDigestJob();
});

describe('daily digest — who gets what', () => {
  it('sends each user their own items for today, the next 3 working days and overdue', async () => {
    const s = await scenario();
    const { team } = s;
    const result = await runDigestJob(s, WED);
    expect(result).toMatchObject({
      status: 'ok',
      detail: { date: WED, workingDay: true, activeTenders: 1, users: 8, sent: 6, alreadySent: 0, failed: 0, skipped: { nothing: 2, opted_out: 0, quiet_day: 0 } },
    });

    // Alice (role A): checklist item through her role (overdue), her own task (today), R6 on the guarantee.
    const [alice] = mailsTo(team.alice);
    expect(mailsTo(team.alice)).toHaveLength(1);
    expect(alice?.subject).toBe('[Bid Manager] 2 εκπρόθεσμα · 1 για σήμερα · G1 σε 2 εργάσιμες — Προμήθεια εξοπλισμού πληροφορικής');
    expect(alice?.text).toContain('Checklist: Αίτηση εγγυητικής και έλεγχος κειμένου · Δευ 07/06/2027 (πριν από 2 εργάσιμες)');
    expect(alice?.text).toContain('Task: ΕΕΕΣ σε συμφωνία με τα κριτήρια επιλογής · σήμερα');
    expect(alice?.text).toContain('Watchlist: Εγγυητική συμμετοχής — τελευταία ημέρα αίτησης · Παρ 04/06/2027');
    expect(alice?.text).toContain('Υποβολή: Παρ 18/06/2027 15:00 · T−7');
    expect(alice?.text).not.toContain('Υπεύθυνες δηλώσεις'); // done
    expect(alice?.text).not.toContain('Έλεγχος ονοματολογίας'); // no date
    expect(alice?.text).not.toContain('datasheets'); // Bob owns it directly although the role key says A
    expect(alice?.text).not.toContain('BOM'); // Bob's and Carol's
    expect(alice?.text).not.toContain('Λίστα απαιτούμενων πιστοποιητικών'); // not delivered yet: the sender's item
    expect(alice?.html).toContain('<li');
    expect(alice?.html).toContain(`/tenders/${s.tender.id}/overview`);

    // Bob (role B): role task, direct task, handoff to deliver, the gate he approves, R6 last request day today.
    const [bob] = mailsTo(team.bob);
    expect(bob?.subject).toBe('[Bid Manager] 2 εκπρόθεσμα · 1 για σήμερα · G1 σε 2 εργάσιμες — Προμήθεια εξοπλισμού πληροφορικής');
    expect(bob?.text).toContain('Task: Συλλογή datasheets κατασκευαστών · Τρί 08/06/2027 (πριν από 1 εργάσιμη)');
    expect(bob?.text).toContain('Παράδοση (Β Τεχνική → Α Δικαιολογητικά): Λίστα απαιτούμενων πιστοποιητικών, MAF και CVs · Τρί 08/06/2027');
    expect(bob?.text).toContain('Watchlist: MAF κατασκευαστή — τελευταία ημέρα αίτησης · σήμερα');
    expect(bob?.text).toContain('Task: BOM με ακριβείς κωδικούς · Παρ 11/06/2027 (σε 2 εργάσιμες)');
    expect(bob?.text).toContain('Πύλη G1 Solution freeze: περιμένει την απόφασή σας · Παρ 11/06/2027');
    expect(bob?.text).toContain('Watchlist: Vendor quotes — αναμενόμενη άφιξη · Πέμ 10/06/2027 (σε 1 εργάσιμη)');
    expect(bob?.text).not.toContain('ΕΕΕΣ');
    expect(bob?.text).not.toContain('Εγγυητική συμμετοχής — τελευταία'); // Alice's watch item (only the tender warning names it)

    // Carol (role C): the delivered handoff waits for her receipt; her far-away task is not there yet.
    const [carol] = mailsTo(team.carol);
    expect(carol?.text).toContain('Παραλαβή (Β Τεχνική → Γ Οικονομική): BOM κλειδωμένο (κωδικοί, ποσότητες, vendor quotes) — παραδόθηκε, περιμένει την επιβεβαίωσή σας');
    expect(carol?.text).not.toContain('Κοστολόγηση');
    expect(carol?.subject).toContain('1 τις επόμενες 3 εργάσιμες');

    // The approver: the gate awaiting her decision (requested), not the one a week away.
    const [boss] = mailsTo(team.boss);
    expect(boss?.text).toContain('Πύλη G2 Pricing approval: περιμένει την απόφασή σας (ζητήθηκε έγκριση) · Δευ 14/06/2027 (σε 3 εργάσιμες)');
    expect(boss?.text).not.toContain('G4 Final sign-off');

    // Viewer and non-member: nothing — and the job detail says so.
    expect(mailsTo(team.victor)).toHaveLength(0);
    expect(mailsTo(team.outsider)).toHaveLength(0);
    const detail = (result?.detail ?? {}) as { perUser: { userId: string; outcome: string }[] };
    expect(detail.perUser).toContainEqual({ userId: team.victor.id, outcome: 'nothing' });
    expect(detail.perUser).toContainEqual({ userId: team.outsider.id, outcome: 'nothing' });
    expect(detail.perUser).toContainEqual({ userId: team.alice.id, outcome: 'sent' });
  });

  it('tender writers get the tender-level warnings; admins also the expiring company documents (R15)', async () => {
    const s = await scenario();
    const { team } = s;
    await runDigestJob(s, WED);

    for (const writer of [team.alice, team.bob, team.carol, team.boss, team.manager, team.admin]) {
      const text = mailsTo(writer)[0]?.text ?? '';
      expect(text).toContain('Λιγότερες από 10 εργάσιμες έως το T (7): η εγγυητική δεν προλαβαίνει χωρίς άμεση αίτηση.'); // R8
      expect(text).toContain('1 συνδεδεμένο έγγραφο λήγει πριν από το T: «ISO 9001:2015».'); // R15
      expect(text).toContain('Watchlist: πέρασε η τελευταία ημέρα αίτησης για «Εγγυητική συμμετοχής» χωρίς αίτηση.'); // R6
      expect(text).toContain('Συμπιεσμένο mode'); // R8
      expect(text).toContain('Ισχύς εγγυητικής έως 15/11/2027· απαιτείται τουλάχιστον έως 14/01/2028 (λείπουν 60 ημέρες).'); // R16
    }

    // The bid manager owns nothing but still hears about the tender, with the team's overdue counts.
    const manager = mailsTo(team.manager)[0];
    expect(manager?.subject).toBe('[Bid Manager] G1 σε 2 εργάσιμες · 3 κόκκινες προειδοποιήσεις — Προμήθεια εξοπλισμού πληροφορικής');
    expect(manager?.text).toContain('Ομάδα: 2 εκπρόθεσμα tasks, 1 εκπρόθεσμη παράδοση');
    expect(manager?.text).not.toContain('Εταιρικά έγγραφα');

    // Admin: documents expired or expiring within 30 days — not the archived one, not the one valid for a year.
    const admin = mailsTo(team.admin)[0];
    expect(admin?.text).toContain('== Εταιρικά έγγραφα ==');
    expect(admin?.text).toContain('ΠΡΟΕΙΔΟΠΟΙΗΣΕΙΣ');
    expect(admin?.text).toContain('Δεν έχετε δικά σας εκπρόθεσμα ή επικείμενα');
    expect(admin?.text).toContain('Ασφαλιστική ενημερότητα — έληξε 06/06/2027');
    expect(admin?.text).toContain('ISO 9001:2015 — λήγει 17/06/2027');
    expect(admin?.text).toContain('Φορολογική ενημερότητα — λήγει 23/06/2027');
    expect(admin?.text).not.toContain('ΓΕΜΗ (παλιό)');
    expect(admin?.text).not.toContain('ISO 27001');
    expect(admin?.text).toContain('/company-documents');
    expect(mailsTo(team.alice)[0]?.text).not.toContain('Ασφαλιστική ενημερότητα');
  });

  it('compressed mode alone is context, not a reason for a daily mail', async () => {
    const org = await createOrg();
    const manager = await createUser(org, 'bid_manager');
    // T far away, nothing due: only the compressed flag is set.
    await createTender(org, { compressed_mode: true, submission_deadline_at: '2027-09-30T12:00:00Z', t0_published_at: '2027-06-01T08:00:00Z', guarantee_valid_until: null });
    const result = await runDigestJob({ org }, WED);
    expect(result?.detail).toMatchObject({ sent: 0, skipped: { nothing: 1 } });
    expect(mailsTo(manager)).toHaveLength(0);
  });

  it('never contains requirement text, financial file names or amounts (confidentiality)', async () => {
    const s = await scenario();
    await runDigestJob(s, WED);
    const mails = Object.values(s.team).flatMap((u) => mailsTo(u));
    expect(mails.length).toBe(6);
    const logged = await dbFor(s.org).list<{ subject: string; body: string }>('email_log', {});
    expect(logged).toHaveLength(6);
    for (const secret of secretStrings()) {
      for (const m of mails) expect(everything(m)).not.toContain(secret);
      for (const l of logged) expect(`${l.subject}\n${l.body}`).not.toContain(secret);
    }
    // no attachments by construction: the mailer only ever gets to/subject/text/html
    for (const m of mails) expect(Object.keys(m).sort()).toEqual(['html', 'subject', 'text', 'to']);
    // links point into the app only
    for (const m of mails) for (const url of m.text.match(/https?:\/\/\S+/g) ?? []) expect(url.startsWith('http://localhost:5173/')).toBe(true);
  });

  it('a user never receives items of another organization', async () => {
    const one = await scenario();
    const other = await createOrg();
    await seedHolidays(other, 2027);
    const two = await createScenario(other, WED, { title: 'Άλλος οργανισμός — μυστικός διαγωνισμός' });

    const [result] = await runJob(DIGEST_JOB, { date: WED, orgId: one.org.id });
    expect(result?.status).toBe('ok');
    for (const u of Object.values(two.team)) expect(mailsTo(u)).toHaveLength(0); // only org one ran
    for (const u of Object.values(one.team)) for (const m of mailsTo(u)) expect(everything(m)).not.toContain('Άλλος οργανισμός');

    await runJob(DIGEST_JOB, { date: WED, orgId: two.org.id });
    for (const u of Object.values(two.team)) {
      for (const m of mailsTo(u)) {
        expect(everything(m)).toContain('Άλλος οργανισμός');
        expect(everything(m)).not.toContain(one.tender.id);
      }
    }
    expect(await dbFor(one.org).count('email_log', {})).toBe(6);
    expect(await dbFor(other).count('email_log', {})).toBe(6);
  });

  it('members only hear about tenders they belong to; inactive users get nothing', async () => {
    const s = await scenario();
    const second = await createTender(s.org, { title: 'Δεύτερος διαγωνισμός', submission_deadline_at: '2027-07-30T12:00:00Z', guarantee_valid_until: null, compressed_mode: true });
    const db = dbFor(s.org);
    await addMember(second, s.team.outsider, 'A');
    await db.insert('task', { tender_id: second.id, title: 'Task του δεύτερου διαγωνισμού', owner_role_key: 'A', due_date: WED });
    await db.update('user', s.team.bob.id, { active: false });

    const result = await runDigestJob(s, WED);
    expect(result?.detail).toMatchObject({ users: 7 });
    expect(mailsTo(s.team.bob)).toHaveLength(0);
    // Alice holds role A in the first tender only: the role-A task of the second tender is not hers.
    expect(mailsTo(s.team.alice)[0]?.text).not.toContain('Task του δεύτερου διαγωνισμού');
    const outsider = mailsTo(s.team.outsider)[0];
    expect(outsider?.text).toContain('Task: Task του δεύτερου διαγωνισμού · σήμερα');
    expect(outsider?.text).not.toContain('Προμήθεια εξοπλισμού');
    expect(outsider?.subject).toBe('[Bid Manager] 1 για σήμερα — Δεύτερος διαγωνισμός');
    // the bid manager sees both
    expect(mailsTo(s.team.manager)[0]?.subject).toContain('— 2 διαγωνισμοί');
  });

  it('closed tenders produce nothing', async () => {
    const s = await scenario();
    await dbFor(s.org).update('tender', s.tender.id, { status: 'submitted', closed_at: new Date() });
    const result = await runDigestJob(s, WED);
    // only the admin's company documents remain
    expect(result?.detail).toMatchObject({ activeTenders: 0, sent: 1 });
    expect(mailsTo(s.team.admin)[0]?.subject).toBe('[Bid Manager] 3 εταιρικά έγγραφα λήγουν');
  });
});

describe('daily digest — idempotency and the execution log', () => {
  it('running twice sends one e-mail per user; both the job run and each mail are logged', async () => {
    const s = await scenario();
    const first = await runDigestJob(s, WED);
    expect(first?.status).toBe('ok');
    const second = await runDigestJob(s, WED);
    expect(second?.status).toBe('skipped');
    expect(mailsTo(s.team.alice)).toHaveLength(1);

    const db = dbFor(s.org);
    const run = await db.findOne('job_run', { job: DIGEST_JOB, run_date: WED });
    expect(run).toMatchObject({ status: 'ok', attempts: 1, detail: { sent: 6, skipped: { nothing: 2 } } });
    expect(run?.finished_at).toBeInstanceOf(Date);
    const log = await db.findOne('email_log', { dedupe_key: `digest:${WED}:${s.team.alice.id}` });
    expect(log).toMatchObject({ kind: 'digest', status: 'sent', user_id: s.team.alice.id, to_email: s.team.alice.email });
    expect(log?.sent_at).toBeInstanceOf(Date);
    expect(log?.subject).toContain('2 εκπρόθεσμα');

    // even when the job_run row is gone (e.g. manual cleanup) the per-user key still prevents a second mail
    await db.sql('DELETE FROM job_run WHERE org_id = :org_id AND job = :job', { job: DIGEST_JOB });
    const third = await runDigestJob(s, WED);
    expect(third).toMatchObject({ status: 'ok', detail: { sent: 0, alreadySent: 6 } });
    expect(mailsTo(s.team.alice)).toHaveLength(1);

    // the next day is a new digest
    const next = await runDigestJob(s, '2027-06-10');
    expect(next).toMatchObject({ status: 'ok', detail: { sent: 6 } });
    expect(mailsTo(s.team.alice)).toHaveLength(2);
  });

  it('a run that fails halfway is recorded as failed and the retry sends only what is missing', async () => {
    const s = await scenario();
    const { team } = s;
    smtp.failFor.add(team.bob.email).add(team.carol.email);
    const first = await runDigestJob(s, WED);
    expect(first?.status).toBe('failed');
    expect(String((first?.detail as { error: string }).error)).toContain('2 of 6 e-mails failed');
    expect(mailsTo(team.alice)).toHaveLength(1);
    expect(mailsTo(team.bob)).toHaveLength(0);
    const db = dbFor(s.org);
    expect(await db.findOne('email_log', { dedupe_key: `digest:${WED}:${team.bob.id}` })).toMatchObject({ status: 'failed', error: 'SMTP down' });

    smtp.failFor.clear();
    const retry = await runDigestJob(s, WED);
    expect(retry).toMatchObject({ status: 'ok', detail: { sent: 2, alreadySent: 4, failed: 0 } });
    for (const u of [team.admin, team.manager, team.alice, team.bob, team.carol, team.boss]) expect(mailsTo(u)).toHaveLength(1);
    expect(await db.findOne('job_run', { job: DIGEST_JOB, run_date: WED })).toMatchObject({ status: 'ok', attempts: 2 });
    expect(await db.count('email_log', { kind: 'digest', status: 'sent' })).toBe(6);
  });

  it('a crash between claim and send (stale "pending" row) is resumed; a fresh pending row is left alone', async () => {
    const s = await scenario();
    const db = dbFor(s.org);
    const pending = (userId: string, updated: string) =>
      db.sql(
        `INSERT INTO email_log (org_id, user_id, kind, dedupe_key, status, updated_at)
         VALUES (:org_id, :user_id, 'digest', :key, 'pending', now() - CAST(:age AS interval))`,
        { user_id: userId, key: `digest:${WED}:${userId}`, age: updated },
      );
    await pending(s.team.alice.id, '2 hours'); // crashed run
    await pending(s.team.bob.id, '5 seconds'); // another process is sending it right now
    const result = await runDigestJob(s, WED);
    expect(result).toMatchObject({ status: 'ok', detail: { sent: 5, alreadySent: 1 } });
    expect(mailsTo(s.team.alice)).toHaveLength(1);
    expect(mailsTo(s.team.bob)).toHaveLength(0);
  });
});

describe('daily digest — weekends, holidays, preferences', () => {
  async function quietOrg() {
    const org = await createOrg();
    await seedHolidays(org, 2027);
    const user = await createUser(org, 'member');
    const tender = await createTender(org, { submission_deadline_at: '2027-09-30T12:00:00Z', t0_published_at: '2027-06-01T08:00:00Z', guarantee_valid_until: null });
    await addMember(tender, user, 'A');
    const task = (title: string, due: string) => dbFor(org).insert('task', { tender_id: tender.id, title, owner_user_id: user.id, due_date: due });
    return { org, user, tender, task };
  }

  it('is not sent on a weekend when everything is still ahead', async () => {
    const q = await quietOrg();
    await q.task('Τη Δευτέρα', '2027-06-14');
    const sat = await runDigestJob(q, '2027-06-12');
    expect(sat).toMatchObject({ status: 'ok', detail: { workingDay: false, sent: 0, skipped: { quiet_day: 1 } } });
    expect(mailsTo(q.user)).toHaveLength(0);
    // Friday before: "next 3 working days" skips the weekend, so Monday's task is announced
    const fri = await runDigestJob(q, '2027-06-11');
    expect(fri).toMatchObject({ detail: { workingDay: true, sent: 1 } });
    expect(mailsTo(q.user)[0]?.text).toContain('Task: Τη Δευτέρα · Δευ 14/06/2027 (σε 1 εργάσιμη)');
  });

  it('is sent on a weekend when something is overdue or due that day', async () => {
    const overdue = await quietOrg();
    await overdue.task('Χθεσινό', '2027-06-11');
    expect(await runDigestJob(overdue, '2027-06-12')).toMatchObject({ detail: { workingDay: false, sent: 1 } });
    expect(mailsTo(overdue.user)[0]?.subject).toContain('1 εκπρόθεσμο');

    const dueToday = await quietOrg();
    await dueToday.task('Κυριακάτικο', '2027-06-13');
    expect(await runDigestJob(dueToday, '2027-06-13')).toMatchObject({ detail: { workingDay: false, sent: 1 } });
    expect(mailsTo(dueToday.user)[0]?.subject).toContain('1 για σήμερα');
  });

  it('treats an organization holiday like a weekend and skips it when counting the next 3 working days', async () => {
    const q = await quietOrg();
    await q.task('Μετά την αργία', '2027-06-24');
    // Mon 21/06/2027 = Αγίου Πνεύματος
    expect(await runDigestJob(q, '2027-06-21')).toMatchObject({ detail: { workingDay: false, sent: 0, skipped: { quiet_day: 1 } } });
    // Fri 18/06: next 3 working days = 22, 23, 24 (the 21st is a holiday)
    expect(await runDigestJob(q, '2027-06-18')).toMatchObject({ detail: { workingDay: true, sent: 1 } });
    expect(mailsTo(q.user)[0]?.text).toContain('Πέμ 24/06/2027 (σε 3 εργάσιμες)');

    // an admin removes the holiday → the 21st becomes a normal working day for this org
    const other = await quietOrg();
    await other.task('Μετά την αργία', '2027-06-24');
    await dbFor(other.org).sql("DELETE FROM holiday WHERE org_id = :org_id AND date = '2027-06-21'");
    expect(await runDigestJob(other, '2027-06-21')).toMatchObject({ detail: { workingDay: true, sent: 1 } });
  });

  it('respects the digest switch in the user settings (default on)', async () => {
    const s = await scenario();
    const api = await as(s.team.alice);
    expect((await api.get('/api/notifications/preferences')).body).toEqual({ digest: true, immediate: true, email: s.team.alice.email });
    const put = await api.put('/api/notifications/preferences').send({ digest: false });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ digest: false, immediate: true, email: s.team.alice.email });

    const result = await runDigestJob(s, WED);
    expect(result?.detail).toMatchObject({ sent: 5, skipped: { opted_out: 1, nothing: 2 } });
    expect(mailsTo(s.team.alice)).toHaveLength(0);
    expect(mailsTo(s.team.bob)).toHaveLength(1);
  });
});

describe('/api/notifications — preferences, log, preview, run', () => {
  it('preferences: own user only, validated, other settings keys are kept', async () => {
    const org = await createOrg();
    const user = await createUser(org, 'member', { settings: { theme: 'dark' } });
    const other = await createUser(org, 'member');
    const api = await as(user);
    expect((await api.put('/api/notifications/preferences').send({ immediate: false })).body).toMatchObject({ digest: true, immediate: false });
    expect((await api.put('/api/notifications/preferences').send({ digest: false })).body).toMatchObject({ digest: false, immediate: false });
    const row = await dbFor(org).get('user', user.id);
    expect(row?.settings).toEqual({ theme: 'dark', notifications: { digest: false, immediate: false } });
    expect((await dbFor(org).get('user', other.id))?.settings).toEqual({});
    for (const bad of [{ digest: 'no' }, { digest: true, user_id: other.id }, { weekly: true }]) {
      expect((await api.put('/api/notifications/preferences').send(bad)).status).toBe(400);
    }
    // a viewer may change their own preferences too
    const viewer = await createUser(org, 'viewer');
    expect((await as(viewer).put('/api/notifications/preferences').send({ digest: false })).status).toBe(200);
  });

  it('preview returns what today\'s digest would contain without sending or logging anything', async () => {
    const today = todayAthens();
    const s = await scenario(today);
    const before = testOutbox.length;
    const res = await as(s.team.bob).post('/api/notifications/digest/preview').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: today, wouldSend: true, reason: null, totals: { overdue: 2, today: 1, upcoming: 3, waiting: 0 } });
    expect(res.body.subject).toContain('[Bid Manager] 2 εκπρόθεσμα · 1 για σήμερα');
    expect(res.body.text).toContain('Task: BOM με ακριβείς κωδικούς');
    expect(res.body.html).toContain('<!doctype html>');
    expect(res.body.tenders).toHaveLength(1);
    expect(res.body.tenders[0].items.map((i: { kind: string }) => i.kind).sort()).toEqual(['gate', 'handoff_deliver', 'task', 'task', 'watch_arrival', 'watch_request']);
    expect(testOutbox.length).toBe(before);
    expect(await dbFor(s.org).count('email_log', {})).toBe(0);
    for (const secret of secretStrings()) expect(JSON.stringify(res.body)).not.toContain(secret);

    // somebody with nothing, and somebody who opted out
    const nothing = await as(s.team.outsider).post('/api/notifications/digest/preview').send({});
    expect(nothing.body).toMatchObject({ wouldSend: false, reason: 'nothing', tenders: [], totals: { overdue: 0, today: 0, upcoming: 0, waiting: 0 } });
    await as(s.team.bob).put('/api/notifications/preferences').send({ digest: false });
    expect((await as(s.team.bob).post('/api/notifications/digest/preview').send({})).body).toMatchObject({ wouldSend: false, reason: 'opted_out' });
  });

  it('run: admin only, for today, idempotent', async () => {
    const today = todayAthens();
    const s = await scenario(today);
    for (const u of [s.team.manager, s.team.alice, s.team.boss, s.team.victor]) {
      expect((await as(u).post('/api/notifications/digest/run').send({})).status).toBe(403);
    }
    const admin = await as(s.team.admin);
    const first = await admin.post('/api/notifications/digest/run').send({});
    expect(first.status).toBe(200);
    // overdue items exist, so the digest goes out even when the test happens to run on a weekend
    expect(first.body).toMatchObject({ date: today, status: 'ok', alreadyRan: false, detail: { sent: 6, failed: 0 } });
    const second = await admin.post('/api/notifications/digest/run').send({});
    expect(second.body).toMatchObject({ date: today, status: 'ok', alreadyRan: true, detail: { sent: 6 } });
    expect(mailsTo(s.team.alice)).toHaveLength(1);
    expect((await as(s.team.alice).post('/api/notifications/digest/preview').send({})).body).toMatchObject({ wouldSend: false, reason: 'already_sent' });
  });

  it('log: own e-mails; an admin can see all of the organization — never another organization\'s', async () => {
    const s = await scenario();
    await runDigestJob(s, WED);
    const mine = await as(s.team.alice).get('/api/notifications/log');
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0]).toMatchObject({ kind: 'digest', status: 'sent', user_id: s.team.alice.id, to_email: s.team.alice.email });
    expect(mine.body.items[0].body).toContain('ΕΕΕΣ');
    // scope=all is ignored for non-admins
    expect((await as(s.team.alice).get('/api/notifications/log?scope=all')).body.total).toBe(1);
    expect((await as(s.team.manager).get('/api/notifications/log?scope=all')).body.total).toBe(1);
    expect((await as(s.team.victor).get('/api/notifications/log')).body).toEqual({ items: [], total: 0 });

    const admin = await as(s.team.admin);
    expect((await admin.get('/api/notifications/log')).body.total).toBe(1);
    const all = await admin.get('/api/notifications/log?scope=all&limit=4');
    expect(all.body.total).toBe(6);
    expect(all.body.items).toHaveLength(4);
    expect(all.body.items.every((i: { user_name: string }) => typeof i.user_name === 'string')).toBe(true);
    expect((await admin.get('/api/notifications/log?limit=0')).status).toBe(400);

    const foreignAdmin = await createUser(await createOrg(), 'admin');
    expect((await as(foreignAdmin).get('/api/notifications/log?scope=all')).body).toEqual({ items: [], total: 0 });
    expect((await as(foreignAdmin).post('/api/notifications/digest/preview').send({})).body).toMatchObject({ tenders: [], orgDocuments: [] });
  });
});

describe('immediate e-mails from events', () => {
  it('gate.approval_requested → the approver only', async () => {
    const s = await scenario();
    emit(ctxOf(s.team.manager), 'gate.approval_requested', { tenderId: s.tender.id, gateId: s.ids.G2 as string, approverUserId: s.team.boss.id });
    await flushEvents();
    const [mail] = mailsTo(s.team.boss);
    expect(mailsTo(s.team.boss)).toHaveLength(1);
    expect(mail?.subject).toBe('[Bid Manager] Αίτημα έγκρισης G2 — Προμήθεια εξοπλισμού πληροφορικής');
    expect(mail?.text).toContain('Ο/Η Βασίλης Bid ζητά την απόφασή σας για την πύλη G2 Pricing approval');
    expect(mail?.text).toContain('Ημερομηνία πύλης: Δευ 14/06/2027 (T−4)');
    expect(mail?.text).toContain(`http://localhost:5173/tenders/${s.tender.id}/gates`);
    expect(mail?.html).toContain(`/tenders/${s.tender.id}/gates`);
    for (const u of [s.team.admin, s.team.manager, s.team.alice, s.team.bob, s.team.carol, s.team.victor, s.team.outsider]) expect(mailsTo(u)).toHaveLength(0);
    expect(await dbFor(s.org).findOne('email_log', { kind: 'gate_approval_requested' })).toMatchObject({ user_id: s.team.boss.id, status: 'sent' });

    // the same request delivered twice (same requested_at) is one mail; a new request is a new mail
    emit(ctxOf(s.team.manager), 'gate.approval_requested', { tenderId: s.tender.id, gateId: s.ids.G2 as string, approverUserId: s.team.boss.id });
    await flushEvents();
    expect(mailsTo(s.team.boss)).toHaveLength(1);
    await dbFor(s.org).update('gate', s.ids.G2 as string, { requested_at: new Date(Date.now() + 60_000) });
    emit(ctxOf(s.team.manager), 'gate.approval_requested', { tenderId: s.tender.id, gateId: s.ids.G2 as string, approverUserId: s.team.boss.id });
    await flushEvents();
    expect(mailsTo(s.team.boss)).toHaveLength(2);
  });

  it('tender.extended → every member of the tender, with old and new deadline and a link to the schedule', async () => {
    const s = await scenario();
    await dbFor(s.org).update('tender', s.tender.id, { submission_deadline_at: '2027-06-25T12:00:00Z' });
    emit(ctxOf(s.team.manager), 'tender.extended', { tenderId: s.tender.id, oldT: '2027-06-18', newT: '2027-06-25' });
    await flushEvents();
    for (const member of [s.team.alice, s.team.bob, s.team.carol, s.team.boss, s.team.victor]) {
      const [mail] = mailsTo(member);
      expect(mailsTo(member)).toHaveLength(1);
      expect(mail?.subject).toBe('[Bid Manager] Παράταση: νέα προθεσμία 25/06/2027 15:00 — Προμήθεια εξοπλισμού πληροφορικής');
      expect(mail?.text).toContain('Παλιά προθεσμία: 18/06/2027');
      expect(mail?.text).toContain('Νέα προθεσμία: 25/06/2027 15:00');
      expect(mail?.text).toContain(`http://localhost:5173/tenders/${s.tender.id}/schedule`);
    }
    // not members: the admin, the bid manager who made the change, somebody outside the tender
    for (const u of [s.team.admin, s.team.manager, s.team.outsider]) expect(mailsTo(u)).toHaveLength(0);
  });

  it('gate.decided → the tender members (decision and by whom), not the decider', async () => {
    const s = await scenario();
    await dbFor(s.org).update('gate', s.ids.G2 as string, { decision: 'approved_with_exception', decided_by: s.team.boss.id, decided_at: new Date(), justification: 'SECRET-REQ-TEXT τιμή 48500' });
    emit(ctxOf(s.team.boss), 'gate.decided', { tenderId: s.tender.id, gateId: s.ids.G2 as string, decision: 'approved_with_exception' });
    await flushEvents();
    for (const member of [s.team.alice, s.team.bob, s.team.carol, s.team.victor]) {
      const [mail] = mailsTo(member);
      expect(mailsTo(member)).toHaveLength(1);
      expect(mail?.subject).toBe('[Bid Manager] G2: Εγκρίθηκε με εξαίρεση — Προμήθεια εξοπλισμού πληροφορικής');
      expect(mail?.text).toContain('Πύλη G2 Pricing approval του διαγωνισμού «Προμήθεια εξοπλισμού πληροφορικής»: Εγκρίθηκε με εξαίρεση — απόφαση από Δήμητρα Διοίκηση.');
      for (const secret of secretStrings()) expect(everything(mail as Mail)).not.toContain(secret); // the justification stays in the app
    }
    for (const u of [s.team.boss, s.team.admin, s.team.manager, s.team.outsider]) expect(mailsTo(u)).toHaveLength(0);
  });

  it('handoff.delivered → the holders of the receiving role', async () => {
    const s = await scenario();
    const second = await createUser(s.org, 'member', { name: 'Δεύτερη Οικονομικής' });
    await addMember(s.tender, second, 'C');
    emit(ctxOf(s.team.bob), 'handoff.delivered', { tenderId: s.tender.id, taskId: s.ids.hBom as string });
    await flushEvents();
    for (const receiver of [s.team.carol, second]) {
      const [mail] = mailsTo(receiver);
      expect(mailsTo(receiver)).toHaveLength(1);
      expect(mail?.subject).toBe('[Bid Manager] Παράδοση προς παραλαβή: BOM κλειδωμένο (κωδικοί, ποσότητες, vendor quotes) — Προμήθεια εξοπλισμού πληροφορικής');
      expect(mail?.text).toContain('Ο/Η Μπάμπης Τεχνικός παρέδωσε: «BOM κλειδωμένο (κωδικοί, ποσότητες, vendor quotes)» (Β Τεχνική → Γ Οικονομική)');
      expect(mail?.text).toContain(`http://localhost:5173/tenders/${s.tender.id}/tasks`);
    }
    for (const u of [s.team.bob, s.team.alice, s.team.boss, s.team.manager, s.team.admin, s.team.victor]) expect(mailsTo(u)).toHaveLength(0);
  });

  it('immediate e-mails respect the user preference, skip inactive users and never cross organizations', async () => {
    const s = await scenario();
    await as(s.team.alice).put('/api/notifications/preferences').send({ immediate: false });
    await dbFor(s.org).update('user', s.team.carol.id, { active: false });
    emit(ctxOf(s.team.manager), 'tender.extended', { tenderId: s.tender.id, oldT: '2027-06-18', newT: '2027-06-25' });
    await flushEvents();
    expect(mailsTo(s.team.alice)).toHaveLength(0);
    expect(mailsTo(s.team.carol)).toHaveLength(0);
    expect(mailsTo(s.team.bob)).toHaveLength(1);
    // the digest switch is independent: Alice still gets her digest
    await runDigestJob(s, WED);
    expect(mailsTo(s.team.alice)).toHaveLength(1);

    // an event that names a tender of another organization does nothing
    const foreign = await createUser(await createOrg(), 'admin');
    const before = testOutbox.length;
    emit(ctxOf(foreign), 'tender.extended', { tenderId: s.tender.id, oldT: '2027-06-18', newT: '2027-06-25' });
    emit(ctxOf(foreign), 'gate.approval_requested', { tenderId: s.tender.id, gateId: s.ids.G2 as string, approverUserId: s.team.boss.id });
    emit(ctxOf(foreign), 'gate.decided', { tenderId: s.tender.id, gateId: s.ids.G2 as string, decision: 'approved' });
    emit(ctxOf(foreign), 'handoff.delivered', { tenderId: s.tender.id, taskId: s.ids.hBom as string });
    await flushEvents();
    expect(testOutbox.length).toBe(before);
  });
});
